import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { detailRangeOn, parseDetailArg } from './sc-detail.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN_PATH = join(REPO_ROOT, 'bin/throughline.mjs');

function pad(n) {
  return String(n).padStart(2, '0');
}

function clock(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function ymd(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 今日から daysAgo 日前の、指定した時刻。 */
function daysAgoAt(daysAgo, hours, minutes, seconds) {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, hours, minutes, seconds);
}

function createBox() {
  const home = mkdtempSync(join(tmpdir(), 'tl-sc-detail-'));
  const project = join(home, 'project');
  mkdirSync(project);
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
  };
  const run = (args) =>
    spawnSync(process.execPath, [BIN_PATH, 'detail', ...args], { cwd: project, env, encoding: 'utf8' });
  // detail は cwd の project だけを対象にする。子 process から見える cwd をそのまま記録する
  const cwd = spawnSync(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], {
    cwd: project, env, encoding: 'utf8',
  }).stdout;
  // 最初の実行で製品の schema が作られる
  assert.equal(run(['00:00']).status, 0);
  const db = new DatabaseSync(join(home, '.throughline', 'throughline.db'));
  db.prepare(
    `INSERT INTO sessions (session_id, project_path, status, created_at, updated_at)
     VALUES ('detail-session', ?, 'active', 1, 1)`,
  ).run(cwd);
  const insertBody = db.prepare(
    `INSERT INTO bodies (session_id, origin_session_id, turn_number, role, text, token_count, created_at)
     VALUES ('detail-session', 'detail-session', ?, ?, ?, 1, ?)`,
  );
  const insertDetail = db.prepare(
    `INSERT INTO details
       (session_id, origin_session_id, turn_number, tool_name, input_text, output_text, token_count, created_at, kind, source_id)
     VALUES ('detail-session', 'detail-session', ?, 'Bash', ?, NULL, 1, ?, 'tool_input', ?)`,
  );
  let turn = 0;
  const addTurn = (date, label) => {
    turn += 1;
    insertBody.run(turn, 'user', `${label}_REQUEST`, date.getTime());
    insertBody.run(turn, 'assistant', `${label}_ANSWER`, date.getTime() + 400);
    insertDetail.run(turn, `${label}_COMMAND`, date.getTime() + 200, `tool-${turn}`);
  };
  return { home, run, addTurn, close: () => db.close() };
}

test('parseDetailArg: 時刻だけ、日付つき、範囲を解釈する', () => {
  assert.deepEqual(parseDetailArg('19:20:25'), {
    from: { date: null, hours: 19, minutes: 20, seconds: 25 },
    to: { date: null, hours: 19, minutes: 20, seconds: 25 },
  });
  assert.deepEqual(parseDetailArg('9:05').from, { date: null, hours: 9, minutes: 5, seconds: null });
  const date = { year: 2026, month: 10, day: 4 };
  assert.deepEqual(parseDetailArg('2026-10-04T19:20:25').from, { date, hours: 19, minutes: 20, seconds: 25 });
  assert.deepEqual(parseDetailArg('2026-10-04 19:20').from, { date, hours: 19, minutes: 20, seconds: null });
  // 範囲: 終了の日付を省くと開始と同じ日
  assert.deepEqual(parseDetailArg('19:20:25-19:30:00'), {
    from: { date: null, hours: 19, minutes: 20, seconds: 25 },
    to: { date: null, hours: 19, minutes: 30, seconds: 0 },
  });
  assert.deepEqual(parseDetailArg('2026-10-04T23:50:00-23:59:59'), {
    from: { date, hours: 23, minutes: 50, seconds: 0 },
    to: { date, hours: 23, minutes: 59, seconds: 59 },
  });
  assert.deepEqual(parseDetailArg('2026-10-04T23:50:00-2026-10-05T00:10:00').to, {
    date: { year: 2026, month: 10, day: 5 }, hours: 0, minutes: 10, seconds: 0,
  });
  for (const invalid of ['', 'abc', '19', '2026-10-04', '2026-10-04T', '19:20:25-', '19:20:25-abc', '10-04T19:20:25']) {
    assert.equal(parseDetailArg(invalid), null, invalid);
  }
});

