'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const { mimeFor } = require('./gallery-store');

// The private dashboard. Bound to 127.0.0.1 ONLY — it can change the storage
// folder, API key, autostart, etc., so it must never be reachable from the LAN
// (only the photo-upload server on :8420 is exposed to phones).

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * deps = {
 *   host, port, publicDir,
 *   getStatus()        -> Promise<status>
 *   applySettings(p)   -> Promise<status>   // { serverName, apiKey, port }
 *   setStorage(path)   -> Promise<status>
 *   pickFolder()       -> Promise<string|null>
 *   setServerRunning(b)-> Promise<status>
 *   setAutostart(b)    -> Promise<status>
 *   setNotifications(b)-> Promise<status>
 *   openFolder()       -> void
 *   recentActivity(n)  -> array
 *   onQuit()           -> void
 * }
 */
function startControlServer(deps) {
  const server = http.createServer((req, res) => {
    route(req, res, deps).catch((err) => {
      sendJson(res, err.statusCode || 500, { error: err.message });
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(deps.port, deps.host, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

async function route(req, res, deps) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  // ---- API -----------------------------------------------------------------
  if (p === '/api/status' && req.method === 'GET') {
    return sendJson(res, 200, await deps.getStatus());
  }

  if (p === '/api/activity' && req.method === 'GET') {
    const limit = parseInt(url.searchParams.get('limit') || '100', 10);
    return sendJson(res, 200, { entries: deps.recentActivity(limit) });
  }

  // ---- gallery -------------------------------------------------------------
  if (p === '/api/media' && req.method === 'GET') {
    const storage = deps.getStorage();
    if (!storage) return sendJson(res, 200, { items: [], accounts: [], thumbnails: false });

    const all = storage.list(); // each item carries its `user`
    const counts = {};
    for (const m of all) counts[m.user] = (counts[m.user] || 0) + 1;
    const accounts = Object.entries(counts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    // account=<name> → just that account; account=all → everyone (dupes kept);
    // omitted → everyone (the client then picks a default account).
    const account = url.searchParams.get('account') || '';
    const items = account && account !== 'all' ? all.filter((m) => m.user === account) : all;

    return sendJson(res, 200, { items, accounts, thumbnails: deps.thumbnailer.available });
  }

  if (p === '/media/thumb' && req.method === 'GET') {
    const entry = entryFor(deps, url.searchParams.get('hash'));
    if (!entry) return sendJson(res, 404, { error: 'not found' });
    const type = mimeFor(entry.path).startsWith('video') ? 'video' : 'image';
    const thumb = await deps.thumbnailer.thumb(entry.hash, entry.abs, type);
    if (thumb) return serveFile(req, res, thumb, 'image/jpeg');
    return serveFile(req, res, entry.abs, mimeFor(entry.path)); // fallback: original
  }

  if (p === '/media/file' && req.method === 'GET') {
    const entry = entryFor(deps, url.searchParams.get('hash'));
    if (!entry) return sendJson(res, 404, { error: 'not found' });
    return serveFile(req, res, entry.abs, mimeFor(entry.path));
  }

  if (p === '/api/media/delete' && req.method === 'POST') {
    const body = await readJson(req);
    if (!Array.isArray(body.hashes) || body.hashes.length === 0) {
      throw httpError(400, 'hashes must be a non-empty array');
    }
    return sendJson(res, 200, await deps.deleteMedia(body.hashes));
  }

  // ---- recycle bin ---------------------------------------------------------
  if (p === '/api/trash' && req.method === 'GET') {
    return sendJson(res, 200, { items: deps.listTrash() });
  }

  if ((p === '/media/trash-thumb' || p === '/media/trash-file') && req.method === 'GET') {
    const t = deps.trashFile(url.searchParams.get('id'));
    if (!t) return sendJson(res, 404, { error: 'not found' });
    if (p === '/media/trash-thumb') {
      const thumb = await deps.thumbnailer.thumb(t.id, t.abs, t.type);
      if (thumb) return serveFile(req, res, thumb, 'image/jpeg');
    }
    return serveFile(req, res, t.abs, mimeFor(t.name));
  }

  if (p === '/api/trash/restore' && req.method === 'POST') {
    const body = await readJson(req);
    if (!Array.isArray(body.ids) || body.ids.length === 0) throw httpError(400, 'ids required');
    return sendJson(res, 200, await deps.restoreMedia(body.ids));
  }

  if (p === '/api/trash/delete' && req.method === 'POST') {
    const body = await readJson(req);
    if (!Array.isArray(body.ids) || body.ids.length === 0) throw httpError(400, 'ids required');
    return sendJson(res, 200, await deps.deleteTrash(body.ids));
  }

  if (p === '/api/trash/empty' && req.method === 'POST') {
    return sendJson(res, 200, await deps.emptyTrash());
  }

  // ---- second-drive copy ---------------------------------------------------
  if (p === '/api/mirror/pick' && req.method === 'POST') {
    return sendJson(res, 200, await deps.pickMirror());
  }
  if (p === '/api/mirror/clear' && req.method === 'POST') {
    return sendJson(res, 200, await deps.clearMirror());
  }
  if (p === '/api/mirror/set' && req.method === 'POST') {
    const body = await readJson(req);
    return sendJson(res, 200, await deps.setMirror(typeof body.path === 'string' ? body.path : ''));
  }
  if (p === '/api/mirror/sync' && req.method === 'POST') {
    return sendJson(res, 200, await deps.mirrorNow());
  }

  if (p === '/api/settings' && req.method === 'POST') {
    const body = await readJson(req);
    const patch = {};
    if (typeof body.serverName === 'string') patch.serverName = body.serverName.trim() || 'PhotoSync Server';
    if (typeof body.apiKey === 'string') patch.apiKey = body.apiKey;
    if (body.port !== undefined) {
      const port = parseInt(body.port, 10);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw httpError(400, 'port must be between 1 and 65535');
      }
      patch.port = port;
    }
    return sendJson(res, 200, await deps.applySettings(patch));
  }

  if (p === '/api/pick-folder' && req.method === 'POST') {
    const folder = await deps.pickFolder();
    if (!folder) return sendJson(res, 200, { cancelled: true });
    return sendJson(res, 200, await deps.setStorage(folder));
  }

  if (p === '/api/storage' && req.method === 'POST') {
    const body = await readJson(req);
    if (typeof body.path !== 'string' || body.path.trim() === '') {
      throw httpError(400, 'path is required');
    }
    return sendJson(res, 200, await deps.setStorage(body.path.trim()));
  }

  if (p === '/api/server' && req.method === 'POST') {
    const body = await readJson(req);
    if (body.action !== 'start' && body.action !== 'stop') {
      throw httpError(400, 'action must be "start" or "stop"');
    }
    return sendJson(res, 200, await deps.setServerRunning(body.action === 'start'));
  }

  if (p === '/api/autostart' && req.method === 'POST') {
    const body = await readJson(req);
    return sendJson(res, 200, await deps.setAutostart(!!body.enabled));
  }

  if (p === '/api/notifications' && req.method === 'POST') {
    const body = await readJson(req);
    return sendJson(res, 200, await deps.setNotifications(!!body.enabled));
  }

  if (p === '/api/open-folder' && req.method === 'POST') {
    deps.openFolder();
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/quit' && req.method === 'POST') {
    sendJson(res, 200, { ok: true });
    setTimeout(() => deps.onQuit(), 100);
    return;
  }

  // ---- static dashboard ----------------------------------------------------
  if (req.method === 'GET') {
    return serveStatic(res, deps.publicDir, p === '/' ? '/index.html' : p);
  }

  throw httpError(404, `no route for ${req.method} ${p}`);
}

// Resolve a media hash to its on-disk file via the shared storage.
function entryFor(deps, hash) {
  const storage = deps.getStorage();
  if (!storage || !hash) return null;
  const e = storage.get(hash);
  if (!e) return null;
  return { hash, path: e.path, abs: path.join(storage.root, e.path) };
}

// Streams a file, honouring HTTP Range requests so <video> can seek.
function serveFile(req, res, absPath, mime) {
  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return sendJson(res, 404, { error: 'not found' });
  }
  const total = stat.size;
  const headers = {
    'content-type': mime,
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=300',
  };

  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : total - 1;
    if (!Number.isFinite(start) || start < 0) start = 0;
    if (!Number.isFinite(end) || end >= total) end = total - 1;
    if (start > end) {
      res.writeHead(416, { 'content-range': `bytes */${total}` });
      return res.end();
    }
    headers['content-range'] = `bytes ${start}-${end}/${total}`;
    headers['content-length'] = end - start + 1;
    res.writeHead(206, headers);
    fs.createReadStream(absPath, { start, end }).pipe(res);
  } else {
    headers['content-length'] = total;
    res.writeHead(200, headers);
    fs.createReadStream(absPath).pipe(res);
  }
}

function serveStatic(res, publicDir, pathname) {
  // Prevent path traversal: resolve and ensure it stays under publicDir.
  const filePath = path.join(publicDir, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(publicDir)) {
    return sendJson(res, 403, { error: 'forbidden' });
  }
  fs.readFile(filePath, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'not found' });
    const type = STATIC_TYPES[path.extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type });
    res.end(data);
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 1024) {
        reject(httpError(413, 'body too large'));
        req.destroy();
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw === '') return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(httpError(400, 'invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  if (res.headersSent) return res.end();
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

module.exports = { startControlServer };
