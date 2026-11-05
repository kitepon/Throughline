import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir, platform } from 'node:os';

import { normalizeProjectPath } from './state-file.mjs';

// state-file.mjs は ~/.throughline/state を直接見るので、モジュール全体を一時ディレクトリ指定で
// 差し替える薄いヘルパーを用意する。HOME 環境変数を偽装して import し直す方式で隔離する。
async function withIsolatedStateDir(testFn) {
  const work = mkdtempSync(join(tmpdir(), 'tl-state-'));
  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;
  process.env.HOME = work;
  process.env.USERPROFILE = work;
  // ESM キャッシュをバイパスするため query string 付きで import
  const mod = await import(`./state-file.mjs?isolated=${Date.now()}-${Math.random()}`);
  const stateDir = mod.getStateDir();
  mkdirSync(stateDir, { recursive: true });
  try {
    await testFn({ stateDir, mod });
  } finally {
    process.env.HOME = origHome;
    process.env.USERPROFILE = origUserProfile;
    rmSync(work, { recursive: true, force: true });
  }
}

test('normalizeProjectPath: 空文字列は空文字列', () => {
  assert.equal(normalizeProjectPath(''), '');
  assert.equal(normalizeProjectPath(null), '');
  assert.equal(normalizeProjectPath(undefined), '');
});

test('normalizeProjectPath: バックスラッシュがスラッシュになり末尾スラッシュ除去', () => {
  const result = normalizeProjectPath('C:\\Users\\foo\\');
  assert.ok(result.includes('/'));
  assert.ok(!result.endsWith('/') || result === '/');
});

test('normalizeProjectPath: Windows では lowercase', () => {
  if (platform() !== 'win32') return;
  const result = normalizeProjectPath('C:\\Users\\Foo');
  assert.equal(result, result.toLowerCase());
});

test('readAllSessionStates: 破損 JSON を削除して skip する', async () => {
  await withIsolatedStateDir(async ({ stateDir, mod }) => {
    const broken = join(stateDir, 'broken-abc.json');
    const good = join(stateDir, 'good-session.json');
    writeFileSync(broken, '{ not valid json');
    writeFileSync(good, JSON.stringify({
      sessionId: 'good-session',
      projectPath: '/tmp/foo',
      transcriptPath: null,
      updatedAt: Date.now(),
    }));
    const results = mod.readAllSessionStates();
    assert.equal(results.length, 1);
    assert.equal(results[0].sessionId, 'good-session');
    // 破損ファイルは削除されている
    assert.ok(!existsSync(broken), 'corrupt file should be unlinked');
  });
});

test('readAllSessionStates: 24h 超のファイルはハード削除される', async () => {
  await withIsolatedStateDir(async ({ stateDir, mod }) => {
    const old = join(stateDir, 'old-session.json');
    const past = Date.now() - (25 * 60 * 60 * 1000); // 25h 前
    writeFileSync(old, JSON.stringify({
      sessionId: 'old-session',
      projectPath: '/tmp/foo',
      transcriptPath: null,
      updatedAt: past,
    }));
    const results = mod.readAllSessionStates();
    assert.equal(results.length, 0);
    assert.ok(!existsSync(old), 'old file should be deleted');
  });
});

test('readAllSessionStates: 15 分超は stale フラグ付きで返される', async () => {
  await withIsolatedStateDir(async ({ stateDir, mod }) => {
    const stale = join(stateDir, 'stale-session.json');
    const past = Date.now() - (20 * 60 * 1000); // 20 分前
    writeFileSync(stale, JSON.stringify({
      sessionId: 'stale-session',
      projectPath: '/tmp/foo',
      transcriptPath: null,
      updatedAt: past,
    }));
    const results = mod.readAllSessionStates();
    assert.equal(results.length, 1);
    assert.equal(results[0].stale, true);
  });
});

test('readAllSessionStates: state ディレクトリ未作成なら空配列', async () => {
  await withIsolatedStateDir(async ({ stateDir, mod }) => {
    rmSync(stateDir, { recursive: true, force: true });
    const results = mod.readAllSessionStates();
    assert.deepEqual(results, []);
  });
});

test('snapshotStateMtimes: 存在する JSON の mtime を返す', async () => {
  await withIsolatedStateDir(async ({ stateDir, mod }) => {
    const file = join(stateDir, 'abc.json');
    writeFileSync(file, '{}');
    const snap = mod.snapshotStateMtimes();
    assert.equal(snap.size, 1);
    assert.ok(snap.has('abc.json'));
    assert.ok(typeof snap.get('abc.json') === 'number');
  });
});

test('snapshotStateMtimes: .json 以外は無視', async () => {
  await withIsolatedStateDir(async ({ stateDir, mod }) => {
    writeFileSync(join(stateDir, 'ignored.txt'), 'hello');
    writeFileSync(join(stateDir, 'abc.json'), '{}');
    const snap = mod.snapshotStateMtimes();
    assert.equal(snap.size, 1);
    assert.ok(snap.has('abc.json'));
    assert.ok(!snap.has('ignored.txt'));
  });
});

