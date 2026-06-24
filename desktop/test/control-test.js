'use strict';

/**
 * Headless integration test for the desktop control server + PhotoServer,
 * without the tray/browser/registry side effects. Uses a temp storage folder
 * and never touches the real config.json.
 *
 * Run with: npm test
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { PhotoServer } = require('../../server/src/server');
const { ActivityLog } = require('../src/activity-log');
const { startControlServer } = require('../src/control-server');

const PHOTO_PORT = 8530;
const CONTROL_PORT = 8531;
const BASE = `http://127.0.0.1:${CONTROL_PORT}`;

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`); }
}

async function api(p, method = 'GET', body) {
  const opts = { method };
  if (body !== undefined) {
    opts.headers = { 'content-type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + p, opts);
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function main() {
  const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'psd-a-'));
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'psd-b-'));

  const config = {
    port: PHOTO_PORT,
    discoveryPort: 38931,
    storagePath: dir1,
    serverName: 'Test Server',
    apiKey: '',
    serverId: crypto.randomUUID(),
  };

  const photoServer = new PhotoServer(config);
  const activityLog = new ActivityLog();
  photoServer.on('log', ({ level, message }) => activityLog.add(level, message));

  let autostartState = false;
  let notificationsState = true;

  async function getStatus() {
    const s = photoServer.stats();
    return {
      ...s,
      phoneUrl: `http://${s.addresses[0] || 'localhost'}:${s.port}`,
      driveConnected: true,
      disk: { freeBytes: 1000, totalBytes: 2000 },
      autostart: autostartState,
      notificationsEnabled: notificationsState,
      notificationsAvailable: true,
      hasTray: false,
    };
  }

  const deps = {
    host: '127.0.0.1',
    port: CONTROL_PORT,
    publicDir: path.join(__dirname, '..', 'public'),
    getStatus,
    recentActivity: (n) => activityLog.recent(n),
    async applySettings(patch) { Object.assign(config, patch); if (photoServer.running) await photoServer.restart(); return getStatus(); },
    async setStorage(p) { config.storagePath = p; if (photoServer.running) await photoServer.restart(); return getStatus(); },
    pickFolder: async () => dir2, // simulate the user picking dir2
    async setServerRunning(run) { if (run && !photoServer.running) await photoServer.start(); else if (!run && photoServer.running) await photoServer.stop(); return getStatus(); },
    async setAutostart(b) { autostartState = b; return getStatus(); },
    async setNotifications(b) { notificationsState = b; return getStatus(); },
    openFolder() {},
    onQuit() {},
  };

  const control = await startControlServer(deps);
  await photoServer.start();

  try {
    // status
    let r = await api('/api/status');
    check('status: 200', r.status === 200);
    check('status: running true', r.body.running === true);
    check('status: storagePath is dir1', r.body.storagePath === dir1, r.body.storagePath);
    check('status: name', r.body.name === 'Test Server');
    check('status: phoneUrl present', typeof r.body.phoneUrl === 'string' && r.body.phoneUrl.includes(`:${PHOTO_PORT}`));

    // stop / start
    r = await api('/api/server', 'POST', { action: 'stop' });
    check('server stop: running false', r.body.running === false);
    r = await api('/api/server', 'POST', { action: 'start' });
    check('server start: running true', r.body.running === true);

    // settings: rename + bad port rejected
    r = await api('/api/settings', 'POST', { serverName: 'Living Room' });
    check('settings: name updated', r.body.name === 'Living Room');
    r = await api('/api/settings', 'POST', { port: 99999 });
    check('settings: bad port rejected 400', r.status === 400, `got ${r.status}`);

    // storage change (simulated picker) → dir2, and the server still works there
    r = await api('/api/pick-folder', 'POST');
    check('pick-folder: storage moved to dir2', r.body.storagePath === dir2, r.body.storagePath);
    check('pick-folder: still running', r.body.running === true);

    // a real upload lands in dir2
    const photo = crypto.randomBytes(2048);
    const hash = crypto.createHash('sha256').update(photo).digest('hex');
    const up = await fetch(`http://127.0.0.1:${PHOTO_PORT}/api/upload`, {
      method: 'PUT',
      headers: { 'x-filename': 'test.jpg', 'x-hash': hash, 'x-taken-at': String(Date.UTC(2026, 0, 1)) },
      body: photo,
    });
    check('upload via running server: 201', up.status === 201, `got ${up.status}`);
    const filed = fs.existsSync(path.join(dir2, '2026', '01', 'test.jpg'));
    check('upload landed in dir2', filed);

    // autostart + notifications toggles
    r = await api('/api/autostart', 'POST', { enabled: true });
    check('autostart toggle', r.body.autostart === true);
    r = await api('/api/notifications', 'POST', { enabled: false });
    check('notifications toggle', r.body.notificationsEnabled === false);

    // activity log reflects events
    r = await api('/api/activity?limit=100');
    check('activity: has entries', Array.isArray(r.body.entries) && r.body.entries.length > 0);
    check('activity: recorded the stored file', r.body.entries.some((e) => e.message.includes('stored')));

    // static dashboard
    const html = await fetch(`${BASE}/`).then((x) => x.text());
    check('static: serves dashboard html', html.includes('PhotoSync Server') && html.includes('Connect your phone'));

    // path traversal blocked
    const trav = await fetch(`${BASE}/../../server/config.json`);
    check('static: path traversal blocked', trav.status === 404 || trav.status === 403, `got ${trav.status}`);
  } finally {
    await photoServer.stop();
    await new Promise((res) => control.close(res));
    fs.rmSync(dir1, { recursive: true, force: true });
    fs.rmSync(dir2, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('test harness error:', err);
  process.exit(1);
});
