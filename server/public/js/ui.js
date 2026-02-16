/**
 * public/js/ui.js — Shared UI helpers for the repo editor pages.
 *
 * Provides geocoding search (via the server proxy), collapsible advanced
 * panels, per-stop commit wiring, popover place picker, and row cloning
 * for adding new stops.  All functions are attached to `window` so that
 * inline <script> blocks in EJS templates can call them.
 */

/** Fetch geocoding results from the server proxy (/api/geo/search). */
async function searchPlaces(q) {
  const r = await fetch(`/api/geo/search?q=${encodeURIComponent(q)}`);
  if (!r.ok) throw new Error('Search failed');
  const payload = await r.json().catch(() => null);
  if (!payload || !payload.ok) {
    throw new Error(payload?.error || 'Search not ok');
  }
  return payload.results || [];
}

/** Wire a collapsible "Show advanced / Hide advanced" toggle panel. */
function wireAdvanced(panelId, btnId, open = false) {
  const p = document.getElementById(panelId);
  const b = document.getElementById(btnId);
  if (!p || !b) return;

  const set = (v) => {
    p.classList.toggle('show', v);
    b.setAttribute('aria-expanded', v ? 'true' : 'false');
    const txt = b.querySelector('.text');
    if (txt) txt.textContent = v ? 'Hide advanced' : 'Show advanced';
  };

  set(!!open);
  b.addEventListener('click', (e) => {
    e.preventDefault();
    set(!p.classList.contains('show'));
  });
}

/**
 * Wire per-stop commit buttons: clicking a row's commit button disables all
 * other rows' [enabled] checkboxes, enables only that row, and submits the
 * form — so the server receives a single-stop commit.
 */
function wirePerStopCommit(formId, rowSel, btnSel) {
  const form = document.getElementById(formId);
  if (!form) return;

  const rewire = () => {
    form.querySelectorAll(rowSel).forEach((row) => {
      const btn = row.querySelector(btnSel);
      if (!btn) return;

      btn.onclick = (e) => {
        e.preventDefault();
        // disable all
        form.querySelectorAll('input[name$="[enabled]"]').forEach((ch) => {
          ch.checked = false;
        });
        // enable this
        const flag = row.querySelector('input[name$="[enabled]"]');
        if (flag) flag.checked = true;
        form.requestSubmit();
      };
    });
  };

  rewire();
  return { rewire };
}

/**
 * Attach a geocoding popover to a stop row's search button.
 * On click, queries the server proxy for the name typed into the row,
 * displays results in an absolutely-positioned popup, and fills the row's
 * hidden lat/lng/openingHours fields when the user picks a result.
 */
function attachSearch(button, row) {
  if (!button || !row) return;

  button.addEventListener('click', async () => {
    const nameInput = row.querySelector('input[name$="[name]"]');
    const name = (nameInput?.value || '').trim();
    if (!name) {
      alert('Type a name first.');
      return;
    }

    let data = [];
    try {
      data = await searchPlaces(name);
    } catch (e) {
      console.error('searchPlaces error', e);
      alert('Search error. Try again, or type coordinates manually.');
      return;
    }

    if (!data.length) {
      alert('No results.');
      return;
    }

    const pop = document.createElement('div');
    pop.className = 'result-pop';
    const rect = button.getBoundingClientRect();
    pop.style.left = rect.left + window.scrollX + 'px';
    pop.style.top = rect.bottom + window.scrollY + 8 + 'px';

    data.slice(0, 10).forEach((d) => {
      const el = document.createElement('div');
      el.className = 'item';

      const lat = Number(d.lat);
      const lng = Number(d.lng);
      const hours = d.opening_hours || '—';

      const nameEl = document.createElement('strong');
      nameEl.textContent = d.name;
      el.appendChild(nameEl);
      el.appendChild(document.createElement('br'));
      const detailEl = document.createElement('span');
      detailEl.style.cssText = 'color:#667085;font-size:12px';
      let detail = `lat ${Number.isFinite(lat) ? lat.toFixed(5) : '—'}, lng ${Number.isFinite(lng) ? lng.toFixed(5) : '—'}`;
      if (hours && hours !== '—') detail += ` \u00B7 hours: ${hours}`;
      detailEl.textContent = detail;
      el.appendChild(detailEl);

      el.onclick = () => {
        // ensure hidden fields exist
        const ns = row.dataset.ns || '';
        let latInput = row.querySelector('input[name$="[lat]"]');
        let lngInput = row.querySelector('input[name$="[lng]"]');
        let ohInput = row.querySelector('input[name$="[openingHours]"]');

        if (!latInput) {
          latInput = document.createElement('input');
          latInput.type = 'hidden';
          latInput.name = ns + '[lat]';
          row.appendChild(latInput);
        }
        if (!lngInput) {
          lngInput = document.createElement('input');
          lngInput.type = 'hidden';
          lngInput.name = ns + '[lng]';
          row.appendChild(lngInput);
        }
        if (!ohInput) {
          ohInput = document.createElement('input');
          ohInput.type = 'hidden';
          ohInput.name = ns + '[openingHours]';
          row.appendChild(ohInput);
        }

        if (Number.isFinite(lat)) latInput.value = lat;
        if (Number.isFinite(lng)) lngInput.value = lng;
        ohInput.value = hours === '—' ? '' : hours;

        pop.remove();
      };

      pop.appendChild(el);
    });

    document.body.appendChild(pop);

    const remove = () => {
      pop.remove();
      window.removeEventListener('click', off, true);
    };
    const off = (e) => {
      if (!pop.contains(e.target) && e.target !== button) remove();
    };
    window.addEventListener('click', off, true);
  });
}

