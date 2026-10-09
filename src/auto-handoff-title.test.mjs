import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoHandoffProjectName, autoHandoffSummaryOf, composeAutoHandoffTitle, markHandedOffTitle } from './auto-handoff-title.mjs';

test('名前は「project 名｜作業の概要（自動引き継ぎ）」の形にする', () => {
  assert.equal(composeAutoHandoffTitle({ projectPath: '/Users/kite/Developer/BellTeam', titles: ['ASCからの連絡を確認'] }),
    'BellTeam｜ASCからの連絡を確認（自動引き継ぎ）');
  assert.equal(composeAutoHandoffTitle({ projectPath: '/work/app', titles: [null, '', '  ', '2つ目の候補'] }),
    'app｜2つ目の候補（自動引き継ぎ）', '使える最初の候補を採る');
  assert.equal(composeAutoHandoffTitle({ projectPath: '/work/app' }), 'app（自動引き継ぎ）', '概要が取れない時は project 名と印だけ');
});

test('project 名は場所の最後のフォルダ名。Windows の場所を他の OS で読んでも同じ', () => {
  assert.equal(autoHandoffProjectName('C:\\Users\\kite_\\Developer\\Throughline'), 'Throughline');
  assert.equal(autoHandoffProjectName('C:\\Users\\kite_\\tl-claude-probe\\'), 'tl-claude-probe');
  assert.equal(autoHandoffProjectName('/srv/bellteam/bots/bot-220e0f1b/'), 'bot-220e0f1b');
  assert.equal(autoHandoffProjectName(null), '');
});

test('前任がこの形の名前を持つ後継なら、中の概要だけを取り出す', () => {
  const first = composeAutoHandoffTitle({ projectPath: '/work/app', titles: ['hookの失敗を直す'] });
  assert.equal(autoHandoffSummaryOf(first), 'hookの失敗を直す');
  assert.equal(composeAutoHandoffTitle({ projectPath: '/work/app', titles: [first] }), first, '引き継ぎを重ねても同じ名前');
  assert.equal(composeAutoHandoffTitle({ projectPath: '/work/moved', titles: [first] }), 'moved｜hookの失敗を直す（自動引き継ぎ）',
    'project 名は今の場所から付け直す');
  assert.equal(autoHandoffSummaryOf('app（自動引き継ぎ）'), null, '概要の無い名前からは、概要を作らない');
  assert.equal(composeAutoHandoffTitle({ projectPath: '/work/app', titles: ['app（自動引き継ぎ）', '元の依頼'] }),
    'app｜元の依頼（自動引き継ぎ）');
});

test('継続の指示は概要にしない（名前の無い後継は、これが題として見える）', () => {
  const claude = 'Throughline自動継続 89903aed-a0a8-486e-9932-a10ce526d2d5\n注入された記憶と元のユーザー依頼に従い、未完了の作業をそのまま継続してください。';
  const codex = 'Throughline自動継続 89903aed-a0a8-486e-9932-a10ce526d2d5 / b90f43ab-7056-4216-9737-a7430a6768ca\n注入された記憶と…';
  assert.equal(autoHandoffSummaryOf(claude), null);
  assert.equal(autoHandoffSummaryOf(codex), null);
  assert.equal(composeAutoHandoffTitle({ projectPath: '/work/app', titles: [codex, 'ASCからの連絡を確認'] }),
    'app｜ASCからの連絡を確認（自動引き継ぎ）');
  assert.equal(autoHandoffSummaryOf('Throughline自動継続の試験'), 'Throughline自動継続の試験', '人が付けた題は残す');
});

test('概要は最初の行を1行にして、長さを抑える', () => {
  assert.equal(autoHandoffSummaryOf('\n  1行目の  依頼\t文  \n2行目'), '1行目の 依頼 文');
  assert.equal(autoHandoffSummaryOf('say "hello" & exit'), 'say hello & exit', '二重引用符は落とす');
  const long = autoHandoffSummaryOf('あ'.repeat(100));
  assert.equal(Array.from(long).length, 40);
  assert.ok(long.endsWith('…'));
  assert.equal(autoHandoffSummaryOf(long), long, '切った概要は、もう一度通しても変わらない');
  assert.equal(Array.from(autoHandoffSummaryOf(`${'😀'.repeat(50)}`)).length, 40, '絵文字を途中で割らない');
  assert.equal(autoHandoffSummaryOf(undefined), null);
});

test('引き継ぎ済みの印は名前の頭に付け、元の名前を残す。印を重ねない', () => {
  assert.equal(markHandedOffTitle('kitepon.devのメールアドレス作成方法'), '【引き継ぎ済み】kitepon.devのメールアドレス作成方法');
  assert.equal(markHandedOffTitle('BellTeam｜ベルチーム（自動引き継ぎ）'), '【引き継ぎ済み】BellTeam｜ベルチーム（自動引き継ぎ）');
  assert.equal(markHandedOffTitle('【引き継ぎ済み】ベルチーム'), null, 'もう印がある名前は付け直さない');
  assert.equal(markHandedOffTitle('1行目\n2行目'), '【引き継ぎ済み】1行目', '名前の無いタスクの依頼文は1行目だけ使う');
  assert.equal(Array.from(markHandedOffTitle('あ'.repeat(200))).length, '【引き継ぎ済み】'.length + 60, '長い依頼文は切る');
  for (const value of [null, undefined, '', '  ', 'Throughline自動継続 39cdb98e-9e68-4dff-8a53-38d1fd861a8b']) {
    assert.equal(markHandedOffTitle(value), null);
  }
});

test('印の付いた旧タスクの名前から概要を取る時は、印を外す', () => {
  assert.equal(autoHandoffSummaryOf('【引き継ぎ済み】BellTeam｜ベルチーム（自動引き継ぎ）'), 'ベルチーム');
  assert.equal(autoHandoffSummaryOf('【引き継ぎ済み】ベルチーム'), 'ベルチーム');
  assert.equal(composeAutoHandoffTitle({ projectPath: '/work/BellTeam', titles: ['【引き継ぎ済み】BellTeam｜ベルチーム（自動引き継ぎ）'] }),
    'BellTeam｜ベルチーム（自動引き継ぎ）');
});
