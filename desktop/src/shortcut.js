'use strict';

// Offers a desktop shortcut on first launch (portable build only).
// Uses wscript.exe + VBScript so no extra dependencies are needed.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Returns the path to PhotoSync Server.exe when running inside the portable build,
// or null in dev mode (no shortcut makes sense without a stable exe location).
function launcherExe() {
  const candidate = path.join(path.dirname(process.execPath), 'PhotoSync Server.exe');
  return fs.existsSync(candidate) ? candidate : null;
}

// Shows a yes/no dialog asking the user if they want a desktop shortcut.
// Creates the shortcut if they say yes. Calls back with true/false.
// Safe to call from the main async startup — wscript runs out-of-process.
function promptAndCreate(callback) {
  const target = launcherExe();
  if (!target) { callback(false); return; }

  // Skip the prompt if the shortcut already exists (e.g. created by the installer).
  const lnkCheck = path.join(os.homedir(), 'Desktop', 'PhotoSync Server.lnk');
  if (fs.existsSync(lnkCheck)) { callback(false); return; }

  const lnk = path.join(os.homedir(), 'Desktop', 'PhotoSync Server.lnk');
  const vbs = path.join(os.tmpdir(), 'photosync-shortcut.vbs');

  const t = target.replace(/\\/g, '\\\\');
  const l = lnk.replace(/\\/g, '\\\\');

  fs.writeFileSync(vbs, [
    'Dim ans',
    'ans = MsgBox("Would you like a desktop shortcut for PhotoSync Server?", vbYesNo + vbQuestion, "PhotoSync Server")',
    'If ans = vbYes Then',
    '  Dim sh, sc',
    '  Set sh = CreateObject("WScript.Shell")',
    `  Set sc = sh.CreateShortcut("${l}")`,
    `  sc.TargetPath = "${t}"`,
    '  sc.Description = "PhotoSync Server"',
    '  sc.Save',
    '  WScript.Quit 1',
    'End If',
    'WScript.Quit 0',
  ].join('\r\n') + '\r\n');

  execFile('wscript.exe', [vbs], (err) => {
    try { fs.unlinkSync(vbs); } catch { /* best-effort cleanup */ }
    // wscript exits 1 if shortcut was created, 0 if the user said no.
    callback(err ? err.code === 1 : false);
  });
}

module.exports = { promptAndCreate };