/**
 * Add a new empty stop row by cloning the first row in the list and
 * re-indexing all input names (places[0][name] → places[N][name]).
 */
function addRow(listId) {
  const list = document.getElementById(listId);
  if (!list) return null;
  const first = list.querySelector('[data-stop-row]');
  if (!first) return null;

  const idx = list.querySelectorAll('[data-stop-row]').length;
  const row = first.cloneNode(true);
  row.dataset.index = idx;
  row.dataset.ns = `places[${idx}]`;

  row.querySelectorAll('input, select, textarea').forEach((inp) => {
    const nm = inp.getAttribute('name');
    if (nm) {
      inp.setAttribute('name', nm.replace(/\[\d+\]/, `[${idx}]`));
    }

    if (inp.type === 'checkbox') {
      inp.checked = inp.name.endsWith('[enabled]');
    } else {
      inp.value = '';
    }
  });

  // collapse its per-stop advanced, if any
  const adv = row.querySelector('[data-adv-stop]');
  if (adv) adv.classList.remove('show');

  list.appendChild(row);

  const btn = row.querySelector('[data-search]');
  if (btn) attachSearch(btn, row);

  return row;
}

/** Pre-fill three London demo places (British Museum, Covent Garden, Tower Bridge). */
function applyDemo(formId) {
  const form = document.getElementById(formId);
  if (!form) return;

  const rows = [...form.querySelectorAll('[data-stop-row]')];
  const seeds = [
    { name: 'British Museum', lat: 51.519413, lng: -0.126957 },
    { name: 'Covent Garden', lat: 51.51174, lng: -0.12268 },
    { name: 'Tower Bridge', lat: 51.5055, lng: -0.0754 }
  ];

  rows.forEach((row, i) => {
    const s = seeds[i];
    if (!s) return;
    const nameInput = row.querySelector('input[name$="[name]"]');
    if (nameInput) nameInput.value = s.name;

    const ns = row.dataset.ns || '';
    let lat = row.querySelector('input[name$="[lat]"]');
    let lng = row.querySelector('input[name$="[lng]"]');

    if (!lat) {
      lat = document.createElement('input');
      lat.type = 'hidden';
      lat.name = ns + '[lat]';
      row.appendChild(lat);
    }
    if (!lng) {
      lng = document.createElement('input');
      lng.type = 'hidden';
      lng.name = ns + '[lng]';
      row.appendChild(lng);
    }

    lat.value = s.lat;
    lng.value = s.lng;
  });
}

// Expose to window so that inline <script> blocks in EJS templates can call them
window.wireAdvanced = wireAdvanced;
window.wirePerStopCommit = wirePerStopCommit;
window.attachSearch = attachSearch;
window.addRow = addRow;
window.applyDemo = applyDemo;
