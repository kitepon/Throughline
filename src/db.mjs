/**
 * SQLite 接続管理 — node:sqlite (Node.js v22.5+ 組み込み、依存ゼロ)
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const DB_DIR = join(homedir(), '.throughline');
export const DB_PATH = join(DB_DIR, 'throughline.db');
export const DB_BUSY_TIMEOUT_MS = 5_000;
// WAL が checkpoint で巻き戻った後、次の書き込みでファイルをこの大きさまで切り詰める (ADR 0042)。
// 既定 (-1) は切り詰めないので、一度膨らんだ WAL は中身が空でも元の大きさのまま残る。
export const WAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;
export const CURRENT_VERSION = 12;

let _db = null;

export function openReadOnlyDb(path = DB_PATH) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${DB_BUSY_TIMEOUT_MS}`);
    settleFirstRead(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

const WAL_SWITCH_RETRY_MS = 25;

function isSqliteBusy(error) {
  if (typeof error?.errcode === 'number') return (error.errcode & 0xff) === 5;
  return /database is locked/u.test(String(error?.message ?? ''));
}

function isSqliteIoError(error) {
  if (typeof error?.errcode === 'number') return (error.errcode & 0xff) === 10;
  return /disk I\/O error/u.test(String(error?.message ?? ''));
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 開いた接続の最初の読み取りを済ませる。`disk I/O error` の間は 25ms ごとに読み直す (ADR 0036)。
 *
 * Windows では、DB を閉じずに終わった process の片付けと、次の process の最初の読み取りが重なると、
 * SQLite が WAL の索引 (-shm) を切り詰められず `disk I/O error` (SQLITE_IOERR_TRUNCATE) を返す。
 * hook は DB を閉じずに終わるので、同じ hook が続けて走る会話で起きる。重なりは 100ms ほどで解ける。
 * 最初の読み取りが通った接続は索引を持ち続けるので、後の読み書きではこの形にならない。
 * 読み取り専用の接続でも起きるので、Throughline の DB を開く所は全部ここを通す。
 * @param {DatabaseSync} db
 * @param {{ timeoutMs?: number }} [options]
 */
export function settleFirstRead(db, { timeoutMs = DB_BUSY_TIMEOUT_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      db.prepare('PRAGMA user_version').get();
      return;
    } catch (error) {
      if (!isSqliteIoError(error) || Date.now() >= deadline) throw error;
      sleepSync(WAL_SWITCH_RETRY_MS);
    }
  }
}

/**
 * journal mode を WAL にする。既に WAL なら何も書かない。
 *
 * WAL への切り替えは排他 lock を要り、他の process が同じ DB を開いている間は busy_timeout を待たずに
 * `database is locked` で断られる。新しい DB を複数の hook が同時に開く時に起きるので、
 * busy_timeout と同じ時間まで読み直す (ADR 0031)。他の process が先に切り替えれば、読み直しで WAL が見える。
 */
function ensureWalJournalMode(db) {
  const deadline = Date.now() + DB_BUSY_TIMEOUT_MS;
  for (;;) {
    try {
      const journalMode = db.prepare('PRAGMA journal_mode').get().journal_mode;
      if (String(journalMode).toLowerCase() === 'wal') return;
      db.exec('PRAGMA journal_mode = WAL');
      return;
    } catch (error) {
      if (!isSqliteBusy(error) || Date.now() >= deadline) throw error;
      sleepSync(WAL_SWITCH_RETRY_MS);
    }
  }
}

function readSchemaVersion(db) {
  return db.prepare('PRAGMA user_version').get().user_version ?? 0;
}

/**
 * schema を現行版へ上げる。現行版なら何も書かない。
 *
 * 移行は書き込み lock を取ってから版を読み直し、1つの transaction で終える (ADR 0031)。
 * lock の外で読んだ版は、他の process が移行を進めた後では古い。古い版から移行をやり直すと、
 * 途中の版で消した表（v4 の judgments）へ触って `no such table` で落ちる。
 */
function initSchema(db) {
  if (readSchemaVersion(db) >= CURRENT_VERSION) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    const version = readSchemaVersion(db);
    if (version < CURRENT_VERSION) applySchemaMigrations(db, version);
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore
    }
    throw error;
  }
}

