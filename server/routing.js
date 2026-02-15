/**
 * server/routing.js — Transport routing integrations.
 *
 * Provides travel-time matrices and leg-by-leg routing via:
 *   - OpenRouteService (ORS) for driving/walking/cycling
 *   - Google Directions API for public transit
 *   - Haversine great-circle distance as a universal fallback
 *
 * Exported: orsMatrix, orsLegs, gmapsTransitLegs, routeLegs,
 *           haversineMinutes, constantGap
 */
const ORS =
  process.env.ORS_API_KEY || '';
const GMAPS =
  process.env.GOOGLE_MAPS_KEY || process.env.GOOGLE_DIRECTIONS_API_KEY || '';

/** Map user-facing mode names to ORS profile identifiers. */
function orsProfile(mode) {
  switch (mode) {
    case 'walking':
      return 'foot-walking';
    case 'cycling':
      return 'cycling-regular';
    case 'driving':
    default:
      return 'driving-car';
  }
}

function minsFromSecs(s) {
  return Math.round((s || 0) / 60);
}

/**
 * Decode a Google Encoded Polyline string into an array of {lat, lng} points.
 *
 * The encoding stores lat/lng deltas as variable-length base-64 integers
 * (each chunk is 5 bits, with bit 5 as a continuation flag).  Coordinates
 * are stored as fixed-point integers scaled by 1e5.
 *
 * Reference: https://developers.google.com/maps/documentation/utilities/polylinealgorithm
 */
