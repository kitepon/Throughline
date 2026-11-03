import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createObserverCheckCatalog } from './observer-turn-feed.mjs';

function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'tl-check-catalog-'));
  const project = join(root, 'project'); const child = join(project, 'child');
  const codexHome = join(root, 'codex'); const sessions = join(codexHome, 'sessions');
  fs.mkdirSync(child, { recursive: true }); fs.mkdirSync(sessions, { recursive: true });
  const receiptOptions = { env: { HOME: root, USERPROFILE: root, XDG_STATE_HOME: join(root, 'state'), LOCALAPPDATA: join(root, 'state') } };
  function rollout(id, cwd, text = 'answer') {
    const path = join(sessions, `rollout-2026-07-15T00-00-00-00000000-0000-4000-8000-${id.padStart(12, '0')}.jsonl`);
    const event = (type, message, timestamp) => ({ type: 'event_msg', timestamp, payload: { type, message } });
    fs.writeFileSync(path, [
      { type: 'session_meta', payload: { cwd } },
      event('user_message', 'request', '2026-07-15T00:00:01Z'),
      event('task_started', undefined, '2026-07-15T00:00:02Z'),
      event('agent_message', text, '2026-07-15T00:00:03Z'),
      event('task_complete', undefined, '2026-07-15T00:00:04Z'),
    ].map(JSON.stringify).join('\n'));
    return path;
  }
  return { root, project, child, codexHome, receiptOptions, rollout };
}

test('check catalog shares discovery and full parses across parent, child and repeated projects', (t) => {
  const box = fixture(); let catalog;
  try {
    const parentFile = box.rollout('1', box.project); const childFile = box.rollout('2', box.child);
    const read = fs.readFileSync; const head = fs.readSync; const counts = new Map(); let metadataReads = 0;
    t.mock.method(fs, 'readFileSync', (path, ...args) => { counts.set(path, (counts.get(path) ?? 0) + 1); return read(path, ...args); });
    t.mock.method(fs, 'readSync', (...args) => { metadataReads++; return head(...args); });
    syncBuiltinESMExports();
    catalog = createObserverCheckCatalog(box);
    const parent = catalog.read(box.project); const child = catalog.read(box.child);
    assert.deepEqual(catalog.read(box.project), parent);
    assert.notEqual(parent.projectSha256, child.projectSha256);
    assert.notEqual(parent.fingerprint, child.fingerprint);
    assert.equal(counts.get(parentFile), 1); assert.equal(counts.get(childFile), 1);
    assert.equal(metadataReads, 2);
    catalog.close(); assert.throws(() => catalog.read(box.project), /closed/);
  } finally {
    catalog?.close(); t.mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(box.root, { recursive: true, force: true });
  }
});

test('check catalog fingerprints content changes and binds empty sources to each project', () => {
  const box = fixture(); let catalog;
  try {
    catalog = createObserverCheckCatalog(box);
    const empty = catalog.read(box.project); const child = catalog.read(box.child);
    assert.equal(empty.fingerprint, child.fingerprint); assert.notEqual(empty.projectSha256, child.projectSha256);
    catalog.close(); box.rollout('1', box.project);
    catalog = createObserverCheckCatalog(box); const completed = catalog.read(box.project); catalog.close();
    assert.notEqual(completed.fingerprint, empty.fingerprint);
    box.rollout('1', box.project, 'changed body');
    catalog = createObserverCheckCatalog(box); assert.notEqual(catalog.read(box.project).fingerprint, completed.fingerprint);
  } finally { catalog?.close(); fs.rmSync(box.root, { recursive: true, force: true }); }
});

test('check catalog rejects corrupt matching source and discovery without project identity', () => {
  const box = fixture(); let catalog;
  try {
    const path = box.rollout('1', box.project);
    fs.appendFileSync(path, '\n{broken');
    catalog = createObserverCheckCatalog(box); assert.throws(() => catalog.read(box.project), /corrupt/);
    catalog.close(); fs.writeFileSync(path, '{}\n');
    assert.throws(() => createObserverCheckCatalog(box), /project unavailable/);
  } finally { catalog?.close(); fs.rmSync(box.root, { recursive: true, force: true }); }
});

test('check catalog fails closed if a rollout changes after discovery', () => {
  const box = fixture(); let catalog;
  try {
    const path = box.rollout('1', box.project); catalog = createObserverCheckCatalog(box);
    fs.utimesSync(path, new Date(0), new Date(0));
    assert.throws(() => catalog.read(box.project), /changed after discovery/);
    assert.throws(() => catalog.read(box.project), /changed after discovery/);
  } finally { catalog?.close(); fs.rmSync(box.root, { recursive: true, force: true }); }
});
