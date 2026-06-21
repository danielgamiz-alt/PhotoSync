'use strict';

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { exec, spawn } = require('child_process');

const { load, save, CONFIG_FILE } = require('../../server/src/config');
const { PhotoServer } = require('../../server/src/server');
const { Storage } = require('../../server/src/storage');
const { ActivityLog } = require('./activity-log');
const { Notifier } = require('./notifications');
const { Thumbnailer } = require('./gallery-store');
const { TrashStore } = require('./trash-store');
const { startControlServer } = require('./control-server');
const { createTray } = require('./tray');
const { pickFolder } = require('./folder-dialog');
const autostart = require('./autostart');

const CONTROL_HOST = '127.0.0.1';
const CONTROL_PORT = 8421;
const CONTROL_URL = `http://${CONTROL_HOST}:${CONTROL_PORT}`;
const ASSETS = path.join(__dirname, '..', 'assets');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PREFS_FILE = path.join(path.dirname(CONFIG_FILE), 'desktop-prefs.json');

const startMinimized = process.argv.includes('--minimized');

// Desktop-only prefs (not part of the shared server config.json).
function loadPrefs() {
  try {
    return JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8'));
  } catch {
    return { notificationsEnabled: true };
  }
}
function savePrefs(prefs) {
  try {
    fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2) + '\n');
  } catch {
    /* prefs are best-effort */
  }
}

