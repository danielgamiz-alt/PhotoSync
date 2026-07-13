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
    this._warmupAbort = false;
  }

  get available() {
    return sharp !== null;
  }

  _thumbPath(hash, size) {
    return path.join(this.getRoot(), THUMB_DIR, `${hash}-t${size}.webp`);
  }

  _blurPath(hash) {
    return path.join(this.getRoot(), THUMB_DIR, `${hash}-b.webp`);
  }

  _viewPath(hash, size) {
    return path.join(this.getRoot(), THUMB_DIR, `${hash}-v${size}.webp`);
  }

  /**
   * Returns a path to an inside-fit, browser-displayable WebP for the
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
        // effort:0 keeps this fast — the viewer image is generated on-demand
        // when the lightbox opens, so encode latency is user-visible. At the
        // default effort a 2048px WebP takes ~500ms; effort:0 brings it back to
        // JPEG speed (~230ms) while still landing ~40% smaller than JPEG.
        .webp({ quality: 80, effort: 0 })
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
   * Returns the path to a cached square (cover-cropped) WebP thumbnail for an
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
        .webp({ quality: s <= 256 ? 72 : 76 })
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
   * Returns the path to a cached tiny blur WebP for an image, generating it on
   * first request. Served by the gallery as an instant, browser-cacheable
   * placeholder while the full thumbnail loads. Returns null when a blur isn't
   * possible (no sharp, a video, or a decode failure).
   */
  async blurFile(hash, absSource, type) {
    if (!sharp || type === 'video') return null;
    const out = this._blurPath(hash);
    try {
      if (fs.existsSync(out)) return out;
      await fsp.mkdir(path.dirname(out), { recursive: true });
      await sharp(absSource)
        .rotate() // honour EXIF orientation
        .resize(BLUR_SIZE, BLUR_SIZE, { fit: 'cover' })
        .webp({ quality: 40 })
        .toFile(out);
      return out;
    } catch {
      return null;
    }
  }

  /**
   * Background warmup: pre-generates full thumbs + blur placeholders for all
   * image items. Runs with limited concurrency so it doesn't spike CPU while
   * the user is actively using the app. Safe to call multiple times — items
   * with existing files are skipped quickly.
   */
  async warmUp(items) {
    // One-time migration cleanup before warming: everything the cache holds is
    // WebP now, so purge any leftover JPEG derivatives from before the switch.
    await this.sweepLegacyJpegs();
    if (!sharp) return;
    this._warmupAbort = false;
    const root = this.getRoot();
    const imageItems = items.filter((m) => m.type !== 'video');

    let i = 0;
    const worker = async () => {
      while (i < imageItems.length && !this._warmupAbort) {
        const m = imageItems[i++];
        const abs = path.join(root, m.path);
        // Warm every grid variant (256 for 1×, 512 for retina) + blur so the
        // first scroll never waits on an on-demand encode. The larger VIEW_SIZES
        // stay on-demand: the lightbox opens one image at a time (cheap to make
        // then) and pre-rendering 2048px copies for the whole library would
        // bloat the cache upfront.
        for (const size of THUMB_SIZES) {
          if (this._warmupAbort) break;
          await this.thumb(m.hash, abs, 'image', size);
        }
        await this.blurFile(m.hash, abs, 'image');
      }
    };

    const workers = Array.from({ length: WARM_CONCURRENCY }, worker);
    await Promise.all(workers);
  }

  /** Cancel any in-progress warmup (e.g. when the storage folder changes). */
  cancelWarmUp() {
    this._warmupAbort = true;
  }

  /**
   * One-time migration cleanup: the derivative cache used to be JPEG and is now
   * all WebP. Delete any leftover .jpg/.jpeg files in the cache dir so switching
   * formats doesn't leave orphans on disk. The dir is exclusively this class's
   * derivative cache, so nothing else is at risk. Idempotent — after the first
   * pass there are none, making every later call a cheap no-op readdir.
   */
  async sweepLegacyJpegs() {
    const dir = path.join(this.getRoot(), THUMB_DIR);
    let names;
    try {
      names = await fsp.readdir(dir);
    } catch {
      return; // no cache dir yet — nothing to sweep
    }
    await Promise.all(
      names
        .filter((n) => n.endsWith('.jpg') || n.endsWith('.jpeg'))
        .map((n) => fsp.unlink(path.join(dir, n)).catch(() => {}))
    );
  }

  async forget(hash) {
    const dir = path.join(this.getRoot(), THUMB_DIR);
    const files = [
      ...THUMB_SIZES.map((s) => this._thumbPath(hash, s)),
      ...VIEW_SIZES.map((s) => this._viewPath(hash, s)),
      this._blurPath(hash),
      // Legacy fixed-size cache files from before responsive variants.
      path.join(dir, `${hash}.jpg`),
      path.join(dir, `${hash}-view.jpg`),
      // Legacy JPEG derivatives from before the WebP switch (same naming,
      // different extension) — clean them up so we don't leave orphans behind.
      ...THUMB_SIZES.map((s) => path.join(dir, `${hash}-t${s}.jpg`)),
      ...VIEW_SIZES.map((s) => path.join(dir, `${hash}-v${s}.jpg`)),
      path.join(dir, `${hash}-b.jpg`),
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
