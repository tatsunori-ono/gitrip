/**
 * algorithm.js — Multi-algorithm route optimisation visualisation.
 *
 * Three tabs: Nearest Neighbour, NN + 2-opt, Held-Karp DP.
 * Each runs an animated, step-by-step demonstration on London landmarks
 * with synchronised pseudocode highlighting.
 */
(() => {
  'use strict';

  /* ================================================================
   * 1. DATA
   * ================================================================ */

  var LANDMARKS = [
    { name: 'British Museum',    lat: 51.5194, lng: -0.1270, abbr: 'BM' },
    { name: 'Tower Bridge',      lat: 51.5055, lng: -0.0754, abbr: 'TB' },
    { name: 'Covent Garden',     lat: 51.5117, lng: -0.1240, abbr: 'CG' },
    { name: 'Big Ben',           lat: 51.5007, lng: -0.1246, abbr: 'BB' },
    { name: 'Buckingham Palace', lat: 51.5014, lng: -0.1419, abbr: 'BP' },
    { name: 'Camden Market',     lat: 51.5393, lng: -0.1427, abbr: 'CM' },
    { name: 'St Paul\'s',        lat: 51.5138, lng: -0.0984, abbr: 'SP' },
    { name: 'Hyde Park',         lat: 51.5073, lng: -0.1657, abbr: 'HP' },
    { name: 'Trafalgar Square',  lat: 51.5080, lng: -0.1281, abbr: 'TS' },
    { name: 'London Eye',        lat: 51.5033, lng: -0.1196, abbr: 'LE' },
    { name: 'Kings Cross',       lat: 51.5309, lng: -0.1233, abbr: 'KC' },
    { name: 'Greenwich Park',    lat: 51.4769, lng: -0.0005, abbr: 'GP' },
  ];

  function haversineMin(a, b) {
    var R = 6371;
    var dLat = (b.lat - a.lat) * Math.PI / 180;
    var dLng = (b.lng - a.lng) * Math.PI / 180;
    var sLat = Math.sin(dLat / 2);
    var sLng = Math.sin(dLng / 2);
    var h = sLat * sLat +
            Math.cos(a.lat * Math.PI / 180) *
            Math.cos(b.lat * Math.PI / 180) *
            sLng * sLng;
    return 2 * R * Math.asin(Math.sqrt(h)) / 5 * 60;
  }

  function haversineKm(a, b) {
    var R = 6371;
    var dLat = (b.lat - a.lat) * Math.PI / 180;
    var dLng = (b.lng - a.lng) * Math.PI / 180;
    var sLat = Math.sin(dLat / 2);
    var sLng = Math.sin(dLng / 2);
    var h = sLat * sLat +
            Math.cos(a.lat * Math.PI / 180) *
            Math.cos(b.lat * Math.PI / 180) *
            sLng * sLng;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function haversineMetres(a, b) {
    return haversineKm(a, b) * 1000;
  }

  function buildMatrix(pts) {
    var n = pts.length;
    var M = [];
    for (var i = 0; i < n; i++) {
      M[i] = [];
      for (var j = 0; j < n; j++) {
        M[i][j] = i === j ? 0 : haversineMin(pts[i], pts[j]);
      }
    }
    return M;
  }

  function pathCost(order, matrix) {
    var sum = 0;
    for (var i = 0; i < order.length - 1; i++) sum += matrix[order[i]][order[i + 1]];
    return sum;
  }

  function computeRouteCost(order) {
    if (!state.matrix) return 0;
    var total = 0;
    for (var i = 0; i < order.length - 1; i++) {
      total += state.matrix[order[i]][order[i + 1]];
    }
    return total;
  }

  var matrixUnit = 'min';
  var matrixProvider = 'haversine';

  function formatCost(val) {
    return Math.round(val) + ' ' + matrixUnit;
  }

  /* ================================================================
   * 2. PSEUDOCODE ARRAYS
   * ================================================================ */

  var PSEUDO_NN = [
    'function nearestNeighbour(start, travelTime):',
    '  visited = {start}',
    '  route   = [start]',
    '  current = start',
    '  while visited.size < N:',
    '    bestTime = \u221e',
    '    bestNode = null',
    '    for each node in unvisited:',
    '      time = travelTime[current][node]',
    '      if time < bestTime:',
    '        bestTime = time',
    '        bestNode = node',
    '    visited.add(bestNode)',
    '    route.append(bestNode)',
    '    current = bestNode',
    '  return route',
  ];

  var PSEUDO_2OPT = [
    'route = nearestNeighbour(start, travelTime)',
    'improved = true',
    'while improved:',
    '  improved = false',
    '  for i = 1 to N-2:',
    '    for k = i+1 to N-1:',
    '      new = reverse(route, i, k)',
    '      if cost(new) < cost(route):',
    '        route = new',
    '        improved = true',
    'return route',
  ];

  var PSEUDO_HK = [
    'function heldKarp(start, travelTime):',
    '  dp[{start}][start] = 0',
    '  for each subset S containing start:',
    '    for j in S:',
    '      for k not in S:',
    '        c = dp[S][j] + travelTime[j][k]',
    '        if c < dp[S\u222a{k}][k]:',
    '          dp[S\u222a{k}][k] = c',
    '          parent[S\u222a{k}][k] = j',
    '  end = argmin(dp[ALL][j])',
    '  return reconstruct(end, parent)',
  ];

  /* ================================================================
   * 3. ALGORITHM HELPERS (silent solvers)
   * ================================================================ */

  function nearestNeighborOrder(startIdx, matrix) {
    var n = matrix.length;
    var used = [];
    for (var x = 0; x < n; x++) used.push(false);
    var order = [startIdx];
    used[startIdx] = true;
    while (order.length < n) {
      var cur = order[order.length - 1];
      var best = -1, bestW = Infinity;
      for (var j = 0; j < n; j++) {
        if (used[j]) continue;
        if (matrix[cur][j] < bestW) { bestW = matrix[cur][j]; best = j; }
      }
      if (best === -1) break;
      used[best] = true;
      order.push(best);
    }
    return order;
  }

  function solveHeldKarp(startIdx, matrix) {
    var n = matrix.length;
    var FULL = (1 << n) - 1;
    var dp = [], par = [];
    for (var m = 0; m < (1 << n); m++) {
      dp[m] = []; par[m] = [];
      for (var j = 0; j < n; j++) { dp[m][j] = Infinity; par[m][j] = -1; }
    }
    dp[1 << startIdx][startIdx] = 0;
    for (var mask = 0; mask <= FULL; mask++) {
      if (!(mask & (1 << startIdx))) continue;
      for (var j = 0; j < n; j++) {
        if (dp[mask][j] === Infinity || !(mask & (1 << j))) continue;
        for (var k = 0; k < n; k++) {
          if (mask & (1 << k)) continue;
          var nm = mask | (1 << k);
          var c = dp[mask][j] + matrix[j][k];
          if (c < dp[nm][k]) { dp[nm][k] = c; par[nm][k] = j; }
        }
      }
    }
    var bestEnd = -1, bestCost = Infinity;
    for (var j = 0; j < n; j++) {
      if (dp[FULL][j] < bestCost) { bestCost = dp[FULL][j]; bestEnd = j; }
    }
    var order = [], mask = FULL, cur = bestEnd;
    while (cur !== -1) { order.push(cur); var prev = par[mask][cur]; mask &= ~(1 << cur); cur = prev; }
    order.reverse();
    return { order: order, cost: bestCost };
  }

  /* ================================================================
   * 4. STEP GENERATORS
   * ================================================================ */

  /* --- Nearest Neighbour --- */
  function generateNNSteps(startIdx, matrix) {
    var steps = [];
    var n = matrix.length;
    var used = [];
    for (var x = 0; x < n; x++) used.push(false);
    var order = [startIdx];
    used[startIdx] = true;

    steps.push({ type: 'init', pseudoLine: -1 });
    steps.push({ type: 'select_start', nodeIndex: startIdx, pseudoLine: 1 });

    while (order.length < n) {
      var cur = order[order.length - 1];
      var best = -1, bestW = Infinity;
      steps.push({ type: 'begin_search', current: cur, pseudoLine: 4 });
      for (var j = 0; j < n; j++) {
        if (used[j]) continue;
        var w = matrix[cur][j];
        steps.push({ type: 'scan_node', current: cur, candidate: j, distance: w, pseudoLine: 8 });
        if (w < bestW) {
          bestW = w; best = j;
          steps.push({ type: 'found_better', current: cur, candidate: j, distance: w, pseudoLine: 10 });
        }
      }
      steps.push({ type: 'choose_best', from: cur, to: best, distance: bestW, pseudoLine: 12 });
      used[best] = true;
      order.push(best);
      steps.push({ type: 'mark_visited', nodeIndex: best, order: order.slice(), pseudoLine: 14 });
    }
    steps.push({ type: 'complete', order: order.slice(), totalDist: pathCost(order, matrix), pseudoLine: 15 });
    return steps;
  }

  /* --- NN + 2-opt --- */
  function generateTwoOptSteps(startIdx, matrix) {
    var steps = [];
    var n = matrix.length;
    var nnOrder = nearestNeighborOrder(startIdx, matrix);

    steps.push({ type: 'twoopt_show_nn', order: nnOrder.slice(), pseudoLine: 0 });
    steps.push({ type: 'twoopt_begin', pseudoLine: 1 });

    var best = nnOrder.slice();
    var bestCost = pathCost(best, matrix);
    var anyImproved = false;

    for (var pass = 0; pass < 4; pass++) {
      var improved = false;
      for (var i = 1; i < n - 2; i++) {
        for (var k = i + 1; k < n - 1; k++) {
          var cand = best.slice();
          var left = i, right = k;
          while (left < right) {
            var tmp = cand[left]; cand[left] = cand[right]; cand[right] = tmp;
            left++; right--;
          }
          var cCost = pathCost(cand, matrix);

          steps.push({ type: 'twoopt_consider', i: i, k: k, order: best.slice(), pseudoLine: 6 });

          if (cCost + 1e-9 < bestCost) {
            steps.push({
              type: 'twoopt_improve', i: i, k: k,
              oldOrder: best.slice(), newOrder: cand.slice(),
              pseudoLine: 8,
            });
            best = cand;
            bestCost = cCost;
            improved = true;
            anyImproved = true;
          }
        }
      }
      if (!improved) break;
    }

    if (!anyImproved) {
      steps.push({ type: 'twoopt_no_change', pseudoLine: 2 });
    }

    steps.push({
      type: 'twoopt_complete', order: best.slice(), totalDist: bestCost,
      nnOrder: nnOrder.slice(), pseudoLine: 10,
    });
    return steps;
  }

  /* --- Held-Karp DP --- */
  function generateHKSteps(startIdx, matrix) {
    var steps = [];
    var n = matrix.length;
    var hk = solveHeldKarp(startIdx, matrix);
    var nnOrder = nearestNeighborOrder(startIdx, matrix);

    steps.push({ type: 'hk_init', pseudoLine: -1 });
    steps.push({ type: 'hk_start', nodeIndex: startIdx, pseudoLine: 1 });

    // Show edges from start being evaluated
    for (var j = 0; j < n; j++) {
      if (j === startIdx) continue;
      steps.push({ type: 'hk_explore_edge', from: startIdx, to: j, pseudoLine: 5 });
    }

    // DP computing phase
    steps.push({ type: 'hk_computing', pseudoLine: 3 });

    // Find best endpoint
    steps.push({ type: 'hk_find_best', bestEnd: hk.order[hk.order.length - 1], pseudoLine: 9 });

    // Reconstruct path
    var order = hk.order;
    for (var i = 0; i < order.length; i++) {
      steps.push({ type: 'hk_mark_node', nodeIndex: order[i], pseudoLine: 10 });
      if (i > 0) {
        steps.push({ type: 'hk_reconstruct_edge', from: order[i - 1], to: order[i], pseudoLine: 10 });
      }
    }

    steps.push({
      type: 'hk_complete', order: order.slice(), totalDist: hk.cost,
      nnOrder: nnOrder.slice(), pseudoLine: 10,
    });
    return steps;
  }

  /* ================================================================
   * 5. ALGORITHM REGISTRY
   * ================================================================ */

  var ALGOS = {
    nn: {
      pseudo: PSEUDO_NN, generate: generateNNSteps,
      desc: 'A greedy heuristic that always moves to the closest unvisited stop. Fast at O(N\u00b2) but can produce routes up to 25% longer than optimal. Travel times are computed from real routing APIs based on the selected transport mode.',
    },
    nn2opt: {
      pseudo: PSEUDO_2OPT, generate: generateTwoOptSteps,
      desc: 'Starts with a Nearest Neighbour route, then iteratively reverses sub-segments to shorten the total distance. GiTrip uses this for trips with more than 12 stops (shown here on 12 for demonstration). Travel times come from real routing APIs.',
    },
    hk: {
      pseudo: PSEUDO_HK, generate: generateHKSteps,
      desc: 'An exact dynamic-programming algorithm that evaluates every possible route via bitmask subsets. Guarantees the shortest path but is O(2\u207f\u00b7n\u00b2) \u2014 at 12 stops that\u2019s 4,096 subsets, which is still fast; at 13 it doubles to 8,192 and grows rapidly, so GiTrip caps it at 12.',
    },
  };
  var currentAlgo = 'nn';

  /* ================================================================
   * 6. LEAFLET MAP SETUP
   * ================================================================ */

  var mapEl = document.getElementById('algoMap');
  if (!mapEl) return;

  var map = L.map('algoMap', {
    zoomControl: false,
    attributionControl: true,
    dragging: true,
    scrollWheelZoom: true,
  });

  L.control.zoom({ position: 'bottomleft' }).addTo(map);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 18,
  }).addTo(map);

  var bounds = L.latLngBounds(LANDMARKS.map(function (l) { return [l.lat, l.lng]; }));
  map.fitBounds(bounds, { padding: [50, 50] });

  setTimeout(function () {
    map.invalidateSize();
    map.fitBounds(bounds, { padding: [50, 50] });
  }, 200);

  /* ================================================================
   * 7. MAP LAYER MANAGEMENT
   * ================================================================ */

  var markerLayer = L.layerGroup().addTo(map);
  var edgeLayer   = L.layerGroup().addTo(map);
  var ringLayer   = L.layerGroup().addTo(map);
  var scanLayer   = L.layerGroup().addTo(map);
  var markers = [];

  function createMarkerIcon(abbr, cls) {
    return L.divIcon({
      className: '',
      html: '<div class="algo-marker ' + cls + '">' + abbr + '</div>',
      iconSize: [28, 28], iconAnchor: [14, 14],
    });
  }

  function placeMarkers() {
    markerLayer.clearLayers();
    markers = [];
    for (var i = 0; i < LANDMARKS.length; i++) {
      var lm = LANDMARKS[i];
      var m = L.marker([lm.lat, lm.lng], {
        icon: createMarkerIcon(lm.abbr, 'algo-marker--unvisited'),
        interactive: false, zIndexOffset: 500,
      }).addTo(markerLayer);
      m.bindTooltip(lm.name, { permanent: false, direction: 'top', offset: [0, -14] });
      markers.push(m);
    }
  }

  function updateMarkerState(idx, cls) {
    var lm = LANDMARKS[idx];
    markers[idx].setIcon(createMarkerIcon(lm.abbr, 'algo-marker--' + cls));
    markers[idx].setZIndexOffset(cls === 'current' ? 1000 : 500);
  }

  /* --- Geometry cache for real route polylines --- */
  var geoCache = {};    // key -> { coords: [[lat,lng],...], segments: [{points, subMode},...] | null }

  function geoCacheKey(fromIdx, toIdx) {
    return fromIdx + '-' + toIdx;
  }

  function getGeoCached(fromIdx, toIdx) {
    return geoCache[geoCacheKey(fromIdx, toIdx)] || null;
  }

  function getGeoCoords(fromIdx, toIdx) {
    var cached = getGeoCached(fromIdx, toIdx);
    if (cached && cached.coords && cached.coords.length > 1) return cached.coords;
    var a = LANDMARKS[fromIdx], b = LANDMARKS[toIdx];
    return [[a.lat, a.lng], [b.lat, b.lng]];
  }

  function addEdge(fromIdx, toIdx) {
    var cached = getGeoCached(fromIdx, toIdx);
    var coords = getGeoCoords(fromIdx, toIdx);

    // Transit mode: draw walking segments dotted, transit segments solid
    if (cached && cached.segments && cached.segments.length) {
      for (var s = 0; s < cached.segments.length; s++) {
        var seg = cached.segments[s];
        if (!seg.points || seg.points.length < 2) continue;
        var isWalk = seg.subMode === 'walking';
        L.polyline(seg.points, {
          color: isWalk ? '#8a9b97' : '#ec5643',
          weight: isWalk ? 3 : 4,
          opacity: isWalk ? 0.8 : 0.9,
          dashArray: isWalk ? '6 6' : null,
          lineCap: 'round',
        }).addTo(edgeLayer);
      }
    } else {
      L.polyline(coords, {
        color: '#ec5643', weight: 4, opacity: 0.9, lineCap: 'round',
      }).addTo(edgeLayer);
    }

    var mid = coords[Math.floor(coords.length / 2)];
    var cost = state.matrix ? state.matrix[fromIdx][toIdx] : haversineKm(LANDMARKS[fromIdx], LANDMARKS[toIdx]);
    var label = formatCost(cost);
    L.marker(mid, {
      icon: L.divIcon({
        className: 'algo-edge-label',
        html: '<span style="background:rgba(27,37,31,0.9);color:#ec5643;padding:2px 8px;border-radius:6px;font-size:11px;font-weight:600;white-space:nowrap">' + label + '</span>',
        iconSize: [0, 0], iconAnchor: [0, 0],
      }),
      interactive: false,
    }).addTo(edgeLayer);
  }

  function showSearchRing(fromIdx, toIdx, progress) {
    ringLayer.clearLayers();
    var a = LANDMARKS[fromIdx], b = LANDMARKS[toIdx];
    var r = progress * haversineMetres(a, b);
    if (r > 0) {
      L.circle([a.lat, a.lng], {
        radius: r, color: '#ec5643', weight: 3,
        opacity: Math.max(0.15, 0.9 - progress * 0.6),
        fillColor: '#ec5643', fillOpacity: Math.max(0, 0.12 - progress * 0.1),
        fill: true, dashArray: '6 4', interactive: false,
      }).addTo(ringLayer);
    }
  }

  function showScanLine(fromIdx, toIdx) {
    scanLayer.clearLayers();
    var a = LANDMARKS[fromIdx], b = LANDMARKS[toIdx];
    L.polyline([[a.lat, a.lng], [b.lat, b.lng]], {
      color: '#ec5643', weight: 1, opacity: 0.2, dashArray: '4 4', interactive: false,
    }).addTo(scanLayer);
  }

  function clearTransient() {
    ringLayer.clearLayers();
    scanLayer.clearLayers();
  }

  function drawFullRoute(order) {
    edgeLayer.clearLayers();
    for (var i = 0; i < order.length - 1; i++) addEdge(order[i], order[i + 1]);
  }

  function highlightSwapSegment(order, segI, segK) {
    scanLayer.clearLayers();
    var s = Math.max(0, segI - 1);
    var e = Math.min(order.length - 2, segK);
    for (var idx = s; idx <= e; idx++) {
      var coords = getGeoCoords(order[idx], order[idx + 1]);
      L.polyline(coords, {
        color: '#f97316', weight: 6, opacity: 0.7, interactive: false,
      }).addTo(scanLayer);
    }
    for (var idx = segI; idx <= segK; idx++) updateMarkerState(order[idx], 'candidate');
  }

  /* ================================================================
   * 8. ANIMATION STATE MACHINE
   * ================================================================ */

  var state = {
    steps: [], stepIndex: 0, subProgress: 0,
    playing: false, speed: 1,
    completedEdges: [], visitedSet: {}, currentNode: -1,
    currentOrder: [], matrix: null, startTime: 0,
    loading: true,
  };

  var DURATIONS = {
    init: 600, select_start: 900, begin_search: 300,
    scan_node: 500, found_better: 250, choose_best: 700,
    mark_visited: 350, complete: 1200,
    twoopt_show_nn: 1500, twoopt_begin: 800,
    twoopt_consider: 500, twoopt_improve: 1000,
    twoopt_no_change: 800, twoopt_complete: 1200,
    hk_init: 600, hk_start: 900,
    hk_explore_edge: 350, hk_computing: 1200,
    hk_find_best: 800, hk_mark_node: 400,
    hk_reconstruct_edge: 600, hk_complete: 1200,
  };

  var animFrame = null, lastTimestamp = 0;

  function tick(timestamp) {
    if (!state.playing) return;
    if (!lastTimestamp) { lastTimestamp = timestamp; state.startTime = timestamp; }
    var delta = (timestamp - lastTimestamp) * state.speed;
    lastTimestamp = timestamp;

    var step = state.steps[state.stepIndex];
    if (!step) { state.playing = false; updateControls(); return; }

    var dur = DURATIONS[step.type] || 400;
    state.subProgress += delta / dur;

    if (state.subProgress >= 1) {
      applyStep(step);
      state.stepIndex++;
      state.subProgress = 0;
      if (state.stepIndex >= state.steps.length) {
        state.playing = false;
        updateControls();
        return;
      }
    }

    renderStep();
    highlightPseudo(step.pseudoLine);
    showPhase(step);
    animFrame = requestAnimationFrame(tick);
  }

  /* ================================================================
   * 9. APPLY + RENDER STEPS
   * ================================================================ */

  function applyStep(step) {
    clearTransient();
    switch (step.type) {
      /* --- NN --- */
      case 'select_start':
        state.currentNode = step.nodeIndex;
        state.visitedSet[step.nodeIndex] = true;
        updateMarkerState(step.nodeIndex, 'current');
        break;
      case 'choose_best':
        state.completedEdges.push({ from: step.from, to: step.to });
        addEdge(step.from, step.to);
        break;
      case 'mark_visited':
        if (state.currentNode >= 0 && state.currentNode !== step.nodeIndex)
          updateMarkerState(state.currentNode, 'visited');
        state.currentNode = step.nodeIndex;
        state.visitedSet[step.nodeIndex] = true;
        updateMarkerState(step.nodeIndex, 'current');
        break;
      case 'complete':
        showStats(step);
        break;

      /* --- 2-opt --- */
      case 'twoopt_show_nn':
        drawFullRoute(step.order);
        state.currentOrder = step.order.slice();
        for (var i = 0; i < LANDMARKS.length; i++) {
          state.visitedSet[i] = true;
          updateMarkerState(i, 'visited');
        }
        updateMarkerState(step.order[0], 'current');
        break;
      case 'twoopt_improve':
        drawFullRoute(step.newOrder);
        state.currentOrder = step.newOrder.slice();
        for (var i = 0; i < LANDMARKS.length; i++) updateMarkerState(i, 'visited');
        updateMarkerState(step.newOrder[0], 'current');
        break;
      case 'twoopt_complete':
        showStats(step);
        break;

      /* --- HK --- */
      case 'hk_start':
        state.currentNode = step.nodeIndex;
        state.visitedSet[step.nodeIndex] = true;
        updateMarkerState(step.nodeIndex, 'current');
        break;
      case 'hk_mark_node':
        if (state.currentNode >= 0 && state.currentNode !== step.nodeIndex)
          updateMarkerState(state.currentNode, 'visited');
        state.currentNode = step.nodeIndex;
        state.visitedSet[step.nodeIndex] = true;
        updateMarkerState(step.nodeIndex, 'current');
        break;
      case 'hk_reconstruct_edge':
        addEdge(step.from, step.to);
        break;
      case 'hk_complete':
        showStats(step);
        break;
    }
  }

  function renderStep() {
    var step = state.steps[state.stepIndex];
    if (!step) return;

    switch (step.type) {
      case 'scan_node':
        showSearchRing(step.current, step.candidate, state.subProgress);
        showScanLine(step.current, step.candidate);
        if (!state.visitedSet[step.candidate]) updateMarkerState(step.candidate, 'candidate');
        break;
      case 'found_better':
        clearTransient();
        if (!state.visitedSet[step.candidate]) updateMarkerState(step.candidate, 'candidate');
        break;
      case 'twoopt_consider':
        highlightSwapSegment(step.order, step.i, step.k);
        break;
      case 'hk_explore_edge':
        showScanLine(step.from, step.to);
        if (!state.visitedSet[step.to]) updateMarkerState(step.to, 'candidate');
        break;
    }

    // Reset non-candidate unvisited markers
    if (step.type === 'scan_node' || step.type === 'found_better') {
      for (var i = 0; i < LANDMARKS.length; i++) {
        if (i === state.currentNode || state.visitedSet[i]) continue;
        if (step.candidate === i) continue;
        updateMarkerState(i, 'unvisited');
      }
    }
    if (step.type === 'hk_explore_edge') {
      for (var i = 0; i < LANDMARKS.length; i++) {
        if (i === state.currentNode || state.visitedSet[i]) continue;
        if (step.to === i) continue;
        updateMarkerState(i, 'unvisited');
      }
    }
  }

  /* ================================================================
   * 10. PSEUDOCODE HIGHLIGHTING
   * ================================================================ */

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function initPseudocode() {
    var codeEl = document.querySelector('#algoPseudocode code');
    if (!codeEl) return;
    var pseudo = ALGOS[currentAlgo].pseudo;
    var html = '';
    for (var i = 0; i < pseudo.length; i++) {
      html += '<span class="line" data-line="' + i + '">' + escapeHtml(pseudo[i] || ' ') + '</span>\n';
    }
    codeEl.innerHTML = html;
  }

  function highlightPseudo(lineIdx) {
    var lines = document.querySelectorAll('#algoPseudocode .line');
    for (var i = 0; i < lines.length; i++) {
      lines[i].classList.toggle('active', Number(lines[i].getAttribute('data-line')) === lineIdx);
    }
  }

  /* ================================================================
   * 11. PHASE INDICATOR + STATS
   * ================================================================ */

  function showPhase(step) {
    var el = document.getElementById('algoPhase');
    if (!el) return;
    var msg = '';

    switch (step.type) {
      /* NN */
      case 'init': msg = 'Placing destinations\u2026'; break;
      case 'select_start': msg = 'Selecting start node'; break;
      case 'begin_search': msg = 'Searching for nearest unvisited\u2026'; break;
      case 'scan_node':
        var edgeCost = state.matrix ? state.matrix[step.current][step.candidate] : 0;
        msg = 'Checking ' + LANDMARKS[step.candidate].name + ' (' + formatCost(edgeCost) + ')';
        break;
      case 'found_better': msg = 'Closer neighbour found!'; break;
      case 'choose_best': msg = LANDMARKS[step.from].name + ' \u2192 ' + LANDMARKS[step.to].name; break;
      case 'mark_visited': msg = 'Arrived \u2014 marking visited'; break;
      case 'complete': msg = 'Route complete!'; break;

      /* 2-opt */
      case 'twoopt_show_nn': msg = 'Initial route from Nearest Neighbour'; break;
      case 'twoopt_begin': msg = 'Starting 2-opt local search\u2026'; break;
      case 'twoopt_consider':
        msg = 'Try reversing positions ' + step.i + '\u2013' + step.k;
        break;
      case 'twoopt_improve':
        msg = 'Improved! ' + formatCost(computeRouteCost(step.oldOrder)) + ' \u2192 ' + formatCost(computeRouteCost(step.newOrder));
        break;
      case 'twoopt_no_change': msg = 'No improving swaps \u2014 locally optimal'; break;
      case 'twoopt_complete': msg = '2-opt refinement complete!'; break;

      /* HK */
      case 'hk_init': msg = 'Placing destinations\u2026'; break;
      case 'hk_start': msg = 'Initialising DP from start node'; break;
      case 'hk_explore_edge': msg = 'Evaluating edge to ' + LANDMARKS[step.to].name; break;
      case 'hk_computing': msg = 'Computing all subsets via DP\u2026'; break;
      case 'hk_find_best': msg = 'Finding optimal endpoint\u2026'; break;
      case 'hk_mark_node': msg = 'Optimal path visits ' + LANDMARKS[step.nodeIndex].name; break;
      case 'hk_reconstruct_edge': msg = LANDMARKS[step.from].name + ' \u2192 ' + LANDMARKS[step.to].name; break;
      case 'hk_complete': msg = 'Optimal route found!'; break;
    }
    el.textContent = msg;
  }

  function showStats(step) {
    var el = document.getElementById('algoStats');
    if (!el) return;
    var order = step.order;
    var names = order.map(function (i) { return LANDMARKS[i].abbr; });
    var totalCost = computeRouteCost(order);
    var route = escapeHtml(names.join(' \u2192 '));
    var html = route + '  |  <u style="text-decoration-thickness:2px;text-underline-offset:3px">' + escapeHtml(formatCost(totalCost)) + '</u>';

    if (step.nnOrder) {
      var nnCost = computeRouteCost(step.nnOrder);
      if (step.type === 'hk_complete') {
        html += '  (NN: ' + escapeHtml(formatCost(nnCost)) + ')';
      } else if (step.type === 'twoopt_complete') {
        html += '  (was ' + escapeHtml(formatCost(nnCost)) + ')';
      }
    }
    el.innerHTML = html;
    el.hidden = false;
  }

  /* ================================================================
   * 12. PLAYBACK CONTROLS + TABS
   * ================================================================ */

  function wireControls() {
    var playBtn  = document.getElementById('algoPlayBtn');
    var pauseBtn = document.getElementById('algoPauseBtn');
    var stepBtn  = document.getElementById('algoStepBtn');
    var resetBtn = document.getElementById('algoResetBtn');
    var slider   = document.getElementById('algoSpeedSlider');
    var speedVal = document.getElementById('algoSpeedValue');

    playBtn.addEventListener('click', function () {
      state.playing = true;
      lastTimestamp = 0;
      updateControls();
      animFrame = requestAnimationFrame(tick);
    });

    pauseBtn.addEventListener('click', function () {
      state.playing = false;
      updateControls();
    });

    stepBtn.addEventListener('click', function () {
      state.playing = false;
      if (state.stepIndex < state.steps.length) {
        var s = state.steps[state.stepIndex];
        applyStep(s);
        state.stepIndex++;
        state.subProgress = 0;
        highlightPseudo(s.pseudoLine);
        showPhase(s);
      }
      updateControls();
    });

    resetBtn.addEventListener('click', resetAnimation);

    slider.addEventListener('input', function () {
      state.speed = Number(slider.value);
      var label = state.speed % 1 === 0 ? state.speed.toFixed(0) : state.speed.toFixed(2).replace(/0$/, '');
      speedVal.textContent = label + '\u00d7';
    });

    var startSelect = document.getElementById('algoStartSelect');
    if (startSelect) {
      startSelect.addEventListener('change', function () {
        state.loading = true;
        updateControls();
        resetAnimation();
        fetchGeometries(state.steps, function () {
          state.loading = false;
          updateControls();
          var phase = document.getElementById('algoPhase');
          if (phase) phase.textContent = 'Press Play to begin (' + matrixProvider + ' ' + getMode() + ')';
        });
      });
    }
  }

  function updateControls() {
    var playBtn  = document.getElementById('algoPlayBtn');
    var pauseBtn = document.getElementById('algoPauseBtn');
    var stepBtn  = document.getElementById('algoStepBtn');
    playBtn.hidden  = state.playing;
    pauseBtn.hidden = !state.playing;
    playBtn.disabled = state.loading;
    stepBtn.disabled = state.loading;
  }

  function resetAnimation() {
    state.playing = false;
    state.stepIndex = 0;
    state.subProgress = 0;
    state.completedEdges = [];
    state.visitedSet = {};
    state.currentNode = -1;
    state.currentOrder = [];
    if (animFrame) cancelAnimationFrame(animFrame);
    lastTimestamp = 0;

    state.steps = ALGOS[currentAlgo].generate(getStartIndex(), state.matrix);

    edgeLayer.clearLayers();
    clearTransient();
    placeMarkers();

    updateControls();
    highlightPseudo(-1);
    var phase = document.getElementById('algoPhase');
    if (phase) phase.textContent = 'Press Play to begin (' + matrixProvider + ' ' + getMode() + ')';
    var stats = document.getElementById('algoStats');
    if (stats) stats.hidden = true;
  }

  function updateDescription() {
    var el = document.getElementById('algoDescription');
    if (el) el.textContent = ALGOS[currentAlgo].desc;
  }

  function switchAlgorithm(algoKey) {
    currentAlgo = algoKey;
    resetAnimation();
    initPseudocode();
    updateDescription();
    var tabs = document.querySelectorAll('.algo-tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('active', tabs[i].getAttribute('data-algo') === algoKey);
    }
  }

  function wireTabs() {
    var tabs = document.querySelectorAll('.algo-tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener('click', function () {
        switchAlgorithm(this.getAttribute('data-algo'));
      });
    }
  }

  /* ================================================================
   * 13. INITIALISATION
   * ================================================================ */

  function getStartIndex() {
    var sel = document.getElementById('algoStartSelect');
    return sel ? Number(sel.value) : 0;
  }

  function getMode() {
    var sel = document.getElementById('algoModeSelect');
    return sel ? sel.value : 'walking';
  }

  function populateStartSelect() {
    var sel = document.getElementById('algoStartSelect');
    if (!sel) return;
    for (var i = 0; i < LANDMARKS.length; i++) {
      var opt = document.createElement('option');
      opt.value = i;
      opt.textContent = LANDMARKS[i].name;
      sel.appendChild(opt);
    }
  }

  function getCsrf() {
    var m = document.cookie.match(/gitrip_csrf=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  function fetchMatrix(callback) {
    state.loading = true;
    updateControls();
    var points = LANDMARKS.map(function (l) { return { lat: l.lat, lng: l.lng }; });
    var mode = getMode();
    var phase = document.getElementById('algoPhase');
    if (phase) phase.textContent = 'Fetching ' + mode + ' travel times\u2026';

    fetch('/api/algo-matrix', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrf() },
      body: JSON.stringify({ points: points, mode: mode }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.ok && Array.isArray(data.matrix)) {
          state.matrix = data.matrix;
          matrixUnit = data.unit || 'min';
          matrixProvider = data.provider || 'haversine';
        } else {
          state.matrix = buildMatrix(LANDMARKS);
          matrixUnit = 'min';
          matrixProvider = 'haversine';
        }
        if (callback) callback();
      })
      .catch(function () {
        state.matrix = buildMatrix(LANDMARKS);
        matrixUnit = 'min';
        matrixProvider = 'haversine';
        if (callback) callback();
      });
  }

  /* --- Collect all unique routes from algorithm steps for geometry pre-fetch --- */
  function collectRoutes(steps) {
    var routes = {};
    for (var i = 0; i < steps.length; i++) {
      var s = steps[i];
      var order = null;
      if (s.type === 'complete' || s.type === 'twoopt_complete' || s.type === 'hk_complete') {
        order = s.order;
      } else if (s.type === 'twoopt_show_nn') {
        order = s.order;
      } else if (s.type === 'twoopt_improve') {
        order = s.newOrder;
      } else if (s.type === 'mark_visited' && s.order) {
        // NN builds up progressively — cache the full final route from the complete step
        continue;
      }
      if (order && order.length >= 2) {
        var key = order.join(',');
        if (!routes[key]) routes[key] = order;
      }
    }
    // Also build the full NN route for edge-by-edge NN animation
    var nnOrder = nearestNeighborOrder(getStartIndex(), state.matrix);
    routes[nnOrder.join(',')] = nnOrder;
    // And HK route
    var hk = solveHeldKarp(getStartIndex(), state.matrix);
    if (hk.order) routes[hk.order.join(',')] = hk.order;
    return Object.keys(routes).map(function (k) { return routes[k]; });
  }

  function fetchGeometries(steps, callback) {
    var routes = collectRoutes(steps);
    if (!routes.length) { if (callback) callback(); return; }
    var phase = document.getElementById('algoPhase');
    if (phase) phase.textContent = 'Loading route paths\u2026';

    // Collect unique edges across all routes (skip already-cached ones)
    var edgeList = [];
    var edgeSeen = {};
    for (var r = 0; r < routes.length; r++) {
      var order = routes[r];
      for (var i = 0; i < order.length - 1; i++) {
        var key = geoCacheKey(order[i], order[i + 1]);
        if (!geoCache[key] && !edgeSeen[key]) {
          edgeSeen[key] = true;
          edgeList.push({ from: order[i], to: order[i + 1] });
        }
      }
    }
    if (!edgeList.length) { if (callback) callback(); return; }

    // Single batch request — server processes edges sequentially to avoid rate limits
    var payload = {
      mode: getMode(),
      edges: edgeList.map(function (e) {
        return {
          from: { lat: LANDMARKS[e.from].lat, lng: LANDMARKS[e.from].lng },
          to:   { lat: LANDMARKS[e.to].lat,   lng: LANDMARKS[e.to].lng },
        };
      }),
    };

    fetch('/api/algo-geometry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrf() },
      body: JSON.stringify(payload),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.ok && Array.isArray(data.results)) {
          for (var i = 0; i < data.results.length; i++) {
            var res = data.results[i];
            if (res && res.coords && res.coords.length > 1) {
              geoCache[geoCacheKey(edgeList[i].from, edgeList[i].to)] = {
                coords: res.coords,
                segments: res.segments || null,
              };
            }
          }
        }
      })
      .catch(function () { /* fallback to straight lines */ })
      .finally(function () { if (callback) callback(); });
  }

  function afterMatrixReady() {
    state.steps = ALGOS[currentAlgo].generate(getStartIndex(), state.matrix);
    geoCache = {};
    placeMarkers();
    fetchGeometries(state.steps, function () {
      state.loading = false;
      updateControls();
      var phase = document.getElementById('algoPhase');
      if (phase) phase.textContent = 'Press Play to begin (' + matrixProvider + ' ' + getMode() + ')';
      var stats = document.getElementById('algoStats');
      if (stats) stats.hidden = true;
    });
  }

  function init() {
    populateStartSelect();
    placeMarkers();
    initPseudocode();
    updateDescription();
    wireControls();
    wireTabs();

    var modeSelect = document.getElementById('algoModeSelect');
    if (modeSelect) {
      modeSelect.addEventListener('change', function () {
        geoCache = {};
        fetchMatrix(function () {
          resetAnimation();
          fetchGeometries(state.steps, function () {
            state.loading = false;
            updateControls();
            var phase = document.getElementById('algoPhase');
            if (phase) phase.textContent = 'Press Play to begin (' + matrixProvider + ' ' + getMode() + ')';
          });
        });
      });
    }

    fetchMatrix(function () {
      afterMatrixReady();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
