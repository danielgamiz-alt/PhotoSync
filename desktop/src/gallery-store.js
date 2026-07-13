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
const BLUR_SIZE = 12;
const WARM_CONCURRENCY = 3;

// Allowlisted variant sizes (longest edge, in CSS px × DPR terms). Requests are
// snapped to the nearest of these so the on-disk cache stays bounded and a
// caller can't ask us to render arbitrary sizes. This is the server side of the
// responsive-images story: each surface (grid tile, retina grid, laptop
// lightbox, 4K lightbox) fetches the smallest variant that still looks sharp,
// exactly like Google Photos' `=w400` / `=w2048` URL suffixes.
//   THUMB_SIZES → square, cover-cropped — the gallery grid (art-direction crop)
//   VIEW_SIZES  → inside-fit, full aspect — the full-screen viewer
const THUMB_SIZES = [256, 512];
const VIEW_SIZES = [1024, 2048];
const DEFAULT_THUMB = THUMB_SIZES[0]; // warmed up ahead of time; grid 1× baseline
const DEFAULT_VIEW = VIEW_SIZES[VIEW_SIZES.length - 1];

// Smallest allowlisted size that still covers `want`; falls back to the largest.
function snapSize(sizes, want) {
  const n = Number(want);
  if (!Number.isFinite(n)) return sizes[0];
  for (const s of sizes) if (s >= n) return s;
  return sizes[sizes.length - 1];
}

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

  _thumbPath(hash, size) {
    return path.join(this.getRoot(), THUMB_DIR, `${hash}-t${size}.jpg`);
  }

  _blurPath(hash) {
    return path.join(this.getRoot(), THUMB_DIR, `${hash}-b.jpg`);
  }

  _viewPath(hash, size) {
    return path.join(this.getRoot(), THUMB_DIR, `${hash}-v${size}.jpg`);
  }

  /**
   * Returns a path to an inside-fit, browser-displayable JPEG for the
   * full-screen viewer at (the nearest allowlisted size to) `size` px on the
   * longest edge, generating it on first request and caching it beside the
   * thumbnails. This both downsizes big originals to a viewport-appropriate copy
   * AND converts formats the browser can't render natively (HEIC/HEIF/TIFF/BMP…).
   * Returns null when a conversion isn't possible (no sharp, a video, or a decode
   * failure) so the caller can fall back to serving the original bytes.
   */
  async view(hash, absSource, type, size = DEFAULT_VIEW) {
    if (!sharp || type === 'video') return null;
    const s = snapSize(VIEW_SIZES, size);
    const out = this._viewPath(hash, s);
    try {
      if (fs.existsSync(out)) return out;
      await fsp.mkdir(path.dirname(out), { recursive: true });
      await sharp(absSource)
        .rotate() // honour EXIF orientation
        .resize(s, s, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82 })
        .toFile(out);
      return out;
    } catch {
      // toFile may have left a partial/garbage file — drop it so a failed
      // generation isn't cached and re-served forever on the next request.
      await fsp.unlink(out).catch(() => {});
      return null;
    }
  }

  /**
   * Returns the path to a cached square (cover-cropped) JPEG thumbnail for an
   * image at (the nearest allowlisted size to) `size` px, generating it on first
   * request. Returns null when thumbnails aren't possible (no sharp, a video, or
   * a decode failure) so the caller can serve the original instead.
   */
  async thumb(hash, absSource, type, size = DEFAULT_THUMB) {
    if (!sharp || type === 'video') return null;
    const s = snapSize(THUMB_SIZES, size);
    const out = this._thumbPath(hash, s);
    try {
      if (fs.existsSync(out)) return out;
      await fsp.mkdir(path.dirname(out), { recursive: true });
      await sharp(absSource)
        .rotate() // honour EXIF orientation
        .resize(s, s, { fit: 'cover', position: 'attention' })
        .jpeg({ quality: s <= 256 ? 72 : 76 })
        .toFile(out);
      return out;
    } catch {
      // toFile may have left a partial/garbage file — drop it so a failed
      // generation isn't cached and re-served forever on the next request.
      await fsp.unlink(out).catch(() => {});
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
        // Warm only the grid's 1× baseline + blur; larger variants are cheap to
        // make on demand and warming them all would bloat the cache upfront.
        await this.thumb(m.hash, abs, 'image', DEFAULT_THUMB);
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
    const dir = path.join(this.getRoot(), THUMB_DIR);
    const files = [
      ...THUMB_SIZES.map((s) => this._thumbPath(hash, s)),
      ...VIEW_SIZES.map((s) => this._viewPath(hash, s)),
      this._blurPath(hash),
      // Legacy fixed-size cache files from before responsive variants.
      path.join(dir, `${hash}.jpg`),
      path.join(dir, `${hash}-view.jpg`),
    ];
    await Promise.all(files.map((f) => fsp.unlink(f).catch(() => {})));
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

// Image formats browsers render natively in an <img>. Anything else (HEIC,
// HEIF, TIFF, BMP…) needs converting before the full-screen viewer can show it.
const WEB_SAFE_IMAGE = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
function isWebSafeImage(name) {
  return WEB_SAFE_IMAGE.has(path.extname(name).toLowerCase());
}

module.exports = { Thumbnailer, mimeFor, isWebSafeImage, THUMB_DIR, THUMB_SIZES, VIEW_SIZES };
