import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { readCompletedTurnReceiptSnapshot } from './completed-turn-receipts.mjs';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function makeTempHome() {
  return mkdtempSync(join(tmpdir(), 'tl-hooks-home-'));
}

function makeTempProject() {
  return mkdtempSync(join(tmpdir(), 'tl-hooks-project-'));
}

function childEnv(home) {
  // 設定とstateの置き場も一時HOMEへ向ける。親のXDG_*やLOCALAPPDATAを引き継ぐと、
  // 失敗したhookが本物のruntime error storeへ記録し、完了受領も本物のstateへ書かれる。
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    THROUGHLINE_NO_VSCODE: '1',
  };
}

function runNode(args, { home, cwd = REPO_ROOT, input = '', env = {} }) {
  return spawnSync(process.execPath, args, {
    cwd,
    env: { ...childEnv(home), ...env },
    input,
    encoding: 'utf8',
  });
}

function openDb(home) {
  return new DatabaseSync(join(home, '.throughline', 'throughline.db'));
}

test('hook modules can be imported without executing their hook body', () => {
  const home = makeTempHome();
  try {
    const result = runNode(
      [
        '--input-type=module',
        '-e',
        [
          "await import('./src/prompt-submit.mjs');",
          "await import('./src/session-start.mjs');",
          "await import('./src/turn-processor.mjs');",
        ].join('\n'),
      ],
      { home },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      existsSync(join(home, '.throughline')),
      false,
      'importing hook modules should not create the real hook DB or state dir',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('Grok camelCase envelopes register a grok: session instead of no-op', () => {
  const home = makeTempHome();
  const project = makeTempProject();
  const sessionId = '01a00aa2-50f8-7791-86fd-df2d27cf003e';
  const common = {
    sessionId,
    cwd: project,
    workspaceRoot: project,
    timestamp: '2026-08-17T00:00:00Z',
    permissionMode: 'default',
  };

  try {
    const start = runNode([join(REPO_ROOT, 'src/session-start.mjs')], {
      home,
      cwd: project,
      input: JSON.stringify({ ...common, hookEventName: 'session_start', source: 'startup' }),
    });
    assert.equal(start.status, 0, start.stderr);

    const prompt = runNode([join(REPO_ROOT, 'src/prompt-submit.mjs')], {
      home,
      cwd: project,
      input: JSON.stringify({ ...common, hookEventName: 'user_prompt_submit', prompt: 'hello grok' }),
    });
    assert.equal(prompt.status, 0, prompt.stderr);

    const historyDir = join(home, '.grok', 'sessions', encodeURIComponent(project), sessionId);
    mkdirSync(historyDir, { recursive: true });
    writeFileSync(
      join(historyDir, 'chat_history.jsonl'),
      [
        JSON.stringify({ type: 'user', content: [{ type: 'text', text: 'hello grok' }] }),
        JSON.stringify({ type: 'assistant', content: 'captured reply' }),
      ].join('\n'),
    );
    const stop = runNode([join(REPO_ROOT, 'src/turn-processor.mjs')], {
      home,
      cwd: project,
      input: JSON.stringify({
        ...common,
        hookEventName: 'stop',
        lastAssistantMessage: 'captured reply',
      }),
    });
    assert.equal(stop.status, 0, stop.stderr);

    const db = openDb(home);
    const row = db.prepare('SELECT session_id, project_path FROM sessions').get();
    assert.equal(row.session_id, `grok:${sessionId}`);
    assert.equal(row.project_path, project);
    const bodies = db.prepare('SELECT role, text FROM bodies ORDER BY role').all();
    assert.deepEqual(
      bodies.map((b) => ({ role: b.role, text: b.text })),
      [
        { role: 'assistant', text: 'captured reply' },
        { role: 'user', text: 'hello grok' },
      ],
    );
    db.close();
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('Grok Stop with updates.jsonl transcriptPath still captures L2 from chat_history', () => {
  const home = makeTempHome();
  const project = makeTempProject();
  const sessionId = '01a00b38-87ea-7670-8f7d-a9fe937263c5';
  const common = {
    sessionId,
    cwd: project,
    workspaceRoot: project,
    timestamp: '2026-08-17T00:00:00Z',
    permissionMode: 'default',
  };

  try {
    const start = runNode([join(REPO_ROOT, 'src/session-start.mjs')], {
      home,
      cwd: project,
      input: JSON.stringify({ ...common, hookEventName: 'session_start', source: 'startup' }),
    });
    assert.equal(start.status, 0, start.stderr);

    const historyDir = join(home, '.grok', 'sessions', encodeURIComponent(project), sessionId);
    mkdirSync(historyDir, { recursive: true });
    writeFileSync(
      join(historyDir, 'updates.jsonl'),
      JSON.stringify({
        method: '_x.ai/session/update',
        params: { update: { sessionUpdate: 'hook_execution', event_name: 'stop' } },
      }) + '\n',
    );
    writeFileSync(
      join(historyDir, 'chat_history.jsonl'),
      [
        JSON.stringify({ type: 'user', content: [{ type: 'text', text: 'hello grok' }] }),
        JSON.stringify({ type: 'assistant', content: 'captured reply' }),
      ].join('\n'),
    );
    const stop = runNode([join(REPO_ROOT, 'src/turn-processor.mjs')], {
      home,
      cwd: project,
      input: JSON.stringify({
        ...common,
        hookEventName: 'stop',
        transcriptPath: join(historyDir, 'updates.jsonl'),
        lastAssistantMessage: 'captured reply',
      }),
    });
    assert.equal(stop.status, 0, stop.stderr);

    const db = openDb(home);
    const bodies = db.prepare('SELECT role, text FROM bodies ORDER BY role').all();
    assert.deepEqual(
      bodies.map((b) => ({ role: b.role, text: b.text })),
      [
        { role: 'assistant', text: 'captured reply' },
        { role: 'user', text: 'hello grok' },
      ],
    );
    db.close();
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('Grok wrapped /tl prompt writes a grok: baton', () => {
  const home = makeTempHome();
  const project = makeTempProject();
  const sessionId = '01a00b38-87ea-7670-8f7d-a9fe937263c5';
  try {
    const result = runNode([join(REPO_ROOT, 'src/prompt-submit.mjs')], {
      home,
      cwd: project,
      input: JSON.stringify({
        sessionId,
        cwd: project,
        hookEventName: 'user_prompt_submit',
        prompt:
          '<user_query>\n/tl\n</user_query>\n<skill_information>\nThroughline saved the baton.\n</skill_information>',
      }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /grok-continue exited/);

    const db = openDb(home);
    const row = db.prepare('SELECT project_path, session_id FROM handoff_batons').get();
    assert.equal(row.project_path, project);
    assert.equal(row.session_id, `grok:${sessionId}`);
    db.close();
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('Grok empty hook prompt still writes /tl baton from chat_history', () => {
  const home = makeTempHome();
  const project = makeTempProject();
  const sessionId = '01a00b38-87ea-7670-8f7d-a9fe937263c5';
  const historyDir = join(home, '.grok', 'sessions', encodeURIComponent(project), sessionId);
  mkdirSync(historyDir, { recursive: true });
  writeFileSync(
    join(historyDir, 'chat_history.jsonl'),
    JSON.stringify({
      type: 'user',
      content: [{ type: 'text', text: '<user_query>\n/tl\n</user_query>\n<skill_information>x</skill_information>' }],
    }) + '\n',
  );
  try {
    const result = runNode([join(REPO_ROOT, 'src/prompt-submit.mjs')], {
      home,
      cwd: project,
      input: JSON.stringify({
        sessionId,
        cwd: project,
        hookEventName: 'user_prompt_submit',
      }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /grok-continue exited/);

    const db = openDb(home);
    const row = db.prepare('SELECT session_id FROM handoff_batons').get();
    assert.equal(row.session_id, `grok:${sessionId}`);
    db.close();
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('prompt-submit subprocess writes a /tl baton into an isolated DB', () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    const result = runNode([join(REPO_ROOT, 'src/prompt-submit.mjs')], {
      home,
      cwd: project,
      input: JSON.stringify({
        session_id: 'old-session',
        cwd: project,
        prompt: '/tl',
      }),
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr.includes('grok-continue'), false);

    const db = openDb(home);
    const row = db.prepare('SELECT project_path, session_id FROM handoff_batons').get();
    assert.equal(row.project_path, project);
    assert.equal(row.session_id, 'old-session');
    db.close();
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('prompt-submit subprocess writes a /clear baton (specific session marker)', () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    const result = runNode([join(REPO_ROOT, 'src/prompt-submit.mjs')], {
      home,
      cwd: project,
      input: JSON.stringify({
        session_id: 'cleared-session',
        cwd: project,
        prompt: '/clear',
      }),
    });

    assert.equal(result.status, 0, result.stderr);

    const db = openDb(home);
    const row = db.prepare('SELECT project_path, session_id FROM handoff_batons').get();
    assert.equal(row.project_path, project);
    assert.equal(row.session_id, 'cleared-session');
    db.close();
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('prompt-submit: /clear baton overwrites previous /tl baton in same project', () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    const tl = runNode([join(REPO_ROOT, 'src/prompt-submit.mjs')], {
      home,
      cwd: project,
      input: JSON.stringify({ session_id: 'session-A', cwd: project, prompt: '/tl' }),
    });
    assert.equal(tl.status, 0, tl.stderr);

    const clear = runNode([join(REPO_ROOT, 'src/prompt-submit.mjs')], {
      home,
      cwd: project,
      input: JSON.stringify({ session_id: 'session-B', cwd: project, prompt: '/clear' }),
    });
    assert.equal(clear.status, 0, clear.stderr);

    const db = openDb(home);
    const row = db.prepare('SELECT session_id FROM handoff_batons').get();
    assert.equal(row.session_id, 'session-B', 'most recent baton write wins');
    db.close();
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('prompt-submit: non-baton prompt does not write any baton', () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    const result = runNode([join(REPO_ROOT, 'src/prompt-submit.mjs')], {
      home,
      cwd: project,
      input: JSON.stringify({
        session_id: 'session-X',
        cwd: project,
        prompt: 'hello world',
      }),
    });

    assert.equal(result.status, 0, result.stderr);

    if (existsSync(join(home, '.throughline', 'throughline.db'))) {
      const db = openDb(home);
      const row = db.prepare('SELECT COUNT(*) AS n FROM handoff_batons').get();
      assert.equal(row.n, 0, 'a normal prompt must not create any baton');
      db.close();
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('Grok first prompt injects handoff into chat_history instead of stdout', () => {
  const home = makeTempHome();
  const project = makeTempProject();
  const oldId = '01a00aa2-50f8-7791-86fd-df2d27cf003e';
  const newId = '01a00ce5-0169-7852-95c0-9e6b8cc50c06';
  const historyDir = join(home, '.grok', 'sessions', encodeURIComponent(project), newId);
  mkdirSync(historyDir, { recursive: true });
  writeFileSync(
    join(historyDir, 'chat_history.jsonl'),
    [
      JSON.stringify({ type: 'system', content: 'sys' }),
      JSON.stringify({
        type: 'user',
        content: [{ type: 'text', text: '<user_query>\nこれかな？\n</user_query>' }],
      }),
    ].join('\n') + '\n',
  );
  try {
    const baton = runNode([join(REPO_ROOT, 'src/prompt-submit.mjs')], {
      home,
      cwd: project,
      input: JSON.stringify({
        sessionId: oldId,
        cwd: project,
        hookEventName: 'user_prompt_submit',
        prompt: '/tl',
      }),
    });
    assert.equal(baton.status, 0, baton.stderr);

    const db = openDb(home);
    db.prepare(
      `INSERT INTO sessions (session_id, project_path, status, created_at, updated_at)
       VALUES (?, ?, 'active', 1, 1)`,
    ).run(`grok:${oldId}`, project);
    db.prepare(
      `INSERT INTO bodies
         (session_id, origin_session_id, turn_number, role, text, token_count, created_at)
       VALUES (?, ?, 1, 'assistant', 'old assistant body', 4, 2)`,
    ).run(`grok:${oldId}`, `grok:${oldId}`);
    db.close();

    const started = runNode([join(REPO_ROOT, 'src/session-start.mjs')], {
      home,
      cwd: project,
      input: JSON.stringify({
        sessionId: newId,
        cwd: project,
        hookEventName: 'session_start',
        source: 'new',
      }),
    });
    assert.equal(started.status, 0, started.stderr);

    const firstPrompt = runNode([join(REPO_ROOT, 'src/prompt-submit.mjs')], {
      home,
      cwd: project,
      input: JSON.stringify({
        sessionId: newId,
        cwd: project,
        hookEventName: 'user_prompt_submit',
        prompt: 'これかな？',
      }),
    });
    assert.equal(firstPrompt.status, 0, firstPrompt.stderr);
    assert.equal(firstPrompt.stdout, '', 'Grok must not rely on ignored hook stdout');

    const rows = readFileSync(join(historyDir, 'chat_history.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(rows[1].synthetic_reason, 'system_reminder');
    assert.match(rows[1].content[0].text, /data-throughline-handoff="1"/);
    assert.match(rows[1].content[0].text, /old assistant body/);
    assert.match(rows[2].content[0].text, /これかな？/);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('two-phase: session-start registers intent only; first prompt consumes baton and injects', () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    const baton = runNode([join(REPO_ROOT, 'src/prompt-submit.mjs')], {
      home,
      cwd: project,
      input: JSON.stringify({
        session_id: 'old-session',
        cwd: project,
        prompt: '/tl',
      }),
    });
    assert.equal(baton.status, 0, baton.stderr);

    const db = openDb(home);
    db.prepare(
      `INSERT INTO sessions (session_id, project_path, status, created_at, updated_at)
       VALUES ('old-session', ?, 'active', 1, 1)`,
    ).run(project);
    db.prepare(
      `INSERT INTO bodies
         (session_id, origin_session_id, turn_number, role, text, token_count, created_at)
       VALUES ('old-session', 'old-session', 1, 'assistant', 'old assistant body', 4, 2)`,
    ).run();
    db.close();

    // 第一相: SessionStart は intent 登録のみ。merge も注入もせず、baton も残る。
    const started = runNode([join(REPO_ROOT, 'src/session-start.mjs')], {
      home,
      cwd: project,
      input: JSON.stringify({
        session_id: 'new-session',
        cwd: project,
        source: 'startup',
      }),
    });
    assert.equal(started.status, 0, started.stderr);
    assert.equal(started.stdout, '', 'SessionStart must not inject anything');

    const mid = openDb(home);
    assert.equal(
      mid.prepare("SELECT merged_into FROM sessions WHERE session_id = 'old-session'").get()
        .merged_into,
      null,
      'no merge at SessionStart',
    );
    assert.equal(mid.prepare('SELECT COUNT(*) AS c FROM handoff_batons').get().c, 1, 'baton kept');
    assert.equal(
      mid.prepare("SELECT COUNT(*) AS c FROM pending_handoffs WHERE session_id = 'new-session'").get().c,
      1,
      'pending intent registered',
    );
    mid.close();

    // 第二相: 初回プロンプト (= 実体の証明) で consume + merge + 注入。
    const firstPrompt = runNode([join(REPO_ROOT, 'src/prompt-submit.mjs')], {
      home,
      cwd: project,
      input: JSON.stringify({
        session_id: 'new-session',
        cwd: project,
        prompt: 'continue the work',
      }),
    });
    assert.equal(firstPrompt.status, 0, firstPrompt.stderr);
    assert.match(firstPrompt.stdout, /old assistant body/);

    const after = openDb(home);
    assert.equal(
      after.prepare("SELECT merged_into FROM sessions WHERE session_id = 'old-session'").get()
        .merged_into,
      'new-session',
    );
    assert.equal(after.prepare('SELECT COUNT(*) AS c FROM handoff_batons').get().c, 0);
    assert.equal(after.prepare('SELECT COUNT(*) AS c FROM pending_handoffs').get().c, 0);
    after.close();

    // 2 回目のプロンプトでは再注入しない (pending 消費済み)
    const secondPrompt = runNode([join(REPO_ROOT, 'src/prompt-submit.mjs')], {
      home,
      cwd: project,
      input: JSON.stringify({
        session_id: 'new-session',
        cwd: project,
        prompt: 'and then?',
      }),
    });
    assert.equal(secondPrompt.status, 0, secondPrompt.stderr);
    assert.equal(secondPrompt.stdout, '', 'no duplicate injection on later prompts');
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('two-phase GHOST regression: first-arriving promptless SessionStart cannot steal the baton', () => {
  // 2026-07-17 incident (ADR 0014) の再現形:
  // 同一 project で幽霊 SessionStart が実体より数百 ms 先に発火しても、
  // プロンプトを発火しない限りバトンも記憶も奪えない。
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    const baton = runNode([join(REPO_ROOT, 'src/prompt-submit.mjs')], {
      home,
      cwd: project,
      input: JSON.stringify({ session_id: 'predecessor', cwd: project, prompt: '/tl' }),
    });
    assert.equal(baton.status, 0, baton.stderr);

    const db = openDb(home);
    db.prepare(
      `INSERT INTO sessions (session_id, project_path, status, created_at, updated_at)
       VALUES ('predecessor', ?, 'active', 1, 1)`,
    ).run(project);
    db.prepare(
      `INSERT INTO bodies
         (session_id, origin_session_id, turn_number, role, text, token_count, created_at)
       VALUES ('predecessor', 'predecessor', 1, 'assistant', 'precious memory', 4, 2)`,
    ).run();
    db.close();

    // 幽霊が先着 (488ms 差の再現 — 順序だけが本質)
    const ghost = runNode([join(REPO_ROOT, 'src/session-start.mjs')], {
      home,
      cwd: project,
      input: JSON.stringify({ session_id: 'ghost-session', cwd: project, source: 'startup' }),
    });
    assert.equal(ghost.status, 0, ghost.stderr);

    // 実体が後着
    const real = runNode([join(REPO_ROOT, 'src/session-start.mjs')], {
      home,
      cwd: project,
      input: JSON.stringify({ session_id: 'real-session', cwd: project, source: 'startup' }),
    });
    assert.equal(real.status, 0, real.stderr);

    // 幽霊はプロンプトを発火しない。実体の初回プロンプトが記憶を受け取る。
    const firstPrompt = runNode([join(REPO_ROOT, 'src/prompt-submit.mjs')], {
      home,
      cwd: project,
      input: JSON.stringify({ session_id: 'real-session', cwd: project, prompt: '続きをやろう' }),
    });
    assert.equal(firstPrompt.status, 0, firstPrompt.stderr);
    assert.match(firstPrompt.stdout, /precious memory/, 'real session receives the memory');

    const after = openDb(home);
    assert.equal(
      after.prepare("SELECT merged_into FROM sessions WHERE session_id = 'predecessor'").get()
        .merged_into,
      'real-session',
      'memory merged into the REAL session, not the ghost',
    );
    const ghostBodies = after
      .prepare("SELECT COUNT(*) AS c FROM bodies WHERE session_id = 'ghost-session'")
      .get();
    assert.equal(ghostBodies.c, 0, 'ghost holds nothing');
    after.close();
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('two-phase: a running session does not steal a baton written after its birth', () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    // セッション B が誕生して初回プロンプトも済んでいる (pending 消費済み)
    const startB = runNode([join(REPO_ROOT, 'src/session-start.mjs')], {
      home,
      cwd: project,
      input: JSON.stringify({ session_id: 'running-B', cwd: project, source: 'startup' }),
    });
    assert.equal(startB.status, 0, startB.stderr);
    const promptB1 = runNode([join(REPO_ROOT, 'src/prompt-submit.mjs')], {
      home,
      cwd: project,
      input: JSON.stringify({ session_id: 'running-B', cwd: project, prompt: 'work work' }),
    });
    assert.equal(promptB1.status, 0, promptB1.stderr);

    // その後、別セッション A が /tl → 次の新規セッションへのバトンを書く
    const tl = runNode([join(REPO_ROOT, 'src/prompt-submit.mjs')], {
      home,
      cwd: project,
      input: JSON.stringify({ session_id: 'session-A', cwd: project, prompt: '/tl' }),
    });
    assert.equal(tl.status, 0, tl.stderr);

    // B の 2 発目のプロンプトはバトンを奪えない (pending 無し = ハンドオフ判定なし)
    const promptB2 = runNode([join(REPO_ROOT, 'src/prompt-submit.mjs')], {
      home,
      cwd: project,
      input: JSON.stringify({ session_id: 'running-B', cwd: project, prompt: 'more work' }),
    });
    assert.equal(promptB2.status, 0, promptB2.stderr);
    assert.equal(promptB2.stdout, '');

    const db = openDb(home);
    const rows = db.prepare('SELECT session_id FROM handoff_batons').all();
    assert.equal(rows.length, 1, 'baton must remain for the true successor');
    assert.equal(rows[0].session_id, 'session-A');
    db.close();
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('session-start subprocess registers session row and stays silent without a baton', () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    const started = runNode([join(REPO_ROOT, 'src/session-start.mjs')], {
      home,
      cwd: project,
      input: JSON.stringify({
        session_id: 'new-session',
        cwd: project,
        source: 'startup',
      }),
    });

    assert.equal(started.status, 0, started.stderr);
    assert.equal(started.stdout, '');

    const db = openDb(home);
    const row = db
      .prepare("SELECT session_id, project_path FROM sessions WHERE session_id = 'new-session'")
      .get();
    assert.equal(row.session_id, 'new-session');
    assert.equal(row.project_path, project);
    const pending = db
      .prepare("SELECT COUNT(*) AS c FROM pending_handoffs WHERE session_id = 'new-session'")
      .get();
    assert.equal(pending.c, 1, 'pending intent registered even without baton');
    db.close();
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('process-turn subprocess stores L2 bodies and L3 details in an isolated DB', () => {
  const home = makeTempHome();
  const project = makeTempProject();
  const transcriptPath = join(project, 'transcript.jsonl');
  try {
    const entries = [
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'run the check' }],
        },
      },
      {
        type: 'assistant',
        uuid: 'asst-tool',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'I should inspect the output first' },
            {
              type: 'tool_use',
              id: 'toolu_check',
              name: 'Bash',
              input: { command: 'echo ok' },
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_check',
              content: 'ok\n',
            },
          ],
        },
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          model: 'claude-opus-4-6',
          usage: {
            input_tokens: 100,
            cache_creation_input_tokens: 20,
            cache_read_input_tokens: 5,
            output_tokens: 10,
          },
          content: [{ type: 'text', text: 'check passed' }],
        },
      },
    ];
    writeFileSync(transcriptPath, entries.map((e) => JSON.stringify(e)).join('\n'));

    const result = runNode([join(REPO_ROOT, 'src/turn-processor.mjs')], {
      home,
      cwd: project,
      input: JSON.stringify({
        session_id: 'turn-session',
        cwd: project,
        transcript_path: transcriptPath,
        last_assistant_message: 'check passed',
      }),
    });

    assert.equal(result.status, 0, result.stderr);

    const db = openDb(home);
    const bodies = db
      .prepare('SELECT role, text FROM bodies ORDER BY role')
      .all()
      .map((row) => ({ role: row.role, text: row.text }));
    assert.deepEqual(bodies, [
      { role: 'assistant', text: 'check passed' },
      { role: 'user', text: 'run the check' },
    ]);

    const details = db
      .prepare('SELECT kind, tool_name, source_id, input_text, output_text FROM details ORDER BY id')
      .all();
    assert.equal(details.length, 3);
    assert.deepEqual(details.map((d) => d.kind), [
      'thinking',
      'tool_input',
      'tool_output',
    ]);
    assert.equal(details[0].source_id, 'asst-tool:thinking:0');
    assert.equal(details[0].output_text, 'I should inspect the output first');
    assert.equal(details[1].tool_name, 'Bash');
    assert.match(details[1].input_text, /echo ok/);
    assert.equal(details[2].tool_name, 'Bash');
    assert.equal(details[2].output_text, 'ok\n');
    db.close();
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('process-turn subprocess backfills all completed logical turns from a multi-turn JSONL', () => {
  const home = makeTempHome();
  const project = makeTempProject();
  const transcriptPath = join(project, 'transcript.jsonl');
  try {
    writeFileSync(
      transcriptPath,
      [
        { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'first request' }] } },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] } },
        { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'second request' }] } },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'second answer' }] } },
      ].map((entry) => JSON.stringify(entry)).join('\n'),
      'utf8',
    );
    const result = runNode([join(REPO_ROOT, 'src/turn-processor.mjs')], {
      home,
      cwd: project,
      input: JSON.stringify({
        session_id: 'multi-turn-session',
        cwd: project,
        transcript_path: transcriptPath,
        last_assistant_message: 'second answer',
      }),
    });
    assert.equal(result.status, 0, result.stderr);
    const db = openDb(home);
    assert.deepEqual(
      db.prepare('SELECT role, text FROM bodies ORDER BY turn_number, role').all().map((row) => ({ ...row })),
      [
        { role: 'assistant', text: 'first answer' },
        { role: 'user', text: 'first request' },
        { role: 'assistant', text: 'second answer' },
        { role: 'user', text: 'second request' },
      ],
    );
    const receipts = readCompletedTurnReceiptSnapshot({ projectPath: project, env: childEnv(home) });
    assert.equal(receipts.receipts.length, 2);
    assert.deepEqual(receipts.receipts.map((entry) => entry.sequence), [1, 2]);
    db.close();
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('process-turn subprocess captures the completed turn when the next user entry lands right after Stop', () => {
  const home = makeTempHome();
  const project = makeTempProject();
  const transcriptPath = join(project, 'transcript.jsonl');
  const text = (role, value) => ({ type: role, message: { role, content: [{ type: 'text', text: value }] } });
  const stop = (lastAssistantMessage) => runNode([join(REPO_ROOT, 'src/turn-processor.mjs')], {
    home,
    cwd: project,
    input: JSON.stringify({
      session_id: 'queued-input-session',
      cwd: project,
      transcript_path: transcriptPath,
      last_assistant_message: lastAssistantMessage,
    }),
  });
  try {
    // 実測の並び: assistantの最終行、Stop、その数十ms後にqueueのuser行。hookの最初の読取より前にuser行がある。
    writeFileSync(transcriptPath, [
      text('user', 'first request'),
      text('assistant', 'first answer'),
      text('user', 'queued request'),
    ].map((entry) => JSON.stringify(entry)).join('\n'), 'utf8');
    // deadlineまで待つとhookは非0で終わる。待たずに採用することは turn-processor.test.mjs が
    // 時計を差し替えて確かめる（子プロセスの起動が遅い環境では実時間を条件にできない）。
    const first = stop('first answer');
    assert.equal(first.status, 0, first.stderr);

    let db = openDb(home);
    assert.deepEqual(
      db.prepare('SELECT role, text FROM bodies ORDER BY turn_number, role').all().map((row) => ({ ...row })),
      [{ role: 'assistant', text: 'first answer' }, { role: 'user', text: 'first request' }],
    );
    db.close();
    assert.equal(readCompletedTurnReceiptSnapshot({ projectPath: project, env: childEnv(home) }).receipts.length, 1);

    // 次のturnが同じ文で終わっても、捕捉済みの前のturnを今回の完了として採用しない。
    appendFileSync(transcriptPath, `\n${JSON.stringify(text('assistant', 'first answer'))}`, 'utf8');
    const second = stop('first answer');
    assert.equal(second.status, 0, second.stderr);
    db = openDb(home);
    assert.deepEqual(
      db.prepare('SELECT role, text FROM bodies ORDER BY turn_number, role').all().map((row) => ({ ...row })),
      [
        { role: 'assistant', text: 'first answer' }, { role: 'user', text: 'first request' },
        { role: 'assistant', text: 'first answer' }, { role: 'user', text: 'queued request' },
      ],
    );
    db.close();
    assert.equal(readCompletedTurnReceiptSnapshot({ projectPath: project, env: childEnv(home) }).receipts.length, 2);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('first prompt backfills a derived predecessor transcript without a state file', {
  skip: process.platform === 'win32' ? 'Windowsはstate file transcriptPath fallback契約' : undefined,
}, () => {
  const home = makeTempHome();
  const project = makeTempProject();
  const predecessorId = 'missing-stop-predecessor';
  const derivedPath = join(
    home,
    '.claude',
    'projects',
    `-${project.replace(/[/.]/g, '-').replace(/^-+/, '')}`,
    `${predecessorId}.jsonl`,
  );
  try {
    mkdirSync(dirname(derivedPath), { recursive: true });
    writeFileSync(
      derivedPath,
      [
        { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'predecessor question' }] } },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'predecessor answer' }] } },
      ].map((entry) => JSON.stringify(entry)).join('\n'),
      'utf8',
    );
    const baton = runNode([join(REPO_ROOT, 'src/prompt-submit.mjs')], {
      home,
      cwd: project,
      input: JSON.stringify({ session_id: predecessorId, cwd: project, prompt: '/clear' }),
    });
    assert.equal(baton.status, 0, baton.stderr);
    const db = openDb(home);
    db.prepare(
      `INSERT INTO sessions (session_id, project_path, status, created_at, updated_at)
       VALUES (?, ?, 'active', 1, 1)`,
    ).run(predecessorId, project);
    db.close();

    const started = runNode([join(REPO_ROOT, 'src/session-start.mjs')], {
      home,
      cwd: project,
      input: JSON.stringify({ session_id: 'new-session', cwd: project, source: 'startup' }),
    });
    assert.equal(started.status, 0, started.stderr);

    // 二相ハンドオフ: backfill + merge は初回プロンプトで行われる
    const firstPrompt = runNode([join(REPO_ROOT, 'src/prompt-submit.mjs')], {
      home,
      cwd: project,
      input: JSON.stringify({ session_id: 'new-session', cwd: project, prompt: 'continue' }),
    });
    assert.equal(firstPrompt.status, 0, firstPrompt.stderr);

    const after = openDb(home);
    assert.deepEqual(
      after
        .prepare('SELECT session_id, origin_session_id, role, text FROM bodies ORDER BY turn_number, role')
        .all()
        .map((row) => ({ ...row })),
      [
        { session_id: 'new-session', origin_session_id: predecessorId, role: 'assistant', text: 'predecessor answer' },
        { session_id: 'new-session', origin_session_id: predecessorId, role: 'user', text: 'predecessor question' },
      ],
    );
    after.close();
    const backfillLog = readFileSync(join(home, '.throughline', 'logs', 'backfill.log'), 'utf8')
      .split('\n')
      .filter((line) => line)
      .map((line) => JSON.parse(line));
    assert.ok(backfillLog.some((entry) => entry.hook === 'prompt-submit'));
    assert.equal(existsSync(join(home, '.throughline', 'state', `${predecessorId}.json`)), false);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- Phase 0-5 spike (UserPromptSubmit) ----

function seedMergedSession(home, sessionId, originId = 'orig-sess') {
  // DB を直接作って bodies に origin != session_id を入れ、spikeInject が
  // recentBodies を返せる状態にする。
  const dbPath = join(home, '.throughline', 'throughline.db');
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      merged_into TEXT
    );
    CREATE TABLE IF NOT EXISTS skeletons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      origin_session_id TEXT,
      turn_number INTEGER NOT NULL,
      role TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bodies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      origin_session_id TEXT NOT NULL,
      turn_number INTEGER NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      token_count INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS details (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      origin_session_id TEXT,
      turn_number INTEGER,
      tool_name TEXT NOT NULL,
      input_text TEXT,
      output_text TEXT,
      token_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      kind TEXT,
      source_id TEXT
    );
    CREATE TABLE IF NOT EXISTS handoff_batons (
      project_path TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  db.prepare(
    `INSERT INTO sessions (session_id, project_path, status, created_at, updated_at)
     VALUES (?, '/repo', 'active', 1, 2)`,
  ).run(sessionId);
  for (const r of [
    { turn: 1, role: 'user', text: 'past user turn', createdAt: 1000 },
    { turn: 2, role: 'assistant', text: 'past assistant turn', createdAt: 1100 },
  ]) {
    db.prepare(
      `INSERT INTO bodies (session_id, origin_session_id, turn_number, role, text, token_count, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
    ).run(sessionId, originId, r.turn, r.role, r.text, r.createdAt);
  }
  db.close();
}

function touchSpikePromptFlag(home) {
  const flagPath = join(home, '.throughline', 'spike-prompt.flag');
  mkdirSync(dirname(flagPath), { recursive: true });
  writeFileSync(flagPath, '', 'utf8');
}

function readPromptSpikeLog(home) {
  const path = join(home, '.throughline', 'logs', 'prompt-spike.log');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

test('Phase 0-5: spike SKIPS when marker file is absent', () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    seedMergedSession(home, 'sess-no-marker');
    const transcriptPath = join(project, 'transcript.jsonl');
    writeFileSync(transcriptPath, '', 'utf8');

    const result = runNode([join(REPO_ROOT, 'src/prompt-submit.mjs')], {
      home,
      cwd: project,
      input: JSON.stringify({
        session_id: 'sess-no-marker',
        cwd: project,
        prompt: 'hello world',
        transcript_path: transcriptPath,
      }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(transcriptPath, 'utf8'), '', 'transcript untouched');
    assert.equal(readPromptSpikeLog(home).length, 0, 'no spike log entry');
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('Phase 0-5: spike LOGS skip_reason when transcript_path is missing in payload', () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    seedMergedSession(home, 'sess-no-tp');
    touchSpikePromptFlag(home);

    const result = runNode([join(REPO_ROOT, 'src/prompt-submit.mjs')], {
      home,
      cwd: project,
      input: JSON.stringify({
        session_id: 'sess-no-tp',
        cwd: project,
        prompt: 'hello world',
        // transcript_path omitted
      }),
    });
    assert.equal(result.status, 0, result.stderr);
    const logs = readPromptSpikeLog(home);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].skip_reason, 'no_transcript_path_in_payload');
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('Phase 0-5: spike INJECTS into JSONL chain-reachable from last uuid on first prompt', () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    seedMergedSession(home, 'sess-inject');
    touchSpikePromptFlag(home);

    // Pre-populate transcript with 1 attachment line (= simulates SessionStart hook output)
    const transcriptPath = join(project, 'transcript.jsonl');
    const attachmentLine = JSON.stringify({
      type: 'attachment',
      uuid: 'pre-attach-uuid',
      parentUuid: null,
    });
    writeFileSync(transcriptPath, attachmentLine + '\n', 'utf8');

    const result = runNode([join(REPO_ROOT, 'src/prompt-submit.mjs')], {
      home,
      cwd: project,
      input: JSON.stringify({
        session_id: 'sess-inject',
        cwd: project,
        prompt: 'tell me the spike-tracer',
        transcript_path: transcriptPath,
        version: '2.1.145',
        gitBranch: 'main',
      }),
    });
    assert.equal(result.status, 0, result.stderr);

    const content = readFileSync(transcriptPath, 'utf8');
    const lines = content.split('\n').filter((l) => l.trim());
    assert.equal(lines.length, 3, '1 preexisting + 2 spike lines');
    const firstSpike = JSON.parse(lines[1]);
    assert.equal(firstSpike.parentUuid, 'pre-attach-uuid', 'chain (b) from last attachment uuid');
    const lastSpike = JSON.parse(lines[2]);
    assert.match(
      lastSpike.message.content[0].text,
      /\[spike-tracer: [0-9a-f]{8}\]$/,
      'tracer in last assistant',
    );

    const logs = readPromptSpikeLog(home);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].parent_uuid_start, 'pre-attach-uuid');
    assert.equal(logs[0].appended, 2);
    assert.match(logs[0].tracer, /^[0-9a-f]{8}$/);

    // per-session marker created
    assert.ok(
      existsSync(join(home, '.throughline', 'spike-prompt-state', 'sess-inject')),
      'per-session marker created after successful spike',
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('Phase 0-5: spike is IDEMPOTENT per session (second call is no-op)', () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    seedMergedSession(home, 'sess-idem');
    touchSpikePromptFlag(home);

    const transcriptPath = join(project, 'transcript.jsonl');
    writeFileSync(
      transcriptPath,
      JSON.stringify({ type: 'attachment', uuid: 'preU', parentUuid: null }) + '\n',
      'utf8',
    );

    const firstPayload = JSON.stringify({
      session_id: 'sess-idem',
      cwd: project,
      prompt: 'first',
      transcript_path: transcriptPath,
    });
    const secondPayload = JSON.stringify({
      session_id: 'sess-idem',
      cwd: project,
      prompt: 'second',
      transcript_path: transcriptPath,
    });

    const r1 = runNode([join(REPO_ROOT, 'src/prompt-submit.mjs')], {
      home,
      cwd: project,
      input: firstPayload,
    });
    assert.equal(r1.status, 0, r1.stderr);
    const after1 = readFileSync(transcriptPath, 'utf8').split('\n').filter((l) => l.trim()).length;

    const r2 = runNode([join(REPO_ROOT, 'src/prompt-submit.mjs')], {
      home,
      cwd: project,
      input: secondPayload,
    });
    assert.equal(r2.status, 0, r2.stderr);
    const after2 = readFileSync(transcriptPath, 'utf8').split('\n').filter((l) => l.trim()).length;

    assert.equal(after2, after1, 'second prompt did not append additional lines');
    assert.equal(readPromptSpikeLog(home).length, 1, 'only the first call logged');
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('Phase 0-5: /tl and /clear prompts do NOT trigger spike', () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    seedMergedSession(home, 'sess-slash');
    touchSpikePromptFlag(home);
    const transcriptPath = join(project, 'transcript.jsonl');
    writeFileSync(
      transcriptPath,
      JSON.stringify({ type: 'attachment', uuid: 'preU', parentUuid: null }) + '\n',
      'utf8',
    );

    const r = runNode([join(REPO_ROOT, 'src/prompt-submit.mjs')], {
      home,
      cwd: project,
      input: JSON.stringify({
        session_id: 'sess-slash',
        cwd: project,
        prompt: '/tl',
        transcript_path: transcriptPath,
      }),
    });
    assert.equal(r.status, 0, r.stderr);

    assert.equal(readPromptSpikeLog(home).length, 0, 'no spike log for /tl');
    assert.ok(
      !existsSync(join(home, '.throughline', 'spike-prompt-state', 'sess-slash')),
      'per-session marker NOT created for /tl',
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});


test('Cursor hooks accept the UTF-8 BOM emitted by Windows and capture the turn', () => {
  const home = makeTempHome();
  const project = makeTempProject();
  const id = '23c59dba-f4b5-4ce7-a2de-27a2fbbb4193';
  const transcript = join(project, 'cursor.jsonl');
  writeFileSync(transcript, [
    { role: 'user', message: { content: [{ type: 'text', text: 'BOM hook capture' }] } },
    { role: 'assistant', message: { content: [{ type: 'text', text: 'Captured' }] } },
  ].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  try {
    for (const [event, command] of [
      ['sessionStart', 'session-start'],
      ['beforeSubmitPrompt', 'prompt-submit'],
      ['stop', 'process-turn'],
    ]) {
      const result = runNode([join(REPO_ROOT, 'bin/throughline.mjs'), command], {
        home,
        cwd: project,
        input: '\uFEFF' + JSON.stringify({
          conversation_id: id,
          session_id: id,
          hook_event_name: event,
          cursor_version: '2026.10.01-e373342',
          workspace_roots: [project],
          transcript_path: transcript,
          prompt: '/tl',
        }),
      });
      assert.equal(result.status, 0, `${event}: ${result.stderr}`);
    }
    const db = openDb(home);
    try {
      assert.equal(db.prepare('SELECT session_id FROM sessions').get().session_id, `cursor:${id}`);
      assert.equal(db.prepare('SELECT session_id FROM handoff_batons').get().session_id, `cursor:${id}`);
      const bodies = db.prepare('SELECT role, text FROM bodies ORDER BY role').all();
      assert.deepEqual(bodies.map((row) => [row.role, row.text]), [
        ['assistant', 'Captured'], ['user', 'BOM hook capture'],
      ]);
    } finally {
      db.close();
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('a leading BOM does not hide malformed hook JSON', () => {
  const home = makeTempHome();
  try {
    for (const command of ['session-start', 'prompt-submit', 'process-turn']) {
      const result = runNode([join(REPO_ROOT, 'bin/throughline.mjs'), command], {
        home, input: '\uFEFF{"conversation_id":',
      });
      assert.notEqual(result.status, 0, command);
      assert.match(result.stderr, /SyntaxError/, command);
    }
    assert.equal(existsSync(join(home, '.throughline', 'throughline.db')), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
