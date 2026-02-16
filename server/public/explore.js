/**
 * server/public/explore.js — Explore-page client-side logic.
 *
 * Self-contained IIFE that drives the Leaflet map, the destination list with
 * drag-and-drop reordering, debounced geocoding search, bookmark management
 * (persisted to localStorage), route optimisation via the server API, and
 * visualisation of the optimised route (polylines, numbered markers, travel
 * time labels, transit station dots).
 */
(() => {
  const mapEl = document.getElementById('exploreMap');
  if (!mapEl || typeof window.L === 'undefined') return;

  const $ = (id) => document.getElementById(id);

  const placesList = $('placesList');
  const addPlaceBtn = $('addPlaceBtn');
  const computeBtn = $('computeBtn');
  const clearBtn = $('clearBtn');
  const modeSelect = $('modeSelect');
  const tripTitle = $('tripTitle');
  const startRepoBtn = $('startRepoBtn');
  const statusMsg = $('statusMsg');
  const summaryLine = $('summaryLine');
  const legsList = $('legsList');
  const bookmarkListName = $('bookmarkListName');
  const bookmarkIconPicker = $('bookmarkIconPicker');
  const bookmarkIconButton = $('bookmarkIconButton');
  const bookmarkIconMenu = $('bookmarkIconMenu');
  const bookmarkCreateBtn = $('bookmarkCreateBtn');
  const bookmarkLists = $('bookmarkLists');
  const bookmarkSidebarToggle = $('bookmarkSidebarToggle');
  const exploreSidebar = bookmarkSidebarToggle?.closest('.explore-sidebar') || null;

  /** Generate a unique ID (crypto.randomUUID with fallback for older browsers). */
  const uid = () =>
    (window.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const modeIconHtml = (m) => {
    const x = String(m || '').toLowerCase();
    if (x === 'walking') return '<i class="fa-solid fa-person-walking" aria-hidden="true"></i>';
    if (x === 'cycling') return '<i class="fa-solid fa-bicycle" aria-hidden="true"></i>';
    if (x === 'transit') return '<i class="fa-solid fa-train" aria-hidden="true"></i>';
    return '<i class="fa-solid fa-car" aria-hidden="true"></i>';
  };

  const startIconHtml = '<i class="fa-solid fa-location-dot" aria-hidden="true"></i>';

  // --- Map initialisation (Leaflet + OpenStreetMap tiles) ---
  const map = L.map('exploreMap', { preferCanvas: true, zoomControl: false });
  L.control.zoom({ position: 'bottomleft' }).addTo(map);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
  }).addTo(map);

  map.setView([51.5074, -0.1278], 6); // default view
  setTimeout(() => map.invalidateSize(), 0);

  // --- Map layer arrays (cleared and rebuilt on each route computation) ---
  let stopMarkers = [];      // numbered destination pins
  let routeLines = [];       // polyline segments (solid/dashed by mode)
  let routeLabels = [];      // "X min" labels at segment midpoints
  let stationMarkers = [];   // transit station dots
  let bookmarkMarkers = [];  // bookmark pins (persisted separately)

  function clearLayers() {
    stopMarkers.forEach((m) => map.removeLayer(m));
    routeLines.forEach((l) => map.removeLayer(l));
    routeLabels.forEach((m) => map.removeLayer(m));
    stationMarkers.forEach((m) => map.removeLayer(m));
    stopMarkers = [];
    routeLines = [];
    routeLabels = [];
    stationMarkers = [];
  }

  function clearBookmarkMarkers() {
    bookmarkMarkers.forEach((m) => map.removeLayer(m));
    bookmarkMarkers = [];
  }

  function numIcon(n) {
    return L.divIcon({
      className: 'num-pin',
      html: `<div class="pin"><span>${n}</span></div>`,
      iconSize: [26, 26],
      iconAnchor: [13, 13],
    });
  }

  const ROUTE_COLORS = {
    driving: '#ec5643',
    transit: '#ec5643',
    walking: '#ec5643',
    cycling: '#5f7a74',
  };

  function colorFor(m) {
    return ROUTE_COLORS[String(m || '').toLowerCase()] || '#233331';
  }

  /** Return Leaflet polyline options for a transport sub-mode (dotted/dashed/solid). */
  function routeStyle(subMode) {
    const m = String(subMode || '').toLowerCase();
    const polyOpts = {
      weight: (m === 'walking' || m === 'cycling') ? 4 : 5,
      color: colorFor(m),
      opacity: 0.95,
    };
    if (m === 'walking') polyOpts.dashArray = '4 6';   // dotted for walking
    if (m === 'cycling') polyOpts.dashArray = '1 8';   // dashed for cycling
    return polyOpts;                                    // solid for driving/transit
  }

  function midPointFromCoords(coords) {
    const pts = Array.isArray(coords) ? coords : [];
    if (!pts.length) return null;
    return pts[Math.floor(pts.length / 2)];
  }

  function labelMarker(lat, lng, html) {
    return L.marker([lat, lng], {
      interactive: false,
      icon: L.divIcon({
        className: 'route-label',
        html: `<div class="bubble">${html}</div>`,
        iconSize: null,
        iconAnchor: [0, 0],
      }),
    });
  }

  // --- UI state ---
  const state = {
    rows: [],           // destination rows [{id, query, place}]
    startId: null,      // ID of the row marked as starting point
    computed: null,     // last successful server optimisation response
    draggingId: null,   // row currently being dragged (for reorder)
  };

  /** Bookmark lists persisted to localStorage. */
  const bookmarkState = {
    lists: [],          // [{id, name, icon, show, items:[{id,name,lat,lng}]}]
    activeListId: null,
  };
  let openBookmarkMenuEl = null;  // currently-open bookmark save menu (for toggle)

  const BOOKMARK_KEY = 'gitripBookmarks';   // localStorage key
  const ICONS = {
    star: { icon: 'fa-star', color: '#f59e0b' },
    heart: { icon: 'fa-heart', color: '#ef4444' },
    bookmark: { icon: 'fa-bookmark', color: '#2563eb' },
    flag: { icon: 'fa-flag', color: '#10b981' },
    'location-dot': { icon: 'fa-location-dot', color: '#8b5cf6' },
  };
  const ICON_KEYS = Object.keys(ICONS);

  function iconKeyOrDefault(key) {
    return ICONS[key] ? key : 'star';
  }

  function iconHtml(key) {
    const cfg = ICONS[iconKeyOrDefault(key)];
    return `<i class="fa-solid ${cfg.icon}" aria-hidden="true"></i>`;
  }

  function applyIconButton(el, key) {
    if (!el) return;
    const cfg = ICONS[iconKeyOrDefault(key)];
    el.innerHTML = `<i class="fa-solid ${cfg.icon}" aria-hidden="true"></i>`;
    el.style.background = cfg.color;
    el.style.color = '#fff';
  }

  function renderIconMenu(menuEl, selectedKey, onSelect) {
    if (!menuEl) return;
    const safe = iconKeyOrDefault(selectedKey);
    menuEl.innerHTML = '';
    ICON_KEYS.forEach((key) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.icon = key;
      btn.innerHTML = iconHtml(key);
      btn.style.color = ICONS[key].color;
      if (key === safe) btn.classList.add('is-active');
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        onSelect(key);
      });
      menuEl.appendChild(btn);
    });
  }

  function loadBookmarks() {
    try {
      const raw = localStorage.getItem(BOOKMARK_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.lists)) {
          bookmarkState.lists = parsed.lists;
          bookmarkState.activeListId = parsed.activeListId || null;
          return;
        }
      }
    } catch {}
    bookmarkState.lists = [
      { id: uid(), name: 'Favorites', icon: 'star', show: true, items: [] },
      { id: uid(), name: 'Want to go', icon: 'bookmark', show: true, items: [] },
      { id: uid(), name: 'Starred', icon: 'heart', show: true, items: [] },
    ];
    bookmarkState.activeListId = bookmarkState.lists[0]?.id || null;
    saveBookmarks();
  }

  function saveBookmarks() {
    try {
      localStorage.setItem(
        BOOKMARK_KEY,
        JSON.stringify({
          lists: bookmarkState.lists,
          activeListId: bookmarkState.activeListId,
        })
      );
    } catch {}
  }

  function iconForList(list) {
    const key = list?.icon || 'star';
    return ICONS[key] || ICONS.star;
  }

  function refreshBookmarkMarkers() {
    clearBookmarkMarkers();
    bookmarkState.lists.forEach((list) => {
      if (!list.show) return;
      const iconCfg = iconForList(list);
      (list.items || []).forEach((p) => {
        if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return;
        const mk = L.marker([p.lat, p.lng], {
          icon: L.divIcon({
            className: 'bookmark-pin',
            html: `<div class="bookmark-pin__badge" style="background:${iconCfg.color}"><i class="fa-solid ${iconCfg.icon}"></i></div>`,
            iconSize: [22, 22],
            iconAnchor: [11, 11],
          }),
        }).addTo(map);
        if (p.name) mk.bindPopup(p.name);
        bookmarkMarkers.push(mk);
      });
    });
  }

  function renderBookmarkLists() {
    if (!bookmarkLists) return;
    bookmarkLists.innerHTML = '';

    bookmarkState.lists.forEach((list) => {
      const wrap = document.createElement('div');
      wrap.className = 'bookmark-list';

      const header = document.createElement('div');
      header.className = 'bookmark-list-header';

      const iconPicker = document.createElement('details');
      iconPicker.className = 'icon-picker icon-picker--compact';

      const iconSummary = document.createElement('summary');
      iconSummary.className = 'icon-picker__summary';
      const iconButton = document.createElement('span');
      iconButton.className = 'icon-picker__icon';
      applyIconButton(iconButton, list.icon);
      iconSummary.appendChild(iconButton);
      iconPicker.appendChild(iconSummary);

      const iconMenu = document.createElement('div');
      iconMenu.className = 'icon-picker__menu';
      renderIconMenu(iconMenu, list.icon, (key) => {
        list.icon = key;
        saveBookmarks();
        renderBookmarkLists();
        refreshBookmarkMarkers();
      });
      iconPicker.appendChild(iconMenu);

      const nameInput = document.createElement('input');
      nameInput.value = list.name || '';
      nameInput.addEventListener('change', () => {
        list.name = nameInput.value.trim() || 'Untitled list';
        saveBookmarks();
        renderBookmarkLists();
      });

      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = list.show !== false;
      toggle.title = 'Show on map';
      toggle.addEventListener('change', () => {
        list.show = toggle.checked;
        saveBookmarks();
        refreshBookmarkMarkers();
      });

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'explore-remove';
      delBtn.title = 'Delete list';
      delBtn.textContent = '✕';
      delBtn.addEventListener('click', () => {
        const ok = window.confirm(`Delete "${list.name || 'Untitled list'}"?`);
        if (!ok) return;
        bookmarkState.lists = bookmarkState.lists.filter((x) => x.id !== list.id);
        if (bookmarkState.activeListId === list.id) {
          bookmarkState.activeListId = bookmarkState.lists[0]?.id || null;
        }
        saveBookmarks();
        renderBookmarkLists();
        refreshBookmarkMarkers();
      });

      header.appendChild(iconPicker);
      header.appendChild(nameInput);
      header.appendChild(toggle);
      header.appendChild(delBtn);

      const items = document.createElement('ul');
      items.className = 'bookmark-items';
      (list.items || []).forEach((p) => {
        const li = document.createElement('li');
        li.textContent = p.name || 'Place';
        li.addEventListener('click', () => {
          if (Number.isFinite(p.lat) && Number.isFinite(p.lng)) {
            map.setView([p.lat, p.lng], 15);
          }
        });

        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'explore-remove';
        rm.style.marginLeft = '6px';
        rm.textContent = '✕';
        rm.addEventListener('click', (e) => {
          e.stopPropagation();
          list.items = (list.items || []).filter((x) => x.id !== p.id);
          saveBookmarks();
          renderBookmarkLists();
          refreshBookmarkMarkers();
        });

        li.appendChild(rm);
        items.appendChild(li);
      });

      items.addEventListener('click', (e) => {
        if (e.target && e.target.closest('button')) return;
        if (!list.items || !list.items.length) return;
        state.rows = list.items.map((p) => ({
          id: uid(),
          query: p.name || '',
          place: {
            name: p.name || '',
            fullName: p.fullName || p.name || '',
            lat: Number(p.lat),
            lng: Number(p.lng),
          },
        }));
        state.startId = state.rows[0]?.id || null;
        state.computed = null;
        startRepoBtn.disabled = true;
        renderRows();
        setStatus(`Loaded ${list.items.length} place${list.items.length === 1 ? '' : 's'} from "${list.name}".`);
      });

      wrap.appendChild(header);
      wrap.appendChild(items);
      bookmarkLists.appendChild(wrap);
    });
  }

  function ensureActiveList() {
    if (!bookmarkState.activeListId && bookmarkState.lists[0]) {
      bookmarkState.activeListId = bookmarkState.lists[0].id;
    }
  }

  function savePlaceToList(place, listId) {
    if (!place || !Number.isFinite(place.lat) || !Number.isFinite(place.lng)) {
      setStatus('Pick a place first to save it.');
      return;
    }
    const list = bookmarkState.lists.find((l) => l.id === listId);
    if (!list) {
      setStatus('Create a list first.');
      return;
    }
    const key = `${place.lat},${place.lng},${place.name}`;
    const exists = (list.items || []).some((p) => `${p.lat},${p.lng},${p.name}` === key);
    if (exists) {
      setStatus('Already in this list.');
      return;
    }
    list.items = list.items || [];
    list.items.push({
      id: uid(),
      name: place.name,
      fullName: place.fullName,
      lat: place.lat,
      lng: place.lng,
    });
    saveBookmarks();
    renderBookmarkLists();
    refreshBookmarkMarkers();
    setStatus(`Saved to "${list.name}".`);
  }

  function closeBookmarkMenu() {
    if (openBookmarkMenuEl) {
      openBookmarkMenuEl.classList.remove('is-open');
      openBookmarkMenuEl = null;
    }
  }

  function buildBookmarkMenu(menuEl, place) {
    if (!menuEl) return;
    menuEl.innerHTML = '';

    if (!place || !Number.isFinite(place.lat) || !Number.isFinite(place.lng)) {
      const empty = document.createElement('div');
      empty.className = 'bookmark-menu__empty';
      empty.textContent = 'Pick a place first.';
      menuEl.appendChild(empty);
      return;
    }

    if (!bookmarkState.lists.length) {
      const empty = document.createElement('div');
      empty.className = 'bookmark-menu__empty';
      empty.textContent = 'Create a list first.';
      menuEl.appendChild(empty);
      return;
    }

    bookmarkState.lists.forEach((list) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      const iconCfg = iconForList(list);
      btn.innerHTML = `<span class="bookmark-menu__icon" style="background:${iconCfg.color}"><i class="fa-solid ${iconCfg.icon}" aria-hidden="true"></i></span><span>${list.name || 'Untitled list'}</span>`;
      btn.addEventListener('click', () => {
        savePlaceToList(place, list.id);
        closeBookmarkMenu();
      });
      menuEl.appendChild(btn);
    });
  }

  function setStatus(s) {
    if (statusMsg) statusMsg.textContent = String(s || '');
  }

  async function geoSearch(q, limit = 6, signal) {
    const url = `/api/geo/search?q=${encodeURIComponent(q)}&limit=${encodeURIComponent(limit)}`;
    const r = await fetch(url, { signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) return [];
    return Array.isArray(j.results) ? j.results : [];
  }

  function primaryLabel(item) {
    const label = String(item?.name || item?.display_name || '').trim();
    if (!label) return 'Place';
    const comma = label.indexOf(',');
    return comma === -1 ? label : label.slice(0, comma);
  }

  function splitFullName(item) {
    const full = String(item?.display_name || item?.name || '').trim();
    if (!full) return { primary: 'Place', rest: '' };
    const comma = full.indexOf(',');
    if (comma === -1) return { primary: full, rest: '' };
    return {
      primary: full.slice(0, comma).trim(),
      rest: full.slice(comma + 1).trim(),
    };
  }

  function makePlace(item) {
    return {
      name: primaryLabel(item),
      fullName: String(item?.display_name || item?.name || primaryLabel(item)).trim(),
      lat: Number(item?.lat),
      lng: Number(item?.lng),
      osm_type: item?.osm_type || null,
      osm_id: item?.osm_id || null,
    };
  }

  function addRow(prefill = null) {
    const r = {
      id: uid(),
      query: prefill?.query || '',
      place: prefill?.place || null,
    };
    state.rows.push(r);
    if (!state.startId) state.startId = r.id;
    renderRows();
  }

  function resetAll() {
    state.rows = [];
    state.startId = null;
    state.computed = null;
    clearLayers();
    if (summaryLine) summaryLine.textContent = '';
    if (legsList) legsList.innerHTML = '';
    setStatus('');
    startRepoBtn.disabled = true;
    addRow();
    addRow();
  }

  function reorderRows(fromId, toId) {
    const a = state.rows.findIndex((x) => x.id === fromId);
    const b = state.rows.findIndex((x) => x.id === toId);
    if (a < 0 || b < 0 || a === b) return;
    const copy = state.rows.slice();
    const [moved] = copy.splice(a, 1);
    copy.splice(b, 0, moved);
    state.rows = copy;
    renderRows();
  }

  function renderRows() {
    if (!placesList) return;
    placesList.innerHTML = '';

    state.rows.forEach((row, idx) => {
      const wrap = document.createElement('div');
      wrap.className = 'explore-row';
      wrap.dataset.id = row.id;
      wrap.draggable = true;

      // drag handle
      const handle = document.createElement('div');
      handle.className = 'explore-handle';
      handle.title = 'Drag to reorder';
      handle.textContent = '⋮⋮';

      // start button
      const startBtn = document.createElement('button');
      startBtn.type = 'button';
      startBtn.className = 'explore-start' + (row.id === state.startId ? ' is-active' : '');
      startBtn.title = 'Start here';
      startBtn.setAttribute('aria-label', 'Start here');
      startBtn.innerHTML = row.id === state.startId ? startIconHtml : '';
      startBtn.addEventListener('click', () => {
        state.startId = row.id;
        renderRows();
      });

      // input + suggestions
      const inputWrap = document.createElement('div');
      inputWrap.className = 'explore-input-wrap';

      const input = document.createElement('input');
      input.className = 'explore-input';
      input.placeholder = (idx === 0) ? 'Start location' : 'Destination';
      input.value = row.place ? row.place.name : row.query;

      const sug = document.createElement('div');
      sug.className = 'explore-suggestions';
      sug.style.display = 'none';

      let timer = null;
      let controller = null;

      function hideSug() {
        sug.style.display = 'none';
        sug.innerHTML = '';
      }

      // Debounced geocoding: waits 220ms after the user stops typing,
      // then fires a search request (aborting any previous in-flight request).
      input.addEventListener('input', () => {
        row.query = input.value;
        row.place = null; // editing invalidates the previously picked place
        state.computed = null;
        startRepoBtn.disabled = true;

        if (timer) clearTimeout(timer);
        if (controller) controller.abort();

        const q = String(input.value || '').trim();
        if (q.length < 2) {
          hideSug();
          return;
        }

        timer = setTimeout(async () => {
          controller = new AbortController();
          const results = await geoSearch(q, 6, controller.signal).catch(() => []);
          if (!results.length) {
            hideSug();
            return;
          }

          sug.innerHTML = '';
          results.forEach((item) => {
            const btn = document.createElement('button');
            btn.type = 'button';

            const title = document.createElement('div');
            title.className = 'explore-sugg-title';
            const { primary, rest } = splitFullName(item);
            const strong = document.createElement('strong');
            strong.textContent = primary;
            title.appendChild(strong);
            if (rest) {
              const span = document.createElement('span');
              span.className = 'explore-sugg-rest';
              span.textContent = ', ' + rest;
              title.appendChild(span);
            }

            btn.appendChild(title);

            btn.addEventListener('click', () => {
              const p = makePlace(item);
              row.place = p;
              row.query = p.name;
              input.value = p.name;
              hideSug();
            });

            sug.appendChild(btn);
          });

          sug.style.display = 'block';
        }, 220);
      });

      input.addEventListener('blur', () => {
        // allow clicks on suggestions to register first
        setTimeout(() => hideSug(), 150);
      });

      inputWrap.appendChild(input);
      inputWrap.appendChild(sug);

      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'explore-save';
      saveBtn.title = 'Save to list';
      saveBtn.innerHTML = '<i class="fa-solid fa-bookmark" aria-hidden="true"></i>';
      const saveWrap = document.createElement('div');
      saveWrap.className = 'explore-save-wrap';
      const saveMenu = document.createElement('div');
      saveMenu.className = 'bookmark-menu';
      saveBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (openBookmarkMenuEl && openBookmarkMenuEl !== saveMenu) {
          closeBookmarkMenu();
        }
        const isOpen = saveMenu.classList.contains('is-open');
        if (isOpen) {
          closeBookmarkMenu();
          return;
        }
        buildBookmarkMenu(saveMenu, row.place);
        saveMenu.classList.add('is-open');
        openBookmarkMenuEl = saveMenu;
      });
      saveMenu.addEventListener('click', (e) => e.stopPropagation());

      // remove-row button
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'explore-remove';
      rm.title = 'Remove';
      rm.textContent = '✕';
      rm.addEventListener('click', () => {
        state.rows = state.rows.filter((x) => x.id !== row.id);
        if (!state.rows.length) addRow();
        if (state.startId === row.id) state.startId = state.rows[0]?.id || null;
        state.computed = null;
        startRepoBtn.disabled = true;
        renderRows();
      });

      // HTML5 drag-and-drop for reordering rows in the destination list
      wrap.addEventListener('dragstart', (ev) => {
        state.draggingId = row.id;
        try {
          ev.dataTransfer.effectAllowed = 'move';
          ev.dataTransfer.setData('text/plain', row.id);
        } catch {}
      });

      wrap.addEventListener('dragover', (ev) => {
        ev.preventDefault();
        if (!state.draggingId || state.draggingId === row.id) return;
        wrap.classList.add('drag-over');
      });

      wrap.addEventListener('dragleave', () => {
        wrap.classList.remove('drag-over');
      });

      wrap.addEventListener('drop', (ev) => {
        ev.preventDefault();
        wrap.classList.remove('drag-over');
        const fromId = state.draggingId;
        const toId = row.id;
        state.draggingId = null;
        if (fromId && toId && fromId !== toId) reorderRows(fromId, toId);
      });

      wrap.appendChild(handle);
      wrap.appendChild(startBtn);
      wrap.appendChild(inputWrap);
      saveWrap.appendChild(saveBtn);
      saveWrap.appendChild(saveMenu);
      wrap.appendChild(saveWrap);
      wrap.appendChild(rm);

      placesList.appendChild(wrap);
    });
  }

  /**
   * Auto-geocode any row that has text typed but no place selected yet.
   * Picks the top search result automatically so the user doesn't have to
   * click a suggestion for every row before computing a route.
   */
  async function ensureGeocodedRows() {
    const rows = state.rows;

    for (const row of rows) {
      if (row.place && Number.isFinite(row.place.lat) && Number.isFinite(row.place.lng)) continue;

      const q = String(row.query || '').trim();
      if (!q) continue;

      const results = await geoSearch(q, 1).catch(() => []);
      if (results[0]) {
        row.place = makePlace(results[0]);
      }
    }
  }

  /**
   * Render the optimised route on the Leaflet map: numbered stop markers,
   * polyline segments (styled per transport mode), transit station dots,
   * and travel-time labels at each segment midpoint.
   */
  function drawResult(result) {
    clearLayers();

    const stops = Array.isArray(result.stops) ? result.stops : [];
    if (!stops.length) return;

    // numbered stop markers
    const bounds = [];
    stops.forEach((s, i) => {
      const lat = Number(s.lat);
      const lng = Number(s.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

      const m = L.marker([lat, lng], {
        icon: numIcon(i + 1),
        title: `${i + 1}. ${s.name || 'Stop'}`,
      })
        .addTo(map)
        .bindPopup(`${i + 1}. ${s.fullName || s.name || 'Stop'}`);

      stopMarkers.push(m);
      bounds.push([lat, lng]);
    });

    // route segments
    const segByLeg = Array.isArray(result.segmentsByLeg) ? result.segmentsByLeg : [];
    segByLeg.forEach((legSegs) => {
      const list = Array.isArray(legSegs) ? legSegs : [];
      list.forEach((seg) => {
        const pts = Array.isArray(seg?.points) ? seg.points : [];
        if (!pts.length) return;

        const latlngs = pts.map((p) => [p.lat, p.lng]);
        const poly = L.polyline(latlngs, routeStyle(seg.subMode)).addTo(map);
        routeLines.push(poly);

        latlngs.forEach((ll) => bounds.push(ll));
      });
    });

    // transit station dots
    const mode = String(result.mode || '').toLowerCase();
    if (mode === 'transit' && Array.isArray(result.transitStops)) {
      result.transitStops.forEach((s) => {
        const lat = Number(s.lat);
        const lng = Number(s.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

        const mk = L.circleMarker([lat, lng], {
          radius: 6,
          weight: 2,
          color: colorFor('transit'),
          fillColor: colorFor('transit'),
          fillOpacity: 0.85,
        })
          .addTo(map)
          .bindPopup(`${modeIconHtml('transit')} ${s.name || 'Station'}`);

        stationMarkers.push(mk);
        bounds.push([lat, lng]);
      });
    }

    // travel time labels (per leg)
    const minutes = Array.isArray(result.minutes) ? result.minutes : [];
    const geoms = Array.isArray(result.geometries) ? result.geometries : [];
    for (let i = 0; i < minutes.length; i++) {
      const m = Number(minutes[i]);
      if (!Number.isFinite(m)) continue;

      const mid = midPointFromCoords(geoms[i]);
      if (!mid || !Number.isFinite(mid.lat) || !Number.isFinite(mid.lng)) continue;

      const html = `${Math.round(m)} min ${modeIconHtml(result.mode)}`;
      const mk = labelMarker(mid.lat, mid.lng, html).addTo(map);
      routeLabels.push(mk);
    }

    if (bounds.length) {
      map.fitBounds(bounds, { padding: [20, 20] });
    }
  }

  function renderSummary(result) {
    const stops = Array.isArray(result.stops) ? result.stops : [];
    const minutes = Array.isArray(result.minutes) ? result.minutes : [];
    const total = Number(result.totalMinutes || 0);

    if (summaryLine) {
      const extras = [];
      if (result.matrixProvider) extras.push(`matrix: ${result.matrixProvider}`);
      if (result.routeProvider) extras.push(`route: ${result.routeProvider}`);
      summaryLine.textContent =
        stops.length >= 2
          ? `Total travel: ~${Math.round(total)} min • ${extras.join(' • ')}`
          : '';
    }

    if (legsList) {
      legsList.innerHTML = '';
      for (let i = 0; i < minutes.length; i++) {
        const from = stops[i]?.name || `Stop ${i + 1}`;
        const to = stops[i + 1]?.name || `Stop ${i + 2}`;
        const li = document.createElement('li');
        li.textContent = `${from} → ${to}: ~${Math.round(minutes[i])} min`;
        legsList.appendChild(li);
      }
    }
  }

  /**
   * Main "Compute route" flow:
   *  1. Auto-geocode any rows missing coordinates.
   *  2. POST to /api/quick/optimize with the stop list and transport mode.
   *  3. Reorder UI rows to match the server's optimised visit order.
   *  4. Draw the route on the map and display the summary.
   */
  async function computeShortest() {
    setStatus('Preparing…');
    computeBtn.disabled = true;
    startRepoBtn.disabled = true;
    state.computed = null;

    try {
      await ensureGeocodedRows();

      const activeRows = state.rows.filter(
        (r) => r.place && Number.isFinite(r.place.lat) && Number.isFinite(r.place.lng)
      );

      if (activeRows.length < 2) {
        setStatus('Add at least 2 destinations (and pick a suggestion for each).');
        clearLayers();
        return;
      }

      // startIndex is based on the start pin, within the activeRows list
      let startIndex = 0;
      const startRowIdx = activeRows.findIndex((r) => r.id === state.startId);
      if (startRowIdx >= 0) startIndex = startRowIdx;

      const mode = modeSelect ? modeSelect.value : 'walking';
      const todayIso = new Date().toISOString().slice(0, 10);

      setStatus('Optimizing route…');

      const resp = await fetch('/api/quick/optimize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode,
          startIndex,
          dateIso: todayIso,
          startTimeMin: 9 * 60,
          stops: activeRows.map((r) => ({
            name: r.place.name,
            fullName: r.place.fullName,
            lat: r.place.lat,
            lng: r.place.lng,
          })),
        }),
      });

      const json = await resp.json().catch(() => ({}));
      if (!resp.ok || !json.ok) {
        setStatus(`Failed to optimize: ${json.error || resp.statusText}`);
        return;
      }

      if (Array.isArray(json.warnings) && json.warnings.length) {
        setStatus(json.warnings.join(' '));
      } else {
        setStatus('');
      }

      // Reorder the destination list to match the server's optimised order
      const order = Array.isArray(json.order) ? json.order : [];
      if (order.length === activeRows.length) {
        const orderedRows = order.map((i) => activeRows[i]).filter(Boolean);
        // keep any empty/unpicked rows after
        const rest = state.rows.filter((r) => !activeRows.includes(r));
        state.rows = [...orderedRows, ...rest];
        state.startId = orderedRows[0]?.id || state.startId;
        renderRows();
      }

      state.computed = json;
      renderSummary(json);
      drawResult(json);
      startRepoBtn.disabled = false;
    } finally {
      computeBtn.disabled = false;
    }
  }

  /** Create a new GiTrip repo from the computed route and redirect to the repo page. */
  async function startRepoFromTrip() {
    if (!state.computed || !state.computed.ok) return;

    startRepoBtn.disabled = true;
    setStatus('Creating repo…');

    try {
      const title = String(tripTitle?.value || '').trim() || 'Untitled Trip';

      const resp = await fetch('/api/quick/start-repo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          mode: state.computed.mode,
          dateIso: state.computed.dateIso || new Date().toISOString().slice(0, 10),
          startTimeMin: state.computed.startTimeMin || 9 * 60,
          stops: state.computed.stops,
          minutes: state.computed.minutes,
        }),
      });

      const json = await resp.json().catch(() => ({}));
      if (!resp.ok || !json.ok) {
        setStatus(`Repo creation failed: ${json.error || resp.statusText}`);
        startRepoBtn.disabled = false;
        return;
      }

      window.location.href = json.redirect;
    } catch (e) {
      console.error(e);
      setStatus('Repo creation failed. Check server logs.');
      startRepoBtn.disabled = false;
    }
  }

  // --- Wire buttons ---
  addPlaceBtn?.addEventListener('click', () => addRow());
  clearBtn?.addEventListener('click', () => resetAll());
  computeBtn?.addEventListener('click', () => computeShortest());
  startRepoBtn?.addEventListener('click', () => startRepoFromTrip());

  bookmarkCreateBtn?.addEventListener('click', () => {
    const name = String(bookmarkListName?.value || '').trim();
    if (!name) {
      setStatus('Enter a list name.');
      return;
    }
    const icon = iconKeyOrDefault(bookmarkIconPicker?.dataset.value || 'star');
    bookmarkState.lists.push({
      id: uid(),
      name,
      icon,
      show: true,
      items: [],
    });
    bookmarkState.activeListId = bookmarkState.lists[bookmarkState.lists.length - 1].id;
    if (bookmarkListName) bookmarkListName.value = '';
    saveBookmarks();
    renderBookmarkLists();
    refreshBookmarkMarkers();
  });

  // --- Bookmark icon picker setup + initial render ---
  let createIconKey = 'star';
  function setCreateIcon(key) {
    createIconKey = iconKeyOrDefault(key);
    if (bookmarkIconPicker) bookmarkIconPicker.dataset.value = createIconKey;
    applyIconButton(bookmarkIconButton, createIconKey);
    renderIconMenu(bookmarkIconMenu, createIconKey, (next) => {
      setCreateIcon(next);
      bookmarkIconPicker?.removeAttribute('open');
    });
  }

  setCreateIcon(createIconKey);
  loadBookmarks();
  renderBookmarkLists();
  refreshBookmarkMarkers();
  resetAll();
  ensureActiveList();

  if (bookmarkSidebarToggle && exploreSidebar) {
    bookmarkSidebarToggle.addEventListener('click', () => {
      const collapsed = exploreSidebar.getAttribute('data-collapsed') === 'true';
      exploreSidebar.setAttribute('data-collapsed', collapsed ? 'false' : 'true');
      bookmarkSidebarToggle.setAttribute(
        'aria-label',
        collapsed ? 'Collapse bookmarks' : 'Expand bookmarks'
      );
    });
  }

  document.addEventListener('click', () => closeBookmarkMenu());
})();
