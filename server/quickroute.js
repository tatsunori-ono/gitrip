/**
 * server/quickroute.js — Quick route optimiser for the Explore map.
 *
 * Takes a set of stops and a transport mode, then:
 *   1. Builds a travel-time matrix (ORS, pairwise transit, or Haversine).
 *   2. Finds the shortest Hamiltonian path (visit every stop once):
 *      - Exact solution via Held-Karp DP for N <= 12.
 *      - Greedy nearest-neighbour + 2-opt refinement for larger N.
 *   3. Computes real route geometry along the optimal order.
 *
 * Exported: optimizeQuickRoute
 */
import { orsMatrix, routeLegs, haversineMinutes } from './routing.js';

/** Normalise transport mode aliases to canonical names. */
function normMode(mode) {
  const m = String(mode || '').toLowerCase().trim();
  if (m === 'walk') return 'walking';
  if (m === 'bike') return 'cycling';
  if (m === 'train') return 'transit';
  if (['walking', 'driving', 'cycling', 'transit'].includes(m)) return m;
  return 'walking';
}

/** Sanitise and normalise incoming stop objects from the client. */
function normStops(raw) {
  const arr = Array.isArray(raw) ? raw : [];
  return arr
    .map((s) => {
      const name =
        String(s?.name || s?.label || s?.title || '').trim() || 'Stop';
      const fullName =
        String(s?.fullName || s?.display_name || s?.name || name).trim() || name;

      const lat = Number(s?.lat);
      const lng = Number(s?.lng);
      return {
        name,
        fullName,
        lat,
        lng,
      };
    })
    .filter((s) => s && s.name);
}

/** Build an N*N distance matrix using Haversine estimates. */
function buildHaversineMatrix(points, mode) {
  const n = points.length;
  const M = Array.from({ length: n }, () => Array(n).fill(Infinity));
  for (let i = 0; i < n; i++) M[i][i] = 0;

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const a = points[i];
      const b = points[j];
      const m = haversineMinutes(a, b, mode);
      M[i][j] = Number.isFinite(m) ? m : Infinity;
    }
  }
  return M;
}

async function buildOrsMatrix(points, mode) {
  const res = await orsMatrix(points, mode);
  if (res && res.ok && Array.isArray(res.minutes) && res.minutes.length) {
    return { provider: 'ors_matrix', matrix: res.minutes };
  }
  return null;
}

/** Execute async functions with bounded concurrency (at most `limit` in flight). */
async function runPool(fns, limit = 4) {
  const executing = new Set();
  const results = new Array(fns.length);

  for (let i = 0; i < fns.length; i++) {
    const p = Promise.resolve()
      .then(() => fns[i]())
      .then((r) => (results[i] = r))
      .catch(() => (results[i] = null))
      .finally(() => executing.delete(p));

    executing.add(p);

    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);
  return results;
}

/**
 * Build a directed transit-time matrix via pairwise Google Directions calls.
 * Limited to small N (called with N <= 7) to avoid O(N^2) API usage.
 */
async function buildTransitMatrix(points, opts) {
  const n = points.length;
  const M = Array.from({ length: n }, () => Array(n).fill(Infinity));
  for (let i = 0; i < n; i++) M[i][i] = 0;

  const tasks = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      tasks.push(async () => {
        const r = await routeLegs([points[i], points[j]], 'transit', opts);
        const m = r?.minutes && Number.isFinite(r.minutes[0]) ? r.minutes[0] : Infinity;
        M[i][j] = m;
        return true;
      });
    }
  }

  await runPool(tasks, 4);
  return { provider: 'transit_pairwise', matrix: M };
}

/**
 * Held-Karp dynamic programming for the shortest Hamiltonian PATH
 * (not cycle), starting from a fixed node.
 *
 * State: dp[mask][j] = minimum cost to reach node j having visited
 * exactly the nodes in `mask`.  Runs in O(2^N * N^2) time/space,
 * so it is only practical for small N (capped at 12 in the caller).
 *
 * Returns { order: number[], cost: number } or { order: null, cost: Infinity }.
 */