function decodePolyline(str) {
  if (!str || typeof str !== 'string') return [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  const coords = [];

  while (index < str.length) {
    // Decode one variable-length integer (latitude delta)
    let result = 0;
    let shift = 0;
    let b;
    do {
      b = str.charCodeAt(index++) - 63;  // ASCII offset
      result |= (b & 0x1f) << shift;     // accumulate 5 low bits
      shift += 5;
    } while (b >= 0x20);                  // bit 5 = "more chunks follow"
    // Undo one's complement for negative values
    const deltaLat = (result & 1) ? ~(result >> 1) : (result >> 1);
    lat += deltaLat;

    // Decode longitude delta (same algorithm)
    result = 0;
    shift = 0;
    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const deltaLng = (result & 1) ? ~(result >> 1) : (result >> 1);
    lng += deltaLng;

    coords.push({
      lat: lat / 1e5,
      lng: lng / 1e5,
    });
  }

  return coords;
}

/** Fetch an N×N pairwise travel-duration matrix from OpenRouteService. */
export async function orsMatrix(points, mode = 'driving') {
  if (!ORS || points.length < 2) return { ok: false };
  try {
    const body = {
      locations: points.map((p) => [p.lng, p.lat]),
      metrics: ['duration'],
      resolve_locations: false,
    };
    const r = await fetch(
      `https://api.openrouteservice.org/v2/matrix/${orsProfile(mode)}`,
      {
        method: 'POST',
        headers: {
          Authorization: ORS,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }
    );
    if (!r.ok) return { ok: false };
    const j = await r.json();
    return {
      ok: true,
      minutes: (j.durations || []).map((row) => row.map(minsFromSecs)),
    };
  } catch {
    return { ok: false };
  }
}

/** Compute sequential leg durations (A→B→C) with route geometry via ORS. */
export async function orsLegs(points, mode = 'driving') {
  if (!ORS || points.length < 2) return { ok: false };
  try {
    const out = [];
    const geoms = [];
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i],
        b = points[i + 1];
      const body = { coordinates: [[a.lng, a.lat], [b.lng, b.lat]] };
      const r = await fetch(
        `https://api.openrouteservice.org/v2/directions/${orsProfile(
          mode
        )}/geojson`,
        {
          method: 'POST',
          headers: {
            Authorization: ORS,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        }
      );
      if (!r.ok) return { ok: false };
      const j = await r.json();
      const feat = j.features?.[0];
      const secs = feat?.properties?.summary?.duration || 0;
      out.push(minsFromSecs(secs));

      // ORS coordinates are [lng, lat]
      const coords = Array.isArray(feat?.geometry?.coordinates)
        ? feat.geometry.coordinates.map((pair) => {
            const lng = Number(pair[0]);
            const lat = Number(pair[1]);
            return { lat, lng };
          })
        : [];
      geoms.push(coords);
    }
    return { ok: true, minutes: out, geometries: geoms };
  } catch {
    return { ok: false };
  }
}

/**
 * Google Directions transit legs, with:
 * - minutes per leg
 * - overall geometry per leg
 * - per‑step segments with subMode ('walking'/'transit'/...)
 * - detailed metadata for timeline (line name, headsign, times, stations)
 */
export async function gmapsTransitLegs(points, opts = {}) {
  // Transit is sequential; Google has no free matrix for transit.
  // opts: { departEpochSeconds?: number, collectStops?: boolean }
  if (!GMAPS || points.length < 2) return { ok: false };

  const base = 'https://maps.googleapis.com/maps/api/directions/json';
  const key = `&key=${GMAPS}`;
  const departEpochSeconds = opts.departEpochSeconds ?? null;
  const collectStops = !!opts.collectStops;

  const legs = [];
  const geoms = [];
  const allStops = [];
  const seenStops = new Set();
  const legSegments = []; // per leg: [{ points:[{lat,lng}...], subMode }]
  const legDetails = [];  // per leg: { steps: [...] }

  function pushStop(stop) {
    if (!stop || !stop.location) return;
    const lat = Number(stop.location.lat);
    const lng = Number(stop.location.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    const name = String(stop.name || '').trim();
    const key = `${lat.toFixed(6)},${lng.toFixed(6)}`;
    if (seenStops.has(key)) return;
    seenStops.add(key);
    allStops.push({ lat, lng, name });
  }

  try {
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      const origin = `origin=${a.lat},${a.lng}`;
      const dest = `destination=${b.lat},${b.lng}`;
      const mode = `mode=transit`;
      const depart = departEpochSeconds ? `&departure_time=${departEpochSeconds}` : '';
      const url = `${base}?${origin}&${dest}&${mode}${depart}${key}`;

      const r = await fetch(url);
      if (!r.ok) return { ok: false };
      const j = await r.json();
      const route = j.routes?.[0];
      const leg = route?.legs?.[0];

      const secs = leg?.duration?.value || 0;
      legs.push(minsFromSecs(secs));

      const combinedCoords = [];
      const stepSegments = [];
      const stepMeta = [];

      if (leg && Array.isArray(leg.steps)) {
        leg.steps.forEach((step) => {
          if (!step) return;
          const stepMode = step.travel_mode;
          const stepSecs = step.duration?.value || 0;
          const stepMinutes = minsFromSecs(stepSecs);
          const polyStr = step.polyline?.points || null;
          const coords = decodePolyline(polyStr);

          let kind = null;
          let subMode = null;
          if (stepMode === 'WALKING') {
            kind = 'walk';
            subMode = 'walking';
          } else if (stepMode === 'TRANSIT') {
            kind = 'transit';
            subMode = 'transit';
          } else if (stepMode === 'DRIVING') {
            kind = 'drive';
            subMode = 'driving';
          }

          if (coords.length) {
            combinedCoords.push(...coords);
            stepSegments.push({
              points: coords,
              subMode: subMode || 'transit',
            });
          }

          if (kind === 'walk' || kind === 'transit') {
            const meta = {
              kind,
              minutes: stepMinutes,
            };
            if (kind === 'transit' && step.transit_details) {
              const td = step.transit_details;
              const line = td.line || {};
              meta.lineName = line.short_name || line.name || 'Train';
              meta.headsign = td.headsign || null;
              meta.departureStationName = td.departure_stop?.name || null;
              meta.arrivalStationName = td.arrival_stop?.name || null;
              meta.departureTimeText = td.departure_time?.text || null;
            }
            stepMeta.push(meta);
          }

          if (collectStops && stepMode === 'TRANSIT' && step.transit_details) {
            const td = step.transit_details;
            if (td.departure_stop) pushStop(td.departure_stop);
            if (td.arrival_stop) pushStop(td.arrival_stop);
          }
        });
      }

      if (!combinedCoords.length) {
        const polyStr = route?.overview_polyline?.points || null;
        const coords = decodePolyline(polyStr);
        if (coords.length) {
          combinedCoords.push(...coords);
          // If we did not get per-step segments, treat whole leg as transit.
          if (!stepSegments.length) {
            stepSegments.push({
              points: coords,
              subMode: 'transit',
            });
          }
        }
      }

      geoms.push(combinedCoords);
      legSegments.push(stepSegments);
      legDetails.push({ steps: stepMeta });
    }

    return {
      ok: true,
      minutes: legs,
      geometries: geoms,
      provider: 'google',
      transitStops: allStops,
      legSegments,
      legDetails,
    };
  } catch {
    return { ok: false };
  }
}

// ---------- Fallback distance estimators ----------

/**
 * Estimate travel time (minutes) between two points using the Haversine
 * great-circle formula.  Applies a rough speed factor per transport mode:
 *   walking ~5 km/h (12 min/km), cycling ~15 km/h (4 min/km),
 *   driving ~24 km/h (2.5 min/km — accounts for urban speeds).
 */
export function haversineMinutes(a, b, mode = 'driving') {
  const R = 6371;                                    // Earth radius in km
  const toR = (d) => (d * Math.PI) / 180;           // degrees → radians
  const dLat = toR((b.lat || 0) - (a.lat || 0));
  const dLng = toR((b.lng || 0) - (a.lng || 0));
  const sa = Math.sin(dLat / 2) ** 2;
  const sb =
    Math.cos(toR(a.lat || 0)) *
    Math.cos(toR(b.lat || 0)) *
    Math.sin(dLng / 2) ** 2;
  const km = 2 * R * Math.asin(Math.sqrt(sa + sb)); // great-circle distance
  const perKm =
    mode === 'walking' ? 12 : mode === 'cycling' ? 4 : 2.5;
  return Math.round(km * perKm);
}

/** Fixed travel gap (minutes) when no coordinates are available at all. */
export function constantGap(mode) {
  return mode === 'walking' ? 12 : mode === 'cycling' ? 8 : 6;
}

/**
 * Compute minutes per leg for ordered points with chosen mode.
 * mode: 'driving'|'walking'|'cycling'|'transit'
 * opts: {
 *   dateIso?: 'YYYY-MM-DD',
 *   startTimeMin?: number,
 *   collectStops?: boolean    // for transit station markers
 * }
 */
export async function routeLegs(points, mode = 'driving', opts = {}) {
  const pts = points.filter(
    (p) => Number.isFinite(p.lat) && Number.isFinite(p.lng)
  );
  const haveAll = pts.length === points.length && points.length >= 2;

  const dateIso = opts.dateIso;
  const startTimeMin = opts.startTimeMin;
  const collectStops = !!opts.collectStops;

  // Provider cascade: Google Directions (transit only) → ORS → Haversine fallback.
  if (mode === 'transit' && haveAll && GMAPS) {
    // Build a same-day departure timestamp if given
    let depart = null;
    if (dateIso && Number.isFinite(startTimeMin)) {
      const d = new Date(dateIso + 'T00:00:00Z').getTime() / 1000;
      depart = Math.round(d + startTimeMin * 60);
    }
    const g = await gmapsTransitLegs(points, {
      departEpochSeconds: depart,
      collectStops,
    });
    if (g.ok) {
      return {
        minutes: g.minutes,
        provider: 'google',
        geometries: g.geometries || [],      // per-leg overall polyline
        transitStops: g.transitStops || [],   // for map station dots
        segmentsByLeg: g.legSegments || [],   // for dotted vs solid map segments
        transitLegs: g.legDetails || [],      // for the text sub-list
      };
    }
  }

  if (haveAll && ORS) {
    const o = await orsLegs(
      points,
      mode === 'walking' || mode === 'cycling' ? mode : 'driving'
    );
    if (o.ok) {
      return {
        minutes: o.minutes,
        provider: 'ors',
        geometries: o.geometries || [],
        transitStops: [],
        segmentsByLeg: [],
        transitLegs: [],
      };
    }
  }

  // Fallback: haversine or constant
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    out.push(haversineMinutes(a, b, mode) || constantGap(mode));
  }
  return {
    minutes: out,
    provider: 'fallback',
    geometries: [],
    transitStops: [],
    segmentsByLeg: [],
    transitLegs: [],
  };
}
