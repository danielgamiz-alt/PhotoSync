'use strict';

const { spawn } = require('child_process');

// PowerShell script that shows the native "choose folder" dialog and forces it
// to the FRONT. A background process (our Node app) can't normally steal focus,
// so the dialog would open hidden behind the app window. The fix: an invisible
// TopMost owner form, then the well-known "tap ALT to release the foreground
// lock, then SetForegroundWindow" technique so the owned dialog appears on top.
function script(currentPath) {
  const selected = currentPath
    ? `$d.SelectedPath = '${currentPath.replace(/'/g, "''")}'`
    : '';
  return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -Namespace Native -Name Fg -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);
[DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, System.UIntPtr e);
'@
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.Opacity = 0
$owner.StartPosition = 'CenterScreen'
$owner.Show()
[Native.Fg]::keybd_event(0xA4, 0, 0, [System.UIntPtr]::Zero)  # ALT down
[Native.Fg]::keybd_event(0xA4, 0, 2, [System.UIntPtr]::Zero)  # ALT up
[Native.Fg]::SetForegroundWindow($owner.Handle) | Out-Null
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = 'Choose where to store backed-up photos'
$d.ShowNewFolderButton = $true
${selected}
$res = $d.ShowDialog($owner)
$owner.Dispose()
if ($res -eq [System.Windows.Forms.DialogResult]::OK) { [System.Console]::Out.Write($d.SelectedPath) }
`;
}

function pickFolder(currentPath) {
  // Pass the (multi-line) script as a UTF-16LE base64 -EncodedCommand to avoid
  // any quoting/escaping problems.
  const encoded = Buffer.from(script(currentPath), 'utf16le').toString('base64');

  return new Promise((resolve) => {
    let out = '';
    const child = spawn(
      'powershell',
      ['-NoProfile', '-STA', '-EncodedCommand', encoded],
      { windowsHide: true }
    );
    child.stdout.on('data', (d) => (out += d.toString()));
    child.on('error', () => resolve(null));
    child.on('close', () => {
      const p = out.trim();
      resolve(p.length > 0 ? p : null);
    });
  });
}

module.exports = { pickFolder };
