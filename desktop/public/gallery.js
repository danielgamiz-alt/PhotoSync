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
  let lastRev = -1; // library revision last rendered; poll re-fetches only on change

  // 'default' is the no-account folder (e.g. older uploads) — show it as "Me".
  const accountLabel = (name) => (name === 'default' ? 'Me' : name);

  // ---- tabs ----------------------------------------------------------------
  function showTab(tab) {
    activeTab = tab;
    $('tabPhotos').classList.toggle('active', tab === 'photos');
    $('tabTrash').classList.toggle('active', tab === 'trash');
    $('tabSettings').classList.toggle('active', tab === 'settings');
    $('tabAbout').classList.toggle('active', tab === 'about');
    $('galleryView').classList.toggle('hidden', tab !== 'photos');
    $('trashView').classList.toggle('hidden', tab !== 'trash');
    $('settingsView').classList.toggle('hidden', tab !== 'settings');
    $('aboutView').classList.toggle('hidden', tab !== 'about');
    // The photo selection bar belongs to the Photos tab only.
    if (tab !== 'photos') $('selectionBar').classList.add('hidden');
    else if (selected.size > 0) $('selectionBar').classList.remove('hidden');
    if (tab === 'trash') loadTrash();
  }
  $('tabPhotos').onclick = () => showTab('photos');
  $('tabTrash').onclick = () => showTab('trash');
  $('tabSettings').onclick = () => showTab('settings');
  $('tabAbout').onclick = () => showTab('about');

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
  // Section grouping respects how confident we are about a photo's date:
  //   exact → its own day        ("Yesterday", "4 Mar")
  //   year  → one section per year, dateless ("2025 · Undated") — for photos
  //           the owner filed under a bare YYYY/ folder with no real metadata
  //   none  → a single "Undated" section at the bottom
  function groupKey(m) {
    const p = m.datePrecision || 'exact';
    if (p === 'exact' && m.takenAt) return 'd-' + dayKey(m.takenAt);
    if (p === 'year' && m.takenAt) return 'y-' + new Date(m.takenAt).getFullYear();
    return 'undated';
  }
  function groupLabel(m) {
    const p = m.datePrecision || 'exact';
    if (p === 'exact' && m.takenAt) return dayLabel(m.takenAt);
    if (p === 'year' && m.takenAt) return new Date(m.takenAt).getFullYear() + ' · Undated';
    return 'Undated';
  }
  const escapeHtml = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---- fetch + render ------------------------------------------------------
  let mediaLoading = false;
  async function loadMedia() {
    if (mediaLoading) return;
    mediaLoading = true;
    $('galleryError').classList.add('hidden');
    // Show spinner only on the very first load (gallery is empty).
    const firstLoad = $('gallery').children.length === 0 && media.length === 0;
    if (firstLoad) $('galleryLoading').classList.remove('hidden');

    let data;
    const q = currentAccount == null ? '' : `?account=${encodeURIComponent(currentAccount)}`;
    try {
      data = await fetch('/api/media' + q).then((r) => r.json());
    } catch {
      $('galleryLoading').classList.add('hidden');
      if (firstLoad) $('galleryError').classList.remove('hidden');
      mediaLoading = false;
      return; // disconnected — app.js shows the banner
    }
    $('galleryLoading').classList.add('hidden');
    mediaLoading = false;
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
    if (typeof data.rev === 'number') lastRev = data.rev;
    // Now that we've reached the app, reveal the bar so "Scan for new files"
    // is always available (the account dropdown inside it is shown separately).
    $('galleryBar').classList.remove('hidden');
    renderAccountSelector();
    renderGallery();
    updateSelBar();
  }

  function renderAccountSelector() {
    const sel = $('accountSelect');
    // The account dropdown is only worth showing once there's more than one
    // account to choose between. The bar itself (and its "Scan for new files"
    // button) stays visible regardless — see loadMedia — so you can always
    // import folders even when the library still has a single account.
    const multi = accounts.length > 1;
    $('acctPicker').classList.toggle('hidden', !multi);
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
      const k = groupKey(m);
      if (!cur || cur.key !== k) {
        cur = { key: k, label: groupLabel(m), items: [] };
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
    setupLazyLoad();
  }

  function renderTile(i) {
    const m = media[i];
    // Media carries `data-src` only — it isn't fetched until the tile nears the
    // viewport (see setupLazyLoad). With a big library this is the difference
    // between thousands of immediate requests and just the few around the
    // scroll position.
    // If a tiny blur placeholder is available it is set as the immediate src
    // so tiles are never blank while the real thumbnail loads.
    if (m.type === 'video') {
      return `<div class="tile video-tile" data-index="${i}" data-hash="${m.hash}">
        <video muted data-src="/media/file?hash=${m.hash}#t=0.1"></video>
        <div class="play-badge">${PLAY_SVG}</div>
        <div class="tile-check">✓</div>
      </div>`;
    }
    const blurAttr = m.blur
      ? ` src="${m.blur}" data-blur="${m.blur}" class="thumb-blur"`
      : '';
    return `<div class="tile" data-index="${i}" data-hash="${m.hash}">
      <img${blurAttr} data-src="/media/thumb?hash=${m.hash}" alt="">
      <div class="tile-check">✓</div>
    </div>`;
  }

  // ---- lazy thumbnail loading ----------------------------------------------
  // Load each tile's image/video only as it approaches the viewport, and drop
  // the source again once it's scrolled well out of view, so memory and network
  // stay bounded no matter how large the library is. The generous rootMargin
  // preloads a screenful or two ahead so scrolling feels instant.
  //
  // A small concurrency queue (MAX_THUMB_INFLIGHT) prevents fast scrolling from
  // flooding the server — it serialises requests so Node's thumbnailer can keep
  // up and the tiles closest to the viewport load first.
  const MAX_THUMB_INFLIGHT = 6;
  let thumbInflight = 0;
  const thumbQueue = []; // images waiting for a slot (each carries _thumbSrc)
  function drainThumbQueue() {
    while (thumbInflight < MAX_THUMB_INFLIGHT && thumbQueue.length > 0) {
      const img = thumbQueue.shift();
      img._thumbQueued = false;
      if (img._releaseThumb) continue; // already loading (stale duplicate entry)
      // Skip if the tile was scrolled out of view before its turn came, or the
      // real thumb is already showing.
      if (img.dataset.src !== img._thumbSrc) continue;
      if (img.getAttribute('src') === img._thumbSrc) continue;
      startThumbLoad(img);
    }
  }
  // Load one image while holding a concurrency slot. The slot is released
  // exactly once — on load, on error, OR when the tile is unloaded mid-flight
  // (via _releaseThumb, see unloadTileMedia). That last case is essential:
  // clearing an <img>'s src to abort an in-flight request does NOT reliably
  // fire load/error, so without an explicit release a fast scroll would leak
  // slots until thumbInflight saturates and the queue jams for good.
  function startThumbLoad(img) {
    const src = img._thumbSrc;
    thumbInflight++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      img._releaseThumb = null;
      img.removeEventListener('load', onSettle);
      img.removeEventListener('error', onSettle);
      thumbInflight--;
      drainThumbQueue();
    };
    const onSettle = () => {
      const ok = img.getAttribute('src') === src && img.complete && img.naturalWidth > 0;
      release();
      if (ok) {
        img.classList.remove('thumb-blur');
        img.classList.add('thumb-loaded');
      }
    };
    img._releaseThumb = release;
    img.addEventListener('load', onSettle);
    img.addEventListener('error', onSettle);
    img.setAttribute('src', src);
  }
  function enqueueThumb(img, src) {
    if (img._thumbQueued || img._releaseThumb) return; // already waiting/loading
    img._thumbSrc = src;
    img._thumbQueued = true;
    thumbQueue.push(img);
    drainThumbQueue();
  }
  let tileObserver = null;
  function loadTileMedia(el) {
    const src = el.dataset.src;
    if (!src || el.getAttribute('src') === src) return;
    if (el.tagName === 'VIDEO') {
      el.preload = 'metadata';
      el.setAttribute('src', src);
      return;
    }
    enqueueThumb(el, src);
  }
  function unloadTileMedia(el) {
    const blurSrc = el.dataset.blur;
    if (el.tagName === 'VIDEO') {
      if (!el.hasAttribute('src')) return;
      el.removeAttribute('src');
      el.preload = 'none';
      el.load(); // abort any in-flight metadata fetch and free the decoded frame
      return;
    }
    // Give back the concurrency slot if this tile was still loading — the abort
    // below won't reliably fire load/error, so we must release it ourselves.
    el._thumbQueued = false;
    if (el._releaseThumb) el._releaseThumb();
    // Restore blur placeholder if one exists, otherwise clear src.
    el.classList.remove('thumb-loaded');
    if (blurSrc) {
      el.setAttribute('src', blurSrc);
      el.classList.add('thumb-blur');
    } else {
      el.removeAttribute('src');
    }
  }
  function setupLazyLoad() {
    if (tileObserver) tileObserver.disconnect();
    tileObserver = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const el = e.target.querySelector('img, video');
          if (!el) continue;
          if (e.isIntersecting) loadTileMedia(el);
          else unloadTileMedia(el);
        }
      },
      { rootMargin: '2000px 0px' }
    );
    document.querySelectorAll('#gallery .tile').forEach((t) => tileObserver.observe(t));
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
        : `<img src="/media/view?hash=${m.hash}" alt="">`;
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
  $('lbFolder').onclick = async () => {
    const m = media[lightboxIndex];
    if (!m) return;
    // Opens the containing folder in Explorer with this file selected, so the
    // user can drag it into an email / share it.
    await fetch('/api/media/reveal', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hash: m.hash }),
    }).catch(() => {});
  };
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

  $('retryLoad').onclick = () => loadMedia();
  window.reloadGallery = () => loadMedia();

  // ---- polling -------------------------------------------------------------
  // Poll a tiny version counter, not the whole media list. With tens of
  // thousands of photos the list is multiple MB; re-fetching and re-parsing it
  // every few seconds was pure waste when nothing had changed. Only pull the
  // full list when the library's revision actually moved (upload, scan, delete).
  loadMedia();
  setInterval(async () => {
    if (activeTab !== 'photos' || selected.size > 0 || !$('lightbox').classList.contains('hidden')) return;
    try {
      const { rev } = await fetch('/api/media/version').then((r) => r.json());
      if (typeof rev === 'number' && rev !== lastRev) loadMedia();
    } catch {
      /* disconnected — app.js shows the banner; nothing to refresh */
    }
  }, 8000);
})();
