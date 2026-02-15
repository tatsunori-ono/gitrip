/**
 * server/planner.js — Auto-scheduling engine for trip itineraries.
 *
 * Given a list of places, date range, active hours, and transport mode,
 * this module produces an optimised multi-day schedule.  The algorithm:
 *
 *   1. Builds a pairwise travel-time matrix (via ORS or Haversine fallback).
 *   2. Orders stops using nearest-neighbour heuristic, optionally
 *      respecting user-defined strict orderings.
 *   3. Packs stops into day-sized bins using a greedy cursor that
 *      advances through each day's active window, honouring:
 *        - Opening hours (hard constraint, nudged to next open slot).
 *        - Desired time windows (soft) and fixed-time slots (hard).
 *        - Compactness / focus preferences.
 *   4. Spills unfit stops to subsequent days or an overflow list.
 *
 * Exported: autoPlan()
 */
import crypto from 'node:crypto';
import { orsMatrix, routeLegs, haversineMinutes, constantGap } from './routing.js';
import { parseOpeningHours, validateInterval } from './openhours.js';

// ---------- Time helpers ----------
/** Convert "HH:MM" string to total minutes since midnight. */
function toMin(hhmm) {
  if (!hhmm) return 0;
  const [h, m] = String(hhmm).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** Convert total minutes since midnight back to "HH:MM" string. */
function toHHMM(min) {
  min = Math.max(0, Math.round(min || 0));
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function normalizeDates(startDate, endDate) {
  const today = new Date();
  const iso = (d) =>
    new Date(d.getTime() - d.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 10);
  const start = startDate ? new Date(startDate) : today;
  const end = endDate ? new Date(endDate) : start;
  return { start, end, iso };
}

// ---------- Routing helpers ----------
/** Request a pairwise duration matrix from ORS for the given places and mode. */
async function buildDurationMatrix(places, transport) {
  const pts = places.map((p) => ({
    lat: Number(p.lat || NaN),
    lng: Number(p.lng || NaN),
  }));
  const allCoords = pts.every((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  if (!allCoords || places.length < 2) return null;

  const profile =
    transport === 'walking' || transport === 'cycling' ? transport : 'driving';

  const res = await orsMatrix(pts, profile);
  if (res.ok) return res.minutes;
  return null;
}

/** Check whether any segment in a routing result indicates public transit usage. */
function detectTransitInSegments(segList) {
  if (!Array.isArray(segList)) return false;
  return segList.some((seg) => {
    if (!seg) return false;
    const raw =
      seg.subMode ||
      seg.mode ||
      seg.type ||
      (seg.kind ? (seg.kind === 'transit' ? 'transit' : seg.kind) : '');
    const val = String(raw || '').toLowerCase();
    if (!val) return false;
    return (
      val.includes('transit') ||
      val.includes('rail') ||
      val.includes('train') ||
      val.includes('metro') ||
      val.includes('subway') ||
      val.includes('bus')
    );
  });
}

/**
 * Determine the effective transport mode for a single leg.
 * When the user requests 'transit' but the routing provider falls back to
 * walking (e.g. short distance), this detects that and returns 'walking'.
 */
function resolveActualLegMode(requestedMode, legResult) {
  if (requestedMode !== 'transit') return requestedMode || 'driving';
  if (!legResult || typeof legResult !== 'object') return 'walking';

  if (
    Array.isArray(legResult.segmentsByLeg) &&
    legResult.segmentsByLeg.some((legSegs) => detectTransitInSegments(legSegs))
  ) {
    return 'transit';
  }

  if (detectTransitInSegments(legResult.segments)) {
    return 'transit';
  }

  if (
    Array.isArray(legResult.transitLegs) &&
    legResult.transitLegs.some((leg) =>
      Array.isArray(leg?.steps)
        ? leg.steps.some((step) => step && step.kind === 'transit')
        : false
    )
  ) {
    return 'transit';
  }

  return 'walking';
}

// ---------- Ordering (strict order + start here) ----------
/**
 * Determine visit order for places.
 *
 * Strategies (in priority order):
 *  1. 'strict' mode — user-assigned position numbers are absolute slots;
 *     unassigned places fill the gaps.
 *  2. 'relative' mode — strict-ordered places keep their relative order
 *     among themselves; others keep original input positions.
 *  3. No strict orders — nearest-neighbour (NN) greedy ordering using the
 *     travel-time matrix M (or Haversine fallback).
 *
 * In all strategies the "startFirst" flag anchors a place at position 0.
 */
function orderPlaces(places, M, transport, orderingMode = 'relative') {
  if (!places.length) return [];

  const anyStrict = places.some(
    (p) =>
      p.strictOrder !== undefined &&
      p.strictOrder !== null &&
      p.strictOrder !== ''
  );
  const startIdxFlag = places.findIndex((p) => p.startFirst);

  // If user provided strictOrder, choose a strategy based on orderingMode.
  if (anyStrict) {
    const hasStrict = (p) =>
      p.strictOrder !== undefined &&
      p.strictOrder !== null &&
      p.strictOrder !== '';

    if (orderingMode === 'strict') {
      const n = places.length;
      const slots = Array(n).fill(null);
      const remaining = [];

      for (const p of places) {
        const raw =
          p.strictOrder !== undefined &&
          p.strictOrder !== null &&
          p.strictOrder !== ''
            ? Number(p.strictOrder)
            : null;
        const pos = Number.isInteger(raw) ? raw : null;
        if (pos !== null && pos >= 1 && pos <= n && !slots[pos - 1]) {
          slots[pos - 1] = p;
        } else {
          remaining.push(p);
        }
      }

      // Honour startFirst only if slot 1 is free and it won't break fixed slots.
      if (!slots[0]) {
        const sfIdx = remaining.findIndex((p) => p.startFirst);
        if (sfIdx >= 0) {
          const [first] = remaining.splice(sfIdx, 1);
          slots[0] = first;
        }
      }

      let r = 0;
      for (let i = 0; i < n; i++) {
        if (!slots[i]) {
          slots[i] = remaining[r++];
        }
      }
      return slots;
    }

    const strictSorted = places
      .filter(hasStrict)
      .slice()
      .sort((a, b) => {
        const aKey = Number(a.strictOrder);
        const bKey = Number(b.strictOrder);
        if (aKey !== bKey) return aKey - bKey;
        return (a._i ?? 0) - (b._i ?? 0);
      });

    let si = 0;
    const ordered = places.map((p) => (hasStrict(p) ? strictSorted[si++] : p));

    if (startIdxFlag >= 0) {
      const idx = ordered.findIndex((p) => p.startFirst);
      if (idx > 0 && !hasStrict(ordered[idx])) {
        const [first] = ordered.splice(idx, 1);
        ordered.unshift(first);
      }
    }

    return ordered;
  }

  // Attempt to build a fallback distance matrix using haversine if the routed
  // matrix isn't available so we still reorder when coords exist.
  let matrix = M;
  if (!matrix) {
    const allCoords = places.every(
      (p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lng)
    );
    if (allCoords && places.length >= 2) {
      matrix = places.map((a, i) =>
        places.map((b, j) => {
          if (i === j) return 0;
          const d = haversineMinutes(a, b, transport || 'driving');
          return Number.isFinite(d) ? d : Infinity;
        })
      );
    }
  }

  // No strict order → greedy nearest-neighbour using the travel-time matrix.
  if (!matrix) {
    if (startIdxFlag >= 0) {
      const copy = places.slice();
      const [first] = copy.splice(startIdxFlag, 1);
      return [first, ...copy];
    }
    return places.slice();
  }

  // Nearest-neighbour: repeatedly pick the closest unvisited place.
  const n = places.length;
  const used = Array(n).fill(false);
  let cur = startIdxFlag >= 0 ? startIdxFlag : 0;
  used[cur] = true;
  const seq = [cur];

  while (seq.length < n) {
    let best = -1;
    let bestVal = Infinity;
    for (let j = 0; j < n; j++) {
      if (used[j]) continue;
      const d = matrix[cur]?.[j] ?? Infinity;
      if (d < bestVal) {
        best = j;
        bestVal = d;
      }
    }
    used[best] = true;
    seq.push(best);
    cur = best;
  }

  return seq.map((i) => places[i]);
}

function defaultActiveHours(activeHours) {
  const start = activeHours?.start || '08:00';
  const end = activeHours?.end || '21:00';
  return { start, end };
}

// ---------- Constraints core (opening hours + time windows + fixed-time) ----------
/**
 * Try to schedule a single place on a given day.
 * - arriveMin: earliest we can physically arrive (travel + previous stop)
 * - activeStart/activeEnd: day's overall window [min, min]
 * - desiredStart/desiredEnd: user preference window
 * - openingHours: hard-ish constraint; we nudge to next valid slot if possible
 *
 * NEW: place.fixedTime === true makes desiredStart/desiredEnd a HARD constraint.
 * - If desiredStart is provided, the stop must start at that time (exact).
 * - If it can't fit, return fits=false (so caller can spill to next day / overflow).
 */
function applyOpeningHours(place, arriveMin, activeStart, activeEnd, dateObj) {
  const stay = Math.max(5, Number(place.stayMin || 60));
  let a = Math.max(arriveMin, activeStart);
  let b = a + stay;
  let nudged = false;
  let reason = '';

  const fixedTime = !!place.fixedTime;

  // ------ Desired window ------
  const wantStart =
    place.desiredStart && place.desiredStart !== ''
      ? toMin(place.desiredStart)
      : null;
  const wantEnd =
    place.desiredEnd && place.desiredEnd !== ''
      ? toMin(place.desiredEnd)
      : null;

  const hasDesired = wantStart !== null || wantEnd !== null;

  // Fixed-time: treat desiredStart (and desiredEnd optionally) as HARD.
  if (fixedTime && hasDesired && wantStart !== null) {
    const target = wantStart;
    const latestStartAllowed =
      wantEnd !== null ? (wantEnd - stay) : target; // if no end provided, exact start

    // Must be able to arrive by the target start time (waiting is allowed).
    if (arriveMin > target) {
      return {
        fits: false,
        a: target,
        b: target + stay,
        nudged: true,
        reason: 'fixed_time_travel_late',
      };
    }

    // Must be within active window, and within desiredEnd if provided.
    if (target < activeStart || target > latestStartAllowed || target + stay > activeEnd) {
      return {
        fits: false,
        a: target,
        b: target + stay,
        nudged: true,
        reason: 'fixed_time_window',
      };
    }

    a = target;
    b = a + stay;
  } else if (hasDesired) {
    // Non-fixed (default) behaviour: desired window is soft.
    // BUT if fixedTime is enabled without desiredStart (edge case),
    // we treat it as a hard desired window below (no fallback).
    const hardDesiredWindow = fixedTime;

    const earliestDesired = Math.max(
      arriveMin,
      activeStart,
      wantStart !== null ? wantStart : -Infinity
    );
    const latestDesired = Math.min(
      activeEnd - stay,
      wantEnd !== null ? wantEnd - stay : Infinity
    );

    if (earliestDesired <= latestDesired) {
      a = earliestDesired;
      b = a + stay;
    } else {
      if (hardDesiredWindow) {
        return {
          fits: false,
          a: earliestDesired,
          b: earliestDesired + stay,
          nudged: true,
          reason: 'desired_hard',
        };
      }

      // Can't fully honour desired window → fall back to earliest feasible
      const fallbackEarliest = Math.max(arriveMin, activeStart);
      if (fallbackEarliest + stay > activeEnd) {
        return {
          fits: false,
          a: fallbackEarliest,
          b: fallbackEarliest + stay,
          nudged: true,
          reason: 'desired',
        };
      }
      a = fallbackEarliest;
      b = a + stay;
      nudged = true;
      reason = 'desired';
    }
  } else {
    // No desired window, still ensure we start no earlier than arrive/active
    a = Math.max(arriveMin, activeStart);
    b = a + stay;
  }

  // ------ Opening-hours (hard-ish) ------
  const schedule = place.openingHours
    ? parseOpeningHours(place.openingHours)
    : null;

  if (schedule) {
    const val = validateInterval(schedule, dateObj, a, b);
    if (!val.open) {
      // If fixedTime is enabled, we do NOT nudge to a later opening slot;
      // we must keep the fixed time and fail instead.
      if (fixedTime) {
        return {
          fits: false,
          a,
          b,
          nudged: true,
          reason: val.reason || 'opening_hours',
        };
      }

      if (val.nextStart != null) {
        a = Math.max(val.nextStart, activeStart);
        b = a + stay;
        nudged = true;
        if (!reason) reason = 'opening_hours';
      } else {
        return {
          fits: false,
          a,
          b,
          nudged,
          reason: val.reason || 'closed',
        };
      }
    }
  }

  if (b > activeEnd) {
    return {
      fits: false,
      a,
      b,
      nudged,
      reason: reason || 'active_window',
    };
  }

  return { fits: true, a, b, nudged, reason };
}

// ---------- Main planner ----------
export async function autoPlan({
  startDate,
  endDate,
  places,
  activeHours,
  breakMinBetweenStops = 0,
  targetDays,
  compactness = 'compact',
  focus = 'midday',
  transport = 'driving',
  orderingMode = 'relative',
} = {}) {
  const { start, end, iso } = normalizeDates(startDate, endDate);
  const act = defaultActiveHours(activeHours);
  const actStart = toMin(act.start);
  const actEnd = toMin(act.end);

  // Build day shells (at least one)
  const days = [];
  const msDay = 24 * 3600 * 1000;
  for (let t = new Date(start); t <= end; t = new Date(t.getTime() + msDay)) {
    days.push({ id: `day-${iso(t)}`, date: iso(t), stops: [] });
  }
  if (!days.length) {
    days.push({ id: `day-${iso(start)}`, date: iso(start), stops: [] });
  }
  if (targetDays && targetDays > 0 && targetDays < days.length) {
    days.length = targetDays;
  }

  const enabled = (places || [])
    .filter((p) => p && p.enabled !== false)
    .map((p, idx) => ({
      ...p,
      id: p.id || crypto.randomUUID(),
      _i: idx, // original index for ordering fallback
      preferredDay: p.preferredDay,
    }));

  if (!enabled.length) return { transport, days, overflow: [] };

  // Travel matrix provides pairwise durations for ordering; transit skips it
  // because we need per-leg schedules rather than static matrices.
  const M =
    transport === 'transit' ? null : await buildDurationMatrix(enabled, transport);

  // Order stops with nearest-neighbor (or strict order if provided),
  // which gives a reasonable path before time-window packing.
  const ordered = orderPlaces(enabled, M, transport, orderingMode);

  const span = Math.max(30, actEnd - actStart);
  const totalStops = enabled.length;
  const numDays = days.length || 1;
  const avgStay =
    totalStops > 0
      ? enabled.reduce(
          (sum, p) => sum + Math.max(5, Number(p.stayMin || 60)),
          0
        ) / totalStops
      : 60;

  // Focus shift: offset the first stop's start time within the active
  // window so the schedule clusters around morning/midday/afternoon.  For
  // "sparse" compactness we skip the shift so stops spread across the full day.
  let focusShift;
  if (compactness === 'sparse') {
    focusShift = 0;
  } else {
    const f = focus || 'midday';
    focusShift =
      f === 'morning'
        ? 0
        : f === 'midday'
        ? Math.floor(span / 3)
        : Math.floor(span / 1.8);
  }

  // For "sparse" compactness: compute an extra gap between stops so they are
  // evenly distributed across the active window rather than packed tightly.
  const approxPerDay = Math.max(1, Math.ceil(totalStops / numDays));
  const gapRaw =
    (span - approxPerDay * avgStay) / (approxPerDay + 1);
  const sparseExtraGap = Math.max(
    20,
    Math.round(Number.isFinite(gapRaw) ? gapRaw : 0)
  );

  // Fallback travel time (minutes) when no matrix or coordinates are available.
  const DEFAULT_TRAVEL_MIN = constantGap(transport);

  /** Look up pairwise travel time: matrix → Haversine → constant fallback. */
  function travelMinWithMatrix(a, b) {
    if (M && Number.isInteger(a._i) && Number.isInteger(b._i)) {
      const m = M[a._i]?.[b._i];
      if (Number.isFinite(m)) return m;
    }
    if (
      Number.isFinite(a?.lat) &&
      Number.isFinite(a?.lng) &&
      Number.isFinite(b?.lat) &&
      Number.isFinite(b?.lng)
    ) {
      return haversineMinutes(a, b, transport);
    }
    return DEFAULT_TRAVEL_MIN;
  }

  const overflow = []; // stops that couldn't fit in any available day

  /** Compute travel time + effective mode for a single leg (last → place). */
  async function computeLeg(last, place, dayIndex) {
    if (!last) return { legTravel: 0, legMode: transport };
    if (transport === 'transit') {
      const leg = await routeLegs([last, place], 'transit', {
        dateIso: days[dayIndex].date,
        startTimeMin: toMin(last.depart || act.start),
      });
      const legTravel =
        leg && Array.isArray(leg.minutes) && Number.isFinite(leg.minutes[0])
          ? leg.minutes[0]
          : haversineMinutes(last, place, 'walking');
      const legMode = resolveActualLegMode('transit', leg);
      return { legTravel, legMode };
    }
    return { legTravel: travelMinWithMatrix(last, place), legMode: transport };
  }

  /** Return the minute-cursor to start scheduling from on a given day. */
  function initCursorForDay(dayIndex) {
    const day = days[dayIndex];
    if (!day || !Array.isArray(day.stops) || !day.stops.length) {
      return actStart + focusShift;
    }
    const last = day.stops.at(-1);
    const departMin = toMin(last?.depart);
    if (!Number.isFinite(departMin)) return actStart + focusShift;
    if (compactness === 'sparse') {
      return departMin + breakMinBetweenStops + sparseExtraGap;
    }
    return departMin;
  }

  /** Extract a sub-matrix for a subset of places from the full travel matrix. */
  function buildSubMatrix(list, fullMatrix) {
    if (!fullMatrix) return null;
    const idxs = list.map((p) => p._i);
    if (!idxs.every((n) => Number.isInteger(n))) return null;
    return idxs.map((ri) =>
      idxs.map((ci) => fullMatrix[ri]?.[ci] ?? Infinity)
    );
  }

  // Partition places into per-day buckets (preferred day) vs unassigned.
  const assignedByDay = Array.from({ length: days.length }, () => []);
  const unassigned = [];
  enabled.forEach((place) => {
    const pref = Number(place.preferredDay);
    if (Number.isFinite(pref) && pref >= 1 && pref <= days.length) {
      assignedByDay[pref - 1].push(place);
    } else {
      unassigned.push(place);
    }
  });

  const dayCursors = days.map((_, idx) => initCursorForDay(idx));

  // Schedule fixed-day stops first (per-day buckets)
  for (let dayIdx = 0; dayIdx < days.length; dayIdx++) {
    const list = assignedByDay[dayIdx];
    if (!list.length) continue;
    const orderedList = orderPlaces(
      list,
      buildSubMatrix(list, M),
      transport,
      orderingMode
    );
    let cursor = dayCursors[dayIdx];
    const today = new Date(days[dayIdx].date + 'T00:00:00Z');

    for (const place of orderedList) {
      const last = days[dayIdx].stops.at(-1) || null;
      const { legTravel, legMode } = await computeLeg(last, place, dayIdx);

      let propose;
      if (last) {
        const minArrival =
          toMin(last.depart) + breakMinBetweenStops + legTravel;
        if (compactness === 'sparse') {
          propose = place && place.fixedTime ? minArrival : Math.max(minArrival, cursor);
        } else {
          propose = minArrival;
        }
      } else {
        propose = cursor;
      }

      const tryFit = applyOpeningHours(
        place,
        propose,
        actStart,
        actEnd,
        today
      );

      if (!tryFit.fits) {
        overflow.push(place);
        continue;
      }

      const a = tryFit.a;
      const b = tryFit.b;
      days[dayIdx].stops.push({
        ...place,
        arrive: toHHMM(a),
        depart: toHHMM(b),
        prevTravelMin: legTravel,
        routeMode: legMode,
        __nudged: tryFit.nudged ? tryFit.reason || 'opening_hours' : undefined,
      });

      cursor = compactness === 'sparse'
        ? b + breakMinBetweenStops + sparseExtraGap
        : b;
      dayCursors[dayIdx] = cursor;
    }
  }

  let dayIdx = 0;
  let cursor = dayCursors[dayIdx] ?? actStart + focusShift;
  let noMoreDays = false;

  const orderedUnassigned = orderPlaces(
    unassigned,
    buildSubMatrix(unassigned, M),
    transport,
    orderingMode
  );

  for (let pi = 0; pi < orderedUnassigned.length; pi++) {
    const place = orderedUnassigned[pi];

    // If we've already run out of days, everything else goes to overflow.
    if (noMoreDays) {
      overflow.push(place);
      continue;
    }

    if (!days[dayIdx]) {
      noMoreDays = true;
      overflow.push(place);
      continue;
    }

    let today = new Date(days[dayIdx].date + 'T00:00:00Z');
    const last = days[dayIdx].stops.at(-1) || null;
    const { legTravel, legMode } = await computeLeg(last, place, dayIdx);

    // depart last + break + travel → proposed arrival
    let propose;
    if (last) {
      const minArrival =
        toMin(last.depart) + breakMinBetweenStops + legTravel;

      if (compactness === 'sparse') {
        // IMPORTANT: fixed-time stops should NOT be delayed by sparse spacing cursor,
        // otherwise "spacing" can make them falsely impossible.
        if (place && place.fixedTime) {
          propose = minArrival;
        } else {
          propose = Math.max(minArrival, cursor);
        }
      } else {
        propose = minArrival;
      }
    } else {
      // First stop of this day
      propose = cursor;
    }

    let tryFit = applyOpeningHours(
      place,
      propose,
      actStart,
      actEnd,
      today
    );

    if (!tryFit.fits) {
      // advance days until it fits or we run out
      while (!tryFit.fits) {
        dayIdx++;
        if (!days[dayIdx]) {
          noMoreDays = true;
          overflow.push(place);
          break;
        }
        today = new Date(days[dayIdx].date + 'T00:00:00Z');
        cursor = dayCursors[dayIdx] ?? initCursorForDay(dayIdx);
        const firstPropose = cursor;
        tryFit = applyOpeningHours(
          place,
          firstPropose,
          actStart,
          actEnd,
          today
        );
      }
    }

    if (noMoreDays) {
      continue;
    }

    const a = tryFit.a;
    const b = tryFit.b;

    days[dayIdx].stops.push({
      ...place,
      arrive: toHHMM(a),
      depart: toHHMM(b),
      prevTravelMin: legTravel,
      routeMode: legMode,
      __nudged: tryFit.nudged ? tryFit.reason || 'opening_hours' : undefined,
    });

    // advance cursor for next stop
    if (compactness === 'sparse') {
      cursor = b + breakMinBetweenStops + sparseExtraGap;
    } else {
      cursor = b;
    }
    dayCursors[dayIdx] = cursor;
  }

  return { transport, days, overflow };
}
