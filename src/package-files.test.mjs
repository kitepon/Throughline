import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('npm package files include Claude and Codex agent surfaces', () => {
  assert.deepEqual(packageJson.files, [
    'bin/',
    'src/',
    'codex/skills/',
    '.claude/commands/',
    'docs/',
    'rag/',
    'CHANGELOG.md',
    'README.md',
    'LICENSE',
  ]);
});
