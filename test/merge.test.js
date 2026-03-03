import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffMaps, mergeSnapshots } from '../server/merge.js';

// --- helpers ---
function snap(days) {
  return { files: {}, plan: { days } };
}
function day(id, date, stops) {
  return { id, date, stops: stops || [] };
}
function stop(id, name, arrive, depart, extra) {
  return { id, name, arrive: arrive || '10:00', depart: depart || '11:00', ...(extra || {}) };
}

// --- diffMaps ---

test('diffMaps: no changes returns empty array', () => {
  const base = { a: 1, b: 'x' };
  const result = diffMaps(base, { ...base }, { ...base });
  assert.equal(result.length, 0);
});

test('diffMaps: left-only change', () => {
  const changes = diffMaps({ a: 1 }, { a: 2 }, { a: 1 });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].side, 'L');
  assert.equal(changes[0].value, 2);
});

test('diffMaps: right-only change', () => {
  const changes = diffMaps({ a: 1 }, { a: 1 }, { a: 3 });
  assert.equal(changes[0].side, 'R');
  assert.equal(changes[0].value, 3);
});

test('diffMaps: both changed to same value is non-conflict', () => {
  const changes = diffMaps({ a: 1 }, { a: 2 }, { a: 2 });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].side, 'L');
});

test('diffMaps: both changed to different values is BOTH conflict', () => {
  const changes = diffMaps({ a: 1 }, { a: 2 }, { a: 3 });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].side, 'BOTH');
});

test('diffMaps: key-order-independent equality (deep equal)', () => {
  const base = { a: { x: 1, y: 2 } };
  const left = { a: { y: 2, x: 1 } }; // same content, different key order
  const right = { a: { x: 1, y: 2 } };
  const changes = diffMaps(base, left, right);
  assert.equal(changes.length, 0);
});

// --- mergeSnapshots: clean merge ---

test('only theirs changed -> take theirs', () => {
  const base = snap([day('d1', '2025-06-01', [stop('s1', 'Museum')])]);
  const ours = snap([day('d1', '2025-06-01', [stop('s1', 'Museum')])]);
  const theirs = snap([day('d1', '2025-06-01', [stop('s1', 'Museum', '12:00', '13:00')])]);
  const { snapshot, conflicts } = mergeSnapshots(base, ours, theirs);
  assert.equal(conflicts.length, 0);
  assert.equal(snapshot.plan.days[0].stops[0].arrive, '12:00');
});

test('only ours changed -> take ours', () => {
  const base = snap([day('d1', '2025-06-01', [stop('s1', 'Museum')])]);
  const ours = snap([day('d1', '2025-06-01', [stop('s1', 'Museum', '09:00', '10:00')])]);
  const theirs = snap([day('d1', '2025-06-01', [stop('s1', 'Museum')])]);
  const { snapshot, conflicts } = mergeSnapshots(base, ours, theirs);
  assert.equal(conflicts.length, 0);
  assert.equal(snapshot.plan.days[0].stops[0].arrive, '09:00');
});

// --- mergeSnapshots: deletions ---

test('both deleted same stop -> no conflict, stop absent', () => {
  const base = snap([day('d1', '2025-06-01', [stop('s1', 'Park')])]);
  const ours = snap([day('d1', '2025-06-01', [])]);
  const theirs = snap([day('d1', '2025-06-01', [])]);
  const { snapshot, conflicts } = mergeSnapshots(base, ours, theirs);
  assert.equal(conflicts.length, 0);
  assert.equal(snapshot.plan.days[0].stops.length, 0);
});

test('delete-vs-modify creates plan-stop-delete conflict', () => {
  const base = snap([day('d1', '2025-06-01', [stop('s1', 'Cafe')])]);
  const ours = snap([day('d1', '2025-06-01', [])]);
  const theirs = snap([day('d1', '2025-06-01', [stop('s1', 'Cafe', '08:00', '09:00')])]);
  const { conflicts } = mergeSnapshots(base, ours, theirs);
  assert.ok(conflicts.some(c => c.type === 'plan-stop-delete'));
});

// --- mergeSnapshots: time conflict ---

test('time conflict when both changed times differently', () => {
  const base = snap([day('d1', '2025-06-01', [stop('s1', 'Louvre', '10:00', '12:00')])]);
  const ours = snap([day('d1', '2025-06-01', [stop('s1', 'Louvre', '09:00', '11:00')])]);
  const theirs = snap([day('d1', '2025-06-01', [stop('s1', 'Louvre', '14:00', '16:00')])]);
  const { conflicts } = mergeSnapshots(base, ours, theirs);
  assert.ok(conflicts.some(c => c.type === 'plan-stop-time'));
});