test('snapshotStateMtimes: ディレクトリ未作成なら空 Map', async () => {
  await withIsolatedStateDir(async ({ stateDir, mod }) => {
    rmSync(stateDir, { recursive: true, force: true });
    const snap = mod.snapshotStateMtimes();
    assert.equal(snap.size, 0);
  });
});

test('writeSessionState: usage 付きで書くと JSON に含まれる', async () => {
  await withIsolatedStateDir(async ({ stateDir, mod }) => {
    mod.writeSessionState({
      sessionId: 'sess-a',
      projectPath: '/tmp/x',
      transcriptPath: null,
      pid: 1,
      usage: { tokens: 123, model: 'claude-opus-4-6', contextWindowSize: 200000, outputTokens: 10 },
    });
    const results = mod.readAllSessionStates();
    assert.equal(results.length, 1);
    assert.ok(results[0].usage);
    assert.equal(results[0].host, 'claude');
    assert.equal(results[0].rolloutPath, null);
    assert.equal(results[0].usage.tokens, 123);
    assert.equal(results[0].usage.model, 'claude-opus-4-6');
  });
});

test('writeSessionState: Codex state は host と rolloutPath を保持しファイル名を encode する', async () => {
  await withIsolatedStateDir(async ({ stateDir, mod }) => {
    mod.writeSessionState({
      sessionId: 'codex:019dfaba-thread',
      host: 'codex',
      projectPath: '/tmp/x',
      transcriptPath: null,
      rolloutPath: '/tmp/codex/rollout.jsonl',
      pid: 1,
      usage: {
        tokens: 123,
        model: 'codex',
        contextWindowSize: 258400,
        contextWindowEstimated: false,
        outputTokens: 10,
        estimated: false,
        source: 'codex-rollout-token-count',
      },
    });

    assert.deepEqual(readdirSync(stateDir).filter(name => name.endsWith('.json')), ['codex%3A019dfaba-thread.json']);
    const results = mod.readAllSessionStates();
    assert.equal(results.length, 1);
    assert.equal(results[0].sessionId, 'codex:019dfaba-thread');
    assert.equal(results[0].host, 'codex');
    assert.equal(results[0].transcriptPath, null);
    assert.equal(results[0].rolloutPath, '/tmp/codex/rollout.jsonl');
    assert.equal(results[0].usage.source, 'codex-rollout-token-count');
  });
});

test('writeSessionState: unsupported host は throw する', async () => {
  await withIsolatedStateDir(async ({ mod }) => {
    assert.throws(
      () =>
        mod.writeSessionState({
          sessionId: 'sess-bad-host',
          host: 'unknown-host',
          projectPath: '/tmp/x',
        }),
      /unsupported host/,
    );
  });
});

test('writeSessionState: usage 無しで書いたらフィールド自体が無い (旧フォーマット互換)', async () => {
  await withIsolatedStateDir(async ({ stateDir, mod }) => {
    mod.writeSessionState({
      sessionId: 'sess-b',
      projectPath: '/tmp/x',
      transcriptPath: null,
      pid: 1,
    });
    const results = mod.readAllSessionStates();
    assert.equal(results.length, 1);
    assert.equal(results[0].usage, undefined);
    assert.equal(results[0].host, 'claude');
  });
});

test('readAllSessionStates: 旧バージョンが書いた usage 無しの state を読める', async () => {
  await withIsolatedStateDir(async ({ stateDir, mod }) => {
    // 旧フォーマット (usage フィールド無し) を直接書く
    const file = join(stateDir, 'old-fmt.json');
    writeFileSync(file, JSON.stringify({
      sessionId: 'old-fmt',
      projectPath: '/tmp/foo',
      transcriptPath: null,
      pid: 1,
      updatedAt: Date.now(),
    }));
    const results = mod.readAllSessionStates();
    assert.equal(results.length, 1);
    assert.equal(results[0].host, 'claude');
    assert.equal(results[0].rolloutPath, null);
    assert.equal(results[0].usage, undefined);
    // usage 無しで読めること自体が互換性の証明
  });
});


test('normal Stop state writes reclaim old states without a monitor and preserve recent states', async () => {
  await withIsolatedStateDir(async ({ stateDir, mod }) => {
    const old = join(stateDir, 'retired.json'), recent = join(stateDir, 'recent.json');
    writeFileSync(old, JSON.stringify({ sessionId: 'retired', updatedAt: Date.now() - 25 * 3600000 }));
    writeFileSync(recent, JSON.stringify({ sessionId: 'recent', updatedAt: Date.now() }));
    mod.writeSessionState({ sessionId: 'current', projectPath: stateDir });
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(recent), true);
    assert.equal(existsSync(join(stateDir, 'current.json')), true);
    assert.equal(existsSync(join(stateDir, '.last-cleanup')), true);
    assert.deepEqual(readdirSync(stateDir).filter(name => name.endsWith('.tmp')), []);
  });
});
