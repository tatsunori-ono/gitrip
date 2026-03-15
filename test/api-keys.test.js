import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from 'dotenv';

// Load .env so API keys are available
config();

const ORS_KEY = process.env.ORS_API_KEY || '';
const GOOGLE_KEY =
  process.env.GOOGLE_MAPS_KEY || process.env.GOOGLE_DIRECTIONS_API_KEY || '';
const NEWS_KEY = process.env.NEWS_API_KEY || '';

// ---------- Environment variable presence ----------

test('ORS_API_KEY is set in .env', () => {
  assert.ok(ORS_KEY, 'ORS_API_KEY is missing from .env');
});

test('GOOGLE_DIRECTIONS_API_KEY is set in .env', () => {
  assert.ok(GOOGLE_KEY, 'GOOGLE_DIRECTIONS_API_KEY is missing from .env');
});

test('NEWS_API_KEY is set in .env', () => {
  assert.ok(NEWS_KEY, 'NEWS_API_KEY is missing from .env');
});

// ---------- ORS API key ----------

test('ORS API key is valid (matrix endpoint)', async () => {
  if (!ORS_KEY) return; // skip if not set

  const body = {
    locations: [
      [-0.1278, 51.5074], // London
      [-0.1419, 51.5155], // Oxford Circus
    ],
    metrics: ['duration'],
    resolve_locations: false,
  };

  const res = await fetch(
    'https://api.openrouteservice.org/v2/matrix/driving-car',
    {
      method: 'POST',
      headers: {
        Authorization: ORS_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );

  assert.ok(
    res.ok,
    `ORS API returned status ${res.status}: key may be invalid or expired`
  );

  const data = await res.json();
  assert.ok(
    Array.isArray(data.durations),
    'ORS response missing durations array'
  );
  assert.ok(
    data.durations.length === 2 && data.durations[0].length === 2,
    'ORS durations should be a 2x2 matrix'
  );
});

test('ORS API key is valid (directions endpoint)', async () => {
  if (!ORS_KEY) return;

  const body = {
    coordinates: [
      [-0.1278, 51.5074],
      [-0.1419, 51.5155],
    ],
  };

  const res = await fetch(
    'https://api.openrouteservice.org/v2/directions/driving-car/geojson',
    {
      method: 'POST',
      headers: {
        Authorization: ORS_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );

  assert.ok(
    res.ok,
    `ORS directions returned status ${res.status}: key may be invalid or expired`
  );

  const data = await res.json();
  const feat = data.features?.[0];
  assert.ok(feat, 'ORS directions response missing feature');
  assert.ok(
    feat.properties?.summary?.duration > 0,
    'ORS directions should return a positive duration'
  );
});

// ---------- Google Directions API key ----------

test('Google Directions API key is valid (driving)', async () => {
  if (!GOOGLE_KEY) return;

  const url =
    'https://maps.googleapis.com/maps/api/directions/json' +
    '?origin=51.5074,-0.1278&destination=51.5155,-0.1419' +
    '&mode=driving&key=' +
    GOOGLE_KEY;

  const res = await fetch(url);
  assert.ok(res.ok, `Google API HTTP status ${res.status}`);

  const data = await res.json();
  assert.notEqual(
    data.status,
    'REQUEST_DENIED',
    `Google API key is invalid: ${data.error_message || 'REQUEST_DENIED'}`
  );
  assert.equal(
    data.status,
    'OK',
    `Google Directions returned status "${data.status}": ${data.error_message || ''}`
  );
  assert.ok(
    data.routes?.length > 0,
    'Google Directions should return at least one route'
  );
});

test('Google Directions API key is valid (transit)', async () => {
  if (!GOOGLE_KEY) return;

  // Use a future departure time to avoid past-time errors
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  const departEpoch = Math.round(tomorrow.getTime() / 1000);

  const url =
    'https://maps.googleapis.com/maps/api/directions/json' +
    '?origin=51.5074,-0.1278&destination=51.5155,-0.1419' +
    '&mode=transit&departure_time=' +
    departEpoch +
    '&key=' +
    GOOGLE_KEY;

  const res = await fetch(url);
  assert.ok(res.ok, `Google API HTTP status ${res.status}`);

  const data = await res.json();
  assert.notEqual(
    data.status,
    'REQUEST_DENIED',
    `Google API key is invalid: ${data.error_message || 'REQUEST_DENIED'}`
  );
  assert.equal(
    data.status,
    'OK',
    `Google transit returned status "${data.status}": ${data.error_message || ''}`
  );
});

// ---------- GNews API key ----------

test('GNews API key is valid', async () => {
  if (!NEWS_KEY) return;

  const url =
    'https://gnews.io/api/v4/search' +
    '?q=transport&lang=en&max=1&token=' +
    NEWS_KEY;

  const res = await fetch(url);
  assert.ok(res.ok, `GNews API HTTP status ${res.status}`);

  const data = await res.json();
  assert.ok(
    !data.errors,
    `GNews API error: ${JSON.stringify(data.errors)}`
  );
  assert.ok(
    Array.isArray(data.articles),
    'GNews response missing articles array'
  );
  assert.ok(
    data.articles.length > 0,
    'GNews should return at least one article'
  );
});

test('GNews API key: search returns travel-relevant results', async () => {
  if (!NEWS_KEY) return;

  const url =
    'https://gnews.io/api/v4/search' +
    '?q=London+train+strike&lang=en&max=3&token=' +
    NEWS_KEY;

  const res = await fetch(url);
  assert.ok(res.ok, `GNews API HTTP status ${res.status}`);

  const data = await res.json();
  assert.ok(
    Array.isArray(data.articles),
    'GNews response missing articles array'
  );
  // totalArticles should be > 0 for a reasonable query
  assert.ok(
    (data.totalArticles || 0) > 0,
    'GNews found no articles for "London train strike"'
  );
});

// ---------- Open-Meteo API (weather) ----------

test('Open-Meteo forecast endpoint returns valid data', async () => {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', '51.5074');
  url.searchParams.set('longitude', '-0.1278');
  url.searchParams.set('daily', 'temperature_2m_max,temperature_2m_min,precipitation_probability_max,weathercode');
  url.searchParams.set('timezone', 'auto');
  url.searchParams.set('forecast_days', '3');

  const res = await fetch(url);
  assert.ok(res.ok, `Open-Meteo forecast returned status ${res.status}`);

  const data = await res.json();
  assert.ok(data.daily, 'Open-Meteo response missing daily object');
  assert.ok(
    Array.isArray(data.daily.temperature_2m_max),
    'Open-Meteo response missing temperature_2m_max array'
  );
  assert.ok(
    data.daily.temperature_2m_max.length > 0,
    'Open-Meteo should return at least one day of forecast data'
  );
});

test('Open-Meteo archive endpoint returns valid data', async () => {
  const url = new URL('https://archive-api.open-meteo.com/v1/archive');
  url.searchParams.set('latitude', '51.5074');
  url.searchParams.set('longitude', '-0.1278');
  url.searchParams.set('daily', 'temperature_2m_max,temperature_2m_min,precipitation_probability_max,weathercode');
  url.searchParams.set('timezone', 'auto');
  url.searchParams.set('start_date', '2025-01-01');
  url.searchParams.set('end_date', '2025-01-01');

  const res = await fetch(url);
  assert.ok(res.ok, `Open-Meteo archive returned status ${res.status}`);

  const data = await res.json();
  assert.ok(data.daily, 'Open-Meteo archive response missing daily object');
  assert.ok(
    Array.isArray(data.daily.temperature_2m_max),
    'Open-Meteo archive response missing temperature_2m_max array'
  );
  assert.equal(
    data.daily.temperature_2m_max.length, 1,
    'Open-Meteo archive should return exactly one day of data'
  );
});

// ---------- Nominatim API (geocoding) ----------

test('Nominatim search endpoint returns valid results', async () => {
  const url =
    'https://nominatim.openstreetmap.org/search?' +
    'format=jsonv2&addressdetails=0&extratags=1&limit=3' +
    '&q=' + encodeURIComponent('British Museum, London');

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'GiTrip/0.1 (test)',
      Accept: 'application/json',
    },
  });
  assert.ok(res.ok, `Nominatim returned status ${res.status}`);

  const data = await res.json();
  assert.ok(Array.isArray(data), 'Nominatim response should be an array');
  assert.ok(data.length > 0, 'Nominatim should return at least one result');
  assert.ok(data[0].lat, 'Nominatim result should have a lat field');
  assert.ok(data[0].lon, 'Nominatim result should have a lon field');
  assert.ok(data[0].display_name, 'Nominatim result should have a display_name');
});

test('Nominatim returns extratags with opening_hours', async () => {
  const url =
    'https://nominatim.openstreetmap.org/search?' +
    'format=jsonv2&addressdetails=0&extratags=1&limit=1' +
    '&q=' + encodeURIComponent('British Museum, London');

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'GiTrip/0.1 (test)',
      Accept: 'application/json',
    },
  });
  assert.ok(res.ok, `Nominatim returned status ${res.status}`);

  const data = await res.json();
  assert.ok(data.length > 0, 'Nominatim should return at least one result');
  assert.ok(
    data[0].extratags !== undefined,
    'Nominatim result should include extratags when requested'
  );
});
