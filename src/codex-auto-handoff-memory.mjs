import { loadFrozenLineage, continuationInput } from './codex-auto-handoff-store.mjs';
import { createHash } from 'node:crypto';
import { summarizeToL1 } from './haiku-summarizer.mjs';
import { DB_PATH } from './db.mjs';
import { fileURLToPath } from 'node:url';
import { nodeCliCommand } from './os/shell.mjs';

const CLI_PATH = fileURLToPath(new URL('../bin/throughline.mjs', import.meta.url));

function turnKey(row) { return `${row.origin_session_id}\0${row.turn_number}`; }
function recordKey(row) { return `${turnKey(row)}\0${row.role}`; }

export function collectAutoHandoffMemory(db, operation, { requireSummaries = true } = {}) {
  const lineage = loadFrozenLineage(db, operation);
  const bodies = new Map(), skeletons = new Map(), details = new Map();
  for (const { operation: item, snapshot } of lineage) {
    const previous = lineage.find(entry => entry.operation.handoff_id === item.previous_handoff_id)?.operation;
    const control = previous ? continuationInput(previous) : null;
    for (const row of snapshot.bodies) {
      let text = row.text;
      // この製品が後継の最初に送った制御文だけを表示対象から外す。元データはsnapshotへ残す。
      if (control && row.role === 'user' && row.turn_number === 1) {
        if (text === control) continue;
        if (text.startsWith(`${control}\n\n`)) text = text.slice(control.length + 2);
      }
      bodies.set(recordKey(row), { ...row, text, handoffId: item.handoff_id,
        interrupted: row.turn_number === snapshot.sourceTurnNumber });
    }
    for (const row of snapshot.skeletons) skeletons.set(recordKey(row), { ...row, handoffId: item.handoff_id });
    for (const row of snapshot.details) {
      const key = `${turnKey(row)}\0${row.source_id ?? row.id}\0${row.kind}`;
      details.set(key, { ...row, handoffId: item.handoff_id });
    }
  }
  const rows = [...bodies.values()].sort((a, b) => a.created_at - b.created_at || a.turn_number - b.turn_number);
  const turns = [...new Set(rows.map(turnKey))];
  const recent = new Set(turns.slice(-20));
  const old = new Set(turns.slice(0, -20));
  const summaries = [...skeletons.values()].filter(row => old.has(turnKey(row)));
  for (const key of old) {
    if (summaries.some(row => turnKey(row) === key)) continue;
    const group = rows.filter(row => turnKey(row) === key);
    const first = group[0];
    const cached = db.prepare(`SELECT summary, created_at FROM codex_handoff_summaries
      WHERE origin_session_id = ? AND turn_number = ? AND source_hash = ?`)
      .get(first.origin_session_id, first.turn_number, summarySourceHash(group));
    if (cached) summaries.push({ ...first, role: 'assistant', ...cached });
  }
  const summarized = new Set(summaries.map(turnKey));
  if (requireSummaries && [...old].some(key => !summarized.has(key))) throw new Error('handoff_old_l1_missing');
  return { lineage, bodies: rows, details: [...details.values()],
    recentBodies: rows.filter(row => recent.has(turnKey(row))),
    olderSummaries: summaries.sort((a, b) => a.created_at - b.created_at),
    oldTurnKeys: [...old], turnCount: turns.length, recentTurnCount: recent.size };
}

function summarySourceHash(rows) {
  return createHash('sha256').update(JSON.stringify(rows.map(r => [r.role, r.text]))).digest('hex');
}

export function ensureAutoHandoffSummaries(db, operation, { summarize = summarizeToL1, env = process.env } = {}) {
  const memory = collectAutoHandoffMemory(db, operation, { requireSummaries: false });
  const existing = new Set(memory.olderSummaries.map(turnKey));
  for (const key of memory.oldTurnKeys) {
    if (existing.has(key)) continue;
    const rows = memory.bodies.filter(row => turnKey(row) === key);
    const first = rows[0];
    const text = (rows.some(row => row.interrupted) ? 'このターンは作業途中で中断した記録です。\n' : '') +
      rows.map(row => `[${row.role}]: ${row.text}`).join('\n\n');
    const result = summarize(text, { projectPath: operation.project_path, hostMode: 'codex-primary', env });
    if (!result || typeof result.summary !== 'string' || !result.summary.trim()) throw new Error('handoff_l1_unavailable');
    db.prepare(`INSERT INTO codex_handoff_summaries
      (origin_session_id, turn_number, source_hash, summary, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(origin_session_id, turn_number, source_hash) DO NOTHING`)
      .run(first.origin_session_id, first.turn_number, summarySourceHash(rows), result.summary, first.created_at);
  }
}

