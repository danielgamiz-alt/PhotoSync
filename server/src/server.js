'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');

const { Storage, sanitizeUsername, isVideoName } = require('./storage');
const discovery = require('./discovery');

const VERSION = '0.6.0';
const MAX_CHECK_BODY = 5 * 1024 * 1024; // 5 MB of JSON hashes is plenty

/**
 * PhotoSync Server as a controllable, event-emitting object so it can be driven
 * both by the headless CLI (src/index.js) and the desktop tray app.
 *
 * Events:
 *   'started'  (info)                      - bound and listening
 *   'stopped'  ()                          - fully shut down
 *   'stored'   ({ path, hash })            - a new file was saved
 *   'skipped'  ({ filename, duplicateOf }) - upload was a known duplicate
 *   'log'      ({ level, message })        - human-readable activity / errors
 */
class PhotoServer extends EventEmitter {
  constructor(config, opts = {}) {
    super();
    this.config = config;
    // An injected Storage lets the desktop app share one index between the
    // uploader and its gallery; the CLI passes none and we create our own.
    this.storage = opts.storage || null;
    this.httpServer = null;
    this.discoverySocket = null;
    this._running = false;
  }

  get running() {
    return this._running;
  }

  stats() {
    return {
      running: this._running,
      version: VERSION,
      name: this.config.serverName,
      port: this.config.port,
      storagePath: this.config.storagePath,
      fileCount: this.storage ? this.storage.count() : 0,
      storedBytes: this.storage ? this.storage.totalBytes() : 0,
      requiresApiKey: this.config.apiKey !== '',
      addresses: lanAddresses(),
    };
  }

  async start() {
    if (this._running) return this.stats();

    // Reuse an injected/existing storage if it already points at the current
    // folder; otherwise (re)create it (e.g. after a storage-path change).
    if (!this.storage || this.storage.root !== this.config.storagePath) {
      this.storage = new Storage(this.config.storagePath);
    }
    await this.storage.init();

    this.httpServer = http.createServer((req, res) => {
      this._handle(req, res).catch((err) => {
        const status = err.statusCode || 500;
        if (status >= 500) {
          this.emit('log', { level: 'error', message: `${req.method} ${req.url} failed: ${err.message}` });
        }
        sendJson(res, status, { error: err.message });
      });
    });

    // Surface a clean error (e.g. port already in use) instead of crashing.
    await new Promise((resolve, reject) => {
      const onError = (err) => reject(err);
      this.httpServer.once('error', onError);
      this.httpServer.listen(this.config.port, () => {
        this.httpServer.removeListener('error', onError);
        resolve();
      });
    });

    this.discoverySocket = discovery.start(this.config, (level, message) =>
      this.emit('log', { level, message })
    );

    this._running = true;
    const info = this.stats();
    this.emit('log', {
      level: 'info',
      message: `PhotoSync Server v${VERSION} "${this.config.serverName}" listening on port ${this.config.port}`,
    });
    this.emit('started', info);
    return info;
  }

  async stop() {
    if (!this._running) return;

    if (this.discoverySocket) {
      try {
        this.discoverySocket.close();
      } catch {
        /* already closed */
      }
      this.discoverySocket = null;
    }
    if (this.httpServer) {
      await new Promise((resolve) => this.httpServer.close(resolve));
      this.httpServer = null;
    }

    this._running = false;
    this.emit('stopped');
    this.emit('log', { level: 'info', message: 'PhotoSync Server stopped' });
  }

  /** Apply config changes (e.g. new storage folder) and rebind. */
  async restart() {
    const wasRunning = this._running;
    if (wasRunning) await this.stop();
    return this.start();
  }

  async _handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const config = this.config;
    const storage = this.storage;

