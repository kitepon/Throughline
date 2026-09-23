import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeTerminalText,
  normalizeToolResultContent,
  readTranscript,
  sliceCurrentTurnEntries,
  extractDetailBlocks,
} from './transcript-reader.mjs';
import { DETAIL_KIND } from './constants.mjs';

test('normalizeTerminalText: ANSI 色コードを除去する', () => {
  assert.equal(normalizeTerminalText('\x1b[32mgreen\x1b[0m text'), 'green text');
  assert.equal(normalizeTerminalText('plain'), 'plain');
  assert.equal(normalizeTerminalText(''), '');
});

test('normalizeTerminalText: cursor 移動・private mode・OSC・2 byte ESC を除去する', () => {
  // npm の spinner (macOS 実測) と Windows ConPTY の title / cursor 表示切替
  assert.equal(normalizeTerminalText('\x1b[1G\x1b[0K|\x1b[1G\x1b[0Jdone\x1b[38G'), '|done');
  assert.equal(normalizeTerminalText('\x1b]0;C:\\Windows\\pwsh.exe\x07\x1b[?25lok\x1b[?25h'), 'ok');
  assert.equal(normalizeTerminalText('\x1b]8;;https://e.x\x1b\\link\x1b]8;;\x1b\\'), 'link');
  assert.equal(normalizeTerminalText('\x1b(Bx\x1b7y\x1b8'), 'xy');
});

test('normalizeTerminalText: CRLF を LF にし、行内 CR は最後の上書きだけを残す', () => {
  assert.equal(normalizeTerminalText('a\r\nb\r\n'), 'a\nb\n');
  assert.equal(normalizeTerminalText('10%\r50%\r100%\nnext'), '100%\nnext');
  assert.equal(normalizeTerminalText('line\r'), 'line');
});

function writeTranscript(entries) {
  const dir = mkdtempSync(join(tmpdir(), 'tl-transcript-'));
  const path = join(dir, 't.jsonl');
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return path;
}

test('readTranscript: Claude task 通知は識別子・path・端末生出力を落として残す', () => {
  const notice = [
    '<task-notification>',
    '<task-id>b1</task-id>',
    '<tool-use-id>toolu_1</tool-use-id>',
    '<output-file>/tmp/tasks/b1.output</output-file>',
    '<status>completed</status>',
    '<summary>Background command "x" completed (exit code 0)</summary>',
    '<result>subagent report</result>',
    '<usage><subagent_tokens>1</subagent_tokens></usage>',
    '<note>A task-notification fires each time this agent stops.</note>',
    '</task-notification>',
    'Last output:',
    '\x1b[34mEstablishing\x1b[39m\r\nPress ENTER',
    '',
    'The command is likely blocked on an interactive prompt.',
  ].join('\n');
  const path = writeTranscript([
    { type: 'user', message: { role: 'user', content: notice } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '\x1b[1mkeep\x1b[0m' }] } },
  ]);
  const [user, assistant] = readTranscript(path);
  assert.equal(
    user.content,
    [
      '<task-notification>',
      '<status>completed</status>',
      '<summary>Background command "x" completed (exit code 0)</summary>',
      '<result>subagent report</result>',
      '</task-notification>',
    ].join('\n'),
  );
  // assistant 本文は Stop payload との照合に使うため変えない
  assert.equal(assistant.content, '\x1b[1mkeep\x1b[0m');
});

test('readTranscript: task 通知の後ろの system-reminder と通常の user 発言は残す', () => {
  const path = writeTranscript([
    { type: 'user', message: { role: 'user', content: '<task-notification>\n<task-id>b2</task-id>\n<summary>s</summary>\n</task-notification>\n<system-reminder>r</system-reminder>' } },
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '貼った出力 \x1b[31mERR\x1b[0m' }] } },
  ]);
  const [notice, typed] = readTranscript(path);
  assert.equal(notice.content, '<task-notification>\n<summary>s</summary>\n</task-notification>\n<system-reminder>r</system-reminder>');
  assert.equal(typed.content, '貼った出力 ERR');
});

