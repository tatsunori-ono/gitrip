import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOpeningHours, validateInterval } from '../server/openhours.js';

// --- parseOpeningHours ---

test('standard weekday range Mo-Fr', () => {
  const sched = parseOpeningHours('Mo-Fr 09:00-18:00');
  for (let d = 1; d <= 5; d++) {
    assert.ok(Array.isArray(sched[d]));
    assert.equal(sched[d].length, 1);
    assert.equal(sched[d][0].start, 540);
    assert.equal(sched[d][0].end, 1080);
  }
  assert.equal(sched[6], undefined);
  assert.equal(sched[0], undefined);
});

test('wrap-around range Fr-Mo', () => {
  const sched = parseOpeningHours('Fr-Mo 10:00-20:00');
  assert.ok(sched[5]); // Fri
  assert.ok(sched[6]); // Sat
  assert.ok(sched[0]); // Sun
  assert.ok(sched[1]); // Mon
  assert.equal(sched[2], undefined);
});

test('off keyword closes day', () => {
  const sched = parseOpeningHours('Su off');
  assert.ok(Array.isArray(sched[0]));
  assert.equal(sched[0].length, 0);
});

test('multi-span same day', () => {
  const sched = parseOpeningHours('Mo 09:00-12:00,13:00-18:00');
  assert.equal(sched[1].length, 2);
  assert.equal(sched[1][0].start, 540);
  assert.equal(sched[1][0].end, 720);
  assert.equal(sched[1][1].start, 780);
  assert.equal(sched[1][1].end, 1080);
});

test('compound rule with semicolons', () => {
  const sched = parseOpeningHours('Mo-Fr 09:00-18:00; Sa 10:00-16:00; Su off');
  assert.ok(sched[1].length > 0);
  assert.equal(sched[6][0].start, 600);
  assert.equal(sched[0].length, 0);
});

test('empty or null input returns empty object', () => {
  assert.deepEqual(parseOpeningHours(''), {});
  assert.deepEqual(parseOpeningHours(null), {});
});

// --- validateInterval ---

test('open: interval fits in span', () => {
  const sched = parseOpeningHours('Mo 09:00-18:00');
  const monday = new Date('2025-06-02');
  const result = validateInterval(sched, monday, 600, 660);
  assert.equal(result.open, true);
});

test('closed: day not in schedule', () => {
  const sched = parseOpeningHours('Mo 09:00-18:00');
  const tuesday = new Date('2025-06-03');
  const result = validateInterval(sched, tuesday, 600, 660);
  assert.equal(result.open, false);
  assert.equal(result.reason, 'closed');
});

test('nudge: arrive before open, fits if shifted', () => {
  const sched = parseOpeningHours('Mo 09:00-18:00');
  const monday = new Date('2025-06-02');
  const result = validateInterval(sched, monday, 480, 540);
  assert.equal(result.open, false);
  assert.equal(result.nextStart, 540);
});

test('outside_hours: visit too long for any span', () => {
  const sched = parseOpeningHours('Mo 09:00-10:00');
  const monday = new Date('2025-06-02');
  const result = validateInterval(sched, monday, 540, 660);
  assert.equal(result.open, false);
  assert.equal(result.reason, 'outside_hours');
});

test('fits exactly at span boundary', () => {
  const sched = parseOpeningHours('Mo 09:00-10:00');
  const monday = new Date('2025-06-02');
  const result = validateInterval(sched, monday, 540, 600);
  assert.equal(result.open, true);
});
