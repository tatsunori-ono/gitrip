import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toMin, toHHMM, applyOpeningHours } from '../server/planner.js';

// --- toMin ---

test('toMin: converts HH:MM to minutes', () => {
  assert.equal(toMin('09:00'), 540);
  assert.equal(toMin('00:00'), 0);
  assert.equal(toMin('23:59'), 1439);
  assert.equal(toMin('12:30'), 750);
});

test('toMin: null/empty returns 0', () => {
  assert.equal(toMin(null), 0);
  assert.equal(toMin(''), 0);
  assert.equal(toMin(undefined), 0);
});

// --- toHHMM ---

test('toHHMM: converts minutes to HH:MM', () => {
  assert.equal(toHHMM(540), '09:00');
  assert.equal(toHHMM(0), '00:00');
  assert.equal(toHHMM(1439), '23:59');
  assert.equal(toHHMM(61), '01:01');
});

test('toHHMM: clamps negative to 00:00', () => {
  assert.equal(toHHMM(-10), '00:00');
});

test('toHHMM: rounds fractional minutes', () => {
  assert.equal(toHHMM(60.7), '01:01');
});

// --- applyOpeningHours ---

const monday = new Date('2025-06-02'); // a Monday

test('no constraints: starts at arriveMin', () => {
  const place = { stayMin: 60 };
  const result = applyOpeningHours(place, 600, 480, 1260, monday);
  assert.equal(result.fits, true);
  assert.equal(result.a, 600);
  assert.equal(result.b, 660);
});

test('arriveMin before activeStart: clamped to activeStart', () => {
  const place = { stayMin: 60 };
  const result = applyOpeningHours(place, 400, 480, 1260, monday);
  assert.equal(result.fits, true);
  assert.equal(result.a, 480);
});

test('desiredStart pushes start later', () => {
  const place = { stayMin: 60, desiredStart: '14:00' };
  const result = applyOpeningHours(place, 480, 480, 1260, monday);
  assert.equal(result.fits, true);
  assert.equal(result.a, 840); // 14:00
});

test('opening hours nudge to open slot', () => {
  const place = { stayMin: 60, openingHours: 'Mo 12:00-18:00' };
  const result = applyOpeningHours(place, 540, 480, 1260, monday);
  assert.equal(result.fits, true);
  assert.equal(result.a, 720); // nudged to 12:00
  assert.equal(result.nudged, true);
});

test('fixedTime: fails if travel arrives too late', () => {
  const place = { stayMin: 60, fixedTime: true, desiredStart: '09:00' };
  const result = applyOpeningHours(place, 600, 480, 1260, monday);
  assert.equal(result.fits, false);
  assert.equal(result.reason, 'fixed_time_travel_late');
});

test('stop does not fit when b > activeEnd', () => {
  const place = { stayMin: 120 };
  const result = applyOpeningHours(place, 1230, 480, 1260, monday);
  assert.equal(result.fits, false);
});

test('desiredEnd constrains window', () => {
  const place = { stayMin: 60, desiredStart: '09:00', desiredEnd: '10:00' };
  const result = applyOpeningHours(place, 480, 480, 1260, monday);
  assert.equal(result.fits, true);
  assert.equal(result.a, 540);
  assert.equal(result.b, 600);
});

test('opening hours: venue closed all day', () => {
  const place = { stayMin: 60, openingHours: 'Tu 09:00-18:00' }; // only open Tuesday
  const result = applyOpeningHours(place, 540, 480, 1260, monday);
  assert.equal(result.fits, false);
});
