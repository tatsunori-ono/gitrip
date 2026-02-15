/**
 * server/openhours.js — Parser and validator for OSM-style opening hours.
 *
 * Parses strings like "Mo-Fr 09:00-18:00; Sa 10:00-16:00; Su off" into
 * a per-day schedule, then checks whether a proposed time interval falls
 * within open hours (nudging to the next valid slot if possible).
 *
 * Exported: parseOpeningHours, validateInterval
 */

// JS getDay(): 0=Sunday, 1=Monday, ... 6=Saturday
const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

/** Split a semicolon-delimited opening-hours string into individual rules. */
function splitRules(str) {
  return String(str).split(';').map(s => s.trim()).filter(Boolean);
}

/** Convert "HH:MM" to minutes since midnight. */
function parseRange(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
}

/**
 * Expand a day token like "Mo-Fr", "Sa", or "Mo,We,Fr" into an array
 * of day-of-week indices (0-6).  Handles wrap-around (e.g. "Fr-Mo").
 */
function expandDays(token) {
  const parts = token.split(',');
  const result = new Set();
  for (const p of parts) {
    const t = p.trim();
    if (t.includes('-')) {
      const [a, b] = t.split('-').map(x => x.trim());
      const ai = DAYS.indexOf(a);
      const bi = DAYS.indexOf(b);
      if (ai >= 0 && bi >= 0) {
        let i = ai;
        while (true) {
          result.add(i);
          if (i === bi) break;
          i = (i + 1) % 7; // wrap around Sunday→Monday
        }
      }
    } else {
      const idx = DAYS.indexOf(t);
      if (idx >= 0) result.add(idx);
    }
  }
  return Array.from(result).sort((x, y) => x - y);
}

/**
 * Parse an OSM opening_hours string into a schedule map.
 *
 * @example
 *   parseOpeningHours("Mo-Fr 09:00-18:00; Sa 10:00-16:00; Su off")
 *   // => { 1:[{start:540,end:1080}], ..., 6:[{start:600,end:960}], 0:[] }
 *
 * @returns {Object<number, Array<{start:number, end:number}>>}
 *   Keys are day-of-week indices (0=Sun); values are arrays of open intervals
 *   in minutes-since-midnight.  An empty array means explicitly closed.
 */
export function parseOpeningHours(oh) {
  if (!oh) return {};
  const rules = splitRules(oh);
  const schedule = {};
  for (const r of rules) {
    const [daysPart, timesPartRaw] = r.split(/\s+/, 2);
    if (!daysPart) continue;
    const days = expandDays(daysPart);
    if (!timesPartRaw) continue;
    const timesPart = timesPartRaw.trim();

    // Handle "off" / "closed" keywords
    if (timesPart.toLowerCase() === 'off' || timesPart.toLowerCase() === 'closed') {
      days.forEach(d => { schedule[d] = []; });
      continue;
    }

    // Parse comma-separated time spans, e.g. "09:00-12:00,13:00-18:00"
    const spans = timesPart.split(',').map(s => s.trim()).filter(Boolean);
    const parsed = spans.map(sp => {
      const [a, b] = sp.split('-');
      if (!a || !b) return null;
      return { start: parseRange(a), end: parseRange(b) };
    }).filter(Boolean);
    days.forEach(d => {
      schedule[d] = (schedule[d] || []).concat(parsed);
    });
  }
  return schedule;
}

/**
 * Check whether a proposed visit interval [startMin, endMin] falls within
 * an open slot for the given date.
 *
 * @returns {{ open: boolean, nextStart?: number, reason?: string }}
 *   - open=true if the interval fits entirely within an open span.
 *   - open=false with nextStart if a later start on the same day would fit.
 *   - open=false without nextStart if the venue is closed all day or no
 *     span can accommodate the visit duration.
 */
export function validateInterval(schedule, dateObj, startMin, endMin) {
  const dow = dateObj.getDay();
  const spans = schedule[dow] || [];
  if (!spans.length) return { open: false, reason: 'closed' };

  // Check if the interval already fits in any open span
  for (const { start, end } of spans) {
    if (startMin >= start && endMin <= end) return { open: true };
  }

  // Try to find the earliest start that fits the visit duration within a span
  const stayMin = endMin - startMin;
  let nextStart = null;
  for (const { start, end } of spans) {
    if (end >= startMin + stayMin) {
      const s = Math.max(start, startMin);
      if (s + stayMin <= end) {
        nextStart = (nextStart == null) ? s : Math.min(nextStart, s);
      }
    }
  }
  if (nextStart != null) return { open: false, nextStart, reason: 'adjusted' };
  return { open: false, reason: 'outside_hours' };
}
