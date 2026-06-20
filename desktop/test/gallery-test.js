'use strict';

/**
 * Headless test for the gallery API: list, thumbnail/file serving (incl. HTTP
 * Range), and delete. Uses a temp storage folder; never touches real data.
 *
 * Run with: node test/gallery-test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { Storage } = require('../../server/src/storage');
const { Thumbnailer } = require('../src/gallery-store');
const { startControlServer } = require('../src/control-server');

const PORT = 8533;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`); }
}

// Minimal valid 1x1 PNG.
const PNG_1x1 = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
  '1f15c4890000000d49444154789c6360000002000100' +
  '05fe02fea7c2b6000000000049454e44ae426082',
  'hex'
);

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psg-'));
  const storage = new Storage(dir);
  await storage.init();

  // Seed two photos on different days + a fake video.
  async function seed(name, bytes, takenAt) {
    const { Readable } = require('stream');
    const r = await storage.store(Readable.from(bytes), { filename: name, takenAt });
    return r.hash;
  }
  const h1 = await seed('a.png', Buffer.concat([PNG_1x1, Buffer.from('1')]), Date.UTC(2026, 4, 20, 10));
  const h2 = await seed('b.png', Buffer.concat([PNG_1x1, Buffer.from('2')]), Date.UTC(2026, 4, 21, 10));
  const hv = await seed('clip.mp4', crypto.randomBytes(4096), Date.UTC(2026, 4, 21, 12));

  const thumbnailer = new Thumbnailer(() => storage.root);
  const { TrashStore } = require('../src/trash-store');
  const trashStore = new TrashStore(() => storage.root);
  await trashStore.init();

  const mirrorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'psg-mirror-'));
  let mirrorPath = '';
  async function mirrorSync() {
    if (!mirrorPath) return { copied: 0 };
    let copied = 0;
    for (const m of storage.list()) {
      const dst = path.join(mirrorPath, m.path);
      if (!fs.existsSync(dst)) {
        await require('fs/promises').mkdir(path.dirname(dst), { recursive: true });
        await require('fs/promises').copyFile(path.join(storage.root, m.path), dst);
        copied++;
      }
    }
    return { copied };
  }

  const deps = {
    host: '127.0.0.1',
    port: PORT,
    publicDir: path.join(__dirname, '..', 'public'),
    getStatus: async () => ({ mirror: mirrorPath ? { enabled: true, path: mirrorPath } : { enabled: false } }),
    recentActivity: () => [],
    getStorage: () => storage,
    thumbnailer,
    async deleteMedia(hashes) {
      const all = storage.list();
      let trashed = 0;
      for (const h of hashes) {
        const copies = all.filter((m) => m.hash === h);
        if (!copies.length) continue;
        for (const m of copies) {
          await trashStore.add({ hash: m.hash, user: m.user, relPath: m.path, name: m.name, size: m.size, takenAt: m.takenAt, type: m.type });
        }
        await storage.remove(h);
        await thumbnailer.forget(h);
        trashed++;
      }
      return { deleted: trashed, fileCount: storage.count(), trashCount: trashStore.count() };
    },
    listTrash: () => trashStore.list(),
    trashFile(id) {
      const e = trashStore.get(id);
      return e ? { id, abs: trashStore.absFile(id), name: e.name, type: e.type } : null;
    },
    async restoreMedia(ids) {
      let restored = 0;
      for (const id of ids) {
        const e = trashStore.get(id);
        if (!e) continue;
        await storage.store(fs.createReadStream(trashStore.absFile(id)), { filename: e.name, takenAt: e.takenAt, username: e.user });
        await trashStore.deleteForever(id);
        restored++;
      }
      return { restored, fileCount: storage.count(), trashCount: trashStore.count() };
    },
    async deleteTrash(ids) {
      let removed = 0;
      for (const id of ids) if (await trashStore.deleteForever(id)) removed++;
      return { removed, trashCount: trashStore.count() };
    },
    async emptyTrash() { await trashStore.emptyAll(); return { trashCount: trashStore.count() }; },
    async pickMirror() { mirrorPath = mirrorDir; await mirrorSync(); return deps.getStatus(); },
    async clearMirror() { mirrorPath = ''; return deps.getStatus(); },
    async mirrorNow() { const r = await mirrorSync(); return { copied: r.copied }; },
    // unused here:
    applySettings: async () => ({}), setStorage: async () => ({}), pickFolder: async () => null,
    setServerRunning: async () => ({}), setAutostart: async () => ({}), setNotifications: async () => ({}),
    openFolder() {}, onQuit() {},
  };

  const server = await startControlServer(deps);

  try {
    // list
    const list = await fetch(`${BASE}/api/media`).then((r) => r.json());
    check('list: 3 items', list.items.length === 3, `got ${list.items.length}`);
    check('list: newest first', list.items[0].hash === hv, 'video (latest) should be first');
    check('list: video typed', list.items.find((m) => m.hash === hv).type === 'video');
    check('list: image typed', list.items.find((m) => m.hash === h1).type === 'image');

    // file serving
    const fileRes = await fetch(`${BASE}/media/file?hash=${h1}`);
    check('file: 200', fileRes.status === 200);
    check('file: accept-ranges', fileRes.headers.get('accept-ranges') === 'bytes');
    const body = Buffer.from(await fileRes.arrayBuffer());
    check('file: bytes match', body.equals(Buffer.concat([PNG_1x1, Buffer.from('1')])));

    // range request (what <video> uses)
    const rangeRes = await fetch(`${BASE}/media/file?hash=${hv}`, { headers: { Range: 'bytes=0-99' } });
    check('range: 206 partial', rangeRes.status === 206, `got ${rangeRes.status}`);
    check('range: content-range present', !!rangeRes.headers.get('content-range'));
    const partial = Buffer.from(await rangeRes.arrayBuffer());
    check('range: 100 bytes', partial.length === 100, `got ${partial.length}`);

    // thumb (no sharp → falls back to original image bytes, still 200)
    const thumbRes = await fetch(`${BASE}/media/thumb?hash=${h1}`);
    check('thumb: 200', thumbRes.status === 200);

    // missing hash
    const missing = await fetch(`${BASE}/media/file?hash=deadbeef`);
    check('file: missing → 404', missing.status === 404);

    // delete one
    const del = await fetch(`${BASE}/api/media/delete`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hashes: [h2] }),
    }).then((r) => r.json());
    check('delete: 1 removed', del.deleted === 1, `got ${del.deleted}`);
    check('delete: count now 2', del.fileCount === 2, `got ${del.fileCount}`);
    check('delete: file gone from disk', !fs.existsSync(path.join(dir, '2026', '05', 'b.png')));

    const after = await fetch(`${BASE}/api/media`).then((r) => r.json());
    check('delete: list now 2', after.items.length === 2);

    // empty delete rejected
    const bad = await fetch(`${BASE}/api/media/delete`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hashes: [] }),
    });
    check('delete: empty array → 400', bad.status === 400, `got ${bad.status}`);

    // ---- per-account views (h2 deleted above; default now has h1 + hv) -----
    const { Readable } = require('stream');
    const dup = Buffer.concat([PNG_1x1, Buffer.from('shared')]);
    const dupHash = require('crypto').createHash('sha256').update(dup).digest('hex');
    await storage.store(Readable.from(dup), { filename: 'a.png', takenAt: Date.UTC(2026, 4, 22), username: 'alice' });
    await storage.store(Readable.from(dup), { filename: 'b.png', takenAt: Date.UTC(2026, 4, 22), username: 'bob' });

    const full = await fetch(`${BASE}/api/media`).then((r) => r.json());
    check('accounts: default+alice+bob listed',
      ['default', 'alice', 'bob'].every((n) => full.accounts.some((a) => a.name === n)),
      JSON.stringify(full.accounts));

    const alice = await fetch(`${BASE}/api/media?account=alice`).then((r) => r.json());
    check('filter alice: 1 item', alice.items.length === 1, `got ${alice.items.length}`);
    check('filter alice: correct owner', alice.items[0] && alice.items[0].user === 'alice');

    const everyone = await fetch(`${BASE}/api/media?account=all`).then((r) => r.json());
    const dupCount = everyone.items.filter((m) => m.hash === dupHash).length;
    check('everyone: duplicate kept (appears twice)', dupCount === 2, `got ${dupCount}`);

    // ---- recycle bin: the h2 deleted earlier is in the trash --------------
    let trash = await fetch(`${BASE}/api/trash`).then((r) => r.json());
    check('trash: holds the deleted item', trash.items.length === 1, `got ${trash.items.length}`);
    check('trash: item keeps its name', trash.items[0].name === 'b.png', trash.items[0].name);
    const tid = trash.items[0].id;
    check('trash: file is served', (await fetch(`${BASE}/media/trash-file?id=${tid}`)).status === 200);

    const restored = await fetch(`${BASE}/api/trash/restore`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [tid] }),
    }).then((r) => r.json());
    check('trash: restore reports 1', restored.restored === 1, `got ${restored.restored}`);
    check('trash: empty after restore', restored.trashCount === 0, `got ${restored.trashCount}`);
    const back = await fetch(`${BASE}/api/media`).then((r) => r.json());
    check('trash: restored item is back in the library', back.items.some((m) => m.name === 'b.png'));

    // delete again, then permanently remove from the trash
    await fetch(`${BASE}/api/media/delete`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hashes: [h2] }),
    });
    trash = await fetch(`${BASE}/api/trash`).then((r) => r.json());
    const perm = await fetch(`${BASE}/api/trash/delete`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [trash.items[0].id] }),
    }).then((r) => r.json());
    check('trash: delete-forever removes it', perm.removed === 1 && perm.trashCount === 0, JSON.stringify(perm));

    // ---- second-drive copy (mirror) ---------------------------------------
    await fetch(`${BASE}/api/mirror/pick`, { method: 'POST' }); // sets folder + catch-up
    let mirrored = 0;
    const walk = (p) => {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const fp = path.join(p, e.name);
        if (e.isDirectory()) walk(fp);
        else mirrored++;
      }
    };
    walk(mirrorDir);
    check('mirror: files copied to the second folder', mirrored >= 1, `got ${mirrored}`);
    const sync = await fetch(`${BASE}/api/mirror/sync`, { method: 'POST' }).then((r) => r.json());
    check('mirror: copy-now returns a count', typeof sync.copied === 'number');
  } finally {
    await new Promise((res) => server.close(res));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(mirrorDir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('test harness error:', err);
  process.exit(1);
});
