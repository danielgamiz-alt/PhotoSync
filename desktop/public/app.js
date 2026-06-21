'use strict';

const $ = (id) => document.getElementById(id);

let lastStatus = null;
let connected = false;

async function api(path, method = 'GET', body) {
  const opts = { method };
  if (body !== undefined) {
    opts.headers = { 'content-type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function fmtBytes(n) {
  if (!n && n !== 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fmtAgo(ts) {
  if (!ts) return 'never';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

// Don't overwrite a field the user is currently editing.
function setInput(el, value) {
  if (document.activeElement !== el) el.value = value;
}

function setConnected(isConnected) {
  connected = isConnected;
  $('offlineBanner').classList.toggle('hidden', isConnected);
  // Disable controls when we can't reach the app. The Trash action buttons are
  // managed by gallery.js (enabled only when items are selected), so skip them.
  const managed = new Set(['quit', 'trashRestore', 'trashDeleteForever']);
  document.querySelectorAll('main button, main input').forEach((el) => {
    if (managed.has(el.id)) return;
    el.disabled = !isConnected;
  });
  if (!isConnected) {
    const pill = $('statusPill');
    pill.textContent = 'App not running';
    pill.className = 'pill pill-gray';
    $('statusStrip').classList.add('hidden');
  }
}

function render(s) {
  lastStatus = s;
  setConnected(true);

  const pill = $('statusPill');
  pill.textContent = s.running ? 'Running' : 'Stopped';
  pill.className = 'pill ' + (s.running ? 'pill-green' : 'pill-gray');

  $('phoneUrl').textContent = s.phoneUrl;
  setInput($('storageInput'), s.storagePath);
  $('photoCount').textContent = s.fileCount.toLocaleString();
  $('serverState').textContent = s.running ? 'Running' : 'Stopped';
  $('toggleServer').textContent = s.running ? 'Stop server' : 'Start server';

  $('driveWarning').classList.toggle('hidden', s.driveConnected);

  if (s.disk) {
    const used = s.disk.totalBytes - s.disk.freeBytes;
    const pct = s.disk.totalBytes ? (used / s.disk.totalBytes) * 100 : 0;
    $('diskUsed').style.width = pct.toFixed(1) + '%';
    $('diskText').textContent = `${fmtBytes(s.disk.freeBytes)} free of ${fmtBytes(s.disk.totalBytes)}`;
  } else {
    $('diskUsed').style.width = '0%';
    $('diskText').textContent = s.driveConnected ? '—' : 'Drive not connected';
  }

  setInput($('serverName'), s.name);
  setInput($('port'), s.port);
  $('apiKey').placeholder = s.requiresApiKey ? '•••••• (set — type to change)' : 'leave blank for none';

  $('autostart').checked = s.autostart;
  $('notifications').checked = s.notificationsEnabled;
  $('notifications').disabled = !s.notificationsAvailable;
  $('notifyUnavailable').classList.toggle('hidden', s.notificationsAvailable);

  renderStatusStrip(s);
  renderMirror(s);
}

// Always-visible reassurance line under the header.
function renderStatusStrip(s) {
  const strip = $('statusStrip');
  let warn = false;
  let text;
  if (s.fileCount === 0) {
    text = "No photos backed up yet — once your phone uploads, they'll appear here.";
  } else {
    const stale = s.lastUploadAt && Date.now() - s.lastUploadAt > 3 * 86400000;
    if (stale) {
      warn = true;
      text = `⚠ ${s.fileCount.toLocaleString()} photos backed up — but nothing new in ${fmtAgo(s.lastUploadAt)}. Is your phone on and syncing?`;
    } else {
      text = `✓ ${s.fileCount.toLocaleString()} photos backed up · last received ${fmtAgo(s.lastUploadAt)}`;
    }
  }
  if (s.mirror && s.mirror.enabled && !s.mirror.connected) {
    warn = true;
    text += ' · ⚠ second-copy drive disconnected';
  }
  strip.textContent = text;
  strip.className = 'status-strip' + (warn ? ' warn' : '');
}

function renderMirror(s) {
  const m = s.mirror || { enabled: false };
  setInput($('mirrorInput'), m.enabled ? m.path : '');
  $('mirrorSync').disabled = !m.enabled;
  if (m.enabled) {
    let t = m.connected ? 'On — every photo is copied here too' : '⚠ Drive not connected';
    if (m.lastAt) t += ` · last copied ${fmtAgo(m.lastAt)}`;
    $('mirrorStatusText').textContent = t;
  } else {
    $('mirrorStatusText').textContent = 'Off';
  }
}

function renderActivity(entries) {
  const ul = $('activity');
  if (!entries.length) {
    ul.innerHTML = '<li class="muted small">No activity yet.</li>';
    return;
  }
  ul.innerHTML = entries
    .map((e) => `<li class="lvl-${e.level}"><span class="t">${fmtTime(e.time)}</span><span class="m"></span></li>`)
    .join('');
  ul.querySelectorAll('li').forEach((li, i) => {
    li.querySelector('.m').textContent = entries[i].message; // avoid HTML injection
  });
}

async function refresh() {
  try {
    render(await api('/api/status'));
  } catch {
    setConnected(false);
  }
}

async function refreshActivity() {
  try {
    const { entries } = await api('/api/activity?limit=60');
    renderActivity(entries);
  } catch {
    /* handled by refresh() */
  }
}

function flash(msg) {
  const hint = $('saveHint');
  hint.textContent = msg;
  setTimeout(() => { hint.textContent = ''; }, 2500);
}

// Wrap a click handler so failures are shown, not swallowed.
function action(fn) {
  return async (ev) => {
    try {
      await fn(ev);
    } catch (e) {
      flash(e.message || 'Something went wrong');
    }
  };
}

// ---- actions ---------------------------------------------------------------
$('toggleServer').onclick = action(async () => {
  const running = lastStatus && lastStatus.running;
  render(await api('/api/server', 'POST', { action: running ? 'stop' : 'start' }));
  refreshActivity();
});

$('saveStorage').onclick = async () => {
  const path = $('storageInput').value.trim();
  if (!path) { $('storageHint').textContent = 'Enter a folder path'; return; }
  $('storageHint').textContent = 'Saving…';
  try {
    render(await api('/api/storage', 'POST', { path }));
    $('storageHint').textContent = 'Saved ✓';
  } catch (e) {
    $('storageHint').textContent = e.message || 'Could not save';
  }
  setTimeout(() => { $('storageHint').textContent = ''; }, 4000);
  refreshActivity();
};

$('saveSettings').onclick = action(async () => {
  const patch = { serverName: $('serverName').value, port: $('port').value };
  const apiKey = $('apiKey').value;
  if (apiKey !== '') patch.apiKey = apiKey;
  render(await api('/api/settings', 'POST', patch));
  $('apiKey').value = '';
  flash('Saved');
});

$('autostart').onchange = action(async (e) => {
  render(await api('/api/autostart', 'POST', { enabled: e.target.checked }));
});

$('notifications').onchange = action(async (e) => {
  render(await api('/api/notifications', 'POST', { enabled: e.target.checked }));
});

$('copyUrl').onclick = () => {
  if (lastStatus) navigator.clipboard?.writeText(lastStatus.phoneUrl).then(() => flash('Copied'));
};

// ---- second copy (mirror) --------------------------------------------------
$('saveMirror').onclick = async () => {
  const path = $('mirrorInput').value.trim(); // blank = turn off
  $('mirrorHint').textContent = 'Saving…';
  try {
    render(await api('/api/mirror/set', 'POST', { path }));
    $('mirrorHint').textContent = path ? 'Saved ✓' : 'Turned off';
  } catch (e) {
    $('mirrorHint').textContent = e.message || 'Could not save';
  }
  setTimeout(() => { $('mirrorHint').textContent = ''; }, 4000);
};
$('mirrorSync').onclick = async () => {
  $('mirrorHint').textContent = 'Copying…';
  try {
    const s = await api('/api/mirror/sync', 'POST');
    render(s);
    $('mirrorHint').textContent = `Copied ${s.copied || 0} new file${(s.copied || 0) === 1 ? '' : 's'}`;
  } catch (e) {
    $('mirrorHint').textContent = e.message || 'Could not copy';
  }
  setTimeout(() => { $('mirrorHint').textContent = ''; }, 4000);
};

$('quit').onclick = action(async () => {
  if (!confirm('Quit PhotoServer? Backups will stop until you start it again.')) return;
  await api('/api/quit', 'POST').catch(() => {});
  document.body.innerHTML = '<main><section class="card"><h2>PhotoServer has quit</h2>' +
    '<p class="muted">You can close this tab. Start the app again to resume backups.</p></section></main>';
});

// ---- polling ---------------------------------------------------------------
refresh();
refreshActivity();
setInterval(refresh, 2000);
setInterval(refreshActivity, 3000);
