#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  markdownLinkTargets,
  relativeMarkdownLinkTargets,
} from './markdown-link-targets.mjs';
import { spawnPortableSync } from '../src/os/portable-spawn-sync.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function extractMarkdownTargets(source) {
  return markdownLinkTargets(source);
}

export function findMissingPackedTargets(packagePath, source, packedFiles) {
  const failures = [];
  const links = relativeMarkdownLinkTargets(source);
  for (const link of links) {
    const resolvedTarget = posix.normalize(posix.join(posix.dirname(packagePath), link.target));
    if (
      resolvedTarget === '..'
      || resolvedTarget.startsWith('../')
      || !containsTarget(packedFiles, resolvedTarget)
    ) {
      failures.push(`${packagePath}:${link.line}: tarball外の相対target ${link.raw}`);
    }
  }
  return { checked: links.length, failures };
}

export function packedFileSet(report) {
  const packed = Array.isArray(report) && report.length === 1 ? report[0] : report?.throughline;
  if (!Array.isArray(packed?.files)) throw new Error('npm pack dry-run JSON shape invalid');
  return new Set(packed.files.map((entry) => entry.path));
}

function packFileSet() {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnPortableSync(npmCommand, ['pack', '--dry-run', '--ignore-scripts', '--json'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`npm pack dry-run failed: ${result.stderr.trim()}`);
  return packedFileSet(JSON.parse(result.stdout));
}

function containsTarget(packedFiles, target) {
  if (packedFiles.has(target)) return true;
  const prefix = target === '.' ? '' : `${target.replace(/\/$/, '')}/`;
  return [...packedFiles].some((path) => path.startsWith(prefix));
}

function run() {
  const packed = packFileSet();
  const failures = [];
  let checked = 0;
  const markdownPaths = [...packed].filter((path) => path.endsWith('.md')).sort();

  for (const packagePath of markdownPaths) {
    const source = readFileSync(resolve(root, packagePath), 'utf8');
    const result = findMissingPackedTargets(packagePath, source, packed);
    checked += result.checked;
    failures.push(...result.failures);
  }

  if (failures.length > 0) {
    process.stderr.write(`${failures.join('\n')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`packed Markdown links: ok (${markdownPaths.length} Markdown, ${checked} relative targets)\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
