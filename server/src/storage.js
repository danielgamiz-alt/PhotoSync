'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

// Uploads with no account name land here, at the storage root (this is also
// the layout used before accounts existed, so old setups keep working).
const DEFAULT_USER = 'default';

/**
 * Stores uploaded files per account: named users go under
 * <storagePath>/<username>/<YYYY>/<MM>/, the default user at the root. A
 * content-hash index (index.json) gives per-user de-duplication so the same
 * photo is never stored twice for one person.
 *
 * Index shape: { <sha256>: { <username>: { path, size, storedAt, takenAt } } }
 */
class Storage {
  constructor(storagePath) {
    this.root = storagePath;
    this.indexFile = path.join(storagePath, 'index.json');
    this.index = {};
  }

  async init() {
    await fsp.mkdir(this.root, { recursive: true });
    try {
      this.index = JSON.parse(await fsp.readFile(this.indexFile, 'utf8'));
    } catch {
      this.index = {};
    }

    // Migrate the old single-entry-per-hash shape ({hash:{path,...}}) to the
    // per-user shape ({hash:{user:{path,...}}}), attributing legacy files to
    // the default user so existing backups are preserved.
    let changed = false;
    for (const [hash, value] of Object.entries(this.index)) {
      if (value && typeof value.path === 'string') {
        this.index[hash] = { [DEFAULT_USER]: value };
        changed = true;
      }
    }

    // Drop entries whose files were deleted manually.
    for (const [hash, byUser] of Object.entries(this.index)) {
      for (const [user, entry] of Object.entries(byUser)) {
        if (!fs.existsSync(path.join(this.root, entry.path))) {
          delete byUser[user];
          changed = true;
        }
      }
      if (Object.keys(byUser).length === 0) delete this.index[hash];
    }

    if (changed) await this.saveIndex();
  }