async function main() {
  const config = load([]); // load config.json (creates it on first run)
  const prefs = loadPrefs();

  // One Storage instance shared by the uploader and the gallery, so deleting a
  // photo updates counts and dedup consistently. Reassigned if the user
  // switches the backup folder.
  let storage = new Storage(config.storagePath);
  await storage.init();

  const photoServer = new PhotoServer(config, { storage });
  const activityLog = new ActivityLog();
  const notifier = new Notifier(prefs.notificationsEnabled !== false);
  const thumbnailer = new Thumbnailer(() => storage.root);
  const trashStore = new TrashStore(() => storage.root);
  await trashStore.init(); // loads + purges items past the 30-day window

  let tray = null;
  let autostartEnabled = await autostart.isEnabled();

  // "Last received" time for the status line: newest stored item, updated live.
  let lastUploadAt = 0;
  for (const m of storage.list()) if (m.storedAt > lastUploadAt) lastUploadAt = m.storedAt;
  let mirrorLastAt = 0;

  // ---- wire server events → log, notifications, tray ----------------------
  photoServer.on('log', ({ level, message }) => activityLog.add(level, message));
  photoServer.on('started', () => syncTray());
  photoServer.on('stopped', () => syncTray());

  let storedBatch = 0;
  let storedTimer = null;
  photoServer.on('stored', ({ path: rel }) => {
    lastUploadAt = Date.now();
    mirrorCopy(rel); // also copy to the second drive, if configured
    storedBatch++;
    syncTrayThrottled();
    clearTimeout(storedTimer);
    storedTimer = setTimeout(() => {
      if (storedBatch > 0) {
        notifier.notify('Backup', `Backed up ${storedBatch} photo${storedBatch > 1 ? 's' : ''}`);
        storedBatch = 0;
      }
    }, 4000);
  });

  // ---- tray helpers --------------------------------------------------------
  let lastTrayUpdate = 0;
  function syncTray() {
    if (!tray) return;
    const s = photoServer.stats();
    let tip = s.running
      ? `PhotoServer — running · ${s.fileCount} photos`
      : 'PhotoServer — stopped';
    if (tip.length > 120) tip = tip.slice(0, 117) + '…';
    tray.update({ running: s.running, tooltip: tip });
  }
  function syncTrayThrottled() {
    const now = Date.now();
    if (now - lastTrayUpdate > 1000) {
      lastTrayUpdate = now;
      syncTray();
    }
  }

  async function safeStart() {
    try {
      await photoServer.start();
    } catch (e) {
      const msg = e.code === 'EADDRINUSE'
        ? `Port ${config.port} is already in use — change it in Settings.`
        : `Could not start server: ${e.message}`;
      activityLog.add('error', msg);
      notifier.notify('PhotoServer', msg);
    }
    syncTray();
  }

  async function safeRestart() {
    try {
      await photoServer.restart();
    } catch (e) {
      activityLog.add('error', `Could not restart server: ${e.message}`);
      notifier.notify('PhotoServer', `Could not start: ${e.message}`);
    }
    syncTray();
  }

  // ---- second-drive copy (mirror) -----------------------------------------
  async function mirrorCopy(rel) {
    if (!config.mirrorPath) return;
    try {
      const dst = path.join(config.mirrorPath, rel);
      await fsp.mkdir(path.dirname(dst), { recursive: true });
      await fsp.copyFile(path.join(storage.root, rel), dst);
      mirrorLastAt = Date.now();
    } catch (e) {
      activityLog.add('warn', `Second-copy failed for ${rel}: ${e.message}`);
    }
  }

  // Copy any files missing from the mirror (catch-up / verify).
  async function mirrorSync() {
    if (!config.mirrorPath) return { copied: 0, total: 0 };
    let copied = 0;
    const items = storage.list();
    for (const m of items) {
      const dst = path.join(config.mirrorPath, m.path);
      if (!fs.existsSync(dst)) {
        try {
          await fsp.mkdir(path.dirname(dst), { recursive: true });
          await fsp.copyFile(path.join(storage.root, m.path), dst);
          copied++;
        } catch (e) {
          activityLog.add('warn', `Second-copy failed: ${e.message}`);
        }
      }
    }
    mirrorLastAt = Date.now();
    activityLog.add('info', `Second copy updated (${copied} new file${copied === 1 ? '' : 's'})`);
    return { copied, total: items.length };
  }

  function mirrorStatus() {
    if (!config.mirrorPath) return { enabled: false };
    const root = path.parse(config.mirrorPath).root;
    return {
      enabled: true,
      path: config.mirrorPath,
      connected: !root || fs.existsSync(root),
      lastAt: mirrorLastAt,
    };
  }

  // ---- status for the dashboard -------------------------------------------
  async function getStatus() {
    const s = photoServer.stats();
    const root = path.parse(s.storagePath).root;
    let disk = null;
    let driveConnected = true;
    if (root && !fs.existsSync(root)) {
      driveConnected = false;
    } else {
      try {
        const st = await fsp.statfs(s.storagePath);
        disk = { freeBytes: st.bsize * st.bavail, totalBytes: st.bsize * st.blocks };
      } catch {
        // folder may not exist yet though the drive is present
        try {
          const st = await fsp.statfs(root);
          disk = { freeBytes: st.bsize * st.bavail, totalBytes: st.bsize * st.blocks };
        } catch {
          driveConnected = false;
        }
      }
    }
    const primary = s.addresses[0] || 'localhost';
    return {
      ...s,
      phoneUrl: `http://${primary}:${s.port}`,
      controlUrl: CONTROL_URL,
      disk,
      driveConnected,
      autostart: autostartEnabled,
      notificationsEnabled: notifier.enabled,
      notificationsAvailable: notifier.available,
      hasTray: tray !== null,
      lastUploadAt,
      trashCount: trashStore.count(),
      mirror: mirrorStatus(),
    };
  }

  function persistConfig() {
    save(config);
  }

  function openFolder() {
    const target = fs.existsSync(config.storagePath) ? config.storagePath : path.parse(config.storagePath).root;
    if (target && fs.existsSync(target)) {
      exec(`explorer "${target}"`);
    } else {
      notifier.notify('PhotoServer', 'Backup drive is not connected.');
    }
  }

  // Open the dashboard as its OWN window: a chromeless Edge "app mode" window
  // (no tabs, no address bar) so it looks like a standalone program rather than
  // a browser tab. Falls back to Chrome, then the default browser.
  function findBrowser() {
    const edges = [
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    ];
    const chromes = [
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    ];
    return [...edges, ...chromes].find((p) => fs.existsSync(p)) || null;
  }

  function openDashboard() {
    const browser = findBrowser();
    if (browser) {
      spawn(
        browser,
        [`--app=${CONTROL_URL}`, '--window-size=1180,820', '--window-position=120,80'],
        { detached: true, stdio: 'ignore' }
      ).unref();
    } else {
      exec(`cmd /c start "" "${CONTROL_URL}"`); // last resort: normal browser
    }
  }

  async function quit() {
    activityLog.add('info', 'Shutting down');
    try {
      await photoServer.stop();
    } catch {
      /* ignore */
    }
    if (tray) tray.kill();
    process.exit(0);
  }

  // ---- control server (also our single-instance lock) ---------------------
  const deps = {
    host: CONTROL_HOST,
    port: CONTROL_PORT,
    publicDir: PUBLIC_DIR,
    getStatus,
    recentActivity: (n) => activityLog.recent(n),
    async applySettings(patch) {
      Object.assign(config, patch);
      persistConfig();
      activityLog.add('info', 'Settings updated');
      if (photoServer.running) await safeRestart();
      return getStatus();
    },
    async setStorage(newPath) {
      const resolved = path.resolve(newPath);
      const root = path.parse(resolved).root;
      if (root && !fs.existsSync(root)) {
        throw new Error(`Drive ${root} isn't available — connect it and try again.`);
      }
      config.storagePath = resolved;
      persistConfig();
      // Re-point the shared storage at the new folder (gallery + uploader).
      storage = new Storage(config.storagePath);
      await storage.init();
      photoServer.storage = storage;
      activityLog.add('info', `Storage folder set to ${config.storagePath}`);
      if (photoServer.running) await safeRestart();
      return getStatus();
    },
    pickFolder: () => pickFolder(config.storagePath),
    getStorage: () => storage,
    thumbnailer,
    // Delete = move to the recycle bin (restorable for 30 days).
    async deleteMedia(hashes) {
      const all = storage.list();
      let trashed = 0;
      for (const h of hashes) {
        const copies = all.filter((m) => m.hash === h);
        if (copies.length === 0) continue;
        for (const m of copies) {
          await trashStore.add({
            hash: m.hash, user: m.user, relPath: m.path,
            name: m.name, size: m.size, takenAt: m.takenAt, type: m.type,
          });
        }
        await storage.remove(h); // index cleanup; files are already in .trash
        await thumbnailer.forget(h);
        trashed++;
      }
      if (trashed > 0) {
        activityLog.add('info', `Moved ${trashed} item${trashed > 1 ? 's' : ''} to Trash`);
        syncTray();
      }
      return { deleted: trashed, fileCount: storage.count(), trashCount: trashStore.count() };
    },
    // ---- recycle bin -------------------------------------------------------
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
        try {
          await storage.store(fs.createReadStream(trashStore.absFile(id)), {
            filename: e.name, takenAt: e.takenAt, username: e.user,
          });
          await thumbnailer.forget(e.hash);
          await trashStore.deleteForever(id);
          restored++;
        } catch (err) {
          activityLog.add('error', `Restore failed: ${err.message}`);
        }
      }
      if (restored > 0) {
        activityLog.add('info', `Restored ${restored} item${restored > 1 ? 's' : ''}`);
        syncTray();
      }
      return { restored, fileCount: storage.count(), trashCount: trashStore.count() };
    },
    async deleteTrash(ids) {
      let removed = 0;
      for (const id of ids) if (await trashStore.deleteForever(id)) removed++;
      if (removed > 0) activityLog.add('info', `Permanently deleted ${removed} item${removed > 1 ? 's' : ''}`);
      return { removed, trashCount: trashStore.count() };
    },
    async emptyTrash() {
      await trashStore.emptyAll();
      activityLog.add('info', 'Emptied Trash');
      return { trashCount: trashStore.count() };
    },
    // ---- second-drive copy -------------------------------------------------
    async pickMirror() {
      const folder = await pickFolder(config.mirrorPath || config.storagePath);
      if (!folder) return { ...(await getStatus()), cancelled: true };
      config.mirrorPath = path.resolve(folder);
      persistConfig();
      activityLog.add('info', `Second copy folder set to ${config.mirrorPath}`);
      mirrorSync(); // catch up in the background
      return getStatus();
    },
    async clearMirror() {
      config.mirrorPath = '';
      persistConfig();
      activityLog.add('info', 'Second copy disabled');
      return getStatus();
    },
    // Set (or, with a blank path, turn off) the second-copy folder by path.
    async setMirror(newPath) {
      const p = (newPath || '').trim();
      if (p === '') {
        config.mirrorPath = '';
        persistConfig();
        activityLog.add('info', 'Second copy turned off');
        return getStatus();
      }
      const resolved = path.resolve(p);
      const root = path.parse(resolved).root;
      if (root && !fs.existsSync(root)) {
        throw new Error(`Drive ${root} isn't available — connect it and try again.`);
      }
      config.mirrorPath = resolved;
      persistConfig();
      activityLog.add('info', `Second copy folder set to ${resolved}`);
      mirrorSync(); // catch up in the background
      return getStatus();
    },
    async mirrorNow() {
      const r = await mirrorSync();
      return { ...(await getStatus()), copied: r.copied };
    },
    async setServerRunning(shouldRun) {
      if (shouldRun && !photoServer.running) await safeStart();
      else if (!shouldRun && photoServer.running) await photoServer.stop();
      return getStatus();
    },
    async setAutostart(enabled) {
      const ok = await autostart.set(enabled);
      if (ok) autostartEnabled = enabled;
      activityLog.add('info', `Start on login ${enabled ? 'enabled' : 'disabled'}`);
      return getStatus();
    },
    async setNotifications(enabled) {
      notifier.enabled = enabled;
      prefs.notificationsEnabled = enabled;
      savePrefs(prefs);
      return getStatus();
    },
    openFolder,
    onQuit: quit,
  };

  let controlServer;
  try {
    controlServer = await startControlServer(deps);
  } catch (e) {
    if (e.code === 'EADDRINUSE') {
      // Another instance already owns the dashboard port — just surface it.
      console.log('PhotoServer is already running; opening its dashboard.');
      openDashboard();
      process.exit(0);
    }
    throw e;
  }
  activityLog.add('info', `Dashboard ready at ${CONTROL_URL}`);

  // ---- start the photo server + tray --------------------------------------
  await safeStart();

  tray = await createTray({
    runningIcoPath: path.join(ASSETS, 'running.ico'),
    stoppedIcoPath: path.join(ASSETS, 'stopped.ico'),
    running: photoServer.running,
    tooltip: 'PhotoServer',
    handlers: {
      onOpenDashboard: openDashboard,
      onToggleServer: () => deps.setServerRunning(!photoServer.running),
      onOpenFolder: openFolder,
      onQuit: quit,
    },
  });
  if (!tray) {
    activityLog.add('warn', 'Tray unavailable (systray2 not installed) — running headless. Open the dashboard manually.');
    console.log(`Tray not available. Dashboard: ${CONTROL_URL}`);
  }
  syncTray();

  if (!startMinimized) openDashboard();

  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);

  console.log(`PhotoServer desktop running. Dashboard: ${CONTROL_URL}`);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