test('normalizeToolResultContent: string / array / image mix', () => {
  assert.equal(normalizeToolResultContent('raw string'), 'raw string');
  assert.equal(
    normalizeToolResultContent([
      { type: 'text', text: 'hello' },
      { type: 'text', text: ' world' },
    ]),
    'hello world',
  );
  assert.equal(
    normalizeToolResultContent([
      { type: 'text', text: 'before' },
      { type: 'image', source: {} },
      { type: 'text', text: 'after' },
    ]),
    'before[image]after',
  );
  assert.equal(normalizeToolResultContent(null), '');
});

/** 単一 text ブロック user / assistant エントリを作る */
function userEntry(text) {
  return { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } };
}
function asstTextEntry(text) {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  };
}
function asstToolUseEntry(id, name, input) {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  };
}
function userToolResultEntry(toolUseId, content) {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content }],
    },
  };
}
function attachmentEntry(uuid, hookEvent, command, content) {
  return {
    type: 'attachment',
    uuid,
    attachment: { type: 'hook_success', hookEvent, command, content },
  };
}

test('sliceCurrentTurnEntries: 最後の user text → 最後の assistant text を切り出す', () => {
  const entries = [
    userEntry('old prompt'),
    asstTextEntry('old response'),
    userEntry('current prompt'),
    asstToolUseEntry('toolu_1', 'Bash', { command: 'ls' }),
    userToolResultEntry('toolu_1', 'file1\nfile2'),
    asstTextEntry('current response'),
  ];
  const slice = sliceCurrentTurnEntries(entries);
  assert.equal(slice.length, 4);
  assert.equal(slice[0].message.content[0].text, 'current prompt');
  assert.equal(slice[3].message.content[0].text, 'current response');
});

test('sliceCurrentTurnEntries: 空配列なら空を返す', () => {
  assert.deepEqual(sliceCurrentTurnEntries([]), []);
});

test('sliceCurrentTurnEntries: assistant text が無ければ空', () => {
  const entries = [userEntry('hello'), asstToolUseEntry('t1', 'Read', { path: '/x' })];
  assert.deepEqual(sliceCurrentTurnEntries(entries), []);
});

test('extractDetailBlocks: tool_use と tool_result をペアで抽出', () => {
  const entries = [
    userEntry('do it'),
    asstToolUseEntry('toolu_42', 'Bash', { command: 'echo hi' }),
    userToolResultEntry('toolu_42', 'hi\n'),
    asstTextEntry('done'),
  ];
  const details = extractDetailBlocks(entries);
  assert.equal(details.length, 2);

  const [input, output] = details;
  assert.equal(input.kind, DETAIL_KIND.TOOL_INPUT);
  assert.equal(input.tool_name, 'Bash');
  assert.equal(input.source_id, 'toolu_42');
  assert.ok(input.input_text.includes('echo hi'));
  assert.equal(input.output_text, null);

  assert.equal(output.kind, DETAIL_KIND.TOOL_OUTPUT);
  assert.equal(output.tool_name, 'Bash'); // tool_use からマップされる
  assert.equal(output.source_id, 'toolu_42:result');
  assert.equal(output.output_text, 'hi\n');
});

test('extractDetailBlocks: assistant の thinking ブロックを kind=thinking で抽出、text は無視', () => {
  const entries = [
    userEntry('prompt'),
    {
      type: 'assistant',
      uuid: 'asst-1',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'internal thoughts', signature: 'sig' },
          { type: 'text', text: 'response' },
        ],
      },
    },
  ];
  const details = extractDetailBlocks(entries);
  assert.equal(details.length, 1);
  assert.equal(details[0].kind, DETAIL_KIND.THINKING);
  assert.equal(details[0].tool_name, 'thinking');
  assert.equal(details[0].source_id, 'asst-1:thinking:0');
  assert.equal(details[0].input_text, null);
  assert.equal(details[0].output_text, 'internal thoughts');
});

