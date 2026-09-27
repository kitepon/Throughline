import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/throughline.mjs', import.meta.url));

test('公開CLIは部屋ごとの直近3発言を現在の発言まで返す', () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-room-context-'));
  const run = (input) => spawnSync(process.execPath, [bin, 'room-context', '--json'], {
    env: { ...process.env, HOME: home }, input: JSON.stringify(input), encoding: 'utf8',
  });
  const base = { projectPath: '/srv/bellteam', roomId: 'room-a', speaker: 'クオ', text: '発言' };
  try {
    for (let n = 1; n <= 4; n++) {
      const result = run({ ...base, messageId: `message-${n}`, text: `発言${n}` });
      assert.equal(result.status, 0, result.stderr);
      const value = JSON.parse(result.stdout);
      assert.equal(value.schema, 'throughline.room_context.v1');
      assert.deepEqual(value.turns.map(turn => turn.text),
        Array.from({ length: Math.min(n, 3) }, (_, index) => `発言${n - Math.min(n, 3) + index + 1}`));
    }
    const another = run({ ...base, roomId: 'room-b', messageId: 'message-5', text: '別の部屋' });
    assert.equal(another.status, 0, another.stderr);
    assert.deepEqual(JSON.parse(another.stdout).turns.map(turn => turn.text), ['別の部屋']);

    const replay = run({ ...base, messageId: 'message-2', text: '発言2' });
    assert.equal(replay.status, 0, replay.stderr);
    assert.deepEqual(JSON.parse(replay.stdout).turns.map(turn => turn.text), ['発言1', '発言2']);

    const conflict = run({ ...base, messageId: 'message-2', text: '改変' });
    assert.equal(conflict.status, 1);
    assert.equal(JSON.parse(conflict.stderr).code, 'E_ROOM_CONTEXT_RECORD');
    assert.equal(conflict.stderr.includes('改変'), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
