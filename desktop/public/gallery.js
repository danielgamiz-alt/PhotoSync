'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  const PLAY_SVG =
    '<svg viewBox="0 0 24 24" fill="white"><circle cx="12" cy="12" r="11" fill="rgba(0,0,0,.45)"/><path d="M9 7.5v9l8-4.5z"/></svg>';

  let media = []; // newest first; index === flat order
  const ACCOUNT_KEY = 'photoserver.galleryAccount.v2';
  let accounts = []; // [{name, count}] across the whole library
  let currentAccount = localStorage.getItem(ACCOUNT_KEY); // null until chosen; 'all' = everyone
  let renderedSig = '';
  let thumbsAvailable = false;
  const selected = new Set();
  let lastClickedIndex = null;
  let lightboxIndex = -1;
  let activeTab = 'photos';

  // 'default' is the no-account folder (e.g. older uploads) — show it as "Me".
  const accountLabel = (name) => (name === 'default' ? 'Me' : name);

  // ---- tabs ----------------------------------------------------------------
  function showTab(tab) {
    activeTab = tab;
    $('tabPhotos').classList.toggle('active', tab === 'photos');
    $('tabTrash').classList.toggle('active', tab === 'trash');
    $('tabSettings').classList.toggle('active', tab === 'settings');
    $('galleryView').classList.toggle('hidden', tab !== 'photos');
    $('trashView').classList.toggle('hidden', tab !== 'trash');
    $('settingsView').classList.toggle('hidden', tab !== 'settings');
    // The photo selection bar belongs to the Photos tab only.
    if (tab !== 'photos') $('selectionBar').classList.add('hidden');
    else if (selected.size > 0) $('selectionBar').classList.remove('hidden');
    if (tab === 'trash') loadTrash();
  }
  $('tabPhotos').onclick = () => showTab('photos');
  $('tabTrash').onclick = () => showTab('trash');
  $('tabSettings').onclick = () => showTab('settings');

  // ---- date helpers --------------------------------------------------------
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  function dayKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }
  function dayLabel(ts) {
    const d = new Date(ts);
    const now = new Date();
    const diff = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    if (diff > 1 && diff < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
    const sameYear = d.getFullYear() === now.getFullYear();
    return d.toLocaleDateString(
      undefined,
      sameYear
        ? { weekday: 'short', day: 'numeric', month: 'short' }
        : { day: 'numeric', month: 'short', year: 'numeric' }
    );
  }
  const escapeHtml = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---- fetch + render ------------------------------------------------------
  async function loadMedia() {
    let data;
    const q = currentAccount == null ? '' : `?account=${encodeURIComponent(currentAccount)}`;
    try {
      data = await fetch('/api/media' + q).then((r) => r.json());
    } catch {
      return; // disconnected — app.js shows the banner
    }
    accounts = data.accounts || [];

    // First visit (no saved choice): default to YOUR account — the owner of the
    // most recent upload (this fetch is unfiltered, so items[0] is the newest).
    // Then re-fetch filtered to that account. Falls back to "everyone".
    if (currentAccount == null) {
      const newestUser = data.items && data.items[0] && data.items[0].user;
      currentAccount = newestUser || (accounts[0] && accounts[0].name) || 'all';
      localStorage.setItem(ACCOUNT_KEY, currentAccount);
      if (currentAccount !== 'all') return loadMedia();
    }
    // A saved account that no longer exists → fall back to everyone.
    if (currentAccount !== 'all' && accounts.length && !accounts.some((a) => a.name === currentAccount)) {
      currentAccount = 'all';
      localStorage.setItem(ACCOUNT_KEY, currentAccount);
      return loadMedia();
    }

    thumbsAvailable = data.thumbnails;
    media = data.items || [];
    for (const h of [...selected]) {
      if (!media.some((m) => m.hash === h)) selected.delete(h);
    }
    renderAccountSelector();
    renderGallery();
    updateSelBar();
  }

  function renderAccountSelector() {
    const bar = $('galleryBar');
    const sel = $('accountSelect');
    // Only worth showing once there's more than one account to choose between.
    const multi = accounts.length > 1;
    bar.classList.toggle('hidden', !multi);
    if (!multi) return;

    const total = accounts.reduce((n, a) => n + a.count, 0);
    const opts = accounts
      .map((a) => `<option value="${escapeHtml(a.name)}">${escapeHtml(accountLabel(a.name))} (${a.count})</option>`)
      .join('');
    sel.innerHTML = opts + `<option value="all">Everyone (${total})</option>`;
    sel.value = currentAccount;
  }

  $('accountSelect').onchange = (e) => {
    currentAccount = e.target.value;
    localStorage.setItem(ACCOUNT_KEY, currentAccount);
    selected.clear();
    renderedSig = ''; // force re-render for the new account
    loadMedia();
  };

  function renderGallery() {
    const sig = media.map((m) => m.hash).join('|');
    if (sig === renderedSig) return; // nothing changed — avoid flicker/scroll reset
    renderedSig = sig;

    $('galleryEmpty').classList.toggle('hidden', media.length > 0);
    const root = $('gallery');
    if (media.length === 0) {
      root.innerHTML = '';
      return;
    }

    const groups = [];
    let cur = null;
    media.forEach((m, i) => {
      const k = dayKey(m.takenAt);
      if (!cur || cur.key !== k) {
        cur = { key: k, label: dayLabel(m.takenAt), items: [] };
        groups.push(cur);
      }
      cur.items.push(i);
    });

    root.innerHTML = groups
      .map(
        (g) => `<div class="day" data-daykey="${g.key}">
          <div class="day-header">
            <div class="day-check" role="button" title="Select all" aria-label="Select all photos from ${escapeHtml(g.label)}">✓</div>
            <span class="day-title">${escapeHtml(g.label)}</span>
            <span class="day-count">${g.items.length}</span>
          </div>
          <div class="day-grid">${g.items.map(renderTile).join('')}</div>
        </div>`
      )
      .join('');
    applySelectionClasses();
  }

  function renderTile(i) {
    const m = media[i];
    if (m.type === 'video') {
      return `<div class="tile video-tile" data-index="${i}" data-hash="${m.hash}">
        <video preload="metadata" muted src="/media/file?hash=${m.hash}#t=0.1"></video>
        <div class="play-badge">${PLAY_SVG}</div>
        <div class="tile-check">✓</div>
      </div>`;
    }
    return `<div class="tile" data-index="${i}" data-hash="${m.hash}">
      <img loading="lazy" src="/media/thumb?hash=${m.hash}" alt="">
      <div class="tile-check">✓</div>
    </div>`;
  }

  // ---- selection -----------------------------------------------------------
  function toggleOne(hash) {
    if (selected.has(hash)) selected.delete(hash);
    else selected.add(hash);
  }
  function selectRange(a, b) {
    const [lo, hi] = a < b ? [a, b] : [b, a];
    for (let i = lo; i <= hi; i++) selected.add(media[i].hash);
  }
  function toggleDay(dayEl) {
    const hashes = [...dayEl.querySelectorAll('.tile')].map((t) => t.dataset.hash);
    const allSelected = hashes.length > 0 && hashes.every((h) => selected.has(h));
    hashes.forEach((h) => (allSelected ? selected.delete(h) : selected.add(h)));
  }

  function applySelectionClasses() {
    document.querySelectorAll('#gallery .tile').forEach((t) => {
      t.classList.toggle('selected', selected.has(t.dataset.hash));
    });
    document.querySelectorAll('#gallery .day').forEach((day) => {
      const tiles = [...day.querySelectorAll('.tile')];
      const all = tiles.length > 0 && tiles.every((t) => selected.has(t.dataset.hash));
      day.classList.toggle('day-selected', all);
    });
  }
  function updateSelBar() {
    const n = selected.size;
    $('selectionBar').classList.toggle('hidden', n === 0);
    $('selCount').textContent = n;
    applySelectionClasses();
  }

  $('gallery').addEventListener('click', (e) => {
    const dayCheck = e.target.closest('.day-check');
    if (dayCheck) {
      toggleDay(dayCheck.closest('.day'));
      updateSelBar();
      return;
    }
    const tile = e.target.closest('.tile');
    if (!tile) return;
    const index = +tile.dataset.index;
    const onCheck = !!e.target.closest('.tile-check');
    const selecting = onCheck || selected.size > 0 || e.shiftKey;

    if (selecting) {
      if (e.shiftKey && lastClickedIndex !== null) selectRange(lastClickedIndex, index);
      else toggleOne(tile.dataset.hash);
      lastClickedIndex = index;
      updateSelBar();
    } else {
      openLightbox(index);
    }
  });

  $('selCancel').onclick = () => {
    selected.clear();
    updateSelBar();
  };
  $('selDelete').onclick = () => {
    const n = selected.size;
    if (!n) return;
    if (!confirm(
      `Permanently delete ${n} item${n > 1 ? 's' : ''} from this computer's backup?\n\n` +
      `This frees space here and does NOT delete anything from your phone.`
    )) return;
    deleteHashes([...selected]);
  };

  async function deleteHashes(hashes) {
    try {
      await fetch('/api/media/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hashes }),
      });
    } catch {
      alert('Delete failed — is the app still running?');
      return;
    }
    selected.clear();
    await loadMedia();
  }

  // ---- lightbox ------------------------------------------------------------
  function openLightbox(index) {
    lightboxIndex = index;
    renderLightbox();
    $('lightbox').classList.remove('hidden');
  }
  function closeLightbox() {
    $('lightbox').classList.add('hidden');
    $('lbStage').innerHTML = ''; // stop video playback
    lightboxIndex = -1;
  }
  function renderLightbox() {
    const m = media[lightboxIndex];
    if (!m) return;
    $('lbStage').innerHTML =
      m.type === 'video'
        ? `<video src="/media/file?hash=${m.hash}" controls autoplay></video>`
        : `<img src="/media/file?hash=${m.hash}" alt="">`;
  }
  function navLightbox(delta) {
    const n = media.length;
    if (n === 0) return;
    lightboxIndex = (lightboxIndex + delta + n) % n;
    renderLightbox();
  }
  $('lbClose').onclick = closeLightbox;
  $('lbPrev').onclick = () => navLightbox(-1);
  $('lbNext').onclick = () => navLightbox(1);
  $('lbDelete').onclick = async () => {
    const m = media[lightboxIndex];
    if (!m) return;
    if (!confirm("Delete this item from this computer's backup?")) return;
    closeLightbox();
    await deleteHashes([m.hash]);
  };
  $('lightbox').addEventListener('click', (e) => {
    if (e.target.id === 'lightbox') closeLightbox();
  });
  document.addEventListener('keydown', (e) => {
    if ($('lightbox').classList.contains('hidden')) return;
    if (e.key === 'Escape') closeLightbox();
    else if (e.key === 'ArrowLeft') navLightbox(-1);
    else if (e.key === 'ArrowRight') navLightbox(1);
  });

  // ---- trash (recycle bin) -------------------------------------------------
  let trashItems = [];
  const trashSelected = new Set();

  async function loadTrash() {
    let data;
    try {
      data = await fetch('/api/trash').then((r) => r.json());
    } catch {
      return;
    }
    trashItems = data.items || [];
    for (const id of [...trashSelected]) {
      if (!trashItems.some((t) => t.id === id)) trashSelected.delete(id);
    }
    renderTrash();
  }

  function renderTrash() {
    $('trashEmptyMsg').classList.toggle('hidden', trashItems.length > 0);
    $('trashGrid').innerHTML = trashItems
      .map((t) => {
        if (t.type === 'video') {
          return `<div class="tile video-tile" data-id="${t.id}">
            <video preload="metadata" muted src="/media/trash-file?id=${t.id}#t=0.1"></video>
            <div class="play-badge">${PLAY_SVG}</div>
            <div class="tile-check">✓</div>
          </div>`;
        }
        return `<div class="tile" data-id="${t.id}">
          <img loading="lazy" src="/media/trash-thumb?id=${t.id}" alt="">
          <div class="tile-check">✓</div>
        </div>`;
      })
      .join('');
    applyTrashSelection();
  }

  function applyTrashSelection() {
    document.querySelectorAll('#trashGrid .tile').forEach((el) => {
      el.classList.toggle('selected', trashSelected.has(el.dataset.id));
    });
    const n = trashSelected.size;
    $('trashSelCount').textContent = n > 0
      ? `${n} selected`
      : 'Deleted photos stay here 30 days, then are removed automatically.';
    $('trashRestore').disabled = n === 0;
    $('trashDeleteForever').disabled = n === 0;
  }

  $('trashGrid').addEventListener('click', (e) => {
    const tile = e.target.closest('.tile');
    if (!tile) return;
    const id = tile.dataset.id;
    if (trashSelected.has(id)) trashSelected.delete(id);
    else trashSelected.add(id);
    applyTrashSelection();
  });

  $('trashRestore').onclick = async () => {
    const ids = [...trashSelected];
    if (!ids.length) return;
    await fetch('/api/trash/restore', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids }),
    }).catch(() => {});
    trashSelected.clear();
    renderedSig = ''; // force the Photos grid to rebuild with restored items
    await loadTrash();
    await loadMedia();
  };

  $('trashDeleteForever').onclick = async () => {
    const ids = [...trashSelected];
    if (!ids.length) return;
    if (!confirm(`Permanently delete ${ids.length} item${ids.length > 1 ? 's' : ''}? This cannot be undone.`)) return;
    await fetch('/api/trash/delete', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids }),
    }).catch(() => {});
    trashSelected.clear();
    await loadTrash();
  };

  $('trashEmpty').onclick = async () => {
    if (trashItems.length === 0) return;
    if (!confirm('Empty the trash? Everything in it will be permanently deleted.')) return;
    await fetch('/api/trash/empty', { method: 'POST' }).catch(() => {});
    trashSelected.clear();
    await loadTrash();
  };

  // ---- polling -------------------------------------------------------------
  loadMedia();
  setInterval(() => {
    if (activeTab === 'photos' && selected.size === 0 && $('lightbox').classList.contains('hidden')) {
      loadMedia();
    }
  }, 8000);
})();