test('detailRangeOn: 日付の無い時刻は渡した日に、日付つきはその日に置く', () => {
  const base = new Date(2026, 9, 5, 3, 0, 0);
  assert.deepEqual(detailRangeOn(parseDetailArg('19:20:25'), base), {
    start: new Date(2026, 9, 5, 19, 20, 25, 0).getTime(),
    end: new Date(2026, 9, 5, 19, 20, 25, 999).getTime(),
  });
  // 秒を省くと、その分の全部
  assert.deepEqual(detailRangeOn(parseDetailArg('19:20'), base), {
    start: new Date(2026, 9, 5, 19, 20, 0, 0).getTime(),
    end: new Date(2026, 9, 5, 19, 20, 59, 999).getTime(),
  });
  assert.deepEqual(detailRangeOn(parseDetailArg('2026-10-04T19:20:25-19:30'), base), {
    start: new Date(2026, 9, 4, 19, 20, 25, 0).getTime(),
    end: new Date(2026, 9, 4, 19, 30, 59, 999).getTime(),
  });
});

test('detail: 日付を省いた時刻は、今日に無ければ遡って最も新しい日のターンを返す', () => {
  const box = createBox();
  try {
    const yesterday = daysAgoAt(1, 19, 20, 25);
    const older = daysAgoAt(3, 19, 20, 25);
    box.addTurn(older, 'OLDER');
    box.addTurn(yesterday, 'YESTERDAY');
    box.close();

    const bare = box.run([clock(yesterday)]);
    assert.equal(bare.status, 0, bare.stderr);
    assert.match(bare.stdout, new RegExp(`指定時刻: 19:20:25（${ymd(yesterday)}）  対象ターン数: 1\\n`));
    assert.match(bare.stdout, /\[19:20:25\] \[user\]: YESTERDAY_REQUEST/);
    assert.match(bare.stdout, /YESTERDAY_ANSWER/);
    assert.match(bare.stdout, /IN {2}Bash\n {2}IN: {2}YESTERDAY_COMMAND/);
    // 同じ時刻のもっと古い日のターンは混ぜない
    assert.doesNotMatch(bare.stdout, /OLDER_/);

    // 日付を付ければ、その日のターンを引ける
    const dated = box.run([`${ymd(older)}T19:20:25`]);
    assert.equal(dated.status, 0, dated.stderr);
    assert.match(dated.stdout, new RegExp(`指定時刻: ${ymd(older)}T19:20:25  対象ターン数: 1\\n`));
    assert.match(dated.stdout, /OLDER_REQUEST/);
    assert.match(dated.stdout, /OLDER_COMMAND/);
    assert.doesNotMatch(dated.stdout, /YESTERDAY_/);

    const range = box.run([`${ymd(older)}T19:20-19:21`]);
    assert.equal(range.status, 0, range.stderr);
    assert.match(range.stdout, /OLDER_REQUEST/);
    assert.doesNotMatch(range.stdout, /YESTERDAY_/);
  } finally {
    rmSync(box.home, { recursive: true, force: true });
  }
});

test('detail: 今日のターンはそのまま返し、無い時刻と無効な書き方は今までどおり知らせる', () => {
  const box = createBox();
  try {
    const earlier = daysAgoAt(2, 8, 15, 0);
    // 今日の 00:00:00 は、いつ実行しても過去の時刻
    const today = daysAgoAt(0, 0, 0, 0);
    box.addTurn(earlier, 'EARLIER');
    box.addTurn(today, 'TODAY');
    box.close();

    const found = box.run(['00:00:00']);
    assert.equal(found.status, 0, found.stderr);
    assert.match(found.stdout, /指定時刻: 00:00:00 {2}対象ターン数: 1\n/);
    assert.match(found.stdout, /TODAY_REQUEST/);

    // この project の記録に無い時刻
    const missing = box.run(['13:13:13']);
    assert.equal(missing.status, 0, missing.stderr);
    assert.match(missing.stdout, /指定時刻 13:13:13 に該当するターンが見つかりませんでした。/);
    // 日付を付けた時は、その日だけを見る
    const wrongDay = box.run([`${ymd(daysAgoAt(1, 0, 0, 0))}T08:15:00`]);
    assert.equal(wrongDay.status, 0, wrongDay.stderr);
    assert.match(wrongDay.stdout, /に該当するターンが見つかりませんでした。/);

    const invalid = box.run(['yesterday']);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /時刻フォーマットが無効: yesterday/);
  } finally {
    rmSync(box.home, { recursive: true, force: true });
  }
});
