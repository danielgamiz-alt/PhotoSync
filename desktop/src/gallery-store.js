'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { Worker } = require('worker_threads');

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

// HEIC/HEIF can't be decoded by the prebuilt sharp/libheif (it lacks the HEVC
// plugin for ~95% of real iPhone HEICs), so these are rendered in a worker
// thread that uses the WASM decoder (heic-decode) with a sharp fallback. See
// heic-decode-worker.js. Everything else stays on the fast in-process sharp path.
const HEIC_EXTS = new Set(['.heic', '.heif']);
const HEIC_WORKER = path.join(__dirname, 'heic-decode-worker.js');
const HEIC_JOB_TIMEOUT_MS = 60000; // WASM decode is slow; give a stuck file a hard cap
function isHeic(name) {
  return HEIC_EXTS.has(path.extname(name).toLowerCase());
}

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
    this._worker = null;        // lazily-spawned HEIC decode worker thread
    this._pending = new Map();  // in-flight HEIC job id -> resolve(ok)
    this._jobId = 0;
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

  // ---- derivative specs ----------------------------------------------------
  // A "job" fully describes one output file: where it goes plus the exact
  // resize/webp options. The same job objects drive both the in-process sharp
  // path and the HEIC worker thread, and serialise cleanly to postMessage.

  _thumbJob(out, s) {
    return { out, resize: { width: s, height: s, fit: 'cover', position: 'attention' }, webp: { quality: s <= 256 ? 72 : 76 } };
  }

  _viewJob(out, s) {
    // effort:0 keeps this fast — the viewer image is generated on-demand when
    // the lightbox opens, so encode latency is user-visible. At the default
    // effort a 2048px WebP takes ~500ms; effort:0 brings it back to JPEG speed
    // (~210ms) while still landing ~40% smaller than JPEG.
    return { out, resize: { width: s, height: s, fit: 'inside', withoutEnlargement: true }, webp: { quality: 80, effort: 0 } };
  }

  _blurJob(out) {
    return { out, resize: { width: BLUR_SIZE, height: BLUR_SIZE, fit: 'cover' }, webp: { quality: 40 } };
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
    if (fs.existsSync(out)) return out;
    return (await this._render(absSource, [this._viewJob(out, s)])) ? out : null;
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
    if (fs.existsSync(out)) return out;
    return (await this._render(absSource, [this._thumbJob(out, s)])) ? out : null;
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
    if (fs.existsSync(out)) return out;
    return (await this._render(absSource, [this._blurJob(out)])) ? out : null;
  }

  /**
   * Render one or more WebP derivatives from a single source. HEIC/HEIF is
   * routed to the WASM decode worker (the prebuilt sharp can't decode most of
   * them); everything else is rendered in-process by sharp. Returns true only if
   * every job's file was written. On any failure the partial outputs are removed
   * so a bad render is never cached and re-served.
   */
  async _render(absSource, jobs) {
    if (!jobs.length) return true;
    try {
      await fsp.mkdir(path.dirname(jobs[0].out), { recursive: true });
      const ok = isHeic(absSource)
        ? await this._renderViaWorker(absSource, jobs)
        : await this._renderInProcess(absSource, jobs);
      if (!ok) throw new Error('render failed');
      return true;
    } catch {
      await Promise.all(jobs.map((j) => fsp.unlink(j.out).catch(() => {})));
      return false;
    }
  }

  /** Non-HEIC: sharp decodes + encodes each job in-process. */
  async _renderInProcess(absSource, jobs) {
    for (const job of jobs) {
      await sharp(absSource).rotate().resize(job.resize).webp(job.webp).toFile(job.out);
    }
    return true;
  }

  /** Lazily start (and keep) the HEIC decode worker thread. */
  _heicWorker() {
    if (this._worker) return this._worker;
    const w = new Worker(HEIC_WORKER);
    const failAll = () => {
      // Worker crashed/exited — fail every in-flight job and drop it so the
      // next HEIC render spawns a fresh one.
      for (const resolve of this._pending.values()) resolve(false);
      this._pending.clear();
      if (this._worker === w) this._worker = null;
    };
    w.on('message', (m) => {
      const resolve = this._pending.get(m.id);
      if (resolve) { this._pending.delete(m.id); resolve(!!m.ok); }
    });
    w.on('error', failAll);
    w.on('exit', () => { if (this._worker === w) failAll(); });
    w.unref(); // the worker alone must not keep the process alive
    this._worker = w;
    return w;
  }

  /** HEIC/HEIF: hand the source + all jobs to the worker (one decode covers all). */
  _renderViaWorker(absSource, jobs) {
    return new Promise((resolve) => {
      const id = ++this._jobId;
      let settled = false;
      const finish = (ok) => { if (settled) return; settled = true; this._pending.delete(id); resolve(ok); };
      this._pending.set(id, finish);
      // Hard cap so a stuck decode can't hang warmup forever.
      setTimeout(() => finish(false), HEIC_JOB_TIMEOUT_MS);
      this._heicWorker().postMessage({ id, src: absSource, jobs });
    });
  }

  /** Stop the HEIC worker thread (e.g. on shutdown). Safe to call when idle. */
  async dispose() {
    const w = this._worker;
    this._worker = null;
    for (const resolve of this._pending.values()) resolve(false);
    this._pending.clear();
    if (w) await w.terminate().catch(() => {});
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
        // Warm every still-missing grid variant (256 for 1×, 512 for retina) +
        // blur in one render pass so the first scroll never waits on an
        // on-demand encode. Batching matters for HEIC: a single (expensive) WASM
        // decode then covers all three. The larger VIEW_SIZES stay on-demand —
        // the lightbox opens one image at a time, and pre-rendering 2048px
        // copies for the whole library would bloat the cache upfront.
        const jobs = [];
        for (const s of THUMB_SIZES) {
          const out = this._thumbPath(m.hash, s);
          if (!fs.existsSync(out)) jobs.push(this._thumbJob(out, s));
        }
        const blurOut = this._blurPath(m.hash);
        if (!fs.existsSync(blurOut)) jobs.push(this._blurJob(blurOut));
        if (jobs.length) await this._render(abs, jobs);
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
