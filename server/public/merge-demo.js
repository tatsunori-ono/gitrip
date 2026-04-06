/**
 * merge-demo.js — Interactive three-way merge visualisation.
 *
 * Four tabs: Clean Merge, Time Conflict, Delete Conflict, Whole-Plan Conflict.
 * Each runs an animated, step-by-step demonstration on London landmarks
 * with synchronised pseudocode highlighting.
 */
(() => {
  'use strict';

  /* ================================================================
   * 1. PSEUDOCODE
   * ================================================================ */

  var PSEUDO_MERGE = [
    'function mergeSnapshots(base, ours, theirs):',
    '  merged = clone(base)',
    '  conflicts = []',
    '',
    '  // Check file-level changes',
    '  for each key in files:',
    '    if only one side changed: take that side',
    '    if both changed differently: conflict',
    '',
    '  // Check plan-level changes',
    '  if only one side changed plan: take it',
    '  if both changed to same: take either',
    '',
    '  // Structural similarity check',
    '  similarity = jaccard(ourStops, theirStops)',
    '  if similarity < 0.4: whole-plan conflict',
    '',
    '  // Per-stop merge',
    '  for each stop in allStops:',
    '    if unchanged: keep base',
    '    if one side changed: take that side',
    '    if both deleted: omit',
    '    if delete vs edit: conflict',
    '    if times differ: time conflict',
    '    if fields differ: field conflict',
    '',
    '  sort days by date, stops by time',
    '  return { merged, conflicts }',
  ];

  /* ================================================================
   * 2. SCENARIO DATA — London landmarks
   * ================================================================ */

  function stop(id, name, arrive, depart, extra) {
    var s = { id: id, name: name, arrive: arrive, depart: depart };
    if (extra) { for (var k in extra) s[k] = extra[k]; }
    return s;
  }

  var SCENARIOS = {
    clean: {
      label: 'Clean Merge',
      desc: 'Source changes the arrival time for British Museum; Target adds a new stop (Camden Market). No overlapping edits, so everything merges automatically.',
      base: [
        stop('bm', 'British Museum', '09:00', '11:00'),
        stop('tb', 'Tower Bridge', '11:30', '12:30'),
        stop('cg', 'Covent Garden', '13:00', '14:30'),
        stop('bb', 'Big Ben', '15:00', '16:00'),
      ],
      ours: [
        stop('bm', 'British Museum', '10:00', '11:30'),
        stop('tb', 'Tower Bridge', '11:30', '12:30'),
        stop('cg', 'Covent Garden', '13:00', '14:30'),
        stop('bb', 'Big Ben', '15:00', '16:00'),
      ],
      theirs: [
        stop('bm', 'British Museum', '09:00', '11:00'),
        stop('tb', 'Tower Bridge', '11:30', '12:30'),
        stop('cg', 'Covent Garden', '13:00', '14:30'),
        stop('bb', 'Big Ben', '15:00', '16:00'),
        stop('cm', 'Camden Market', '16:30', '18:00'),
      ],
    },
    time: {
      label: 'Time Conflict',
      desc: 'Both branches change the arrival time for Tower Bridge to different values. Source says 10:00, Target says 11:00 — a time conflict that needs manual resolution.',
      base: [
        stop('bm', 'British Museum', '09:00', '11:00'),
        stop('tb', 'Tower Bridge', '11:30', '12:30'),
        stop('cg', 'Covent Garden', '13:00', '14:30'),
        stop('bb', 'Big Ben', '15:00', '16:00'),
      ],
      ours: [
        stop('bm', 'British Museum', '09:00', '11:00'),
        stop('tb', 'Tower Bridge', '10:00', '12:30'),
        stop('cg', 'Covent Garden', '13:00', '14:30'),
        stop('bb', 'Big Ben', '15:00', '16:00'),
      ],
      theirs: [
        stop('bm', 'British Museum', '09:00', '11:00'),
        stop('tb', 'Tower Bridge', '11:00', '13:00'),
        stop('cg', 'Covent Garden', '13:00', '14:30'),
        stop('bb', 'Big Ben', '15:00', '16:00'),
      ],
    },
    delete: {
      label: 'Delete Conflict',
      desc: 'Source deletes Covent Garden from the plan; Target changes its departure time. One side deleted what the other edited — a delete-vs-edit conflict.',
      base: [
        stop('bm', 'British Museum', '09:00', '11:00'),
        stop('tb', 'Tower Bridge', '11:30', '12:30'),
        stop('cg', 'Covent Garden', '13:00', '14:30'),
        stop('bb', 'Big Ben', '15:00', '16:00'),
      ],
      ours: [
        stop('bm', 'British Museum', '09:00', '11:00'),
        stop('tb', 'Tower Bridge', '11:30', '12:30'),
        stop('bb', 'Big Ben', '15:00', '16:00'),
      ],
      theirs: [
        stop('bm', 'British Museum', '09:00', '11:00'),
        stop('tb', 'Tower Bridge', '11:30', '12:30'),
        stop('cg', 'Covent Garden', '13:00', '15:00'),
        stop('bb', 'Big Ben', '15:00', '16:00'),
      ],
    },
    whole: {
      label: 'Whole-Plan Conflict',
      desc: 'Source replaces most stops with a new set of landmarks; Target does the same with different choices. The Jaccard similarity is below 0.4, triggering a whole-plan conflict.',
      base: [
        stop('bm', 'British Museum', '09:00', '11:00'),
        stop('tb', 'Tower Bridge', '11:30', '12:30'),
        stop('cg', 'Covent Garden', '13:00', '14:30'),
        stop('bb', 'Big Ben', '15:00', '16:00'),
      ],
      ours: [
        stop('hp', 'Hyde Park', '09:00', '11:00'),
        stop('sp', 'St Paul\'s', '11:30', '13:00'),
        stop('le', 'London Eye', '13:30', '15:00'),
        stop('kc', 'Kings Cross', '15:30', '17:00'),
      ],
      theirs: [
        stop('ts', 'Trafalgar Square', '09:00', '10:30'),
        stop('bp', 'Buckingham Palace', '11:00', '12:30'),
        stop('gp', 'Greenwich Park', '13:00', '15:00'),
        stop('cm', 'Camden Market', '15:30', '17:00'),
      ],
    },
    file: {
      label: 'File Conflict',
      desc: 'Both branches edit the trip description to different text. The plan itself is unchanged, but the file-level metadata conflicts.',
      baseFiles: { description: 'A weekend trip around London.' },
      oursFiles: { description: 'Alice\'s London adventure — museums and markets!' },
      theirsFiles: { description: 'Bob\'s London highlights — bridges and parks.' },
      base: [
        stop('bm', 'British Museum', '09:00', '11:00'),
        stop('tb', 'Tower Bridge', '11:30', '12:30'),
        stop('cg', 'Covent Garden', '13:00', '14:30'),
        stop('bb', 'Big Ben', '15:00', '16:00'),
      ],
      ours: [
        stop('bm', 'British Museum', '09:00', '11:00'),
        stop('tb', 'Tower Bridge', '11:30', '12:30'),
        stop('cg', 'Covent Garden', '13:00', '14:30'),
        stop('bb', 'Big Ben', '15:00', '16:00'),
      ],
      theirs: [
        stop('bm', 'British Museum', '09:00', '11:00'),
        stop('tb', 'Tower Bridge', '11:30', '12:30'),
        stop('cg', 'Covent Garden', '13:00', '14:30'),
        stop('bb', 'Big Ben', '15:00', '16:00'),
      ],
    },
    identical: {
      label: 'Identical Changes',
      desc: 'Both branches independently make the exact same change to Tower Bridge\'s times. Since the changes are identical, there is no conflict — the merge engine accepts either version.',
      base: [
        stop('bm', 'British Museum', '09:00', '11:00'),
        stop('tb', 'Tower Bridge', '11:30', '12:30'),
        stop('cg', 'Covent Garden', '13:00', '14:30'),
        stop('bb', 'Big Ben', '15:00', '16:00'),
      ],
      ours: [
        stop('bm', 'British Museum', '09:00', '11:00'),
        stop('tb', 'Tower Bridge', '10:00', '11:00'),
        stop('cg', 'Covent Garden', '13:00', '14:30'),
        stop('bb', 'Big Ben', '15:00', '16:00'),
      ],
      theirs: [
        stop('bm', 'British Museum', '09:00', '11:00'),
        stop('tb', 'Tower Bridge', '10:00', '11:00'),
        stop('cg', 'Covent Garden', '13:00', '14:30'),
        stop('bb', 'Big Ben', '15:00', '16:00'),
      ],
    },
    bothdelete: {
      label: 'Both Delete',
      desc: 'Both branches independently delete Covent Garden. Since both agree on the deletion, the stop is silently omitted from the merged result — no conflict.',
      base: [
        stop('bm', 'British Museum', '09:00', '11:00'),
        stop('tb', 'Tower Bridge', '11:30', '12:30'),
        stop('cg', 'Covent Garden', '13:00', '14:30'),
        stop('bb', 'Big Ben', '15:00', '16:00'),
      ],
      ours: [
        stop('bm', 'British Museum', '09:00', '11:00'),
        stop('tb', 'Tower Bridge', '11:30', '12:30'),
        stop('bb', 'Big Ben', '15:00', '16:00'),
      ],
      theirs: [
        stop('bm', 'British Museum', '09:00', '11:00'),
        stop('tb', 'Tower Bridge', '11:30', '12:30'),
        stop('bb', 'Big Ben', '15:00', '16:00'),
      ],
    },
    field: {
      label: 'Field Conflict',
      desc: 'Both branches rename Covent Garden to different names while keeping the same times. Source calls it "Covent Garden Market", Target calls it "The Piazza" — a field conflict.',
      base: [
        stop('bm', 'British Museum', '09:00', '11:00'),
        stop('tb', 'Tower Bridge', '11:30', '12:30'),
        stop('cg', 'Covent Garden', '13:00', '14:30'),
        stop('bb', 'Big Ben', '15:00', '16:00'),
      ],
      ours: [
        stop('bm', 'British Museum', '09:00', '11:00'),
        stop('tb', 'Tower Bridge', '11:30', '12:30'),
        stop('cg', 'Covent Garden Market', '13:00', '14:30'),
        stop('bb', 'Big Ben', '15:00', '16:00'),
      ],
      theirs: [
        stop('bm', 'British Museum', '09:00', '11:00'),
        stop('tb', 'Tower Bridge', '11:30', '12:30'),
        stop('cg', 'The Piazza', '13:00', '14:30'),
        stop('bb', 'Big Ben', '15:00', '16:00'),
      ],
    },
  };

  var currentScenario = 'clean';

  /* ================================================================
   * 3. STEP GENERATORS
   * ================================================================ */

  function findStop(plan, id) {
    for (var i = 0; i < plan.length; i++) {
      if (plan[i].id === id) return plan[i];
    }
    return null;
  }

  function allStopIds(base, ours, theirs) {
    var seen = {};
    var ids = [];
    var all = base.concat(ours).concat(theirs);
    for (var i = 0; i < all.length; i++) {
      if (!seen[all[i].id]) {
        seen[all[i].id] = true;
        ids.push(all[i].id);
      }
    }
    return ids;
  }

  function jaccardSimilarity(ours, theirs) {
    var setO = {}, setT = {};
    for (var i = 0; i < ours.length; i++) setO[ours[i].id] = true;
    for (var i = 0; i < theirs.length; i++) setT[theirs[i].id] = true;
    var intersection = 0, union = 0;
    var all = {};
    for (var k in setO) all[k] = true;
    for (var k in setT) all[k] = true;
    for (var k in all) {
      union++;
      if (setO[k] && setT[k]) intersection++;
    }
    return union === 0 ? 1 : intersection / union;
  }

  function stopsEqual(a, b) {
    if (!a || !b) return false;
    return a.arrive === b.arrive && a.depart === b.depart && a.name === b.name
      && (a.lat || '') === (b.lat || '') && (a.lng || '') === (b.lng || '')
      && (a.notes || '') === (b.notes || '');
  }

  function timesEqual(a, b) {
    if (!a || !b) return false;
    return a.arrive === b.arrive && a.depart === b.depart;
  }

  function generateSteps(scenarioKey) {
    var sc = SCENARIOS[scenarioKey];
    var base = sc.base, ours = sc.ours, theirs = sc.theirs;
    var steps = [];
    var merged = [];
    var conflicts = 0;

    // Init
    steps.push({ type: 'init', pseudoLine: 0 });

    // Compare files
    var baseFiles = sc.baseFiles || {};
    var oursFiles = sc.oursFiles || {};
    var theirsFiles = sc.theirsFiles || {};
    var fileKeys = {};
    var k;
    for (k in baseFiles) fileKeys[k] = true;
    for (k in oursFiles) fileKeys[k] = true;
    for (k in theirsFiles) fileKeys[k] = true;
    var hasFileConflict = false;
    for (k in fileKeys) {
      var bv = baseFiles[k] || '', ov = oursFiles[k] || '', tv = theirsFiles[k] || '';
      var lc = bv !== ov, rc = bv !== tv;
      if (lc && rc && ov !== tv) {
        hasFileConflict = true;
        steps.push({ type: 'file_conflict', key: k, base: bv, ours: ov, theirs: tv, pseudoLine: 7 });
        conflicts++;
      } else if (lc && !rc) {
        steps.push({ type: 'file_one_side', key: k, side: 'ours', value: ov, pseudoLine: 6 });
      } else if (!lc && rc) {
        steps.push({ type: 'file_one_side', key: k, side: 'theirs', value: tv, pseudoLine: 6 });
      }
    }
    if (!hasFileConflict) {
      steps.push({ type: 'compare_files', pseudoLine: 5 });
    }

    // Check plan changed
    var oursChanged = JSON.stringify(base) !== JSON.stringify(ours);
    var theirsChanged = JSON.stringify(base) !== JSON.stringify(theirs);
    steps.push({ type: 'check_plan_changed', oursChanged: oursChanged, theirsChanged: theirsChanged, pseudoLine: 10 });

    if (oursChanged && theirsChanged) {
      steps.push({ type: 'check_both_changed', pseudoLine: 11 });

      // Jaccard similarity
      var sim = jaccardSimilarity(ours, theirs);
      steps.push({ type: 'compute_jaccard', similarity: sim, pseudoLine: 14 });
      steps.push({ type: 'jaccard_result', similarity: sim, isWholePlanConflict: sim < 0.4, pseudoLine: 15 });

      if (sim < 0.4) {
        // Whole-plan conflict
        conflicts++;
        steps.push({ type: 'build_result', merged: [], conflicts: conflicts, wholePlanConflict: true, pseudoLine: 15 });
        steps.push({ type: 'complete', merged: [], conflicts: conflicts, wholePlanConflict: true, pseudoLine: 27 });
        return steps;
      }
    } else if (oursChanged && !theirsChanged) {
      // Only ours changed — take ours
      steps.push({ type: 'check_plan_changed', oursChanged: true, theirsChanged: false, pseudoLine: 10 });
    } else if (!oursChanged && theirsChanged) {
      // Only theirs changed — take theirs
      steps.push({ type: 'check_plan_changed', oursChanged: false, theirsChanged: true, pseudoLine: 10 });
    }

    // Per-stop merge
    var ids = allStopIds(base, ours, theirs);
    steps.push({ type: 'iterate_stops', stopIds: ids, pseudoLine: 18 });

    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      var bStop = findStop(base, id);
      var oStop = findStop(ours, id);
      var tStop = findStop(theirs, id);

      steps.push({ type: 'check_stop', stopId: id, bStop: bStop, oStop: oStop, tStop: tStop, pseudoLine: 18 });

      // Unchanged
      if (stopsEqual(bStop, oStop) && stopsEqual(bStop, tStop)) {
        steps.push({ type: 'stop_unchanged', stopId: id, stop: bStop, pseudoLine: 19 });
        merged.push(Object.assign({}, bStop, { status: 'unchanged' }));
        continue;
      }

      // Only one side changed
      var oChanged = !stopsEqual(bStop, oStop);
      var tChanged = !stopsEqual(bStop, tStop);

      // One side added (not in base)
      if (!bStop) {
        if (oStop && !tStop) {
          steps.push({ type: 'stop_one_side', stopId: id, side: 'ours', stop: oStop, pseudoLine: 20 });
          merged.push(Object.assign({}, oStop, { status: 'added' }));
        } else if (tStop && !oStop) {
          steps.push({ type: 'stop_one_side', stopId: id, side: 'theirs', stop: tStop, pseudoLine: 20 });
          merged.push(Object.assign({}, tStop, { status: 'added' }));
        } else {
          // Both added same stop — take ours
          steps.push({ type: 'stop_clean_merge', stopId: id, stop: oStop, pseudoLine: 20 });
          merged.push(Object.assign({}, oStop, { status: 'added' }));
        }
        continue;
      }

      // Both deleted
      if (!oStop && !tStop) {
        steps.push({ type: 'stop_both_deleted', stopId: id, pseudoLine: 21 });
        continue;
      }

      // Delete vs edit
      if (!oStop && tStop) {
        steps.push({ type: 'stop_delete_conflict', stopId: id, side: 'ours_deleted', stop: tStop, pseudoLine: 22 });
        conflicts++;
        merged.push(Object.assign({}, tStop, { status: 'conflict' }));
        continue;
      }
      if (oStop && !tStop) {
        steps.push({ type: 'stop_delete_conflict', stopId: id, side: 'theirs_deleted', stop: oStop, pseudoLine: 22 });
        conflicts++;
        merged.push(Object.assign({}, oStop, { status: 'conflict' }));
        continue;
      }

      // Both exist: check fields
      if (oChanged && !tChanged) {
        steps.push({ type: 'stop_one_side', stopId: id, side: 'ours', stop: oStop, pseudoLine: 20 });
        merged.push(Object.assign({}, oStop, { status: 'modified' }));
        continue;
      }
      if (!oChanged && tChanged) {
        steps.push({ type: 'stop_one_side', stopId: id, side: 'theirs', stop: tStop, pseudoLine: 20 });
        merged.push(Object.assign({}, tStop, { status: 'modified' }));
        continue;
      }

      // Both changed — check if same
      if (stopsEqual(oStop, tStop)) {
        steps.push({ type: 'stop_clean_merge', stopId: id, stop: oStop, pseudoLine: 20 });
        merged.push(Object.assign({}, oStop, { status: 'modified' }));
        continue;
      }

      // Time conflict?
      if (oStop.arrive !== tStop.arrive || oStop.depart !== tStop.depart) {
        steps.push({ type: 'stop_time_conflict', stopId: id, oStop: oStop, tStop: tStop, pseudoLine: 23 });
        conflicts++;
        merged.push(Object.assign({}, oStop, { status: 'conflict' }));
        continue;
      }

      // Field conflict (times agree but name/notes/coords differ)
      var diffFields = [];
      if (oStop.name !== tStop.name) diffFields.push('name');
      if ((oStop.lat || '') !== (tStop.lat || '')) diffFields.push('lat');
      if ((oStop.lng || '') !== (tStop.lng || '')) diffFields.push('lng');
      if ((oStop.notes || '') !== (tStop.notes || '')) diffFields.push('notes');
      steps.push({ type: 'stop_field_conflict', stopId: id, oStop: oStop, tStop: tStop, fields: diffFields, pseudoLine: 24 });
      conflicts++;
      merged.push(Object.assign({}, oStop, { status: 'conflict' }));
    }

    // Build result
    steps.push({ type: 'build_result', merged: merged, conflicts: conflicts, wholePlanConflict: false, pseudoLine: 26 });
    steps.push({ type: 'complete', merged: merged, conflicts: conflicts, wholePlanConflict: false, pseudoLine: 27 });

    return steps;
  }

  /* ================================================================
   * 4. DOM REFS
   * ================================================================ */

  var panelBaseStops = document.getElementById('panelBaseStops');
  var panelOursStops = document.getElementById('panelOursStops');
  var panelTheirsStops = document.getElementById('panelTheirsStops');
  var panelMergedStops = document.getElementById('panelMergedStops');

  var panelBase = document.getElementById('panelBase');
  var panelOurs = document.getElementById('panelOurs');
  var panelTheirs = document.getElementById('panelTheirs');
  var panelMerged = document.getElementById('panelMerged');

  var panelBaseFiles = document.getElementById('panelBaseFiles');
  var panelOursFiles = document.getElementById('panelOursFiles');
  var panelTheirsFiles = document.getElementById('panelTheirsFiles');
  var panelMergedFiles = document.getElementById('panelMergedFiles');

  var phaseEl = document.getElementById('mergePhase');
  var statsEl = document.getElementById('mergeStats');
  var descEl = document.getElementById('mergeDescription');
  var pseudoEl = document.getElementById('mergePseudocode');

  var playBtn = document.getElementById('mergePlayBtn');
  var pauseBtn = document.getElementById('mergePauseBtn');
  var stepBtn = document.getElementById('mergeStepBtn');
  var resetBtn = document.getElementById('mergeResetBtn');
  var speedSlider = document.getElementById('mergeSpeedSlider');
  var speedValue = document.getElementById('mergeSpeedValue');

  if (!panelBaseStops) return;

  /* ================================================================
   * 5. ANIMATION STATE
   * ================================================================ */

  var state = {
    steps: [],
    stepIndex: 0,
    subProgress: 0,
    playing: false,
    speed: 1,
    mergedSoFar: [],
    highlightStopId: null,
  };

  var DURATIONS = {
    init: 800,
    compare_files: 700,
    file_conflict: 1000,
    file_one_side: 700,
    check_plan_changed: 700,
    check_both_changed: 600,
    compute_jaccard: 900,
    jaccard_result: 1000,
    iterate_stops: 500,
    check_stop: 600,
    stop_unchanged: 500,
    stop_one_side: 700,
    stop_both_deleted: 600,
    stop_delete_conflict: 900,
    stop_time_conflict: 900,
    stop_field_conflict: 900,
    stop_clean_merge: 600,
    build_result: 800,
    complete: 1200,
  };

  var animFrame = null, lastTimestamp = 0;

  /* ================================================================
   * 6. RENDERING
   * ================================================================ */

  function renderStopCard(s, status, highlight) {
    var cls = 'merge-demo-stop merge-demo-stop--' + (status || 'unchanged');
    if (highlight) cls += ' highlight';
    var icon = '';
    if (status === 'modified') icon = '<span class="merge-demo-stop-icon" style="color:#f59e0b">&#9998;</span>';
    else if (status === 'added') icon = '<span class="merge-demo-stop-icon" style="color:#22c55e">+</span>';
    else if (status === 'deleted') icon = '<span class="merge-demo-stop-icon" style="color:#ef4444">&times;</span>';
    else if (status === 'conflict') icon = '<span class="merge-demo-stop-icon" style="color:#ec5643">&#9888;</span>';
    else icon = '<span class="merge-demo-stop-icon" style="color:#5f7a74">&#10003;</span>';

    return '<div class="' + cls + '">' +
      icon +
      '<span class="merge-demo-stop-name">' + s.name + '</span>' +
      '<span class="merge-demo-stop-time">' + s.arrive + ' - ' + s.depart + '</span>' +
      '</div>';
  }

  function renderPanel(container, stops, statusMap, highlightId) {
    var html = '';
    for (var i = 0; i < stops.length; i++) {
      var s = stops[i];
      var status = (statusMap && statusMap[s.id]) || 'unchanged';
      var hl = highlightId && s.id === highlightId;
      html += renderStopCard(s, status, hl);
    }
    container.innerHTML = html || '<div style="color:#5f7a74;font-size:12px;padding:8px">No stops</div>';
  }

  function renderMergedPanel(mergedStops, highlightId) {
    var html = '';
    for (var i = 0; i < mergedStops.length; i++) {
      var s = mergedStops[i];
      var hl = highlightId && s.id === highlightId;
      html += renderStopCard(s, s.status || 'unchanged', hl);
    }
    panelMergedStops.innerHTML = html || '<div style="color:#5f7a74;font-size:12px;padding:8px">Building...</div>';
  }

  function renderFilePanel(container, files, cssClass) {
    if (!files || !Object.keys(files).length) {
      container.hidden = true;
      return;
    }
    container.hidden = false;
    container.className = 'merge-demo-panel-files' + (cssClass ? ' ' + cssClass : '');
    var html = '';
    for (var k in files) {
      html += '<div class="file-label">' + k + '</div>';
      html += '<div class="file-value">"' + String(files[k] || '').replace(/</g, '&lt;') + '"</div>';
    }
    container.innerHTML = html;
  }

  function hideAllFilePanels() {
    panelBaseFiles.hidden = true;
    panelOursFiles.hidden = true;
    panelTheirsFiles.hidden = true;
    panelMergedFiles.hidden = true;
  }

  function clearPanelHighlights() {
    var panels = [panelBase, panelOurs, panelTheirs, panelMerged];
    for (var i = 0; i < panels.length; i++) panels[i].classList.remove('active');
  }

  function highlightPanel(panel) {
    clearPanelHighlights();
    if (panel) panel.classList.add('active');
  }

  /* ================================================================
   * 7. PSEUDOCODE
   * ================================================================ */

  function renderPseudo() {
    var code = pseudoEl.querySelector('code');
    var html = '';
    for (var i = 0; i < PSEUDO_MERGE.length; i++) {
      html += '<span class="line" data-line="' + i + '">' +
        PSEUDO_MERGE[i].replace(/</g, '&lt;').replace(/>/g, '&gt;') +
        '</span>\n';
    }
    code.innerHTML = html;
  }

  function highlightPseudo(lineIdx) {
    var lines = pseudoEl.querySelectorAll('.line');
    for (var i = 0; i < lines.length; i++) {
      lines[i].classList.toggle('active', i === lineIdx);
    }
  }

  /* ================================================================
   * 8. PHASE & STATS DISPLAY
   * ================================================================ */

  function showPhase(step) {
    var msgs = {
      init: 'Initialising merge...',
      compare_files: 'Checking file-level changes... no conflicts',
      file_conflict: 'File conflict on "' + (step.key || '') + '"!',
      file_one_side: 'File "' + (step.key || '') + '" — taking ' + (step.side || 'changed') + ' version',
      check_plan_changed: 'Checking which branches changed the plan...',
      check_both_changed: 'Both branches modified the plan',
      compute_jaccard: 'Computing Jaccard similarity...',
      jaccard_result: '',
      iterate_stops: 'Iterating through all stops...',
      check_stop: 'Comparing stop: ' + (step.stopId || ''),
      stop_unchanged: 'Stop unchanged — keeping base',
      stop_one_side: 'Only ' + (step.side || 'one side') + ' changed — taking that version',
      stop_both_deleted: 'Both deleted — omitting stop',
      stop_delete_conflict: 'Delete vs edit conflict detected!',
      stop_time_conflict: 'Time conflict detected!',
      stop_field_conflict: 'Field conflict: ' + ((step.fields || []).join(', ') || 'fields differ') + '!',
      stop_clean_merge: 'Fields merge cleanly',
      build_result: 'Building final merged plan...',
      complete: 'Merge complete!',
    };

    if (step.type === 'jaccard_result') {
      var pct = (step.similarity * 100).toFixed(0);
      phaseEl.textContent = 'Similarity: ' + pct + '%' +
        (step.isWholePlanConflict ? ' — WHOLE-PLAN CONFLICT' : ' — OK to per-stop merge');
    } else {
      phaseEl.textContent = msgs[step.type] || '';
    }
  }

  function showStats(step) {
    statsEl.hidden = false;
    if (step.wholePlanConflict) {
      statsEl.textContent = 'Result: Whole-plan conflict — plans diverged too much for automatic merge';
    } else if (step.conflicts === 0) {
      statsEl.textContent = 'Result: Clean merge — ' + step.merged.length + ' stops, 0 conflicts';
    } else {
      statsEl.textContent = 'Result: ' + step.merged.length + ' stops, ' + step.conflicts + ' conflict' + (step.conflicts > 1 ? 's' : '') + ' requiring manual resolution';
    }
  }

  /* ================================================================
   * 9. APPLY STEP
   * ================================================================ */

  function computeStatusMaps(sc, highlightId) {
    // Compute status for ours vs base
    var oursMap = {}, theirsMap = {};
    var base = sc.base, ours = sc.ours, theirs = sc.theirs;

    for (var i = 0; i < ours.length; i++) {
      var o = ours[i];
      var b = findStop(base, o.id);
      if (!b) oursMap[o.id] = 'added';
      else if (!stopsEqual(b, o)) oursMap[o.id] = 'modified';
    }
    // Deleted from ours
    for (var i = 0; i < base.length; i++) {
      if (!findStop(ours, base[i].id)) oursMap[base[i].id] = 'deleted';
    }

    for (var i = 0; i < theirs.length; i++) {
      var t = theirs[i];
      var b = findStop(base, t.id);
      if (!b) theirsMap[t.id] = 'added';
      else if (!stopsEqual(b, t)) theirsMap[t.id] = 'modified';
    }
    for (var i = 0; i < base.length; i++) {
      if (!findStop(theirs, base[i].id)) theirsMap[base[i].id] = 'deleted';
    }

    return { ours: oursMap, theirs: theirsMap };
  }

  function applyStep(step) {
    var sc = SCENARIOS[currentScenario];
    var maps = computeStatusMaps(sc, step.stopId);

    highlightPseudo(step.pseudoLine);
    showPhase(step);

    switch (step.type) {
      case 'init':
        state.mergedSoFar = [];
        renderPanel(panelBaseStops, sc.base, {}, null);
        renderPanel(panelOursStops, sc.ours, maps.ours, null);
        renderPanel(panelTheirsStops, sc.theirs, maps.theirs, null);
        renderMergedPanel([], null);
        clearPanelHighlights();
        // Show file descriptions if scenario has them
        if (sc.baseFiles) {
          renderFilePanel(panelBaseFiles, sc.baseFiles, '');
          renderFilePanel(panelOursFiles, sc.oursFiles, sc.oursFiles && JSON.stringify(sc.oursFiles) !== JSON.stringify(sc.baseFiles) ? 'file-changed' : '');
          renderFilePanel(panelTheirsFiles, sc.theirsFiles, sc.theirsFiles && JSON.stringify(sc.theirsFiles) !== JSON.stringify(sc.baseFiles) ? 'file-changed' : '');
          panelMergedFiles.hidden = true;
        } else {
          hideAllFilePanels();
        }
        break;

      case 'compare_files':
        highlightPanel(panelBase);
        break;

      case 'file_conflict':
        renderFilePanel(panelBaseFiles, sc.baseFiles, '');
        renderFilePanel(panelOursFiles, sc.oursFiles, 'file-conflict');
        renderFilePanel(panelTheirsFiles, sc.theirsFiles, 'file-conflict');
        renderFilePanel(panelMergedFiles, sc.baseFiles, 'file-conflict');
        panelOurs.classList.add('active');
        panelTheirs.classList.add('active');
        break;

      case 'file_one_side':
        var resolvedFiles = {};
        resolvedFiles[step.key] = step.value;
        renderFilePanel(panelMergedFiles, resolvedFiles, 'file-changed');
        highlightPanel(step.side === 'ours' ? panelOurs : panelTheirs);
        break;

      case 'check_plan_changed':
        if (step.oursChanged) highlightPanel(panelOurs);
        else if (step.theirsChanged) highlightPanel(panelTheirs);
        break;

      case 'check_both_changed':
        panelOurs.classList.add('active');
        panelTheirs.classList.add('active');
        break;

      case 'compute_jaccard':
        panelOurs.classList.add('active');
        panelTheirs.classList.add('active');
        break;

      case 'jaccard_result':
        clearPanelHighlights();
        if (step.isWholePlanConflict) {
          panelOurs.classList.add('active');
          panelTheirs.classList.add('active');
        }
        break;

      case 'iterate_stops':
        clearPanelHighlights();
        break;

      case 'check_stop':
        state.highlightStopId = step.stopId;
        renderPanel(panelBaseStops, sc.base, {}, step.stopId);
        renderPanel(panelOursStops, sc.ours, maps.ours, step.stopId);
        renderPanel(panelTheirsStops, sc.theirs, maps.theirs, step.stopId);
        clearPanelHighlights();
        break;

      case 'stop_unchanged':
        state.mergedSoFar.push(Object.assign({}, step.stop, { status: 'unchanged' }));
        renderMergedPanel(state.mergedSoFar, step.stopId);
        break;

      case 'stop_one_side':
        var status = findStop(sc.base, step.stopId) ? 'modified' : 'added';
        state.mergedSoFar.push(Object.assign({}, step.stop, { status: status }));
        renderMergedPanel(state.mergedSoFar, step.stopId);
        highlightPanel(step.side === 'ours' ? panelOurs : panelTheirs);
        break;

      case 'stop_both_deleted':
        // Nothing added to merged
        break;

      case 'stop_delete_conflict':
        state.mergedSoFar.push(Object.assign({}, step.stop, { status: 'conflict' }));
        renderMergedPanel(state.mergedSoFar, step.stopId);
        highlightPanel(panelMerged);
        break;

      case 'stop_time_conflict':
        state.mergedSoFar.push(Object.assign({}, step.oStop, { status: 'conflict' }));
        renderMergedPanel(state.mergedSoFar, step.stopId);
        highlightPanel(panelMerged);
        break;

      case 'stop_field_conflict':
        state.mergedSoFar.push(Object.assign({}, step.oStop, { status: 'conflict' }));
        renderMergedPanel(state.mergedSoFar, step.stopId);
        highlightPanel(panelMerged);
        break;

      case 'stop_clean_merge':
        state.mergedSoFar.push(Object.assign({}, step.stop, { status: 'modified' }));
        renderMergedPanel(state.mergedSoFar, step.stopId);
        highlightPanel(panelMerged);
        break;

      case 'build_result':
        clearPanelHighlights();
        highlightPanel(panelMerged);
        if (step.wholePlanConflict) {
          panelMergedStops.innerHTML = '<div style="color:#ec5643;font-size:13px;padding:12px;text-align:center;font-weight:600">' +
            '&#9888; Whole-plan conflict<br><span style="font-weight:400;font-size:12px;color:#8a9b97">Plans diverged too much (Jaccard &lt; 0.4). Manual resolution required.</span></div>';
        } else {
          renderMergedPanel(step.merged, null);
        }
        break;

      case 'complete':
        clearPanelHighlights();
        showStats(step);
        break;
    }
  }

  /* ================================================================
   * 10. TICK / ANIMATION LOOP
   * ================================================================ */

  function tick(timestamp) {
    if (!state.playing) return;
    if (!lastTimestamp) lastTimestamp = timestamp;
    var delta = (timestamp - lastTimestamp) * state.speed;
    lastTimestamp = timestamp;

    var step = state.steps[state.stepIndex];
    if (!step) { state.playing = false; updateControls(); return; }

    var dur = DURATIONS[step.type] || 600;
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

    animFrame = requestAnimationFrame(tick);
  }

  /* ================================================================
   * 11. CONTROLS
   * ================================================================ */

  function updateControls() {
    var atEnd = state.stepIndex >= state.steps.length;
    playBtn.hidden = state.playing;
    pauseBtn.hidden = !state.playing;
    stepBtn.disabled = state.playing || atEnd;
    resetBtn.disabled = state.stepIndex === 0 && !state.playing;
  }

  function play() {
    if (state.stepIndex >= state.steps.length) return;
    state.playing = true;
    lastTimestamp = 0;
    updateControls();
    animFrame = requestAnimationFrame(tick);
  }

  function pause() {
    state.playing = false;
    if (animFrame) cancelAnimationFrame(animFrame);
    updateControls();
  }

  function stepForward() {
    if (state.stepIndex >= state.steps.length) return;
    applyStep(state.steps[state.stepIndex]);
    state.stepIndex++;
    state.subProgress = 0;
    updateControls();
  }

  function reset() {
    pause();
    state.stepIndex = 0;
    state.subProgress = 0;
    state.mergedSoFar = [];
    state.highlightStopId = null;
    phaseEl.textContent = '';
    statsEl.hidden = true;
    statsEl.textContent = '';
    highlightPseudo(-1);
    clearPanelHighlights();
    var sc = SCENARIOS[currentScenario];
    var maps = computeStatusMaps(sc);
    renderPanel(panelBaseStops, sc.base, {}, null);
    renderPanel(panelOursStops, sc.ours, maps.ours, null);
    renderPanel(panelTheirsStops, sc.theirs, maps.theirs, null);
    panelMergedStops.innerHTML = '<div style="color:#5f7a74;font-size:12px;padding:8px">Press Play to start</div>';
    updateControls();
  }

  playBtn.addEventListener('click', play);
  pauseBtn.addEventListener('click', pause);
  stepBtn.addEventListener('click', stepForward);
  resetBtn.addEventListener('click', reset);

  speedSlider.addEventListener('input', function () {
    state.speed = parseFloat(this.value);
    speedValue.textContent = state.speed + '\u00d7';
  });

  /* ================================================================
   * 12. SCENARIO SWITCHING
   * ================================================================ */

  function switchScenario(key) {
    currentScenario = key;
    state.steps = generateSteps(key);
    descEl.textContent = SCENARIOS[key].desc;

    // Update tab active state
    var tabs = document.querySelectorAll('.merge-demo-tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('active', tabs[i].getAttribute('data-scenario') === key);
    }

    reset();
  }

  var tabs = document.querySelectorAll('.merge-demo-tab');
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].addEventListener('click', function () {
      switchScenario(this.getAttribute('data-scenario'));
    });
  }

  /* ================================================================
   * 13. INIT
   * ================================================================ */

  renderPseudo();
  switchScenario('clean');

})();
