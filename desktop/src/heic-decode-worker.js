'use strict';

// Off-main-thread HEIC/HEIF renderer.
//
// The prebuilt sharp/libheif can only decode ~5% of real (HEVC) HEICs — it
// throws "No decoding plugin installed for this compression format" on the rest,
// which is why HEIC thumbnails were 0% generated. heic-decode carries its own
// libde265 (WASM), so it decodes ~95% regardless of the native plugin; sharp is
// kept as a fallback for the few files WASM rejects, giving ~100% between them.
//
// The WASM decode is CPU-heavy (~1s/image) and blocks its thread, so it runs
// here in a worker_thread rather than on the app's main thread (which also
// serves the gallery HTTP). Jobs are processed one at a time — the decode
// saturates a core anyway, and serializing avoids any libheif reentrancy risk.
//
// Message in:  { id, src, jobs }  where each job is { out, resize, webp }.
// Message out: { id, ok }         (ok:false on any decode/encode failure).

const { parentPort } = require('worker_threads');
const fs = require('fs');
const sharp = require('sharp');

let heicDecode = null;
try {
  heicDecode = require('heic-decode');
} catch {
  heicDecode = null; // fall back to sharp-only if the dep is somehow missing
}

// Decode a HEIC/HEIF file to oriented raw RGB(A) pixels. Tries the WASM decoder
// first, then sharp's native libheif for the handful WASM can't parse.
async function decodeHeic(src) {
  const buf = fs.readFileSync(src);
  if (heicDecode) {
    try {
      const { width, height, data } = await heicDecode({ buffer: buf });
      return { data: Buffer.from(data), width, height, channels: 4 };
    } catch {
      // WASM rejected it (e.g. not actually HEVC) — try native sharp below.
    }
  }
  const { data, info } = await sharp(buf).rotate().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

async function handle({ id, src, jobs }) {
  try {
    const base = await decodeHeic(src);
    const raw = { width: base.width, height: base.height, channels: base.channels };
    for (const job of jobs) {
      await sharp(base.data, { raw }).resize(job.resize).webp(job.webp).toFile(job.out);
    }
    parentPort.postMessage({ id, ok: true });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
}

// Serialize: finish one job before starting the next.
let chain = Promise.resolve();
parentPort.on('message', (msg) => {
  chain = chain.then(() => handle(msg));
});
