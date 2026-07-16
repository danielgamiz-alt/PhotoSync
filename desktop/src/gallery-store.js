'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
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
// plugin for ~95% of real iPhone HEICs), so these are rendered in worker
// threads that use the WASM decoder (heic-decode) with a sharp fallback. See
// heic-decode-worker.js. Everything else stays on the fast in-process sharp path.
//
// The WASM decode costs ~1s of CPU per image, which shapes everything about how
// jobs reach the workers (a naive serial queue starved the gallery — a screenful
// of HEIC tiles held all six browser connections for tens of seconds and JPEG
// tiles couldn't even fetch):
//   - a small POOL of workers, so a scroll's worth of tiles decodes in parallel;
//   - on-demand (gallery-visible) jobs take PRIORITY over background warmup;
//   - requests for the same source COALESCE — one decode produces every missing
//     derivative (blur + both grid sizes), instead of blur and thumb each paying
//     for their own decode of the same photo.
const HEIC_EXTS = new Set(['.heic', '.heif']);
const HEIC_WORKER = path.join(__dirname, 'heic-decode-worker.js');
const HEIC_JOB_TIMEOUT_MS = 30000; // per dispatched decode; a stuck file can't jam the pool
// Each worker's WASM decode saturates one core; leave headroom for the main
// thread (HTTP + in-process sharp) and the rest of the system.
const HEIC_POOL_SIZE = Math.max(1, Math.min(3, os.cpus().length - 2));
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
    this._heicPool = [];          // { worker, entry|null } wrappers, lazily spawned
    this._heicQueue = [];         // entries waiting for a worker (urgent ones first)
    this._heicPending = new Map(); // hash -> queued/running entry, for coalescing
    this._lastUrgentAt = 0;       // when the gallery last asked for something
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
    // For HEIC, piggyback the (missing) grid derivatives on the same decode —
    // the decode dwarfs the extra encodes, and it saves a later decode when the
    // user scrolls back to the grid.
    const jobs = isHeic(absSource)
      ? [this._viewJob(out, s), ...this._missingGridJobs(hash)]
      : [this._viewJob(out, s)];
    const ok = await this._render(hash, absSource, jobs, true);
    return ok && fs.existsSync(out) ? out : null;
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
    // HEIC: render every missing grid derivative from the one decode (the
    // requested size is part of that set by construction).
    const jobs = isHeic(absSource) ? this._missingGridJobs(hash) : [this._thumbJob(out, s)];
    const ok = await this._render(hash, absSource, jobs, true);
    return ok && fs.existsSync(out) ? out : null;
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
    if (isHeic(absSource)) {
      // Don't make the browser wait ~a second of WASM decode for a cosmetic
      // placeholder — that pins one of its six connections per tile and starves
      // every other tile's fetch. Answer "no blur yet" immediately and start the
      // full render in the background. NON-urgent: a blur alone may be a tile
      // merely scrolled past, and fly-past renders must not delay tiles the
      // user actually landed on. If this tile IS on screen, its thumbnail
      // request arrives right behind and coalesces onto this entry, upgrading
      // it to urgent — so visible tiles still jump the queue.
      this._render(hash, absSource, this._missingGridJobs(hash), false).catch(() => {});
      return null;
    }
    const ok = await this._render(hash, absSource, [this._blurJob(out)], true);
    return ok && fs.existsSync(out) ? out : null;
  }

  /**
   * Reads intrinsic image dimensions (width/height in px) from a file's header,
   * for the viewer's properties panel. Cheap — sharp parses the container
   * metadata without decoding pixels, so it works even for the HEVC HEICs the
   * bundled libheif can't actually decode. Returns null for videos or on error.
   */
  async probe(absSource) {
    if (!sharp) return null;
    try {
      const m = await sharp(absSource).metadata();
      if (!m.width || !m.height) return null;
      return { width: m.width, height: m.height };
    } catch {
      return null;
    }
  }

  /** Every grid derivative (both thumb sizes + blur) still missing for `hash` —
   *  the set one HEIC decode should produce in a single pass. */
  _missingGridJobs(hash) {
    const jobs = [];
    for (const s of THUMB_SIZES) {
      const out = this._thumbPath(hash, s);
      if (!fs.existsSync(out)) jobs.push(this._thumbJob(out, s));
    }
    const blurOut = this._blurPath(hash);
    if (!fs.existsSync(blurOut)) jobs.push(this._blurJob(blurOut));
    return jobs;
  }

  /**
   * Render one or more WebP derivatives from a single source. HEIC/HEIF is
   * routed to the WASM decode worker pool (the prebuilt sharp can't decode most
   * of them); everything else is rendered in-process by sharp. `urgent` marks a
   * gallery-visible request that must jump ahead of background warmup. Returns
   * true only if every job's file was written; on failure the partial outputs
   * are removed so a bad render is never cached and re-served.
   */
  async _render(hash, absSource, jobs, urgent) {
    if (!jobs.length) return true;
    if (urgent) this._lastUrgentAt = Date.now(); // warmup backs off while the gallery is active
    try {
      await fsp.mkdir(path.dirname(jobs[0].out), { recursive: true });
      if (!isHeic(absSource)) {
        for (const job of jobs) {
          await sharp(absSource).rotate().resize(job.resize).webp(job.webp).toFile(job.out);
        }
        return true;
      }
      return await this._renderHeic(hash, absSource, jobs, urgent);
    } catch {
      await Promise.all(jobs.map((j) => fsp.unlink(j.out).catch(() => {})));
      return false;
    }
  }

  /**
   * Queue a HEIC render on the worker pool. Concurrent requests for the same
   * source coalesce: if a render for this hash is already queued its job list is
   * merged (so blur + thumb for one tile share a single decode); if it's already
   * running, we wait for it and only re-queue whatever is still missing after.
   */
  async _renderHeic(hash, absSource, jobs, urgent) {
    const pending = this._heicPending.get(hash);
    if (pending) {
      if (!pending.dispatched) {
        // Still waiting for a worker — merge our jobs into it (dedupe by output)
        // and raise its priority if the gallery is now waiting on it.
        const have = new Set(pending.jobs.map((j) => j.out));
        for (const j of jobs) if (!have.has(j.out)) pending.jobs.push(j);
        if (urgent && !pending.urgent) {
          pending.urgent = true;
          const i = this._heicQueue.indexOf(pending);
          if (i >= 0) {
            this._heicQueue.splice(i, 1);
            this._heicQueue.splice(this._heicInsertPos(), 0, pending);
          }
        }
        return pending.promise;
      }
      // Mid-decode — wait, then check what it produced for us.
      await pending.promise;
      jobs = jobs.filter((j) => !fs.existsSync(j.out));
      if (!jobs.length) return true;
    }

    const entry = { hash, src: absSource, jobs, urgent: !!urgent, dispatched: false, timer: null };
    entry.promise = new Promise((resolve) => { entry.resolve = resolve; });
    this._heicQueue.splice(entry.urgent ? this._heicInsertPos() : this._heicQueue.length, 0, entry);
    this._heicPending.set(hash, entry);
    this._heicPump();
    return entry.promise;
  }

  /** Insertion point for an urgent entry: after other urgent ones, before warmup. */
  _heicInsertPos() {
    for (let i = 0; i < this._heicQueue.length; i++) {
      if (!this._heicQueue[i].urgent) return i;
    }
    return this._heicQueue.length;
  }

  /** Feed queued entries to idle workers (spawning up to HEIC_POOL_SIZE). */
  _heicPump() {
    while (this._heicQueue.length) {
      const slot = this._heicIdleSlot();
      if (!slot) return;
      const entry = this._heicQueue.shift();
      entry.dispatched = true;
      slot.entry = entry;
      // The timeout starts at DISPATCH (not enqueue), so a deep queue can't
      // time out jobs that were never given a chance to run.
      entry.timer = setTimeout(() => this._heicKillSlot(slot), HEIC_JOB_TIMEOUT_MS);
      slot.worker.postMessage({ id: entry.hash, src: entry.src, jobs: entry.jobs });
    }
  }

  _heicIdleSlot() {
    const idle = this._heicPool.find((s) => !s.entry);
    if (idle) return idle;
    if (this._heicPool.length >= HEIC_POOL_SIZE) return null;
    const slot = { worker: new Worker(HEIC_WORKER), entry: null };
    slot.worker.on('message', (m) => this._heicSettle(slot, !!m.ok));
    slot.worker.on('error', () => this._heicKillSlot(slot));
    slot.worker.on('exit', () => {
      // Unexpected death (kill/terminate paths already removed the slot).
      if (this._heicPool.includes(slot)) this._heicKillSlot(slot, { alreadyDead: true });
    });
    slot.worker.unref(); // the pool alone must not keep the process alive
    this._heicPool.push(slot);
    return slot;
  }

  /** Complete the slot's current entry and hand the worker the next job. */
  _heicSettle(slot, ok) {
    const entry = slot.entry;
    if (!entry) return;
    slot.entry = null;
    clearTimeout(entry.timer);
    if (this._heicPending.get(entry.hash) === entry) this._heicPending.delete(entry.hash);
    if (!ok) for (const j of entry.jobs) fsp.unlink(j.out).catch(() => {});
    entry.resolve(ok);
    this._heicPump();
  }

  /** Tear down a wedged/crashed worker; its entry fails, the pool respawns lazily. */
  _heicKillSlot(slot, { alreadyDead = false } = {}) {
    const i = this._heicPool.indexOf(slot);
    if (i >= 0) this._heicPool.splice(i, 1);
    if (!alreadyDead) slot.worker.terminate().catch(() => {});
    this._heicSettle(slot, false);
  }

  /** Stop all HEIC workers and fail anything queued (e.g. on shutdown). */
  async dispose() {
    const queued = this._heicQueue.splice(0);
    for (const e of queued) {
      if (this._heicPending.get(e.hash) === e) this._heicPending.delete(e.hash);
      e.resolve(false);
    }
    const pool = this._heicPool.splice(0);
    for (const slot of pool) {
      if (slot.entry) {
        clearTimeout(slot.entry.timer);
        if (this._heicPending.get(slot.entry.hash) === slot.entry) this._heicPending.delete(slot.entry.hash);
        slot.entry.resolve(false);
        slot.entry = null;
      }
    }
    await Promise.all(pool.map((s) => s.worker.terminate().catch(() => {})));
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
    // Cheap-to-decode formats first: the JPEG bulk of the library warms at
    // ~100ms/image, while each HEIC costs ~1s of WASM decode — front-loading
    // JPEGs gets most of the grid covered quickly and leaves the slow HEIC tail
    // for later (on-demand requests preempt it via the urgent queue anyway).
    const imageItems = items
      .filter((m) => m.type !== 'video')
      .sort((a, b) => Number(isHeic(a.path)) - Number(isHeic(b.path)));

    let i = 0;
    const worker = async () => {
      while (i < imageItems.length && !this._warmupAbort) {
        // Yield to the user: while the gallery is actively requesting tiles
        // (scrolling, first paint), warming full-speed on 3 workers competes
        // with those on-demand renders for the same cores and visibly slows the
        // grid. Idle-wait until the gallery has been quiet for a moment.
        while (!this._warmupAbort && Date.now() - this._lastUrgentAt < 1500) {
          await new Promise((r) => setTimeout(r, 300));
        }
        if (this._warmupAbort) return;
        const m = imageItems[i++];
        const abs = path.join(root, m.path);
        // Warm every still-missing grid variant (256 for 1×, 512 for retina) +
        // blur in one render pass so the first scroll never waits on an
        // on-demand encode. Batching matters for HEIC: a single (expensive) WASM
        // decode then covers all three. The larger VIEW_SIZES stay on-demand —
        // the lightbox opens one image at a time, and pre-rendering 2048px
        // copies for the whole library would bloat the cache upfront.
        const jobs = this._missingGridJobs(m.hash);
        if (jobs.length) await this._render(m.hash, abs, jobs, false);
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
