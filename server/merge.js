/**
 * server/merge.js — Three-way merge for trip snapshots.
 *
 * Implements a Git-style merge strategy:
 *   1. File-level: per-key diff of snapshot.files (JSON deep equality).
 *   2. Plan-level:
 *      a. If only one branch changed the plan, take that branch.
 *      b. If both diverged but share enough stops (Jaccard >= 0.4),
 *         merge per-day/per-stop with explicit conflicts on time clashes.
 *      c. If both diverged with low similarity, flag a whole-plan conflict.
 *
 * Exported: diffMaps, mergeSnapshots
 */

/**
 * Compute per-key changes between a base object and two branch objects.
 * Returns an array of change descriptors with side='L', 'R', or 'BOTH'
 * (conflict) depending on which branches modified each key.
 */
export function diffMaps(base, left, right) {
  const keys = new Set([
    ...Object.keys(base || {}),
    ...Object.keys(left || {}),
    ...Object.keys(right || {}),
  ]);
  const changes = [];
  for (const k of keys) {
    const b = base[k];
    const l = left[k];
    const r = right[k];
    const bStr = JSON.stringify(b);
    const lStr = JSON.stringify(l);
    const rStr = JSON.stringify(r);
    const changedL = bStr !== lStr;
    const changedR = bStr !== rStr;
    if (changedL && !changedR) {
      changes.push({ key: k, side: 'L', value: l });
    } else if (!changedL && changedR) {
      changes.push({ key: k, side: 'R', value: r });
    } else if (changedL && changedR && lStr === rStr) {
      changes.push({ key: k, side: 'L', value: l });
    } else if (changedL && changedR) {
      changes.push({ key: k, side: 'BOTH', left: l, right: r });
    }
  }
  return changes;
}

// --- Helpers for plan-level structure comparison ---

/** Build a set of "date::stopName" keys to fingerprint a plan's structure. */
function planKeySet(plan) {
  const out = new Set();
  if (!plan || !Array.isArray(plan.days)) return out;

  for (const day of plan.days) {
    if (!day) continue;
    const date = day.date || '';
    const stops = Array.isArray(day.stops) ? day.stops : [];
    for (const s of stops) {
      if (!s) continue;
      const name = String(s.name || '').trim();
      const id = s.id || '';
      // approximate identity by date + (name or id)
      const key = `${date}::${name || id}`;
      out.add(key);
    }
  }
  return out;
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) {
    if (!b.has(v)) return false;
  }
  return true;
}

/**
 * Jaccard similarity coefficient: |A ∩ B| / |A ∪ B|.
 * Returns 1.0 for identical sets, 0.0 for completely disjoint sets.
 * Used to decide whether two diverged plans are similar enough to auto-merge.
 */
function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const v of a) {
    if (b.has(v)) inter++;
  }
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

/**
 * Three-way merge of trip snapshots (base vs ours vs theirs).
 * Returns { snapshot, conflicts } where conflicts is an array of unresolved
 * differences that need user intervention.
 */
