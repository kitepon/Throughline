import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readSync,
  renameSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const LOG_MAX_BYTES = 4 * 1024 * 1024;

function regularFile(path) {
  try {
    if (!lstatSync(path).isFile()) throw new Error('log_regular_file_required');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

/** Keep the current diagnostic and one bounded predecessor; memory stores never use this. */
export function appendBoundedLog(path, line) {
  if (Buffer.byteLength(line) > LOG_MAX_BYTES) throw new RangeError('log_entry_too_large');
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lockPath = join(directory, '.log-retention.sqlite');
  regularFile(lockPath);
  const lock = new DatabaseSync(lockPath);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    lock.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE');
    regularFile(path);
    regularFile(`${path}.1`);
    const size = existsSync(path) ? statSync(path).size : 0;
    if (size + Buffer.byteLength(line) > LOG_MAX_BYTES) {
      const length = Math.min(size, LOG_MAX_BYTES);
      const tail = Buffer.alloc(length);
      const fd = openSync(path, 'r');
      try {
        let read = 0;
        while (read < length) {
          const count = readSync(fd, tail, read, length - read, size - length + read);
          if (!count) throw new Error('log_changed_during_rotation');
          read += count;
        }
      } finally { closeSync(fd); }
      const boundary = tail.indexOf(10);
      const start = size > length ? (boundary < 0 ? length : boundary + 1) : 0;
      writeFileSync(temporary, tail.subarray(start), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, `${path}.1`);
      truncateSync(path, 0);
    }
    appendFileSync(path, line, { encoding: 'utf8', mode: 0o600 });
    lock.exec('COMMIT');
  } finally {
    try { rmSync(temporary, { force: true }); }
    finally { lock.close(); }
  }
}
