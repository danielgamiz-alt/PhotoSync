'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

// Optional fast thumbnails. If `sharp` isn't installed, the gallery falls back
// to serving (browser-scaled) originals — so this is a pure enhancement.
let sharp = null;
try {
  sharp = require('sharp');
} catch {
  sharp = null;
}

const THUMB_DIR = '.thumbs';
const THUMB_SIZE = 400;
const BLUR_SIZE = 12;
const WARM_CONCURRENCY = 3;

class Thumbnailer {
  /** getRoot() returns the current storage root (changes when the user
   *  switches the backup folder). */
  constructor(getRoot) {
    this.getRoot = getRoot;
    // hash → 'data:image/jpeg;base64,...' for tiny blur placeholders
    this._blurCache = new Map();
    this._warmupAbort = false;
  }

  get available() {
    return sharp !== null;
  }

  _thumbPath(hash) {
    return path.join(this.getRoot(), THUMB_DIR, `${hash}.jpg`);
  }

  _blurPath(hash) {
    return path.join(this.getRoot(), THUMB_DIR, `${hash}-b.jpg`);
  }

  /**
   * Returns the path to a cached JPEG thumbnail for an image, generating it on
   * first request. Returns null when thumbnails aren't possible (no sharp, a
   * video, or a decode failure) so the caller can serve the original instead.
   */
  async thumb(hash, absSource, type) {
    if (!sharp || type === 'video') return null;
    const out = this._thumbPath(hash);
    try {
      if (fs.existsSync(out)) return out;
      await fsp.mkdir(path.dirname(out), { recursive: true });
      await sharp(absSource)
        .rotate() // honour EXIF orientation
        .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'cover', position: 'attention' })
        .jpeg({ quality: 72 })
        .toFile(out);
      return out;
    } catch {
      return null;
    }
  }

  /** Returns the cached base64 blur data URI for a hash, or null. */
  getBlur(hash) {
    return this._blurCache.get(hash) || null;
  }

  /** Generate (or load from disk) a tiny blur JPEG for one image hash. */
  async _ensureBlur(hash, absSource) {
    if (this._blurCache.has(hash)) return;
    const blurFile = this._blurPath(hash);
    try {
      if (fs.existsSync(blurFile)) {
        const buf = await fsp.readFile(blurFile);
        this._blurCache.set(hash, `data:image/jpeg;base64,${buf.toString('base64')}`);
        return;
      }
      await fsp.mkdir(path.dirname(blurFile), { recursive: true });
      const buf = await sharp(absSource)
        .rotate()
        .resize(BLUR_SIZE, BLUR_SIZE, { fit: 'cover' })
        .jpeg({ quality: 40 })
        .toBuffer();
      await fsp.writeFile(blurFile, buf);
      this._blurCache.set(hash, `data:image/jpeg;base64,${buf.toString('base64')}`);
    } catch {
      // Non-fatal — blur just won't be available for this item.
    }
  }

  /**
   * Background warmup: pre-generates full thumbs + blur placeholders for all
   * image items. Runs with limited concurrency so it doesn't spike CPU while
   * the user is actively using the app. Safe to call multiple times — items
   * with existing files are skipped quickly.
   */
  async warmUp(items) {
    if (!sharp) return;
    this._warmupAbort = false;
    const root = this.getRoot();
    const imageItems = items.filter((m) => m.type !== 'video');

    let i = 0;
    const worker = async () => {
      while (i < imageItems.length && !this._warmupAbort) {
        const m = imageItems[i++];
        const abs = path.join(root, m.path);
        await this.thumb(m.hash, abs, 'image');
        await this._ensureBlur(m.hash, abs);
      }
    };

    const workers = Array.from({ length: WARM_CONCURRENCY }, worker);
    await Promise.all(workers);
  }

  /** Cancel any in-progress warmup (e.g. when the storage folder changes). */
  cancelWarmUp() {
    this._warmupAbort = true;
  }

  async forget(hash) {
    this._blurCache.delete(hash);
    await fsp.unlink(this._thumbPath(hash)).catch(() => {});
    await fsp.unlink(this._blurPath(hash)).catch(() => {});
  }
}

const MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.3gp': 'video/3gpp',
  '.avi': 'video/x-msvideo',
};

function mimeFor(name) {
  return MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';
}

module.exports = { Thumbnailer, mimeFor, THUMB_DIR };
