import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  extractMarkdownTargets,
  findMissingPackedTargets,
  packedFileSet,
} from '../scripts/verify-pack-markdown-links.mjs';
import { spawnPortableSync } from './os/portable-spawn-sync.mjs';

test('梱包文書検査はnpmの旧配列形式とpackage名をキーにする形式を読む', () => {
  const packed = { name: 'throughline', files: [{ path: 'README.md' }, { path: 'docs/00_overview.md' }] };
  for (const report of [[packed], { throughline: packed }]) {
    assert.deepEqual([...packedFileSet(report)], ['README.md', 'docs/00_overview.md']);
  }
  for (const report of [null, {}, [], [packed, packed], { throughline: { files: null } }]) {
    assert.throws(() => packedFileSet(report), /npm pack dry-run JSON shape invalid/);
  }
});

test('Markdown-only CI runs the product-owned documentation contract', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(
    packageJson.scripts['verify:docs'],
    'node scripts/verify-docs.mjs && node scripts/verify-pack-markdown-links.mjs',
  );

  const workflow = readFileSync(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8');
  assert.match(workflow, /uses:\s+\.\/\.github\/workflows\/product-full-ci\.yml/);
  assert.match(
    workflow,
    /dependency-command:\s+npm install --ignore-scripts --no-package-lock --no-audit --no-fund/,
  );
  assert.match(
    workflow,
    /documentation-command:\s+npm run verify:docs/,
  );
  assert.doesNotMatch(workflow, /documentation-command:\s*(?:["']{2})?\s*$/m);

  const reusable = readFileSync(new URL('../.github/workflows/product-full-ci.yml', import.meta.url), 'utf8');
  const runner = readFileSync(new URL('../scripts/run-product-ci-tests.mjs', import.meta.url), 'utf8');
  assert.match(reusable, /name: documentation dependency install/);
  assert.match(reusable, /scripts\/product-ci-plan\.mjs verify/);
  assert.ok(
    reusable.indexOf('documentation dependency install') < reusable.indexOf('- name: documentation check'),
    'documentation dependencies must be installed before verification',
  );
  assert.doesNotMatch(runner, /npm\.cmd|cmd\.exe/);

  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnPortableSync(npmCommand, ['run', 'verify:docs', '--silent'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /docs verified:/);
  assert.match(result.stdout, /packed Markdown links:/);
});

test('現行文書は版の正本を参照し、変更履歴は候補版と一致する', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const version = packageJson.version;
  const currentSources = [
    readFileSync(new URL('../README.md', import.meta.url), 'utf8'),
    readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8'),
    readFileSync(new URL('../docs/04_public_release_plan.md', import.meta.url), 'utf8'),
  ];
  for (const source of currentSources) {
    assert.match(source, /`package\.json`/);
    assert.match(source, /公開版はnpm|公開版は冒頭のnpm/);
  }

  const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  assert.match(changelog, new RegExp(`^## \\[${version.replaceAll('.', '\\.')}\\]`, 'm'));
  assert.match(changelog, new RegExp(`^\\[Unreleased\\]: .+/compare/v${version.replaceAll('.', '\\.')}\\.\\.\\.HEAD$`, 'm'));
});

test('packed Markdown closure covers nested links, balanced targets, references, and HTML images', () => {
  const markdown = [
    '[![inner](docs/inner.md)](docs/outer.md)',
    '[balanced](docs/name_(draft).md)',
    '',
    '[reference]: docs/reference.md "title"',
    '[continued]:',
    '  docs/continued.md',
    '',
    '<img src="images/hero.png" srcset="images/hero.png 1x, images/hero@2x.png 2x">',
    '`[ignored](missing.md)`',
    '```md',
    '[also ignored](missing.md)',
    '```',
  ].join('\n');

  assert.deepEqual(
    extractMarkdownTargets(markdown).map(({ raw }) => raw),
    [
      'docs/outer.md',
      'docs/inner.md',
      'docs/name_(draft).md',
      'docs/reference.md',
      'docs/continued.md',
      'images/hero.png',
      'images/hero.png',
      'images/hero@2x.png',
    ],
  );

  const packed = new Set([
    'README.md',
    'docs/inner.md',
    'docs/outer.md',
    'docs/name_(draft).md',
    'docs/reference.md',
    'docs/continued.md',
    'images/hero.png',
  ]);
  const result = findMissingPackedTargets('README.md', markdown, packed);
  assert.equal(result.checked, 8);
  assert.deepEqual(result.failures, [
    'README.md:8: tarball外の相対target images/hero@2x.png',
  ]);
});

test('documentation parser follows CommonMark code, reference, entity, and HTML attribute boundaries', () => {
  const markdown = [
    '    [indented code](missing-indented.md)',
    '``code [real](docs/real.md)```',
    '',
    '[escaped\\]]: docs/escaped.md',
    '> [quoted]: docs/quoted.md',
    '- [listed]: docs/listed.md',
    '[bad]: docs/not-a-definition.md "unterminated',
    '',
    '[entity](assets/a&amp;b.png)',
    '[not a link](',
    '',
    'missing-blank.md)',
    '<div title="note href=\'missing-fake.md\'"><img src="assets/real.png"></div>',
    '<source srcset="assets/crop,wide.png 1x, assets/next.png 2x">',
  ].join('\n');

  assert.deepEqual(
    extractMarkdownTargets(markdown).map(({ raw }) => raw),
    [
      'docs/real.md',
      'docs/escaped.md',
      'docs/quoted.md',
      'docs/listed.md',
      'assets/a&b.png',
      'assets/real.png',
      'assets/crop,wide.png',
      'assets/next.png',
    ],
  );
});

test('current product docs expose one self-update entry instead of a manual update sequence', () => {
  const root = new URL('..', import.meta.url);
  const read = (path) => readFileSync(new URL(path, root), 'utf8');
  for (const path of ['README.md', 'README.ja.md', 'docs/04_public_release_plan.md']) {
    assert.match(read(path), /throughline self-update/u, `${path} is missing the product update entry`);
  }
  const releaseContract = read('docs/04_public_release_plan.md');
  assert.doesNotMatch(
    releaseContract,
    /npm install -g throughline@latest.*throughline install.*throughline migrate.*throughline doctor/su,
  );
});
