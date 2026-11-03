import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { createObserverCheckCatalog } from './observer-turn-feed.mjs';

export const OBSERVER_CHECK_REQUEST_SCHEMA = 'throughline.observer_check_request.v1';
export const OBSERVER_CHECK_RESULT_SCHEMA = 'throughline.observer_check_result.v1';
export const OBSERVER_CHECK_MAX_INPUT_BYTES = 1024 * 1024;
const TOKEN_PREFIX = 'tloc1.';

export function observerCheckError(code) { return Object.assign(new Error(code), { code }); }
export function assertObserverCheckActive(signal) {
  if (signal?.aborted) throw observerCheckError('E_OBSERVER_CHECK_CANCELLED');
}

export function validateObserverCheckRequest(request) {
  if (!exactKeys(request, ['schema', 'projects']) || request.schema !== OBSERVER_CHECK_REQUEST_SCHEMA ||
    !Array.isArray(request.projects) || request.projects.length < 1 || request.projects.length > 256) {
    throw observerCheckError('E_OBSERVER_CHECK_ARGS');
  }
  const ids = new Set();
  const projects = [];
  for (const item of request.projects) {
    if (!exactKeys(item, ['id', 'projectPath', 'after']) || !boundedString(item.id, 128) || ids.has(item.id) ||
      !boundedString(item.projectPath, 4096) || !isAbsolute(item.projectPath) ||
      !(item.after === null || boundedString(item.after, 512))) {
      throw observerCheckError('E_OBSERVER_CHECK_ARGS');
    }
    ids.add(item.id);
    projects.push({ id: item.id, projectPath: item.projectPath, after: item.after });
  }
  const validated = { schema: OBSERVER_CHECK_REQUEST_SCHEMA, projects };
  if (Buffer.byteLength(JSON.stringify(validated), 'utf8') > OBSERVER_CHECK_MAX_INPUT_BYTES) throw observerCheckError('E_OBSERVER_CHECK_ARGS');
  return validated;
}

export async function checkObserverProjects(request, {
  signal, createCatalog = createObserverCheckCatalog, codexHome, receiptOptions,
} = {}) {
  request = validateObserverCheckRequest(request);
  const cache = new Map();
  const results = [];
  let catalog;
  try {
    for (const item of request.projects) {
      await yieldTurn(); assertObserverCheckActive(signal);
      let project;
      try {
        project = realpathSync.native(item.projectPath);
        if (!statSync(project).isDirectory()) throw new Error('project unavailable');
      } catch {
        results.push({ id: item.id, ...sourceError() }); continue;
      }
      const projectSha256 = createHash('sha256').update(project, 'utf8').digest('hex');
      const prior = item.after === null ? null : decodeToken(item.after);
      if (item.after !== null && (!prior || prior.p !== projectSha256)) {
        results.push({ id: item.id, status: 'resync_required', token: null }); continue;
      }
      // Discovery failures affect the whole request; per-project source failures do not.
      catalog ??= createCatalog({ codexHome, receiptOptions });
      if (!cache.has(project)) {
        let snapshot;
        try {
          snapshot = catalog.read(project);
          if (snapshot.ambiguous) snapshot = null;
        } catch { snapshot = null; }
        cache.set(project, snapshot);
      }
      const snapshot = cache.get(project);
      if (!snapshot) { results.push({ id: item.id, ...sourceError() }); continue; }
      if (snapshot.projectSha256 !== projectSha256 || !isSha256(snapshot.fingerprint)) {
        throw observerCheckError('E_OBSERVER_CHECK_INTERNAL');
      }
      const token = encodeToken({ v: 1, p: projectSha256, f: snapshot.fingerprint });
      results.push({ id: item.id, status: prior?.f === snapshot.fingerprint ? 'unchanged' : 'changed', token });
    }
    await yieldTurn(); assertObserverCheckActive(signal);
    return { schema: OBSERVER_CHECK_RESULT_SCHEMA, status: 'complete', results };
  } finally { cache.clear(); catalog?.close(); }
}

function sourceError() { return { status: 'error', token: null, code: 'E_OBSERVER_CHECK_SOURCE' }; }
function encodeToken(value) { return TOKEN_PREFIX + Buffer.from(JSON.stringify(value), 'utf8').toString('base64url'); }
function decodeToken(token) {
  if (!/^tloc1\.[A-Za-z0-9_-]+$/.test(token)) return null;
  try {
    const encoded = token.slice(TOKEN_PREFIX.length);
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) return null;
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!exactKeys(value, ['v', 'p', 'f']) || value.v !== 1 || !isSha256(value.p) || !isSha256(value.f) || encodeToken({ v: value.v, p: value.p, f: value.f }) !== token) return null;
    return value;
  } catch { return null; }
}
function isSha256(value) { return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value); }
function boundedString(value, max) { return typeof value === 'string' && Buffer.byteLength(value, 'utf8') >= 1 && Buffer.byteLength(value, 'utf8') <= max; }
function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