function reference(row, operation) {
  return nodeCliCommand(process.execPath, CLI_PATH, ['auto-handoff', 'detail', '--operation', row.handoffId,
    '--origin', row.origin_session_id, '--turn', String(row.turn_number), '--database', operation.runtime?.databasePath ?? DB_PATH]);
}

export function renderAutoHandoffMemory(db, operation) {
  const memory = collectAutoHandoffMemory(db, operation);
  const lines = ['## Throughline: 自動継続文脈', `handoff_id: ${operation.handoff_id}`,
    "source='throughline' / trust='local' / kind='throughline_handoff' / version=1", '',
    '前任の作業途中から継続するための記憶です。新しい記録と、元のユーザーの依頼・合意を優先してください。',
    '完了済みの操作を繰り返さず、直前の実行結果や作業treeが不明なら詳細を取得してから作業してください。',
    'toolの入出力・Thinkingは本文へ注入していません。下記の取得コマンドは凍結した記録だけを返します。',
    `作業ディレクトリ: ${operation.project_path}`, ''];
  const own = memory.lineage.at(-1).snapshot;
  const latestTurn = Math.max(0, ...own.bodies.map(r => r.turn_number), ...own.details.map(r => r.turn_number ?? 0));
  if (latestTurn > 0) {
    lines.push('### 中断地点の取得',
      reference({ handoffId: operation.handoff_id, origin_session_id: operation.source_session_id, turn_number: latestTurn }, operation), '');
  }
  if (memory.olderSummaries.length) {
    lines.push('### 以前の記憶（L1）');
    for (const row of memory.olderSummaries) lines.push(`[${new Date(row.created_at).toISOString()}] ${row.summary} （詳細: ${reference(row, operation)}）`);
    lines.push('');
  }
  lines.push(`### 直近${memory.recentTurnCount}ターンの全文（L2）`);
  for (const row of memory.recentBodies) {
    lines.push(`[${new Date(row.created_at).toISOString()}] [${row.role}]${row.interrupted ? ' [中断したターン]' : ''} ${row.text}`, `（詳細: ${reference(row, operation)}）`, '');
  }
  lines.push('元のユーザー依頼・制約と、実際の完了結果を確認し、未完了の次の作業から継続してください。');
  return lines.join('\n');
}

export function renderFrozenDetail(db, { operationId, originSessionId, turnNumber }) {
  const operation = db.prepare('SELECT snapshot_json FROM codex_handoffs WHERE handoff_id = ?').get(operationId);
  if (!operation?.snapshot_json) throw new Error('handoff_snapshot_unavailable');
  const snapshot = JSON.parse(operation.snapshot_json);
  if (snapshot.version !== 1) throw new Error('handoff_snapshot_version_unsupported');
  const matches = row => row.origin_session_id === originSessionId && row.turn_number === turnNumber;
  const bodies = snapshot.bodies.filter(matches), details = snapshot.details.filter(matches);
  if (!bodies.length && !details.length) throw new Error('handoff_detail_not_found');
  const lines = [`## 凍結した記憶 ${operationId}`, `origin: ${originSessionId} / turn: ${turnNumber}`, '', '### L2'];
  for (const row of bodies) lines.push(`[${row.role}] ${row.text}`, '');
  lines.push('### L3');
  for (const row of details) {
    lines.push(`[${row.kind}] ${row.tool_name}`);
    if (row.input_text != null) lines.push(row.input_text);
    if (row.output_text != null) lines.push(row.output_text);
    lines.push('');
  }
  return lines.join('\n');
}
