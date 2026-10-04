import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import {
  buildCodexPostToolUseHookCommand,
  buildCodexStopHookCommand,
  buildCodexUserPromptSubmitHookCommand,
  buildCursorHookCommand,
  buildGrokHookCommand,
  createGrokHooksFile,
  createCursorHookEntries,
  isEquivalentCodexHookCommand,
  isThroughlineCodexHookCommand,
  isThroughlineCursorHookCommand,
  parseCodexHookCommand,
  resolveCodexHookNodePath,
  run,
  resolveThroughlineOnPath,
} from './install.mjs';

function makeTempHome() {
  const dir = mkdtempSync(join(tmpdir(), 'tl-install-test-'));
  const origUserprofile = process.env.USERPROFILE;
  const origHome = process.env.HOME;
  process.env.USERPROFILE = dir;
  process.env.HOME = dir;
  const resolved = homedir();
  return {
    dir,
    resolved,
    restore() {
      if (origUserprofile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = origUserprofile;
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function silence() {
  const origLog = console.log;
  const origErr = console.error;
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  console.log = () => {};
  console.error = () => {};
  process.stderr.write = () => true;
  process.stdout.write = () => true;
  return () => {
    console.log = origLog;
    console.error = origErr;
    process.stderr.write = origStderrWrite;
    process.stdout.write = origStdoutWrite;
  };
}

test('global install copies Throughline slash commands to ~/.claude/commands/', async () => {
  const home = makeTempHome();
  if (home.resolved !== home.dir) {
    home.restore();
    return;
  }
  const unsilence = silence();
  try {
    await run([]);
    const tl = join(home.dir, '.claude', 'commands', 'tl.md');
    const sc = join(home.dir, '.claude', 'commands', 'sc-detail.md');
    const trim = join(home.dir, '.claude', 'commands', 'tl-trim.md');
    assert.ok(existsSync(tl), 'tl.md should be installed globally');
    assert.ok(existsSync(sc), 'sc-detail.md should be installed globally');
    assert.ok(!existsSync(trim), 'tl-trim.md should NOT be installed (deprecated in v0.4.0)');
    const tlBody = readFileSync(tl, 'utf8');
    assert.match(tlBody, /Throughline/, 'tl.md content should be real');
    const settings = JSON.parse(readFileSync(join(home.dir, '.claude', 'settings.json'), 'utf8'));
    assert.ok(settings.hooks?.UserPromptSubmit, 'UserPromptSubmit hook should be registered');
    const grokHooks = JSON.parse(readFileSync(join(home.dir, '.grok', 'hooks', 'throughline.json'), 'utf8'));
    assert.ok(grokHooks.hooks?.SessionStart, 'Grok SessionStart hook should be registered');
    assert.ok(grokHooks.hooks?.UserPromptSubmit, 'Grok UserPromptSubmit hook should be registered');
    assert.ok(grokHooks.hooks?.Stop, 'Grok Stop hook should be registered');
    const grokCommands = [
      grokHooks.hooks.SessionStart[0].hooks[0].command,
      grokHooks.hooks.UserPromptSubmit[0].hooks[0].command,
      grokHooks.hooks.Stop[0].hooks[0].command,
    ];
    assert.deepEqual(grokCommands, [
      buildGrokHookCommand('session-start'),
      buildGrokHookCommand('prompt-submit'),
      buildGrokHookCommand('process-turn'),
    ]);
    for (const command of grokCommands) {
      assert.match(command, /throughline\.mjs/);
      assert.doesNotMatch(command, /^throughline /);
    }
    const cursorHooks = JSON.parse(readFileSync(join(home.dir, '.cursor', 'hooks.json'), 'utf8'));
    assert.equal(cursorHooks.version, 1);
    assert.equal(
      cursorHooks.hooks.sessionStart[0].command,
      createCursorHookEntries().sessionStart[0].command,
    );
    assert.equal(
      cursorHooks.hooks.beforeSubmitPrompt[0].command,
      createCursorHookEntries().beforeSubmitPrompt[0].command,
    );
    assert.equal(
      cursorHooks.hooks.stop[0].command,
      createCursorHookEntries().stop[0].command,
    );
    for (const command of [
      cursorHooks.hooks.sessionStart[0].command,
      cursorHooks.hooks.beforeSubmitPrompt[0].command,
      cursorHooks.hooks.stop[0].command,
    ]) {
      assert.equal(isThroughlineCursorHookCommand(command), true);
      assert.doesNotMatch(command, /^throughline /);
    }
  } finally {
    unsilence();
    home.restore();
  }
});

test('project install copies commands to cwd/.claude/commands/', async () => {
  const home = makeTempHome();
  if (home.resolved !== home.dir) {
    home.restore();
    return;
  }
  const projectDir = mkdtempSync(join(tmpdir(), 'tl-install-proj-'));
  const origCwd = process.cwd();
  process.chdir(projectDir);
  const unsilence = silence();
  try {
    await run(['--project']);
    const tl = join(projectDir, '.claude', 'commands', 'tl.md');
    assert.ok(existsSync(tl), 'tl.md should be installed in project');
    const globalTl = join(home.dir, '.claude', 'commands', 'tl.md');
    assert.ok(!existsSync(globalTl), '--project should NOT touch global dir');
    assert.ok(!existsSync(join(home.dir, '.codex', 'hooks.json')), '--project should NOT touch global Codex hooks');
    assert.ok(!existsSync(join(home.dir, '.codex', 'skills', 'throughline')), '--project should NOT touch global Codex skills');
  } finally {
    unsilence();
    process.chdir(origCwd);
    home.restore();
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test('global install registers Codex session hooks and enables hooks features', async () => {
  const home = makeTempHome();
  if (home.resolved !== home.dir) {
    home.restore();
    return;
  }
  const unsilence = silence();
  try {
    await run([]);
    const hooks = JSON.parse(readFileSync(join(home.dir, '.codex', 'hooks.json'), 'utf8'));
    const expectedStopCommand = buildCodexStopHookCommand();
    const expectedPromptCommand = buildCodexUserPromptSubmitHookCommand();
    const expectedPostToolUseCommand = buildCodexPostToolUseHookCommand();
    const codexHook = hooks.hooks.Stop
      .flatMap(g => g.hooks ?? [])
      .find(h => h.command === expectedStopCommand);
    assert.ok(codexHook, 'Codex Stop should have absolute throughline.mjs codex-hook stop');
    assert.equal(codexHook.async, false, 'Codex Stop hook should be synchronous for Codex');
    assert.equal(codexHook.timeout, 300, 'Codex Stop hook should allow summarizer time');
    const promptHook = hooks.hooks.UserPromptSubmit
      .flatMap(g => g.hooks ?? [])
      .find(h => h.command === expectedPromptCommand);
    assert.ok(promptHook, 'Codex UserPromptSubmit should have absolute throughline.mjs codex-hook user-prompt-submit');
    assert.equal(promptHook.async, false, 'Codex UserPromptSubmit hook should be synchronous for capture/monitor state');
    assert.equal(promptHook.timeout, 30, 'Codex UserPromptSubmit hook should be short');
    const postToolUseHook = hooks.hooks.PostToolUse
      .flatMap(g => g.hooks ?? [])
      .find(h => h.command === expectedPostToolUseCommand);
    assert.ok(postToolUseHook, 'Codex PostToolUse should have absolute throughline.mjs codex-hook post-tool-use');
    assert.equal(postToolUseHook.async, false, 'Codex PostToolUse hook should be synchronous for capture/monitor state');
    assert.equal(postToolUseHook.timeout, 30, 'Codex PostToolUse hook should be short');
    const managedHooks = [codexHook, promptHook, postToolUseHook];
    assert.doesNotMatch(JSON.stringify(managedHooks), /timeoutSec/);
    const config = readFileSync(join(home.dir, '.codex', 'config.toml'), 'utf8');
    assert.equal(config, '[features]\nhooks = true\n');
  } finally {
    unsilence();
    home.restore();
  }
});

test('Grok hook commands are absolute node + throughline.mjs on every platform', () => {
  const options = {
    nodePath: String.raw`C:\Program Files\nodejs\node.exe`,
    cliScriptPath: String.raw`C:\Users\Kite\App Data\Roaming\npm\node_modules\throughline\bin\throughline.mjs`,
    platform: 'win32',
  };
  // Grok on Windows runs hook commands through PowerShell; a leading quoted path
  // followed by arguments is a ParserError without the call operator.
  assert.equal(
    buildGrokHookCommand('session-start', options),
    String.raw`& "C:\Program Files\nodejs\node.exe" "C:\Users\Kite\App Data\Roaming\npm\node_modules\throughline\bin\throughline.mjs" session-start`,
  );
  assert.equal(
    buildGrokHookCommand('process-turn', {
      nodePath: '/opt/homebrew/bin/node',
      cliScriptPath: '/Users/kite/Developer/Throughline/bin/throughline.mjs',
      platform: 'darwin',
    }),
    '/opt/homebrew/bin/node /Users/kite/Developer/Throughline/bin/throughline.mjs process-turn',
  );
  const winFile = createGrokHooksFile(options);
  for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
    assert.equal(winFile.hooks[event][0].hooks[0].command.startsWith('& "C:'), true);
  }
  assert.equal(buildCursorHookCommand('session-start', options).startsWith('& '), false);
  const file = createGrokHooksFile({
    nodePath: '/usr/bin/node',
    cliScriptPath: '/pkg/bin/throughline.mjs',
    platform: 'linux',
  });
  assert.equal(file.hooks.SessionStart[0].hooks[0].command, '/usr/bin/node /pkg/bin/throughline.mjs session-start');
  assert.equal(file.hooks.UserPromptSubmit[0].hooks[0].command, '/usr/bin/node /pkg/bin/throughline.mjs prompt-submit');
  assert.equal(file.hooks.Stop[0].hooks[0].command, '/usr/bin/node /pkg/bin/throughline.mjs process-turn');
  assert.equal(file.hooks.Stop[0].hooks[0].async, true);
});

test('Cursor install upserts product hooks and keeps factory commands', async () => {
  const home = makeTempHome();
  if (home.resolved !== home.dir) {
    home.restore();
    return;
  }
  const unsilence = silence();
  try {
    mkdirSync(join(home.dir, '.cursor'), { recursive: true });
    writeFileSync(join(home.dir, '.cursor', 'hooks.json'), `${JSON.stringify({
      version: 1,
      hooks: {
        sessionStart: [{ command: '/tmp/cursor-todo-gate-hook session-start', timeout: 10 }],
      },
    }, null, 2)}\n`);
    await run([]);
    const installed = JSON.parse(readFileSync(join(home.dir, '.cursor', 'hooks.json'), 'utf8'));
    assert.equal(installed.hooks.sessionStart[0].command, '/tmp/cursor-todo-gate-hook session-start');
    assert.equal(isThroughlineCursorHookCommand(installed.hooks.sessionStart[1].command), true);
    assert.equal(isThroughlineCursorHookCommand(installed.hooks.beforeSubmitPrompt[0].command), true);
    assert.equal(isThroughlineCursorHookCommand(installed.hooks.stop[0].command), true);
    await run(['--uninstall']);
    const after = JSON.parse(readFileSync(join(home.dir, '.cursor', 'hooks.json'), 'utf8'));
    assert.equal(after.hooks.sessionStart.length, 1);
    assert.equal(after.hooks.sessionStart[0].command, '/tmp/cursor-todo-gate-hook session-start');
    assert.equal(after.hooks.beforeSubmitPrompt, undefined);
    assert.equal(after.hooks.stop, undefined);
  } finally {
    unsilence();
    home.restore();
  }
});

test('Codex hook builders use the PowerShell call operator on Windows only', () => {
  const options = {
    nodePath: String.raw`C:\Program Files\nodejs\node.exe`,
    cliScriptPath: String.raw`C:\Users\Kite\App Data\Roaming\npm\node_modules\throughline\bin\throughline.mjs`,
  };
  assert.equal(
    buildCodexStopHookCommand({ ...options, platform: 'win32' }),
    String.raw`& "C:\Program Files\nodejs\node.exe" "C:\Users\Kite\App Data\Roaming\npm\node_modules\throughline\bin\throughline.mjs" codex-hook stop`,
  );
  assert.equal(
    buildCodexUserPromptSubmitHookCommand({ ...options, platform: 'win32' }),
    String.raw`& "C:\Program Files\nodejs\node.exe" "C:\Users\Kite\App Data\Roaming\npm\node_modules\throughline\bin\throughline.mjs" codex-hook user-prompt-submit`,
  );
  assert.equal(
    buildCodexPostToolUseHookCommand({ ...options, platform: 'win32' }),
    String.raw`& "C:\Program Files\nodejs\node.exe" "C:\Users\Kite\App Data\Roaming\npm\node_modules\throughline\bin\throughline.mjs" codex-hook post-tool-use`,
  );
  assert.equal(buildCodexStopHookCommand({ ...options, platform: 'linux' }).startsWith('& '), false);
  assert.equal(isThroughlineCodexHookCommand(buildCodexStopHookCommand({ ...options, platform: 'win32' })), true);
});

test('global install copies Throughline Codex skill to ~/.codex/skills/', async () => {
  const home = makeTempHome();
  if (home.resolved !== home.dir) {
    home.restore();
    return;
  }
  const unsilence = silence();
  try {
    await run([]);
    const skill = join(home.dir, '.codex', 'skills', 'throughline', 'SKILL.md');
    const metadata = join(home.dir, '.codex', 'skills', 'throughline', 'agents', 'openai.yaml');
    assert.ok(existsSync(skill), 'Throughline Codex skill should be installed globally');
    assert.ok(existsSync(metadata), 'Throughline Codex skill UI metadata should be installed globally');
    const skillBody = readFileSync(skill, 'utf8');
    const metadataBody = readFileSync(metadata, 'utf8');
    assert.match(skillBody, /name: throughline/);
    assert.match(skillBody, /Bare "\$throughline"/);
    assert.match(skillBody, /throughline codex-handoff-start --execute/);
    assert.match(skillBody, /--open-host desktop/);
    assert.match(skillBody, /--open-host vscode/);
    assert.match(skillBody, /--open-host cli/);
    assert.match(skillBody, /not from[\s\S]*persistent PTY/);
    assert.match(skillBody, /do not run doctor \/ dry-run \/ preflight first/);
    assert.match(metadataBody, /start a new Codex thread with Throughline handoff memory/);
    assert.doesNotMatch(metadataBody, /scripted current-thread rollback/);
    assert.doesNotMatch(metadataBody, /preview blocked Codex trim/);
    assert.doesNotMatch(metadataBody, /inspect guarded Codex trim/);
  } finally {
    unsilence();
    home.restore();
  }
});

test('global install provisions VSCode monitor task for the current project when running under VSCode', async () => {
  const home = makeTempHome();
  if (home.resolved !== home.dir) {
    home.restore();
    return;
  }
  const projectDir = mkdtempSync(join(tmpdir(), 'tl-install-monitor-'));
  const origCwd = process.cwd();
  const origVscodePid = process.env.VSCODE_PID;
  process.chdir(projectDir);
  process.env.VSCODE_PID = '12345';
  const unsilence = silence();
  try {
    await run([]);
    const tasksPath = join(projectDir, '.vscode', 'tasks.json');
    assert.ok(existsSync(tasksPath), 'install should create current-project VSCode tasks.json');
    const tasks = JSON.parse(readFileSync(tasksPath, 'utf8'));
    const task = tasks.tasks.find((t) => t.label === 'Throughline Monitor');
    assert.ok(task, 'Throughline Monitor task should be present');
    assert.deepEqual(task.args.slice(1), ['monitor']);
    assert.deepEqual(task.runOptions, { runOn: 'folderOpen' });
  } finally {
    unsilence();
    if (origVscodePid === undefined) delete process.env.VSCODE_PID;
    else process.env.VSCODE_PID = origVscodePid;
    process.chdir(origCwd);
    home.restore();
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test('global install preserves existing Codex hooks and is idempotent', async () => {
  const home = makeTempHome();
  if (home.resolved !== home.dir) {
    home.restore();
    return;
  }
  mkdirSync(join(home.dir, '.codex'), { recursive: true });
  writeFileSync(
    join(home.dir, '.codex', 'hooks.json'),
    JSON.stringify(
      {
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: 'command',
                  command: '/usr/bin/node /home/kite/.npm-global/bin/caveat codex-hook stop',
                  timeout: 5,
                  async: false,
                  statusMessage: null,
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    ) + '\n',
  );
  writeFileSync(join(home.dir, '.codex', 'config.toml'), '[features]\nother = true\n');
  const unsilence = silence();
  try {
    await run([]);
    await run([]);
    const hooks = JSON.parse(readFileSync(join(home.dir, '.codex', 'hooks.json'), 'utf8'));
    const stopCommands = hooks.hooks.Stop.flatMap(g => g.hooks ?? []).map(h => h.command);
    const promptCommands = hooks.hooks.UserPromptSubmit.flatMap(g => g.hooks ?? []).map(h => h.command);
    const postToolUseCommands = hooks.hooks.PostToolUse.flatMap(g => g.hooks ?? []).map(h => h.command);
    const expectedStopCommand = buildCodexStopHookCommand();
    const expectedPromptCommand = buildCodexUserPromptSubmitHookCommand();
    const expectedPostToolUseCommand = buildCodexPostToolUseHookCommand();
    assert.ok(stopCommands.includes('/usr/bin/node /home/kite/.npm-global/bin/caveat codex-hook stop'));
    assert.equal(stopCommands.filter(c => c === expectedStopCommand).length, 1);
    assert.equal(promptCommands.filter(c => c === expectedPromptCommand).length, 1);
    assert.equal(postToolUseCommands.filter(c => c === expectedPostToolUseCommand).length, 1);
    assert.ok(!stopCommands.includes('throughline codex-hook stop'));
    assert.ok(!promptCommands.includes('throughline codex-hook user-prompt-submit'));
    assert.ok(!postToolUseCommands.includes('throughline codex-hook post-tool-use'));
    const config = readFileSync(join(home.dir, '.codex', 'config.toml'), 'utf8');
    assert.equal(config, '[features]\nother = true\nhooks = true\n');
  } finally {
    unsilence();
    home.restore();
  }
});

test('global install moves the deprecated codex_hooks flag to hooks', async () => {
  const cases = [
    {
      name: '旧名と現行名の両方がある（旧版の install が空行の後ろへ足した形）',
      before: [
        'model = "gpt-5"',
        '',
        '[features]',
        'hooks = true',
        'other = true',
        '',
        'codex_hooks = true',
        '[hooks.state]',
        '',
        '[other]',
        'codex_hooks = true',
        '',
      ].join('\n'),
      after: [
        'model = "gpt-5"',
        '',
        '[features]',
        'hooks = true',
        'other = true',
        '',
        '[hooks.state]',
        '',
        '[other]',
        'codex_hooks = true',
        '',
      ].join('\n'),
    },
    {
      name: '旧名だけが false で残っている',
      before: '[features]\ncodex_hooks = false # legacy\nother = true\n\n[tools]\nweb = true\n',
      after: '[features]\nother = true\nhooks = true\n\n[tools]\nweb = true\n',
    },
  ];

  for (const { name, before, after } of cases) {
    const home = makeTempHome();
    mkdirSync(join(home.dir, '.codex'), { recursive: true });
    writeFileSync(join(home.dir, '.codex', 'config.toml'), before);
    const unsilence = silence();
    try {
      await run([]);
      await run([]);
      assert.equal(readFileSync(join(home.dir, '.codex', 'config.toml'), 'utf8'), after, name);
    } finally {
      unsilence();
      home.restore();
    }
  }
});

test('global install replaces legacy timeoutSec Throughline Codex hook shapes', async () => {
  const home = makeTempHome();
  if (home.resolved !== home.dir) {
    home.restore();
    return;
  }
  mkdirSync(join(home.dir, '.codex'), { recursive: true });
  writeFileSync(
    join(home.dir, '.codex', 'hooks.json'),
    JSON.stringify(
      {
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: 'command',
                  command: 'throughline codex-hook user-prompt-submit',
                  timeoutSec: 300,
                  async: true,
                  statusMessage: null,
                },
              ],
            },
          ],
          PostToolUse: [
            {
              hooks: [
                {
                  type: 'command',
                  command: 'throughline codex-hook post-tool-use',
                  timeoutSec: 300,
                  async: true,
                  statusMessage: null,
                },
              ],
            },
          ],
          Stop: [
            {
              hooks: [
                {
                  type: 'command',
                  command: 'throughline codex-hook stop',
                  timeoutSec: 300,
                  async: true,
                  statusMessage: null,
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    ) + '\n',
  );
  const unsilence = silence();
  try {
    await run([]);
    const hooks = JSON.parse(readFileSync(join(home.dir, '.codex', 'hooks.json'), 'utf8'));
    const expectedStopCommand = buildCodexStopHookCommand();
    const expectedPromptCommand = buildCodexUserPromptSubmitHookCommand();
    const expectedPostToolUseCommand = buildCodexPostToolUseHookCommand();
    const codexHooks = hooks.hooks.Stop
      .flatMap(g => g.hooks ?? [])
      .filter(h => h.command === expectedStopCommand);
    assert.equal(codexHooks.length, 1);
    assert.equal(codexHooks[0].async, false);
    assert.equal(codexHooks[0].timeout, 300);
    assert.equal(Object.hasOwn(codexHooks[0], 'timeoutSec'), false);
    const promptHooks = hooks.hooks.UserPromptSubmit
      .flatMap(g => g.hooks ?? [])
      .filter(h => h.command === expectedPromptCommand);
    assert.equal(promptHooks.length, 1);
    assert.equal(promptHooks[0].async, false);
    assert.equal(promptHooks[0].timeout, 30);
    assert.equal(Object.hasOwn(promptHooks[0], 'timeoutSec'), false);
    const postToolUseHooks = hooks.hooks.PostToolUse
      .flatMap(g => g.hooks ?? [])
      .filter(h => h.command === expectedPostToolUseCommand);
    assert.equal(postToolUseHooks.length, 1);
    assert.equal(postToolUseHooks[0].async, false);
    assert.equal(postToolUseHooks[0].timeout, 30);
    assert.equal(Object.hasOwn(postToolUseHooks[0], 'timeoutSec'), false);
    assert.equal(
      hooks.hooks.Stop.flatMap(g => g.hooks ?? []).filter(h => h.command === 'throughline codex-hook stop').length,
      0,
    );
    assert.equal(
      hooks.hooks.UserPromptSubmit.flatMap(g => g.hooks ?? []).filter(h => h.command === 'throughline codex-hook user-prompt-submit').length,
      0,
    );
    assert.equal(
      hooks.hooks.PostToolUse.flatMap(g => g.hooks ?? []).filter(h => h.command === 'throughline codex-hook post-tool-use').length,
      0,
    );
  } finally {
    unsilence();
    home.restore();
  }
});

test('uninstall removes slash command files', async () => {
  const home = makeTempHome();
  if (home.resolved !== home.dir) {
    home.restore();
    return;
  }
  const unsilence = silence();
  try {
    await run([]);
    const tl = join(home.dir, '.claude', 'commands', 'tl.md');
    assert.ok(existsSync(tl), 'install should have placed tl.md');
    await run(['--uninstall']);
    assert.ok(!existsSync(tl), 'uninstall should remove tl.md');
    const sc = join(home.dir, '.claude', 'commands', 'sc-detail.md');
    assert.ok(!existsSync(sc), 'uninstall should remove sc-detail.md');
    const codexSkill = join(home.dir, '.codex', 'skills', 'throughline', 'SKILL.md');
    assert.ok(!existsSync(codexSkill), 'uninstall should remove Throughline Codex skill');
  } finally {
    unsilence();
    home.restore();
  }
});

test('global uninstall removes only Throughline-managed Codex hook', async () => {
  const home = makeTempHome();
  if (home.resolved !== home.dir) {
    home.restore();
    return;
  }
  const unsilence = silence();
  try {
    await run([]);
    const hooksPath = join(home.dir, '.codex', 'hooks.json');
    const hooks = JSON.parse(readFileSync(hooksPath, 'utf8'));
    hooks.hooks.Stop.push({
      hooks: [
        {
          type: 'command',
          command: '/usr/bin/node /home/kite/.npm-global/bin/caveat codex-hook stop',
          timeout: 5,
          async: false,
          statusMessage: null,
        },
      ],
    });
    writeFileSync(hooksPath, JSON.stringify(hooks, null, 2) + '\n');

    await run(['--uninstall']);
    const after = JSON.parse(readFileSync(hooksPath, 'utf8'));
    const stopCommands = after.hooks.Stop.flatMap(g => g.hooks ?? []).map(h => h.command);
    const promptCommands = after.hooks.UserPromptSubmit?.flatMap(g => g.hooks ?? []).map(h => h.command) ?? [];
    const postToolUseCommands = after.hooks.PostToolUse?.flatMap(g => g.hooks ?? []).map(h => h.command) ?? [];
    assert.ok(stopCommands.includes('/usr/bin/node /home/kite/.npm-global/bin/caveat codex-hook stop'));
    assert.ok(!stopCommands.includes('throughline codex-hook stop'));
    assert.ok(!stopCommands.some(c => c.includes('throughline.mjs codex-hook stop')));
    assert.ok(!promptCommands.includes('throughline codex-hook user-prompt-submit'));
    assert.ok(!promptCommands.some(c => c.includes('throughline.mjs codex-hook user-prompt-submit')));
    assert.ok(!postToolUseCommands.includes('throughline codex-hook post-tool-use'));
    assert.ok(!postToolUseCommands.some(c => c.includes('throughline.mjs codex-hook post-tool-use')));
  } finally {
    unsilence();
    home.restore();
  }
});

test('uninstall preserves unrelated slash commands in the same dir', async () => {
  const home = makeTempHome();
  if (home.resolved !== home.dir) {
    home.restore();
    return;
  }
  const unsilence = silence();
  try {
    await run([]);
    const otherCmd = join(home.dir, '.claude', 'commands', 'unrelated.md');
    writeFileSync(otherCmd, '# unrelated slash command\n');
    await run(['--uninstall']);
    assert.ok(existsSync(otherCmd), 'uninstall must not touch unrelated files');
  } finally {
    unsilence();
    home.restore();
  }
});

test('Claude Stop hook is registered with async:true so it does not block ターン完了 UX', async () => {
  const home = makeTempHome();
  if (home.resolved !== home.dir) {
    home.restore();
    return;
  }
  const unsilence = silence();
  try {
    await run([]);
    const settings = JSON.parse(readFileSync(join(home.dir, '.claude', 'settings.json'), 'utf8'));
    const processTurnHook = settings.hooks.Stop
      .flatMap(g => g.hooks ?? [])
      .find(h => h.command === 'throughline process-turn');
    assert.ok(processTurnHook, 'Stop should have throughline process-turn');
    assert.equal(processTurnHook.async, true, 'Stop hook must be async to avoid blocking ターン完了');
    const sessionStartHook = settings.hooks.SessionStart
      .flatMap(g => g.hooks ?? [])
      .find(h => h.command === 'throughline session-start');
    assert.notEqual(sessionStartHook.async, true, 'SessionStart stays synchronous (needs to inject context before turn)');
    const promptSubmitHook = settings.hooks.UserPromptSubmit
      .flatMap(g => g.hooks ?? [])
      .find(h => h.command === 'throughline prompt-submit');
    assert.notEqual(promptSubmitHook.async, true, 'UserPromptSubmit stays synchronous (needs baton write committed before turn)');
    // 自動継続の印 (ADR 0032)。matcher 無し = 手動の /compact でも呼ばれて古い印を消す。
    assert.deepEqual(settings.hooks.PreCompact, [{ hooks: [{ type: 'command', command: 'throughline pre-compact' }] }]);

    await run(['--uninstall']);
    const removed = JSON.parse(readFileSync(join(home.dir, '.claude', 'settings.json'), 'utf8'));
    assert.equal(removed.hooks, undefined, 'uninstall removes every Throughline Claude hook including PreCompact');
  } finally {
    unsilence();
    home.restore();
  }
});

// --- resolveThroughlineOnPath (地雷 1: PATH 解決チェック) ---

test('resolveThroughlineOnPath: returns null when PATH is empty', () => {
  assert.equal(resolveThroughlineOnPath({ PATH: '' }), null);
  assert.equal(resolveThroughlineOnPath({}), null);
});

test('resolveThroughlineOnPath: returns null when not in any PATH directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-path-empty-'));
  try {
    assert.equal(resolveThroughlineOnPath({ PATH: dir }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveThroughlineOnPath: finds throughline binary in PATH directory', () => {
  // Windows は PATHEXT 経由でしか見つからないので分岐
  const dir = mkdtempSync(join(tmpdir(), 'tl-path-found-'));
  try {
    if (process.platform === 'win32') {
      // PATHEXT は通常大文字 (.EXE;.CMD;.BAT) だが、resolveThroughlineOnPath が
      // 返すパスはその ext をそのまま join するため、書き込んだ実ファイル名 (小文字)
      // と厳密一致するよう小文字を渡す。Windows FS は case-insensitive で
      // existsSync は通る。
      const binPath = join(dir, 'throughline.cmd');
      writeFileSync(binPath, '@echo off\n');
      const result = resolveThroughlineOnPath({
        PATH: dir,
        PATHEXT: '.cmd',
      });
      assert.equal(result, binPath);
    } else {
      const binPath = join(dir, 'throughline');
      writeFileSync(binPath, '#!/bin/sh\n');
      const result = resolveThroughlineOnPath({ PATH: dir });
      assert.equal(result, binPath);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveCodexHookNodePath: prefers a stable PATH node symlink when it resolves to current Node', () => {
  const stableNode = join('/opt/homebrew/bin', process.platform === 'win32' ? 'node.exe' : 'node');
  const cellarNode = join('/opt/homebrew/Cellar/node/26.0.0/bin', process.platform === 'win32' ? 'node.exe' : 'node');
  const realNode = join('/opt/homebrew/Cellar/node/26.0.0/bin', process.platform === 'win32' ? 'node.exe' : 'node');
  const result = resolveCodexHookNodePath({
    env: { PATH: '/opt/homebrew/bin' },
    execPath: cellarNode,
    exists: (p) => p === stableNode,
    realpath: (p) => {
      if (p === stableNode || p === cellarNode) return realNode;
      throw new Error(`unexpected path: ${p}`);
    },
  });
  assert.equal(result, stableNode);
});

test('resolveCodexHookNodePath: falls back to process execPath when PATH node is different', () => {
  const pathNode = join('/usr/local/bin', process.platform === 'win32' ? 'node.exe' : 'node');
  const execPath = join('/opt/homebrew/Cellar/node/26.0.0/bin', process.platform === 'win32' ? 'node.exe' : 'node');
  const result = resolveCodexHookNodePath({
    env: { PATH: '/usr/local/bin' },
    execPath,
    exists: (p) => p === pathNode,
    realpath: (p) => {
      if (p === pathNode) return '/different/node';
      if (p === execPath) return '/current/node';
      throw new Error(`unexpected path: ${p}`);
    },
  });
  assert.equal(result, execPath);
});

test('parseCodexHookCommand: 絶対パス型を分解し、旧 PATH 解決型と別コマンドは null', () => {
  assert.deepEqual(
    parseCodexHookCommand('/opt/homebrew/bin/node /pkg/bin/throughline.mjs codex-hook stop'),
    { nodePath: '/opt/homebrew/bin/node', scriptPath: '/pkg/bin/throughline.mjs', event: 'stop' },
  );
  assert.deepEqual(
    parseCodexHookCommand('& "C:\\node.exe" "C:\\pkg\\bin\\throughline.mjs" codex-hook post-tool-use'),
    { nodePath: 'C:\\node.exe', scriptPath: 'C:\\pkg\\bin\\throughline.mjs', event: 'post-tool-use' },
  );
  assert.equal(parseCodexHookCommand('throughline codex-hook stop'), null);
  assert.equal(parseCodexHookCommand('/bin/node /pkg/bin/throughline.mjs codex-hook rewind'), null);
  assert.equal(parseCodexHookCommand('/bin/node /pkg/bin/other.mjs codex-hook stop'), null);
});

test('isEquivalentCodexHookCommand: 同一 node 実体を指す別表記を legacy と誤判定しない', () => {
  // launchd の最小 PATH から診断すると expected 側だけ Cellar 実体表記になる。
  const registered = '/opt/homebrew/bin/node /pkg/bin/throughline.mjs codex-hook user-prompt-submit';
  const expected = '/opt/homebrew/Cellar/node/26.5.0/bin/node /pkg/bin/throughline.mjs codex-hook user-prompt-submit';
  const realpath = (p) => (p.endsWith('node') ? '/real/node' : p);
  assert.equal(isEquivalentCodexHookCommand(registered, expected, { realpath }), true);
});

test('isEquivalentCodexHookCommand: 別 install / 別 event / 旧形式は同一とみなさない', () => {
  const realpath = (p) => p;
  assert.equal(
    isEquivalentCodexHookCommand(
      '/bin/node /old/bin/throughline.mjs codex-hook stop',
      '/bin/node /new/bin/throughline.mjs codex-hook stop',
      { realpath },
    ),
    false,
  );
  assert.equal(
    isEquivalentCodexHookCommand(
      '/bin/node /pkg/bin/throughline.mjs codex-hook stop',
      '/bin/node /pkg/bin/throughline.mjs codex-hook post-tool-use',
      { realpath },
    ),
    false,
  );
  assert.equal(
    isEquivalentCodexHookCommand(
      'throughline codex-hook stop',
      '/bin/node /pkg/bin/throughline.mjs codex-hook stop',
      { realpath },
    ),
    false,
  );
  // realpath を解決できない時は同一とみなさない（暗黙の緩和をしない）
  assert.equal(
    isEquivalentCodexHookCommand(
      '/a/node /pkg/bin/throughline.mjs codex-hook stop',
      '/b/node /pkg/bin/throughline.mjs codex-hook stop',
      { realpath: (p) => { throw new Error(`missing: ${p}`); } },
    ),
    false,
  );
});

test('install is idempotent: second run keeps exactly one tl.md and one hook entry', async () => {
  const home = makeTempHome();
  if (home.resolved !== home.dir) {
    home.restore();
    return;
  }
  const unsilence = silence();
  try {
    await run([]);
    await run([]);
    const tl = join(home.dir, '.claude', 'commands', 'tl.md');
    assert.ok(existsSync(tl));
    const settings = JSON.parse(readFileSync(join(home.dir, '.claude', 'settings.json'), 'utf8'));
    const stopGroups = settings.hooks.Stop;
    const processTurnCount = stopGroups
      .flatMap(g => g.hooks ?? [])
      .filter(h => h.command === 'throughline process-turn')
      .length;
    assert.equal(processTurnCount, 1, 'double-install must not duplicate hook entries');
  } finally {
    unsilence();
    home.restore();
  }
});