function applySchemaMigrations(db, version) {
  // v0 → v1: 全テーブル作成
  if (version < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id   TEXT    PRIMARY KEY,
        project_path TEXT    NOT NULL,
        status       TEXT    NOT NULL DEFAULT 'active',
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS skeletons (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id   TEXT    NOT NULL,
        turn_number  INTEGER NOT NULL,
        role         TEXT    NOT NULL,
        summary      TEXT    NOT NULL,
        created_at   INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS judgments (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id   TEXT    NOT NULL,
        turn_number  INTEGER NOT NULL,
        category     TEXT    NOT NULL,
        content      TEXT    NOT NULL,
        content_hash TEXT    NOT NULL,
        resolved     INTEGER NOT NULL DEFAULT 0,
        created_at   INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS details (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id   TEXT    NOT NULL,
        turn_number  INTEGER,
        tool_name    TEXT    NOT NULL,
        input_text   TEXT,
        output_text  TEXT,
        token_count  INTEGER NOT NULL DEFAULT 0,
        created_at   INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS injection_log (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id     TEXT    NOT NULL,
        event_type     TEXT    NOT NULL,
        turns_injected INTEGER NOT NULL DEFAULT 0,
        tokens_saved   INTEGER NOT NULL DEFAULT 0,
        created_at     INTEGER NOT NULL
      );
    `);
  }

  // v1 → v2: 重複排除用 UNIQUE インデックス追加
  if (version < 2) {
    // 先に既存の重複行を削除してからインデックスを作成
    db.exec(`
      DELETE FROM skeletons WHERE id NOT IN (
        SELECT MIN(id) FROM skeletons GROUP BY session_id, turn_number, role
      );
      DELETE FROM judgments WHERE id NOT IN (
        SELECT MIN(id) FROM judgments GROUP BY session_id, content_hash
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_skeletons_turn
        ON skeletons(session_id, turn_number, role);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_judgments_hash
        ON judgments(session_id, content_hash);
    `);
  }

  // v2 → v3: 記憶張り替え方式のための origin_session_id / merged_into 列追加
  if (version < 3) {
    // origin_session_id 列追加（デフォルト NULL、後続 UPDATE で自身の session_id をセット）
    const skeletonCols = db.prepare('PRAGMA table_info(skeletons)').all();
    if (!skeletonCols.some((c) => c.name === 'origin_session_id')) {
      db.exec('ALTER TABLE skeletons ADD COLUMN origin_session_id TEXT');
    }
    const judgmentCols = db.prepare('PRAGMA table_info(judgments)').all();
    if (!judgmentCols.some((c) => c.name === 'origin_session_id')) {
      db.exec('ALTER TABLE judgments ADD COLUMN origin_session_id TEXT');
    }
    const detailCols = db.prepare('PRAGMA table_info(details)').all();
    if (!detailCols.some((c) => c.name === 'origin_session_id')) {
      db.exec('ALTER TABLE details ADD COLUMN origin_session_id TEXT');
    }
    const sessionCols = db.prepare('PRAGMA table_info(sessions)').all();
    if (!sessionCols.some((c) => c.name === 'merged_into')) {
      db.exec('ALTER TABLE sessions ADD COLUMN merged_into TEXT');
    }

    // 既存行の origin_session_id に自身の session_id をセット
    db.exec(`
      UPDATE skeletons SET origin_session_id = session_id WHERE origin_session_id IS NULL;
      UPDATE judgments SET origin_session_id = session_id WHERE origin_session_id IS NULL;
      UPDATE details   SET origin_session_id = session_id WHERE origin_session_id IS NULL;
    `);

    // 旧 UNIQUE インデックス drop + 新 UNIQUE インデックス作成（origin_session_id を含む）
    db.exec(`
      DROP INDEX IF EXISTS uq_skeletons_turn;
      DROP INDEX IF EXISTS uq_judgments_hash;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_skeletons_turn_v3
        ON skeletons(session_id, origin_session_id, turn_number, role);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_judgments_hash_v3
        ON judgments(session_id, origin_session_id, content_hash);
      CREATE INDEX IF NOT EXISTS idx_skeletons_session
        ON skeletons(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_judgments_session
        ON judgments(session_id, resolved, created_at);
    `);
  }

  // v3 → v4: bodies テーブル追加（L2 = 会話自然言語ロスレス保存）、judgments DROP
  if (version < 4) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS bodies (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id        TEXT    NOT NULL,
        origin_session_id TEXT    NOT NULL,
        turn_number       INTEGER NOT NULL,
        role              TEXT    NOT NULL,
        text              TEXT    NOT NULL,
        token_count       INTEGER,
        created_at        INTEGER NOT NULL,
        UNIQUE(session_id, origin_session_id, turn_number, role)
      );
      CREATE INDEX IF NOT EXISTS idx_bodies_session_created
        ON bodies(session_id, created_at);
    `);

    // judgments テーブルと関連インデックスを DROP
    db.exec(`
      DROP INDEX IF EXISTS uq_judgments_hash_v3;
      DROP INDEX IF EXISTS uq_judgments_hash;
      DROP INDEX IF EXISTS idx_judgments_session;
      DROP TABLE IF EXISTS judgments;
    `);
  }

  // v4 → v5: details テーブルに kind / source_id 列追加（L3 分離書き込み対応）
  // - kind: 'tool_input' | 'tool_output' | 'system' | 'image'
  // - source_id: transcript の一意 ID (tool_use.id, attachment.uuid 等)、冪等再処理のため
  // - 既存行は kind='tool_input' (デフォルト)、source_id NULL
  if (version < 5) {
    const detailCols = db.prepare('PRAGMA table_info(details)').all();
    if (!detailCols.some((c) => c.name === 'kind')) {
      db.exec("ALTER TABLE details ADD COLUMN kind TEXT NOT NULL DEFAULT 'tool_input'");
    }
    if (!detailCols.some((c) => c.name === 'source_id')) {
      db.exec('ALTER TABLE details ADD COLUMN source_id TEXT');
    }
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_details_source
        ON details(session_id, origin_session_id, source_id)
        WHERE source_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_details_session_kind
        ON details(session_id, kind, created_at);
    `);
  }

  // v5 → v6: handoff_batons テーブル追加（/tl スラッシュコマンドによる明示的引き継ぎ指名用）
  // - project_path ごとに最新 1 件のみ (PRIMARY KEY)
  // - SessionStart で読み出し、TTL 以内なら merge して DELETE
  // - docs/archive/03_inheritance_on_clear_only.md 参照: 案 D (時間差) 撤去、バトン方式へ移行
  if (version < 6) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS handoff_batons (
        project_path TEXT    PRIMARY KEY,
        session_id   TEXT    NOT NULL,
        created_at   INTEGER NOT NULL
      );
    `);
  }

  // v6 → v7: handoff_batons に memo_text 列追加（/tl 発動時に現行 Claude 自身が
  // 書き込む in-flight メモ。「次の一手」「現在の方針」「未解決」「進行中 TODO」
  // の短い Markdown テキスト。次セッションの SessionStart が resume-context の
  // 先頭に注入して「中断地点からの再開」感を復元する）
  if (version < 7) {
    const batonCols = db.prepare('PRAGMA table_info(handoff_batons)').all();
    if (!batonCols.some((c) => c.name === 'memo_text')) {
      db.exec('ALTER TABLE handoff_batons ADD COLUMN memo_text TEXT');
    }
  }

  // v7 → v8: handoff_batons から memo_text 列を drop。
  // 新仕様 (docs/02_clear_auto_handoff_plan.md) で memo 廃止:
  //   - /clear 自動引継ぎ (SessionStart source='clear') + /tl baton (memo なし) の 2 経路に
  //   - 注入は L1 + L2 + L3 refs のみ
  //   - save-inflight CLI / updateBatonMemo 関数も併せて削除
  // SQLite 3.35.0+ で DROP COLUMN サポート (Node.js v22.5+ 同梱版で利用可)。
  if (version < 8) {
    const batonCols = db.prepare('PRAGMA table_info(handoff_batons)').all();
    if (batonCols.some((c) => c.name === 'memo_text')) {
      db.exec('ALTER TABLE handoff_batons DROP COLUMN memo_text');
    }
  }

  // v8 → v9: pending_handoffs テーブル追加（二相ハンドオフ）。
  // SessionStart は merge / 注入をせず intent をここに登録するだけ。
  // 最初の UserPromptSubmit（= セッション実在の証明。幽霊 SessionStart は
  // プロンプトを一度も発火しない）が原子的に consume して merge + 注入する。
  // auto path (source='clear') の前任は SessionStart 時点で解決して凍結する。
  // 幽霊の pending 行は誰にも consume されず無害に残る（行は数百バイト）。
  // 経緯: 2026-07-17 の baton 幽霊奪取 incident（ADR 0014）。
  if (version < 9) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pending_handoffs (
        session_id          TEXT    PRIMARY KEY,
        project_path        TEXT    NOT NULL,
        source              TEXT,
        auto_predecessor_id TEXT,
        created_at          INTEGER NOT NULL
      );
    `);
  }

  // v9 → v10: 外部会話の発言を公開CLIから記録し、部屋ごとに直近の文脈を返す。
  if (version < 10) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS room_turns (
        project_path TEXT NOT NULL,
        room_id      TEXT NOT NULL,
        message_id   TEXT NOT NULL,
        speaker      TEXT NOT NULL,
        text         TEXT NOT NULL,
        PRIMARY KEY (project_path, room_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_room_turns_room
        ON room_turns(project_path, room_id);
    `);
  }

  // v10 → v11: ターンの始まり方（人・配送か、hostが自分から始めたか）を user 行に残す。
  // 旧行は NULL のままで、読む側は unknown として扱う。
  if (version < 11) {
    const bodyCols = db.prepare('PRAGMA table_info(bodies)').all();
    if (!bodyCols.some((c) => c.name === 'turn_start')) {
      db.exec('ALTER TABLE bodies ADD COLUMN turn_start TEXT');
    }
  }

  if (version < 12) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS codex_handoffs (
        handoff_id TEXT PRIMARY KEY,
        source_thread_id TEXT NOT NULL,
        source_turn_id TEXT NOT NULL,
        source_session_id TEXT NOT NULL,
        project_path TEXT NOT NULL,
        rollout_path TEXT NOT NULL,
        codex_home TEXT NOT NULL,
        open_host TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'requested',
        previous_handoff_id TEXT REFERENCES codex_handoffs(handoff_id),
        settings_json TEXT,
        snapshot_json TEXT,
        runtime_json TEXT,
        target_thread_id TEXT UNIQUE,
        delivery_id TEXT NOT NULL UNIQUE,
        queued_submission_id TEXT,
        started_turn_id TEXT,
        mutation_stage TEXT,
        worker_identity_json TEXT,
        resume_state TEXT,
        error_code TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(source_thread_id, source_turn_id)
      );
      CREATE INDEX IF NOT EXISTS idx_codex_handoffs_project
        ON codex_handoffs(project_path, created_at);
      CREATE TABLE IF NOT EXISTS codex_handoff_summaries (
        origin_session_id TEXT NOT NULL,
        turn_number INTEGER NOT NULL,
        source_hash TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(origin_session_id, turn_number, source_hash)
      );
    `);
  }

  if (version < CURRENT_VERSION) {
    db.exec(`PRAGMA user_version = ${CURRENT_VERSION}`);
  }
}

/**
 * 既存の Throughline DB だけを現在 schema へ移行する。
 * 通常の getDb() と異なり、DB や親ディレクトリを作成しない。
 *
 * @returns {{ status: 'not_applicable' | 'already_current' | 'migrated', beforeSchemaVersion: number | null, afterSchemaVersion: number | null, supportedSchemaVersion: number }}
 */
export function migrateDefaultDb() {
  if (!existsSync(DB_PATH)) {
    return {
      status: 'not_applicable',
      beforeSchemaVersion: null,
      afterSchemaVersion: null,
      supportedSchemaVersion: CURRENT_VERSION,
    };
  }

  let db;
  try {
    db = new DatabaseSync(DB_PATH);
    db.exec(`PRAGMA busy_timeout = ${DB_BUSY_TIMEOUT_MS}`);
    settleFirstRead(db);
    db.exec('PRAGMA foreign_keys = ON');

    const beforeSchemaVersion = Number(db.prepare('PRAGMA user_version').get().user_version ?? 0);
    if (beforeSchemaVersion > CURRENT_VERSION) {
      throw new DatabaseMigrationError('future_schema', beforeSchemaVersion, beforeSchemaVersion);
    }

    if (beforeSchemaVersion === CURRENT_VERSION) {
      return {
        status: 'already_current',
        beforeSchemaVersion,
        afterSchemaVersion: beforeSchemaVersion,
        supportedSchemaVersion: CURRENT_VERSION,
      };
    }

    ensureWalJournalMode(db);
    initSchema(db);
    const afterSchemaVersion = Number(db.prepare('PRAGMA user_version').get().user_version ?? 0);
    if (afterSchemaVersion !== CURRENT_VERSION) {
      throw new DatabaseMigrationError('version_mismatch', beforeSchemaVersion, afterSchemaVersion);
    }
    return {
      status: 'migrated',
      beforeSchemaVersion,
      afterSchemaVersion,
      supportedSchemaVersion: CURRENT_VERSION,
    };
  } catch (error) {
    if (error instanceof DatabaseMigrationError) throw error;
    throw new DatabaseMigrationError('migration_failed', null, null);
  } finally {
    db?.close();
  }
}

export class DatabaseMigrationError extends Error {
  constructor(code, beforeSchemaVersion, afterSchemaVersion) {
    super(code);
    this.code = code;
    this.beforeSchemaVersion = beforeSchemaVersion;
    this.afterSchemaVersion = afterSchemaVersion;
  }
}

/**
 * DB インスタンスを返す（シングルトン）
 * @returns {DatabaseSync}
 */
export function getDb() {
  if (_db) return _db;

  mkdirSync(DB_DIR, { recursive: true });

  const db = new DatabaseSync(DB_PATH);
  try {
    db.exec(`PRAGMA busy_timeout = ${DB_BUSY_TIMEOUT_MS}`);
    settleFirstRead(db);
    ensureWalJournalMode(db);
    db.exec(`PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT_BYTES}`);
    db.exec('PRAGMA foreign_keys = ON');
    initSchema(db);
    _db = db;
    return _db;
  } catch (error) {
    db.close();
    throw error;
  }
}
