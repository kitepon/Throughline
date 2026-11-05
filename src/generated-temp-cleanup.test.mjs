import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { testTempDir } from './test-temp-dir.mjs';
import { writeAutoHandoffConfig } from './codex-auto-handoff-config.mjs';
import { writeClaudeAutoHandoffConfig } from './claude-auto-handoff-config.mjs';

test('a failed config replacement preserves existing data and removes unpublished temporary files', () => {
  for (const writer of [writeAutoHandoffConfig, writeClaudeAutoHandoffConfig]) {
    const dir = testTempDir('tl-temp-cleanup-'), target = join(dir, 'config.json');
    mkdirSync(target); writeFileSync(join(target, 'unique'), 'keep');
    assert.throws(() => writer({ enabled: true }, target));
    assert.equal(readFileSync(join(target, 'unique'), 'utf8'), 'keep');
    assert.deepEqual(readdirSync(dir), ['config.json']);
  }
});