function heldKarpPath(matrix, startIdx) {
  const n = matrix.length;
  const FULL = (1 << n) - 1; // bitmask with all N bits set

  // dp[mask][j] = min cost to reach j with visited set = mask
  const dp = Array.from({ length: 1 << n }, () => Array(n).fill(Infinity));
  const parent = Array.from({ length: 1 << n }, () => Array(n).fill(-1));

  // Base case: start at startIdx with only that bit set
  dp[1 << startIdx][startIdx] = 0;

  for (let mask = 0; mask <= FULL; mask++) {
    if ((mask & (1 << startIdx)) === 0) continue; // start must always be visited

    for (let j = 0; j < n; j++) {
      const cur = dp[mask][j];
      if (!Number.isFinite(cur)) continue;
      if ((mask & (1 << j)) === 0) continue; // j must be in current visited set

      // Try extending the path from j to an unvisited node k
      for (let k = 0; k < n; k++) {
        if (mask & (1 << k)) continue; // already visited
        const w = matrix[j]?.[k];
        if (!Number.isFinite(w)) continue;

        const nm = mask | (1 << k);
        const cand = cur + w;
        if (cand < dp[nm][k]) {
          dp[nm][k] = cand;
          parent[nm][k] = j; // remember predecessor for path reconstruction
        }
      }
    }
  }

  // Find the cheapest endpoint when all nodes are visited
  let bestEnd = -1;
  let bestCost = Infinity;
  for (let j = 0; j < n; j++) {
    if (dp[FULL][j] < bestCost) {
      bestCost = dp[FULL][j];
      bestEnd = j;
    }
  }
  if (!Number.isFinite(bestCost) || bestEnd < 0) {
    return { order: null, cost: Infinity };
  }

  // Reconstruct the path by following parent pointers backwards
  const order = [];
  let mask = FULL;
  let cur = bestEnd;
  while (cur !== -1) {
    order.push(cur);
    const prev = parent[mask][cur];
    mask = mask & ~(1 << cur);
    cur = prev;
  }
  order.reverse();

  if (order[0] !== startIdx) {
    return { order: null, cost: Infinity };
  }

  return { order, cost: bestCost };
}

/** Sum of edge weights along a given visit order. */
function pathCost(order, matrix) {
  let sum = 0;
  for (let i = 0; i < order.length - 1; i++) {
    const a = order[i];
    const b = order[i + 1];
    const w = matrix[a]?.[b];
    if (!Number.isFinite(w)) return Infinity;
    sum += w;
  }
  return sum;
}

/** Greedy nearest-neighbour heuristic starting from orderStartIdx. */
function nearestNeighbor(orderStartIdx, matrix) {
  const n = matrix.length;
  const used = Array(n).fill(false);
  const order = [orderStartIdx];
  used[orderStartIdx] = true;

  while (order.length < n) {
    const cur = order[order.length - 1];
    let best = -1;
    let bestW = Infinity;

    for (let j = 0; j < n; j++) {
      if (used[j]) continue;
      const w = matrix[cur]?.[j];
      if (Number.isFinite(w) && w < bestW) {
        bestW = w;
        best = j;
      }
    }

    if (best === -1) {
      // no finite edges; append remaining in original index order
      for (let j = 0; j < n; j++) {
        if (!used[j]) {
          used[j] = true;
          order.push(j);
        }
      }
      break;
    }

    used[best] = true;
    order.push(best);
  }
  return order;
}

/**
 * 2-opt local search improvement for a path (not cycle).
 * Keeps the first node fixed, then repeatedly reverses sub-segments
 * to reduce total cost.  Runs up to `maxPasses` full sweeps.
 */
function twoOptPath(order, matrix, maxPasses = 4) {
  const n = order.length;
  if (n <= 3) return order;

  let best = order.slice();
  let bestCost = pathCost(best, matrix);
  if (!Number.isFinite(bestCost)) return best;

  for (let pass = 0; pass < maxPasses; pass++) {
    let improved = false;

    for (let i = 1; i < n - 2; i++) {
      for (let k = i + 1; k < n - 1; k++) {
        const cand = best.slice();
        // reverse segment [i..k]
        const seg = cand.slice(i, k + 1).reverse();
        cand.splice(i, k - i + 1, ...seg);

        const cCost = pathCost(cand, matrix);
        if (cCost + 1e-9 < bestCost) {
          best = cand;
          bestCost = cCost;
          improved = true;
        }
      }
    }

    if (!improved) break;
  }

  return best;
}

function normalizePoints(src) {
  return (Array.isArray(src) ? src : [])
    .map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
}