  async saveIndex() {
    const tmp = this.indexFile + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(this.index, null, 1));
    await fsp.rename(tmp, this.indexFile);
  }

  has(hash, username = DEFAULT_USER) {
    return Boolean(this.index[hash] && this.index[hash][username]);
  }

  /** Total files stored across all users. */
  count() {
    let total = 0;
    for (const byUser of Object.values(this.index)) total += Object.keys(byUser).length;
    return total;
  }

  /** Total bytes stored across all users (sums the size field in the index). */
  totalBytes() {
    let total = 0;
    for (const byUser of Object.values(this.index))
      for (const e of Object.values(byUser)) total += e.size || 0;
    return total;
  }

  /** Files stored for one user. */
  countFor(username = DEFAULT_USER) {
    let total = 0;
    for (const byUser of Object.values(this.index)) {
      if (byUser[username]) total++;
    }
    return total;
  }

  /**
   * Streams an incoming request body to a temp file while hashing it,
   * then files it under its capture date. Returns { stored, path, hash }.
   * If expectedHash is provided and doesn't match what was received,
   * the temp file is discarded and an error is thrown.
   */
  async store(readable, { filename, takenAt, expectedHash, username }) {
    const user = sanitizeUsername(username);
    await fsp.mkdir(path.join(this.root, '.incoming'), { recursive: true });
    const tmpPath = path.join(this.root, '.incoming', crypto.randomUUID() + '.part');

    const hasher = crypto.createHash('sha256');
    let size = 0;

    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(tmpPath);
      readable.on('data', (chunk) => {
        hasher.update(chunk);
        size += chunk.length;
      });
      readable.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      readable.pipe(out);
    });

    const hash = hasher.digest('hex');

    if (expectedHash && expectedHash !== hash) {
      await fsp.unlink(tmpPath).catch(() => {});
      const err = new Error('hash mismatch: upload corrupted in transit');
      err.statusCode = 400;
      throw err;
    }

    if (this.has(hash, user)) {
      await fsp.unlink(tmpPath).catch(() => {});
      return { stored: false, path: this.index[hash][user].path, hash };
    }

    const relPath = await this._fileAway(tmpPath, filename, takenAt, user);
    const takenAtMs = takenAt && takenAt > 0 ? takenAt : Date.now();
    if (!this.index[hash]) this.index[hash] = {};
    this.index[hash][user] = { path: relPath, size, storedAt: Date.now(), takenAt: takenAtMs };
    await this.saveIndex();
    return { stored: true, path: relPath, hash };
  }

  /**
   * Resolves a hash to a stored entry. With a username, returns that user's
   * copy; without one, returns any copy (the bytes are identical) so the
   * desktop owner gallery can serve content by hash alone.
   */
  get(hash, username) {
    const byUser = this.index[hash];
    if (!byUser) return null;
    if (username) return byUser[username] || null;
    const first = Object.values(byUser)[0];
    return first || null;
  }

  /**
   * Every stored item (one per user copy) with metadata, newest first.
   * `takenAt` falls back to the upload time for items saved before capture
   * dates were recorded.
   */
  list() {
    const out = [];
    for (const [hash, byUser] of Object.entries(this.index)) {
      for (const [user, e] of Object.entries(byUser)) {
        out.push({
          hash,
          user,
          path: e.path,
          name: e.path.split('/').pop(),
          size: e.size,
          takenAt: e.takenAt || e.storedAt || 0,
          storedAt: e.storedAt || 0,
          type: isVideoName(e.path) ? 'video' : 'image',
        });
      }
    }
    return out.sort((a, b) => b.takenAt - a.takenAt);
  }

  /**
   * Permanently deletes a stored file. Without a username, removes every
   * user's copy of that content (the owner "free up space" action); with one,
   * removes just that user's copy.
   */
  async remove(hash, username) {
    const byUser = this.index[hash];
    if (!byUser) return false;
    const users = username ? [username] : Object.keys(byUser);
    let removed = false;
    for (const user of users) {
      const entry = byUser[user];
      if (!entry) continue;
      const abs = path.join(this.root, entry.path);
      await fsp.unlink(abs).catch(() => {}); // tolerate already-gone files
      // Tidy up now-empty month/year folders, best-effort.
      await fsp.rmdir(path.dirname(abs)).catch(() => {});
      await fsp.rmdir(path.dirname(path.dirname(abs))).catch(() => {});
      delete byUser[user];
      removed = true;
    }
    if (Object.keys(byUser).length === 0) delete this.index[hash];
    if (removed) await this.saveIndex();
    return removed;
  }

  /**
   * Moves a temp file into <user>/<YYYY>/<MM>/ (named users) or <YYYY>/<MM>/
   * (the default user, at the root), de-duplicating filename collisions.
   */
  async _fileAway(tmpPath, filename, takenAt, username = DEFAULT_USER) {
    const when = new Date(takenAt && takenAt > 0 ? takenAt : Date.now());
    const year = String(when.getFullYear());
    const month = String(when.getMonth() + 1).padStart(2, '0');
    const userPart = username === DEFAULT_USER ? '' : username;
    const dir = path.join(this.root, userPart, year, month);
    await fsp.mkdir(dir, { recursive: true });

    const safeName = sanitizeFilename(filename);
    let candidate = safeName;
    let n = 1;
    while (fs.existsSync(path.join(dir, candidate))) {
      const ext = path.extname(safeName);
      candidate = `${path.basename(safeName, ext)}_${n}${ext}`;
      n++;
    }

    const dest = path.join(dir, candidate);
    await fsp.rename(tmpPath, dest);
    return path.relative(this.root, dest).split(path.sep).join('/');
  }
}

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v', '.3gp', '.mkv', '.webm', '.avi', '.wmv']);

function isVideoName(name) {
  return VIDEO_EXTS.has(path.extname(name).toLowerCase());
}

const FORBIDDEN_CHARS = '<>:"/\\|?*';

function sanitizeFilename(name) {
  const base = path.basename(name || 'unnamed');
  // Replace characters Windows refuses, plus ASCII control characters.
  let cleaned = '';
  for (const ch of base) {
    cleaned += ch < ' ' || FORBIDDEN_CHARS.includes(ch) ? '_' : ch;
  }
  cleaned = cleaned.trim();
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? 'unnamed' : cleaned;
}

/**
 * Maps an account name to a safe single folder name. No path separators or
 * dots, so it can never escape the storage root. Falls back to "default".
 */
function sanitizeUsername(name) {
  const base = String(name || '').trim();
  let cleaned = '';
  for (const ch of base) {
    cleaned += ch < ' ' || ch === '.' || FORBIDDEN_CHARS.includes(ch) ? '_' : ch;
  }
  cleaned = cleaned.trim().slice(0, 64);
  return cleaned === '' ? 'default' : cleaned;
}

module.exports = { Storage, sanitizeFilename, sanitizeUsername, isVideoName };