    // Health/identity is unauthenticated so phones can probe for the server.
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(res, 200, {
        app: 'photoserver',
        version: VERSION,
        serverId: config.serverId,
        name: config.serverName,
        requiresApiKey: config.apiKey !== '',
        fileCount: storage.count(),
      });
    }

    if (config.apiKey !== '' && req.headers['x-api-key'] !== config.apiKey) {
      return sendJson(res, 401, { error: 'missing or wrong x-api-key' });
    }

    // The account name identifies the uploader; each user's photos live in
    // their own folder. Absent/blank -> the default (root) user. URL-encoded
    // by clients (like x-filename) so non-ASCII names survive HTTP headers.
    const username = sanitizeUsername(decodeHeader(req.headers['x-user']));

    // Phone sends { "hashes": ["...", ...] }; we answer which we don't have yet.
    if (req.method === 'POST' && url.pathname === '/api/check') {
      const body = await readBody(req, MAX_CHECK_BODY);
      let hashes;
      try {
        hashes = JSON.parse(body).hashes;
      } catch {
        throw httpError(400, 'body must be JSON: { "hashes": [...] }');
      }
      if (!Array.isArray(hashes)) throw httpError(400, '"hashes" must be an array');
      const missing = hashes.filter((h) => typeof h === 'string' && !storage.has(h, username));
      return sendJson(res, 200, { missing });
    }

    // Raw file body; metadata in headers. Streaming, so large videos are fine.
    if (req.method === 'PUT' && url.pathname === '/api/upload') {
      const filename = decodeHeader(req.headers['x-filename']) || 'unnamed';
      const takenAt = parseInt(req.headers['x-taken-at'] || '0', 10);
      const expectedHash = (req.headers['x-hash'] || '').toLowerCase() || undefined;

      const result = await storage.store(req, { filename, takenAt, expectedHash, username });
      if (result.stored) {
        this.emit('stored', { path: result.path, hash: result.hash, user: username });
        this.emit('log', { level: 'info', message: `stored ${result.path} (${username})` });
      } else {
        this.emit('skipped', { filename, duplicateOf: result.path, user: username });
        this.emit('log', { level: 'info', message: `skipped ${filename} (duplicate of ${result.path})` });
      }
      return sendJson(res, result.stored ? 201 : 200, result);
    }

    if (req.method === 'GET' && url.pathname === '/api/stats') {
      return sendJson(res, 200, {
        fileCount: storage.countFor(username),
        totalFileCount: storage.count(),
        user: username,
        storagePath: storage.root,
      });
    }

    // Scan the storage folder for files not yet in the index and add them.
    // Useful when photos are copied manually into the storage directory.
    if (req.method === 'POST' && url.pathname === '/api/reindex') {
      const result = await storage.reindex();
      this.emit('log', { level: 'info', message: `reindex: added ${result.added} file(s), total ${result.total}` });
      return sendJson(res, 200, result);
    }

    // List all files stored for this user, newest first.
    if (req.method === 'GET' && url.pathname === '/api/gallery') {
      const items = storage.list()
        .filter((item) => item.user === username)
        .map((item) => ({
          hash: item.hash,
          name: item.name,
          takenAt: item.takenAt,
          size: item.size,
          type: item.type,
        }));
      return sendJson(res, 200, { items });
    }

    // Delete a stored file by its sha256 hash (removes this user's copy).
    const fileMatch = /^\/api\/file\/([a-f0-9]{64})$/.exec(url.pathname);
    if (req.method === 'DELETE' && fileMatch) {
      const hash = fileMatch[1];
      const removed = await storage.remove(hash, username);
      if (!removed) throw httpError(404, 'file not found');
      this.emit('log', { level: 'info', message: `deleted ${hash} (${username})` });
      return sendJson(res, 200, { removed: true });
    }

    // Stream a stored file by its sha256 hash.
    if (req.method === 'GET' && fileMatch) {
      const hash = fileMatch[1];
      const entry = storage.get(hash, username);
      if (!entry) throw httpError(404, 'file not found');
      const abs = path.join(storage.root, entry.path);
      const mime = mimeFor(path.extname(entry.path));
      res.writeHead(200, { 'content-type': mime, 'content-length': String(entry.size || 0) });
      fs.createReadStream(abs).pipe(res);
      return;
    }

    throw httpError(404, `no route for ${req.method} ${url.pathname}`);
  }
}

function sendJson(res, status, obj) {
  if (res.headersSent) return res.end();
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(httpError(413, 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Filenames can contain non-ASCII (e.g. "playa_México.jpg"), which HTTP
// headers can't carry raw — clients URL-encode them.
function decodeHeader(value) {
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

const IMAGE_MIMES = new Map([
  ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'],
  ['.gif', 'image/gif'], ['.webp', 'image/webp'], ['.heic', 'image/heic'],
  ['.heif', 'image/heif'],
]);
const VIDEO_MIMES = new Map([
  ['.mp4', 'video/mp4'], ['.mov', 'video/quicktime'], ['.m4v', 'video/x-m4v'],
  ['.3gp', 'video/3gpp'], ['.mkv', 'video/x-matroska'], ['.webm', 'video/webm'],
  ['.avi', 'video/x-msvideo'], ['.wmv', 'video/x-ms-wmv'],
]);

function mimeFor(ext) {
  const e = ext.toLowerCase();
  return IMAGE_MIMES.get(e) || VIDEO_MIMES.get(e) || 'application/octet-stream';
}

function lanAddresses() {
  const out = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === 'IPv4' && !iface.internal) out.push(iface.address);
    }
  }
  return out.length > 0 ? out : ['localhost'];
}

module.exports = { PhotoServer, VERSION, lanAddresses };