export async function optimizeQuickRoute(payload = {}) {
  const mode = normMode(payload.mode);
  const stops = normStops(payload.stops);

  const warnings = [];

  const points = stops.map((s) => ({ lat: Number(s.lat), lng: Number(s.lng) }));
  const haveAll =
    points.length >= 1 &&
    points.every((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));

  if (stops.length < 2) {
    return {
      ok: true,
      mode,
      matrixProvider: null,
      routeProvider: null,
      warnings,
      order: stops.map((_, i) => i),
      stops,
      minutes: [],
      totalMinutes: 0,
      geometries: [],
      segmentsByLeg: [],
      transitStops: [],
    };
  }

  if (!haveAll) {
    warnings.push('Some destinations are missing coordinates. Pick a suggestion for each row.');
    return {
      ok: true,
      mode,
      matrixProvider: null,
      routeProvider: null,
      warnings,
      order: stops.map((_, i) => i),
      stops,
      minutes: [],
      totalMinutes: 0,
      geometries: [],
      segmentsByLeg: [],
      transitStops: [],
    };
  }

  let startIndex = Number(payload.startIndex);
  if (!Number.isFinite(startIndex)) startIndex = 0;
  startIndex = Math.max(0, Math.min(stops.length - 1, startIndex));

  const dateIso =
    typeof payload.dateIso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(payload.dateIso)
      ? payload.dateIso
      : null;
  const startTimeMin = Number.isFinite(Number(payload.startTimeMin))
    ? Number(payload.startTimeMin)
    : 9 * 60;

  // --- Build matrix (for ordering only, not final routing geometry) ---
  let matrixProvider = 'haversine';
  let M = null;

  if (mode === 'driving' || mode === 'walking' || mode === 'cycling') {
    const o = await buildOrsMatrix(points, mode);
    if (o && o.matrix) {
      matrixProvider = o.provider;
      M = o.matrix;
    }
  } else if (mode === 'transit') {
    // Only do pairwise transit matrix for small N (else it’s too many calls)
    if (points.length <= 7) {
      const t = await buildTransitMatrix(points, { dateIso, startTimeMin, collectStops: false });
      matrixProvider = t.provider;
      M = t.matrix;
    }
  }

  if (!M) {
    matrixProvider = 'haversine';
    M = buildHaversineMatrix(points, mode === 'transit' ? 'driving' : mode);
  }

  // --- Optimize order: exact (Held–Karp) for small N, else NN + 2‑opt ---
  let order = null;

  if (stops.length <= 12) {
    const hk = heldKarpPath(M, startIndex);
    if (hk.order && hk.order.length === stops.length && Number.isFinite(hk.cost)) {
      order = hk.order;
    }
  }

  if (!order) {
    order = nearestNeighbor(startIndex, M);
    order = twoOptPath(order, M, 4);
  }

  // --- Compute actual route geometry + minutes along chosen order ---
  // This uses real routing providers (not the ordering matrix) for fidelity.
  const orderedStops = order.map((i) => stops[i]);
  const orderedPoints = orderedStops.map((s) => ({ lat: s.lat, lng: s.lng }));

  const r = await routeLegs(orderedPoints, mode, {
    dateIso,
    startTimeMin,
    collectStops: mode === 'transit',
  });

  const minutesRaw = Array.isArray(r.minutes) ? r.minutes : [];
  const minutes = [];
  for (let i = 0; i < orderedStops.length - 1; i++) {
    const m = Number(minutesRaw[i]);
    minutes.push(Number.isFinite(m) ? m : 0);
  }
  const totalMinutes = minutes.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);

  // Geometries (per leg) fallback to straight line if provider lacks geometry.
  const geomsRaw = Array.isArray(r.geometries) ? r.geometries : [];
  const geometries = [];
  for (let i = 0; i < orderedStops.length - 1; i++) {
    const g = normalizePoints(geomsRaw[i]);
    if (g.length) {
      geometries.push(g);
    } else {
      geometries.push([
        { lat: orderedStops[i].lat, lng: orderedStops[i].lng },
        { lat: orderedStops[i + 1].lat, lng: orderedStops[i + 1].lng },
      ]);
    }
  }

  // Segments by leg (for dotted walk vs solid transit/driving)
  let segmentsByLeg = [];
  if (Array.isArray(r.segmentsByLeg) && r.segmentsByLeg.length) {
    segmentsByLeg = r.segmentsByLeg.map((legSegs, idx) => {
      const list = Array.isArray(legSegs) ? legSegs : [];
      const cleaned = list
        .map((seg) => {
          const pts = normalizePoints(seg?.points || seg?.coords);
          if (!pts.length) return null;
          const sm = String(seg?.subMode || seg?.mode || seg?.type || mode).toLowerCase();
          return { points: pts, subMode: sm };
        })
        .filter(Boolean);
      // If empty for a leg, fallback to that leg geometry
      if (!cleaned.length && geometries[idx]) {
        cleaned.push({ points: geometries[idx], subMode: mode });
      }
      return cleaned;
    });
  } else {
    segmentsByLeg = geometries.map((g) => [{ points: g, subMode: mode }]);
  }

  const hasTransitLeg = segmentsByLeg.some((leg) =>
    leg.some((seg) => String(seg?.subMode || '').toLowerCase() === 'transit')
  );
  let effectiveMode = mode;
  if (mode === 'transit' && r.provider === 'google' && !hasTransitLeg) {
    effectiveMode = 'walking';
    warnings.push('Transit service unavailable for this trip; showing walking route.');
  }

  const transitStops = Array.isArray(r.transitStops)
    ? r.transitStops
        .map((s) => ({
          lat: Number(s.lat),
          lng: Number(s.lng),
          name: s.name || null,
        }))
        .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng))
    : [];

  return {
    ok: true,
    mode: effectiveMode,
    dateIso,
    startTimeMin,
    matrixProvider,
    routeProvider: r.provider || null,
    warnings,
    order,
    stops: orderedStops,
    minutes,
    totalMinutes,
    geometries,
    segmentsByLeg,
    transitStops,
  };
}
