import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineMinutes, constantGap } from '../server/routing.js';

// --- haversineMinutes ---

test('haversineMinutes: same point returns 0', () => {
  const p = { lat: 51.5074, lng: -0.1278 };
  assert.equal(haversineMinutes(p, p, 'driving'), 0);
});

test('haversineMinutes: London to Paris (driving)', () => {
  const london = { lat: 51.5074, lng: -0.1278 };
  const paris = { lat: 48.8566, lng: 2.3522 };
  const mins = haversineMinutes(london, paris, 'driving');
  // ~340 km * 2.5 min/km ≈ 850 min
  assert(mins > 700 && mins < 1000, `expected ~850 but got ${mins}`);
});

test('haversineMinutes: walking is slower than driving', () => {
  const a = { lat: 51.5074, lng: -0.1278 };
  const b = { lat: 51.51, lng: -0.12 };
  const walk = haversineMinutes(a, b, 'walking');
  const drive = haversineMinutes(a, b, 'driving');
  assert(walk > drive, 'walking should take longer than driving');
});

test('haversineMinutes: cycling is between walking and driving', () => {
  const a = { lat: 51.5074, lng: -0.1278 };
  const b = { lat: 51.52, lng: -0.10 };
  const walk = haversineMinutes(a, b, 'walking');
  const cycle = haversineMinutes(a, b, 'cycling');
  const drive = haversineMinutes(a, b, 'driving');
  assert(walk > cycle, 'walking should be slower than cycling');
  assert(cycle > drive, 'cycling should be slower than driving');
});

test('haversineMinutes: handles null/zero coordinates gracefully', () => {
  const a = { lat: 0, lng: 0 };
  const b = { lat: 0, lng: 0 };
  assert.equal(haversineMinutes(a, b), 0);
});

test('haversineMinutes: handles missing lat/lng with defaults', () => {
  const a = {};
  const b = {};
  assert.equal(haversineMinutes(a, b), 0);
});

// --- constantGap ---

test('constantGap: walking returns 12', () => {
  assert.equal(constantGap('walking'), 12);
});

test('constantGap: cycling returns 8', () => {
  assert.equal(constantGap('cycling'), 8);
});

test('constantGap: driving returns 6', () => {
  assert.equal(constantGap('driving'), 6);
});

test('constantGap: transit defaults to driving gap', () => {
  assert.equal(constantGap('transit'), 6);
});

test('constantGap: unknown mode defaults to driving gap', () => {
  assert.equal(constantGap('ferry'), 6);
});
