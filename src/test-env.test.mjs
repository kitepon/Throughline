import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DATA_ROOT_ENV } from './test-env.mjs';
import { dataRoot } from './storage-roots.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';

test('test runs never inherit a live data root from the seat', () => {
  for (const key of DATA_ROOT_ENV) assert.equal(process.env[key], undefined, key);
  assert.equal(dataRoot(), join(homedir(), '.throughline'));
});
