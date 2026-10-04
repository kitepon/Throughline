import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  COMPLETED_TURN_RECEIPT_LIMIT,
  COMPLETED_TURN_RECEIPT_STORE_SCHEMA,
  defaultCompletedTurnReceiptStorePath,
  readCompletedTurnReceiptSnapshot,
  writeCompletedTurnReceipt,
} from './completed-turn-receipts.mjs';
import { seedCompletedTurnReceiptStore } from './completed-turn-receipts-test-fixture.mjs';
import { verifyWindowsPrivateAcl } from './os/windows-acl-test-helper.mjs';

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'throughline-completed-receipts-'));
  return { root, storePath: join(root, 'state', 'completed-turn-receipts.json') };
}

function input(index = 1) {
  return {
    projectPath: '/repo', targetSessionId: 'target', originSessionId: 'origin',
    userBody: `user ${index}`, assistantBody: `assistant ${index}`, completedAt: index,
  };
}

test('completed turn receipt: private atomic store records only identities and hashes', () => {
  const box = sandbox();
  try {
    const receipt = writeCompletedTurnReceipt(input(), { storePath: box.storePath });
    assert.equal(receipt.schema_version, '1.0');
    assert.equal(receipt.host, 'claude');
    assert.equal(receipt.sequence, 1);
    assert.match(receipt.project_sha256, /^[0-9a-f]{64}$/);
    assert.match(receipt.user_sha256, /^[0-9a-f]{64}$/);
    assert.match(receipt.assistant_sha256, /^[0-9a-f]{64}$/);
    const bytes = readFileSync(box.storePath, 'utf8');
    assert.doesNotMatch(bytes, /user 1|assistant 1|\/repo/);
    const stored = JSON.parse(bytes);
    assert.equal(stored.schema, COMPLETED_TURN_RECEIPT_STORE_SCHEMA);
    assert.equal(stored.history_floor, 1);
    assert.equal(stored.receipts.length, 1);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test('completed turn receipt: same project/session/pair is idempotent and keeps its sequence', () => {
  const box = sandbox();
  try {
    const first = writeCompletedTurnReceipt(input(), { storePath: box.storePath });
    const retry = writeCompletedTurnReceipt({ ...input(), completedAt: 999 }, { storePath: box.storePath });
    assert.deepEqual(retry, first);
    const next = writeCompletedTurnReceipt(input(2), { storePath: box.storePath });
    assert.equal(next.sequence, 2);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test('completed turn receipt: target変更を伴う同一origin/pairの再実行は冪等', () => {
  const box = sandbox();
  try {
    const first = writeCompletedTurnReceipt(input(), { storePath: box.storePath });
    const retriedAfterMerge = writeCompletedTurnReceipt({ ...input(), targetSessionId: 'merged-target' }, { storePath: box.storePath });
    assert.deepEqual(retriedAfterMerge, first);
    assert.equal(retriedAfterMerge.target_session_id, 'target', 'capture時targetを保持する');
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test('completed turn receipt: project digest shares realpath canonicalization with the DB projection', {
  skip: process.platform === 'win32',
}, () => {
  const box = sandbox();
  const project = join(box.root, 'project');
  const alias = join(box.root, 'project-alias');
  try {
    mkdirSync(project);
    symlinkSync(project, alias);
    const direct = writeCompletedTurnReceipt({ ...input(), projectPath: project }, { storePath: box.storePath });
    const viaAlias = writeCompletedTurnReceipt({ ...input(), projectPath: alias }, { storePath: box.storePath });
    assert.deepEqual(viaAlias, direct);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test('completed turn receipt: rejects symlinked store paths', { skip: process.platform === 'win32' }, () => {
  const box = sandbox();
  const target = join(box.root, 'target.json');
  try {
    mkdirSync(dirname(box.storePath), { recursive: true });
    symlinkSync(target, box.storePath);
    assert.throws(() => writeCompletedTurnReceipt(input(), { storePath: box.storePath }), /unsafe/);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test('completed turn receipt: bounded store drops only oldest receipts', () => {
  const box = sandbox();
  try {
    seedCompletedTurnReceiptStore({ projectPath: '/repo', receiptOptions: { storePath: box.storePath } });
    writeCompletedTurnReceipt({ ...input(COMPLETED_TURN_RECEIPT_LIMIT + 1), targetSessionId: 'target-final' }, { storePath: box.storePath });
    const stored = JSON.parse(readFileSync(box.storePath, 'utf8'));
    assert.equal(stored.receipts.length, COMPLETED_TURN_RECEIPT_LIMIT);
    assert.equal(stored.history_floor, 2);
    assert.equal(stored.receipts[0].sequence, 2);
    assert.equal(stored.receipts.at(-1).sequence, COMPLETED_TURN_RECEIPT_LIMIT + 1);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test('completed turn receipt: noisy project cannot evict another project anchor', () => {
  const box = sandbox();
  const env = { HOME: box.root, USERPROFILE: box.root, XDG_STATE_HOME: join(box.root, 'state-home') };
  try {
    const quiet = writeCompletedTurnReceipt({ ...input(), projectPath: '/quiet-project' }, { env });
    seedCompletedTurnReceiptStore({ projectPath: '/noisy-project', receiptOptions: { env } });
    writeCompletedTurnReceipt({
      ...input(COMPLETED_TURN_RECEIPT_LIMIT + 1),
      projectPath: '/noisy-project', targetSessionId: 'target-final',
    }, { env });
    const quietStorePath = defaultCompletedTurnReceiptStorePath(quiet.project_sha256, env);
    const quietStore = JSON.parse(readFileSync(quietStorePath, 'utf8'));
    assert.equal(quietStore.receipts.length, 1);
    assert.equal(quietStore.receipts[0].sequence, 1);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test('completed turn receipt: one Windows mutation spends ACL processes only on distinct state transitions', (t) => {
  const box = sandbox();
  const env = { OS: 'Windows_NT', HOME: box.root, USERPROFILE: box.root };
  const calls = [];
  t.mock.method(childProcess, 'spawnSync', (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0, signal: null, error: undefined };
  });
  const options = { env, storePath: box.storePath };

  try {
    writeCompletedTurnReceipt(input(1), options);
    assert.equal(calls.length, 3, 'new directory, lock, and store each require one apply+verify process');
    assert.ok(calls.every((call) => call.command === 'pwsh.exe'));
    calls.length = 0;

    writeCompletedTurnReceipt(input(2), options);
    assert.equal(calls.length, 4, 'directory apply, existing lock/store verify, and replacement store apply are distinct');
    assert.ok(calls.every((call) => call.options.timeout === 15_000));
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test('completed turn receipt: Windows lock file reaches its final path only after its ACL is applied', (t) => {
  const box = sandbox();
  const env = { OS: 'Windows_NT', HOME: box.root, USERPROFILE: box.root };
  const lockPath = `${box.storePath}.lock.sqlite`;
  const applied = new Set();
  const exposed = [];
  // 同時に走る別のhookは、lockが見えた時点でそのACLを検証する。ACL processの起動を、その検証が入りうる瞬間として見る。
  t.mock.method(childProcess, 'spawnSync', (command, args, options) => {
    if (existsSync(lockPath) && !applied.has(statSync(lockPath, { bigint: true }).ino)) exposed.push(options.env.THROUGHLINE_ACL_PATH);
    if (args.at(-1).includes('Set-Acl')) applied.add(statSync(options.env.THROUGHLINE_ACL_PATH, { bigint: true }).ino);
    return { status: 0, signal: null, error: undefined };
  });

  try {
    writeCompletedTurnReceipt(input(1), { env, storePath: box.storePath });
    assert.deepEqual(exposed, [], 'the lock must not be visible with an inherited ACL');
    assert.ok(applied.has(statSync(lockPath, { bigint: true }).ino));
    assert.deepEqual(readdirSync(dirname(lockPath)).filter((name) => name.endsWith('.tmp')), []);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test('completed turn receipt: Windows temporary ACL failure leaves the previous atomic store intact', (t) => {
  const box = sandbox();
  const env = { OS: 'Windows_NT', HOME: box.root, USERPROFILE: box.root };
  let calls = 0;
  let failAt = Number.POSITIVE_INFINITY;
  t.mock.method(childProcess, 'spawnSync', () => {
    calls += 1;
    return { status: calls === failAt ? 1 : 0, signal: null, error: undefined };
  });
  const options = { env, storePath: box.storePath };

  try {
    writeCompletedTurnReceipt(input(1), options);
    const before = readFileSync(box.storePath, 'utf8');
    failAt = calls + 4;
    assert.throws(() => writeCompletedTurnReceipt(input(2), options), /ACL verification failed/);
    assert.equal(readFileSync(box.storePath, 'utf8'), before);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test('completed turn receipt: atomic private store has owner-only modes', () => {
  const box = sandbox();
  try {
    writeCompletedTurnReceipt(input(), { storePath: box.storePath });
    if (process.platform === 'win32') {
      verifyWindowsPrivateAcl(dirname(box.storePath), true);
      verifyWindowsPrivateAcl(`${box.storePath}.lock.sqlite`);
      verifyWindowsPrivateAcl(box.storePath);
    } else {
      assert.equal(statSync(dirname(box.storePath)).mode & 0o777, 0o700);
      assert.equal(statSync(`${box.storePath}.lock.sqlite`).mode & 0o777, 0o600);
      assert.equal(statSync(box.storePath).mode & 0o777, 0o600);
    }
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test('completed turn receipt: explicit store path rejects a second project', () => {
  const box = sandbox();
  try {
    writeCompletedTurnReceipt({ ...input(), projectPath: '/project-a' }, { storePath: box.storePath });
    assert.throws(
      () => writeCompletedTurnReceipt({ ...input(), projectPath: '/project-b' }, { storePath: box.storePath }),
      /schema invalid/,
    );
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test('completed turn receipt: read-only snapshot validates project binding and does not create missing state', () => {
  const box = sandbox();
  try {
    const missing = readCompletedTurnReceiptSnapshot({ projectPath: '/missing-project', storePath: box.storePath });
    assert.equal(missing.receipts.length, 0);
    assert.throws(() => readFileSync(box.storePath));
    writeCompletedTurnReceipt({ ...input(), projectPath: '/project-a' }, { storePath: box.storePath });
    assert.throws(
      () => readCompletedTurnReceiptSnapshot({ projectPath: '/project-b', storePath: box.storePath }),
      /schema invalid/,
    );
    assert.throws(() => readCompletedTurnReceiptSnapshot({ projectPath: '/project-a', unknown: true }), /options are invalid/);
    assert.throws(() => readCompletedTurnReceiptSnapshot({ projectPath: null }), /projectPath/);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test('completed turn receipt: rejects sequence order corruption', () => {
  const box = sandbox();
  try {
    writeCompletedTurnReceipt(input(1), { storePath: box.storePath });
    writeCompletedTurnReceipt(input(2), { storePath: box.storePath });
    const store = JSON.parse(readFileSync(box.storePath, 'utf8'));
    [store.receipts[0], store.receipts[1]] = [store.receipts[1], store.receipts[0]];
    writeFileSync(box.storePath, `${JSON.stringify(store)}\n`);
    assert.throws(() => writeCompletedTurnReceipt(input(3), { storePath: box.storePath }), /uniqueness invalid/);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test('completed turn receipt: Windows path uses LocalAppData', () => {
  const env = { OS: 'Windows_NT', USERPROFILE: 'C:\\Users\\kite', LOCALAPPDATA: 'C:\\Users\\kite\\AppData\\Local' };
  const projectSha256 = 'a'.repeat(64);
  assert.equal(
    defaultCompletedTurnReceiptStorePath(projectSha256, env),
    join(env.LOCALAPPDATA, 'throughline', 'completed-turn-receipts', `${projectSha256}.json`),
  );
});