export function mergeSnapshots(base, ours, theirs) {
  const out = { ...(base || {}), ...(ours || {}), ...(theirs || {}) };
  out.files = {};
  out.plan = null;
  const conflicts = [];

  // ----- files -----
  const baseFiles = base.files || {};
  const ourFiles = ours.files || {};
  const theirFiles = theirs.files || {};
  const fileChanges = diffMaps(baseFiles, ourFiles, theirFiles);

  const mergedFiles = { ...baseFiles };
  for (const ch of fileChanges) {
    const apply = (val) => {
      if (val === undefined || val === null) {
        delete mergedFiles[ch.key];
      } else {
        mergedFiles[ch.key] = val;
      }
    };
    if (ch.side === 'L') apply(ch.value);
    else if (ch.side === 'R') apply(ch.value);
    else {
      conflicts.push({
        type: 'file',
        path: ch.key,
        ours: ch.left,
        theirs: ch.right,
      });
      mergedFiles[ch.key] = baseFiles[ch.key];
    }
  }
  out.files = mergedFiles;

  // ----- plan (trip) -----
  const bp = base.plan ?? null;
  const op = ours.plan ?? null;
  const tp = theirs.plan ?? null;

  // no plan anywhere
  if (!bp && !op && !tp) {
    return { snapshot: out, conflicts };
  }

  // simple cases: only one side changed, or both changed to the same thing
  const bpStr = JSON.stringify(bp);
  const opStr = JSON.stringify(op);
  const tpStr = JSON.stringify(tp);

  if (bpStr === opStr && bpStr !== tpStr) {
    out.plan = tp;
    return { snapshot: out, conflicts };
  }
  if (bpStr === tpStr && bpStr !== opStr) {
    out.plan = op;
    return { snapshot: out, conflicts };
  }
  if (opStr === tpStr) {
    out.plan = op;
    return { snapshot: out, conflicts };
  }

  // At this point, all three differ. We approximate "trip identity" by
  // a set of (date + stop) keys and use Jaccard similarity to decide if
  // the branches are too divergent to auto-merge safely.
  const baseKeys = planKeySet(bp);
  const ourKeys = planKeySet(op);
  const theirKeys = planKeySet(tp);

  const changedStructOurs = !setsEqual(baseKeys, ourKeys);
  const changedStructTheirs = !setsEqual(baseKeys, theirKeys);

  if (changedStructOurs && changedStructTheirs) {
    const similarityOT = jaccard(ourKeys, theirKeys);
    // if the two branches barely share any stops, ask the user
    if (similarityOT < 0.4) {
      conflicts.push({
        type: 'plan-whole',
        base: bp,
        ours: op,
        theirs: tp,
      });
      out.plan = bp || null; // UI will decide which whole plan to keep
      return { snapshot: out, conflicts };
    }
  }

  // Otherwise do a structured 3‑way merge per day / stop, with
  // explicit conflicts only on time differences for the *same* stop.

  const byKey = (arr, fallbackDayId) =>
    Object.fromEntries(
      (arr || [])
        .filter((x) => x)
        .map((x) => {
          const name = String(x.name || '').trim().toLowerCase();
          const lat = Number.isFinite(Number(x.lat))
            ? Number(x.lat).toFixed(5)
            : 'na';
          const lng = Number.isFinite(Number(x.lng))
            ? Number(x.lng).toFixed(5)
            : 'na';
          const stableId =
            x.id ||
            `auto:${name || 'stop'}|lat:${lat}|lng:${lng}|day:${fallbackDayId || 'na'}`;
          if (!x.id) x.id = stableId;
          return [stableId, x];
        })
    );

  const daysBase = (bp && bp.days) || [];
  const daysOurs = (op && op.days) || [];
  const daysTheirs = (tp && tp.days) || [];

  const dayIds = new Set([
    ...daysBase.map((d) => d.id),
    ...daysOurs.map((d) => d.id),
    ...daysTheirs.map((d) => d.id),
  ]);
  const mergedDays = [];

  for (const dayId of dayIds) {
    const b =
      daysBase.find((d) => d.id === dayId) || {
        id: dayId,
        date: '',
        stops: [],
      };
    const o =
      daysOurs.find((d) => d.id === dayId) || {
        id: dayId,
        date: b.date,
        stops: [],
      };
    const t =
      daysTheirs.find((d) => d.id === dayId) || {
        id: dayId,
        date: b.date,
        stops: [],
      };

    const fallbackDayId = dayId || b.date || o.date || t.date || '';
    const sb = byKey(b.stops, fallbackDayId);
    const so = byKey(o.stops, fallbackDayId);
    const st = byKey(t.stops, fallbackDayId);

    const stopIds = new Set([
      ...Object.keys(sb),
      ...Object.keys(so),
      ...Object.keys(st),
    ]);
    const mergedStops = [];

    const eq = (x, y) =>
      JSON.stringify(x || null) === JSON.stringify(y || null);

    for (const sid of stopIds) {
      const bs = sb[sid];
      const os = so[sid];
      const ts = st[sid];

      const changedO = !eq(bs, os);
      const changedT = !eq(bs, ts);

      if (changedO && !changedT) {
        if (os) mergedStops.push(os);
      } else if (!changedO && changedT) {
        if (ts) mergedStops.push(ts);
      } else if (!changedO && !changedT) {
        if (bs) mergedStops.push(bs);
      } else {
        // Deleted on one side while the other modified: flag explicit conflict.
        if ((os && !ts) || (!os && ts)) {
          conflicts.push({
            type: 'plan-stop-delete',
            dayId,
            stopId: sid,
            base: bs,
            ours: os,
            theirs: ts,
          });
          if (bs) mergedStops.push(bs);
          continue;
        }

        // both changed → see if it's only the times or the full stop
        const timeEq = (a, b) =>
          a?.arrive === b?.arrive && a?.depart === b?.depart;

        if (timeEq(os, ts)) {
          const merged = { ...(ts || {}), ...(os || {}) };
          if (Object.keys(merged).length) mergedStops.push(merged);
        } else {
          conflicts.push({
            type: 'plan-stop-time',
            dayId,
            stopId: sid,
            base: bs,
            ours: os,
            theirs: ts,
          });
          if (bs) mergedStops.push(bs);
        }
      }
    }

    mergedDays.push({
      id: dayId,
      date: o.date || t.date || b.date,
      stops: mergedStops,
    });
  }

  out.plan = { ...(bp || {}), ...op, ...tp, days: mergedDays };
  return { snapshot: out, conflicts };
}