test('extractDetailBlocks: 同 entry 内で thinking + tool_use + image が混在しても全て抽出', () => {
  const entries = [
    userEntry('prompt'),
    {
      type: 'assistant',
      uuid: 'asst-2',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'first thought' },
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: '/x' } },
          { type: 'thinking', thinking: 'second thought' },
          { type: 'image', source: {} },
          { type: 'text', text: 'done' },
        ],
      },
    },
    asstTextEntry('wrap'),
  ];
  const details = extractDetailBlocks(entries);
  // thinking x2, tool_input x1, image x1 = 4
  assert.equal(details.length, 4);
  const thinkings = details.filter((d) => d.kind === DETAIL_KIND.THINKING);
  assert.equal(thinkings.length, 2);
  assert.equal(thinkings[0].source_id, 'asst-2:thinking:0');
  assert.equal(thinkings[1].source_id, 'asst-2:thinking:2');
  assert.equal(thinkings[0].output_text, 'first thought');
  assert.equal(thinkings[1].output_text, 'second thought');
});

test('extractDetailBlocks: thinking エントリに uuid が無くても source_id=null で通過する', () => {
  const entries = [
    userEntry('prompt'),
    {
      type: 'assistant',
      // uuid 欠損
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'thought without uuid' },
          { type: 'text', text: 'reply' },
        ],
      },
    },
  ];
  const details = extractDetailBlocks(entries);
  const thinking = details.find((d) => d.kind === DETAIL_KIND.THINKING);
  assert.ok(thinking);
  assert.equal(thinking.source_id, null);
  assert.equal(thinking.output_text, 'thought without uuid');
});

test('extractDetailBlocks: attachment (hook_success) を system として抽出', () => {
  const entries = [
    userEntry('prompt'),
    attachmentEntry('att-uuid-1', 'UserPromptSubmit', 'node hook.mjs', 'injected context'),
    asstTextEntry('reply'),
  ];
  const details = extractDetailBlocks(entries);
  assert.equal(details.length, 1);
  assert.equal(details[0].kind, DETAIL_KIND.SYSTEM);
  assert.equal(details[0].tool_name, 'hook_success:UserPromptSubmit');
  assert.equal(details[0].source_id, 'att-uuid-1');
  assert.equal(details[0].input_text, 'node hook.mjs');
  assert.equal(details[0].output_text, 'injected context');
});

test('extractDetailBlocks: attachment (async_hook_response) を system として抽出', () => {
  const entries = [
    userEntry('prompt'),
    {
      type: 'attachment',
      uuid: 'async-1',
      attachment: {
        type: 'async_hook_response',
        hookName: 'Stop',
        hookEvent: 'Stop',
        stdout: 'hook output text',
        stderr: '',
        exitCode: 0,
      },
    },
    asstTextEntry('reply'),
  ];
  const details = extractDetailBlocks(entries);
  assert.equal(details.length, 1);
  assert.equal(details[0].kind, DETAIL_KIND.SYSTEM);
  assert.equal(details[0].tool_name, 'async_hook_response:Stop');
  assert.equal(details[0].source_id, 'async-1');
  assert.equal(details[0].output_text, 'hook output text');
});

test('extractDetailBlocks: attachment (nested_memory) も system として拾う', () => {
  const entries = [
    userEntry('prompt'),
    {
      type: 'attachment',
      uuid: 'mem-1',
      attachment: {
        type: 'nested_memory',
        path: 'C:\\Users\\x\\.claude\\rules\\x.md',
        content: 'memory file body',
      },
    },
    asstTextEntry('reply'),
  ];
  const details = extractDetailBlocks(entries);
  assert.equal(details.length, 1);
  assert.equal(details[0].tool_name, 'nested_memory');
  assert.equal(details[0].input_text, 'C:\\Users\\x\\.claude\\rules\\x.md');
  assert.equal(details[0].output_text, 'memory file body');
});

