import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as commands from './hook-commands.mjs';
import { readCodexHookDiagnosis } from './codex-hook-diagnosis.mjs';
import * as installed from '../cli/install.mjs';
import { _internal as doctor } from '../cli/doctor.mjs';

test('host hook services preserve the former import references', () => {
  for (const [name, fn] of Object.entries(commands)) {
    assert.equal(installed[name], fn, name);
  }
  assert.equal(doctor.readCodexHookDiagnosis, readCodexHookDiagnosis);
});