// --- mergeSnapshots: field conflict ---

test('field conflict when times agree but notes differ', () => {
  // Both branches change the same stop's notes (keep name/times same).
  // planKeySet uses names, so Jaccard stays high → reaches per-stop merge.
  const base = snap([day('d1', '2025-06-01', [
    stop('s1', 'Museum', '10:00', '12:00', { notes: 'original' }),
    stop('s2', 'Park', '13:00', '14:00'),
  ])]);
  const ours = snap([day('d1', '2025-06-01', [
    stop('s1', 'Museum', '10:00', '12:00', { notes: 'updated by ours' }),
    stop('s2', 'Park', '13:00', '14:00', { stayMin: 90 }),
  ])]);
  const theirs = snap([day('d1', '2025-06-01', [
    stop('s1', 'Museum', '10:00', '12:00', { notes: 'updated by theirs' }),
    stop('s2', 'Park', '13:00', '14:00', { stayMin: 120 }),
  ])]);
  const { conflicts } = mergeSnapshots(base, ours, theirs);
  assert.ok(conflicts.some(c => c.type === 'plan-stop-field'));
  const fc = conflicts.find(c => c.type === 'plan-stop-field');
  assert.ok(fc.fields.includes('notes'));
});

test('no field conflict when only one side changed name', () => {
  const base = snap([day('d1', '2025-06-01', [stop('s1', 'Museum', '10:00', '12:00')])]);
  const ours = snap([day('d1', '2025-06-01', [stop('s1', 'Art Museum', '10:00', '12:00')])]);
  const theirs = snap([day('d1', '2025-06-01', [stop('s1', 'Museum', '10:00', '12:00')])]);
  const { snapshot, conflicts } = mergeSnapshots(base, ours, theirs);
  assert.equal(conflicts.length, 0);
  assert.equal(snapshot.plan.days[0].stops[0].name, 'Art Museum');
});

// --- mergeSnapshots: plan-whole conflict ---

test('divergent plans with low similarity -> plan-whole conflict', () => {
  const base = snap([day('d1', '2025-06-01', [stop('s1', 'Paris'), stop('s2', 'Lyon')])]);
  const ours = snap([day('d1', '2025-06-01', [stop('s3', 'Berlin'), stop('s4', 'Hamburg'), stop('s5', 'Munich')])]);
  const theirs = snap([day('d1', '2025-06-01', [stop('s6', 'Tokyo'), stop('s7', 'Osaka'), stop('s8', 'Kyoto')])]);
  const { conflicts } = mergeSnapshots(base, ours, theirs);
  assert.ok(conflicts.some(c => c.type === 'plan-whole'));
});

// --- mergeSnapshots: ordering ---

test('merged days are sorted by date', () => {
  // Both sides change different stops so all three plans differ → structured merge
  const base = snap([
    day('d2', '2025-06-02', [stop('s1', 'B')]),
    day('d1', '2025-06-01', [stop('s2', 'A')]),
  ]);
  const ours = snap([
    day('d2', '2025-06-02', [stop('s1', 'B', '10:00', '11:30')]),
    day('d1', '2025-06-01', [stop('s2', 'A')]),
  ]);
  const theirs = snap([
    day('d2', '2025-06-02', [stop('s1', 'B')]),
    day('d1', '2025-06-01', [stop('s2', 'A', '08:00', '09:00')]),
  ]);
  const { snapshot } = mergeSnapshots(base, ours, theirs);
  assert.equal(snapshot.plan.days[0].date, '2025-06-01');
  assert.equal(snapshot.plan.days[1].date, '2025-06-02');
});

test('merged stops are sorted by arrive time', () => {
  // Both sides change different stops so structured merge runs (not fast-path)
  const base = snap([day('d1', '2025-06-01', [
    stop('s2', 'Late', '14:00', '15:00'),
    stop('s1', 'Early', '09:00', '10:00'),
  ])]);
  const ours = snap([day('d1', '2025-06-01', [
    stop('s2', 'Late', '14:00', '15:00'),
    stop('s1', 'Early', '09:00', '10:00'),
    stop('s3', 'Mid', '11:00', '12:00'),
  ])]);
  const theirs = snap([day('d1', '2025-06-01', [
    stop('s2', 'Late', '14:00', '15:00', { notes: 'changed' }),
    stop('s1', 'Early', '09:00', '10:00'),
  ])]);
  const { snapshot } = mergeSnapshots(base, ours, theirs);
  assert.equal(snapshot.plan.days[0].stops[0].name, 'Early');
  assert.equal(snapshot.plan.days[0].stops[1].name, 'Mid');
  assert.equal(snapshot.plan.days[0].stops[2].name, 'Late');
});