test('extractDetailBlocks: attachment (mcp_instructions_delta) の addedBlocks も拾う', () => {
  const entries = [
    userEntry('prompt'),
    {
      type: 'attachment',
      uuid: 'mcp-1',
      attachment: {
        type: 'mcp_instructions_delta',
        addedNames: ['plugin:foo'],
        addedBlocks: ['## plugin:foo\nDo things'],
        removedNames: [],
      },
    },
    asstTextEntry('reply'),
  ];
  const details = extractDetailBlocks(entries);
  assert.equal(details.length, 1);
  assert.equal(details[0].tool_name, 'mcp_instructions_delta');
  assert.ok(details[0].output_text.includes('plugin:foo'));
});

test('extractDetailBlocks: 未知の attachment 種別は JSON dump で残す (情報ロスゼロ)', () => {
  const entries = [
    userEntry('prompt'),
    {
      type: 'attachment',
      uuid: 'unknown-1',
      attachment: {
        type: 'some_future_type',
        foo: 'bar',
        count: 42,
      },
    },
    asstTextEntry('reply'),
  ];
  const details = extractDetailBlocks(entries);
  assert.equal(details.length, 1);
  assert.equal(details[0].tool_name, 'some_future_type');
  assert.ok(details[0].output_text.includes('bar'));
  assert.ok(details[0].output_text.includes('42'));
});

test('extractDetailBlocks: tool_output の ANSI コードは剥離される', () => {
  const entries = [
    userEntry('run it'),
    asstToolUseEntry('t1', 'Bash', { command: 'ls' }),
    userToolResultEntry('t1', '\x1b[32mgreen\x1b[0m file'),
    asstTextEntry('ok'),
  ];
  const details = extractDetailBlocks(entries);
  const output = details.find((d) => d.kind === DETAIL_KIND.TOOL_OUTPUT);
  assert.equal(output.output_text, 'green file');
});

test('extractDetailBlocks: system (stop_hook_summary) と queue-operation はスキップ', () => {
  const entries = [
    userEntry('prompt'),
    { type: 'system', subtype: 'stop_hook_summary', hookCount: 3 },
    { type: 'queue-operation', op: 'enqueue' },
    { type: 'file-history-snapshot', uuid: 'abc' },
    asstTextEntry('reply'),
  ];
  const details = extractDetailBlocks(entries);
  assert.equal(details.length, 0);
});

test('extractDetailBlocks: tool_result の content が配列でも処理できる', () => {
  const entries = [
    userEntry('fetch'),
    asstToolUseEntry('t1', 'Read', { file_path: '/x' }),
    userToolResultEntry('t1', [
      { type: 'text', text: 'line1\n' },
      { type: 'text', text: 'line2' },
    ]),
    asstTextEntry('done'),
  ];
  const details = extractDetailBlocks(entries);
  const output = details.find((d) => d.kind === DETAIL_KIND.TOOL_OUTPUT);
  assert.equal(output.output_text, 'line1\nline2');
});

test('extractDetailBlocks: 複数ツール連続呼び出しを全て拾う', () => {
  const entries = [
    userEntry('investigate'),
    asstToolUseEntry('t1', 'Read', { path: '/a' }),
    userToolResultEntry('t1', 'a contents'),
    asstToolUseEntry('t2', 'Grep', { pattern: 'foo' }),
    userToolResultEntry('t2', 'foo found'),
    asstTextEntry('summary'),
  ];
  const details = extractDetailBlocks(entries);
  assert.equal(details.length, 4);
  assert.deepEqual(
    details.map((d) => d.kind),
    [DETAIL_KIND.TOOL_INPUT, DETAIL_KIND.TOOL_OUTPUT, DETAIL_KIND.TOOL_INPUT, DETAIL_KIND.TOOL_OUTPUT],
  );
});
