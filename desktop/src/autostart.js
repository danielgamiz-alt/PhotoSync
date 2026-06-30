'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

// "Start on login" is implemented with the per-user Windows registry Run key.
// This is user-level (no admin needed) and fully reversible.
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const VALUE_NAME = 'PhotoSync Server';

function run(args) {
  return new Promise((resolve) => {
    execFile('reg', args, (err, stdout) => {
      resolve({ ok: !err, stdout: stdout || '' });
    });
  });
}

/** The command Windows should run at login (start hidden in the tray). */
function launchCommand() {
  // Portable build: PhotoSync Server.exe sits next to the bundled node.exe
  // (process.execPath). Launch through it — it's a windowed exe, so login
  // start is silent (no console window flashing). Running node.exe directly
  // would flash a console.
  const launcher = path.join(path.dirname(process.execPath), 'PhotoSync Server.exe');
  if (fs.existsSync(launcher)) {
    return `"${launcher}" --minimized`;
  }
  if (process.pkg) {
    // Packaged single-exe build: relaunch ourselves.
    return `"${process.execPath}" --minimized`;
  }
  // Dev: launching node.exe directly would flash a console window. Use a
  // wscript.exe + VBScript shim instead — Shell.Run with window-style 0 starts
  // the process completely hidden. wscript.exe ships with every Windows install.
  const main = path.join(__dirname, 'main.js');
  const vbs = path.join(__dirname, 'start-hidden.vbs');
  const cmd = `"${process.execPath}" "${main}" --minimized`.replace(/"/g, '""');
  fs.writeFileSync(vbs, `CreateObject("WScript.Shell").Run "${cmd}", 0, False\r\n`);
  return `wscript.exe "${vbs}"`;
}

// Renames the old 'PhotoServer' registry entry to 'PhotoSync Server' so
// existing installs keep autostart after the rename without user action.
async function migrate() {
  const OLD = 'PhotoServer';
  const { ok } = await run(['query', RUN_KEY, '/v', OLD]);
  if (!ok) return; // nothing to migrate
  await enable();                                    // write new key
  await run(['delete', RUN_KEY, '/v', OLD, '/f']);   // remove old key
}

async function isEnabled() {
  const { ok } = await run(['query', RUN_KEY, '/v', VALUE_NAME]);
  return ok;
}

async function enable() {
  return (await run(['add', RUN_KEY, '/v', VALUE_NAME, '/t', 'REG_SZ', '/d', launchCommand(), '/f'])).ok;
}

async function disable() {
  return (await run(['delete', RUN_KEY, '/v', VALUE_NAME, '/f'])).ok;
}

async function set(enabled) {
  return enabled ? enable() : disable();
}

module.exports = { isEnabled, enable, disable, set, launchCommand, migrate };
