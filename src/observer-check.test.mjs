import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkObserverProjects, validateObserverCheckRequest, OBSERVER_CHECK_REQUEST_SCHEMA as schema } from './observer-check.mjs';

const input = (projectPath, after = null, id = 'one') => ({ schema, projects: [{ id, projectPath, after }] });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'tl-check-core-')); const project = join(root, 'project');
  mkdirSync(project); return { root, project };
}
const digest = (value) => createHash('sha256').update(value).digest('hex');
function source({ fingerprint = digest('completed'), ambiguous = false, readError = false } = {}) {
  const state = { made: 0, reads: 0, closed: 0 };
  state.createCatalog = () => { state.made++; return {
    read(project) { state.reads++; if (readError) throw new Error('/private/source'); return { projectSha256: digest(project), fingerprint, ambiguous }; },
    close() { state.closed++; },
  }; };
  return state;
}

test('check request rejects every structural, field and byte error before source access', async () => {
  const base = input('/project');
  const invalid = [null, {}, { ...base, extra: true }, { ...base, schema: 'old' }, { schema, projects: [] },
    { schema, projects: Array.from({ length: 257 }, (_, i) => ({ id: String(i), projectPath: '/p', after: null })) },
    { schema, projects: [base.projects[0], base.projects[0]] }];
  for (const patch of [{ id: '' }, { id: '字'.repeat(43) }, { projectPath: 'relative' }, { projectPath: '/'+ 'a'.repeat(4096) },
    { after: '' }, { after: 1 }, { after: 'x'.repeat(513) }, { extra: 1 }]) invalid.push({ schema, projects: [{ ...base.projects[0], ...patch }] });
  invalid.push({ schema, projects: Array.from({ length: 256 }, (_, i) => ({ id: String(i), projectPath: '/'+ '\u0001'.repeat(4095), after: null })) });
  for (const request of invalid) {
    const state = source(); await assert.rejects(checkObserverProjects(request, state), { code: 'E_OBSERVER_CHECK_ARGS' }); assert.equal(state.made, 0);
  }
  const request = input('/project'); const validated = validateObserverCheckRequest(request);
  request.projects[0].id = 'mutated'; assert.equal(validated.projects[0].id, 'one');
});

test('check tokens are bounded, deterministic and project bound; fingerprint changes require read', async () => {
  const box = fixture();
  try {
    const initial = await checkObserverProjects(input(box.project), source()); const token = initial.results[0].token;
    assert.equal(initial.results[0].status, 'changed'); assert.match(token, /^tloc1\.[A-Za-z0-9_-]+$/); assert.ok(Buffer.byteLength(token) <= 512);
    const same = await checkObserverProjects(input(box.project, token), source());
    assert.deepEqual(same.results[0], { id: 'one', status: 'unchanged', token });
    assert.equal((await checkObserverProjects(input(box.project, token), source({ fingerprint: digest('rolled back') }))).results[0].status, 'changed');
    for (const after of ['unknown', 'tlc1.cursor', token+'=', 'tloc1.e30']) {
      const state = source(); const result = await checkObserverProjects(input(box.project, after), state);
      assert.equal(result.results[0].status, 'resync_required'); assert.equal(state.reads, 0);
    }
    const value = JSON.parse(Buffer.from(token.slice(6), 'base64url'));
    for (const changed of [{ ...value, v: 2 }, { ...value, p: digest('other') }, { f: value.f, p: value.p, v: value.v }, { ...value, extra: true }]) {
      const after = 'tloc1.'+Buffer.from(JSON.stringify(changed)).toString('base64url');
      assert.equal((await checkObserverProjects(input(box.project, after), source())).results[0].status, 'resync_required');
    }
  } finally { rmSync(box.root, { recursive: true, force: true }); }
});

test('check preserves request order, reuses canonical projects and isolates item source failures', async () => {
  const box = fixture();
  try {
    const alias = join(box.root, 'alias'); symlinkSync(box.project, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const request = { schema, projects: [{ id: 'a', projectPath: box.project, after: null }, { id: 'b', projectPath: alias, after: null }, { id: 'missing', projectPath: join(box.root, 'missing'), after: null }] };
    const state = source(); const result = await checkObserverProjects(request, state);
    assert.deepEqual(result.results.map(x => x.id), ['a','b','missing']); assert.equal(result.results[0].token, result.results[1].token);
    assert.equal(state.reads, 1); assert.equal(state.closed, 1); assert.equal(result.results[2].code, 'E_OBSERVER_CHECK_SOURCE');
    for (const options of [{ ambiguous: true }, { readError: true }]) {
      const failure = source(options); const item = (await checkObserverProjects(input(box.project), failure)).results[0];
      assert.deepEqual(item, { id: 'one', status: 'error', token: null, code: 'E_OBSERVER_CHECK_SOURCE' }); assert.equal(failure.closed, 1);
    }
    await assert.rejects(checkObserverProjects(input(box.project), { createCatalog() { throw new Error('catalog failure'); } }), /catalog failure/);
  } finally { rmSync(box.root, { recursive: true, force: true }); }
});

test('check cancellation before creation and after source work rejects the entire request and closes it', async () => {
  const box = fixture();
  try {
    const early = new AbortController(); early.abort(); const unused = source();
    await assert.rejects(checkObserverProjects(input(box.project), { ...unused, signal: early.signal }), { code: 'E_OBSERVER_CHECK_CANCELLED' }); assert.equal(unused.made, 0);
    const controller = new AbortController(); let closed = 0;
    await assert.rejects(checkObserverProjects(input(box.project), { signal: controller.signal, createCatalog: () => ({
      read(project) { controller.abort(); return { projectSha256: digest(project), fingerprint: digest('done') }; }, close() { closed++; },
    }) }), { code: 'E_OBSERVER_CHECK_CANCELLED' }); assert.equal(closed, 1);
  } finally { rmSync(box.root, { recursive: true, force: true }); }
});
