/**
 * server/geosearch.js — Geocoding via Nominatim with rate-limiting.
 *
 * Searches OpenStreetMap's Nominatim API for place names, enforcing a minimum
 * 1-second gap between calls (Nominatim usage policy).  If the API is
 * unreachable or returns no results, falls back to a small canned set of
 * London landmarks so the UI never completely breaks.
 *
 * Exported: searchGeo
 */
import 'dotenv/config';

const NOMINATIM_EMAIL = process.env.NOMINATIM_EMAIL || '';

let lastCallMs = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A tiny fallback set so the UI never totally breaks.
// These are only used when we can't (or mustn't) call Nominatim.
const cannedBase = [
  {
    name: 'British Museum, London',
    lat: 51.519413,
    lng: -0.126957,
    opening_hours: 'Mo-Su 10:00-17:00',
  },
  {
    name: 'Covent Garden, London',
    lat: 51.51174,
    lng: -0.12268,
    opening_hours: null,
  },
  {
    name: 'Tower Bridge, London',
    lat: 51.5055,
    lng: -0.0754,
    opening_hours: null,
  },
];

function cannedResults(query, limit = 6) {
  const q = String(query || '').toLowerCase();
  const filtered = cannedBase.filter((c) => c.name.toLowerCase().includes(q));
  return (filtered.length ? filtered : cannedBase).slice(0, limit);
}

/**
 * Search Nominatim for a place.
 * Returns an array of { name, lat, lng, opening_hours }.
 */
export async function nominatimSearch(query, limit = 6) {
  const q = String(query || '').trim();
  if (!q) return [];

  // If you didn't set NOMINATIM_EMAIL, we *never* hit Nominatim.
  if (!NOMINATIM_EMAIL) {
    console.warn('nominatimSearch: NOMINATIM_EMAIL not set, returning canned demo data.');
    return cannedResults(q, limit);
  }

  // Respect their 1 req/sec guideline
  const now = Date.now();
  const delta = now - lastCallMs;
  if (delta < 1100) {
    await sleep(1100 - delta);
  }
  lastCallMs = Date.now();

  const url =
    'https://nominatim.openstreetmap.org/search?' +
    `format=jsonv2&addressdetails=0&extratags=1&limit=${limit}` +
    `&q=${encodeURIComponent(q)}`;

  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': `GiTrip/0.1 (${NOMINATIM_EMAIL})`,
        Accept: 'application/json',
      },
    });

    if (!resp.ok) {
      console.warn('nominatimSearch non-OK status:', resp.status);
      // If they’re annoyed (403/429/5xx), fall back to canned, but *don’t* crash.
      return cannedResults(q, limit);
    }

    const data = await resp.json();
    const rows = Array.isArray(data) ? data : [];

    if (!rows.length) {
      return [];
    }

    return rows.map((d) => ({
      name: d.display_name,
      lat: Number(d.lat),
      lng: Number(d.lon),
      opening_hours:
        d.extratags && d.extratags.opening_hours
          ? d.extratags.opening_hours
          : null,
    }));
  } catch (e) {
    console.error('nominatimSearch error:', e);
    // Network / provider issues → safe fallback
    return cannedResults(q, limit);
  }
}

/**
 * Optional: lookup extra info by OSM type/id.
 */
export async function nominatimLookup(osm_type, osm_id) {
  if (!NOMINATIM_EMAIL) return null;

  const typeLetter = String(osm_type || '')
    .charAt(0)
    .toUpperCase(); // N, W, R…
  const id = String(osm_id || '').trim();
  if (!typeLetter || !id) return null;

  const url =
    'https://nominatim.openstreetmap.org/lookup?' +
    `format=jsonv2&osm_ids=${encodeURIComponent(typeLetter + id)}`;

  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': `GiTrip/0.1 (${NOMINATIM_EMAIL})`,
        Accept: 'application/json',
      },
    });

    if (!resp.ok) {
      console.warn('nominatimLookup non-OK status:', resp.status);
      return null;
    }

    const data = await resp.json();
    return (Array.isArray(data) && data[0]) || null;
  } catch (e) {
    console.error('nominatimLookup error:', e);
    return null;
  }
}
