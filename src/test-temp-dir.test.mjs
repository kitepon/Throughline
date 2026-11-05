import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testTempDir } from './test-temp-dir.mjs';

test('the next test reclaims expired scratch from dead creators, preserving live and legacy directories', () => {
  const prefix = `tl-gc-selfcheck-${randomUUID()}-`;
  const dead = join(tmpdir(), `${prefix}2147483647-AbCdEf`);
  const live = join(tmpdir(), `${prefix}${process.pid}-GhIjKl`);
  const legacy = join(tmpdir(), `${prefix}MnOpQr`);
  try {
    for (const path of [dead, live, legacy]) {
      mkdirSync(path, { mode: 0o700 });
      const old = new Date(Date.now() - 48 * 3600000); utimesSync(path, old, old);
    }
    const current = testTempDir(prefix);
    assert.equal(existsSync(dead), false);
    assert.equal(existsSync(live), true);
    assert.equal(existsSync(legacy), true);
    assert.equal(existsSync(current), true);
  } finally { for (const path of [dead, live, legacy]) rmSync(path, { recursive: true, force: true }); }
});
