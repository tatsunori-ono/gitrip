/**
 * schedule-demo.js — Interactive constraint-aware scheduling visualisation.
 *
 * Five scenarios: Basic Schedule, Opening Hours, Fixed Time, Day Overflow,
 * Compact vs Sparse. Each runs an animated, step-by-step demonstration
 * with synchronised pseudocode highlighting and SVG timeline rendering.
 */
(() => {
  'use strict';

  /* ================================================================
   * 1. PSEUDOCODE
   * ================================================================ */

  var PSEUDO_SCHEDULE = [
    'function autoPlan(places, days, activeHours):',
    '  cursor = activeStart + focusShift',
    '  ordered = optimiseOrder(places)',
    '',
    '  for each place in ordered:',
    '    travelTime = matrix[last][place]',
    '    propose = cursor + travelTime',
    '',
    '    // Check opening hours',
    '    if place has openingHours:',
    '      valid = validateInterval(hours, propose)',
    '      if not valid: nudge to nextStart',
    '      if no slot today: overflow',
    '',
    '    // Check desired window',
    '    if place has desiredWindow:',
    '      clamp to [desiredStart, desiredEnd]',
    '',
    '    // Check active window',
    '    if depart > activeEnd:',
    '      spill to next day',
    '',
    '    schedule place at [arrive, depart]',
    '    cursor = depart',
    '  return { days, overflow }',
  ];

  /* ================================================================
   * 2. STOP DATA — London landmarks
   * ================================================================ */

  var STOPS_DATA = {
    bm: { name: 'British Museum', stayMin: 90, openingHours: 'Mo-Su 10:00-17:00' },
    tb: { name: 'Tower Bridge', stayMin: 45 },
    cg: { name: 'Covent Garden', stayMin: 60 },
    bb: { name: 'Big Ben', stayMin: 30 },
    bp: { name: 'Buckingham Palace', stayMin: 45, openingHours: 'Mo-Su 09:30-17:00' },
    le: { name: 'London Eye', stayMin: 60, openingHours: 'Mo-Su 10:00-18:00' },
    sm: { name: 'Borough Market', stayMin: 45, openingHours: 'We-Sa 10:00-17:00' },
    hp: { name: 'Hyde Park', stayMin: 60 },
    sp: { name: "St Paul's Cathedral", stayMin: 60, openingHours: 'Mo-Sa 08:30-16:00' },
    km: { name: 'Kensington Museum', stayMin: 90, openingHours: 'Mo-Su 10:00-17:30' },
  };

  var DAY_START = 480;  // 08:00 in minutes
  var DAY_END = 1260;   // 21:00 in minutes

  function minsToTime(m) {
    var h = Math.floor(m / 60);
    var mm = m % 60;
    return (h < 10 ? '0' : '') + h + ':' + (mm < 10 ? '0' : '') + mm;
  }

  function parseOpeningHours(str) {
    if (!str) return null;
    var match = str.match(/(\d{2}):(\d{2})-(\d{2}):(\d{2})/);
    if (!match) return null;
    return {
      open: parseInt(match[1]) * 60 + parseInt(match[2]),
      close: parseInt(match[3]) * 60 + parseInt(match[4]),
    };
  }

  /* ================================================================
   * 3. SCENARIO DATA
   * ================================================================ */

  var SCENARIOS = {
    basic: {
      label: 'Basic Schedule',
      desc: 'Four stops with no special constraints, just travel gaps between them. The scheduler uses a cursor-based approach to pack stops neatly from the morning onwards.',
      stops: [
        { id: 'tb', travelMin: 0 },
        { id: 'cg', travelMin: 18 },
        { id: 'bb', travelMin: 15 },
        { id: 'hp', travelMin: 20 },
      ],
      dayStart: DAY_START,
      dayEnd: DAY_END,
      mode: 'compact',
    },
    opening: {
      label: 'Opening Hours',
      desc: 'Four stops where two have opening hours that force nudging. The British Museum opens at 10:00 but is proposed for 08:30, so it gets nudged. The London Eye is proposed after travel and fits within its hours naturally.',
      stops: [
        { id: 'bm', travelMin: 0 },
        { id: 'tb', travelMin: 20 },
        { id: 'sm', travelMin: 15 },
        { id: 'le', travelMin: 18 },
      ],
      dayStart: DAY_START,
      dayEnd: DAY_END,
      mode: 'compact',
    },
    fixed: {
      label: 'Fixed Time',
      desc: 'Big Ben has a fixedTime at 14:00 that cannot be moved. The scheduler places other stops around it. Covent Garden fills the morning, then the cursor jumps to Big Ben at 14:00, followed by the British Museum in the afternoon.',
      stops: [
        { id: 'cg', travelMin: 0 },
        { id: 'bb', travelMin: 12, fixedTime: 840 },
        { id: 'bm', travelMin: 20 },
      ],
      dayStart: DAY_START,
      dayEnd: DAY_END,
      mode: 'compact',
    },
    overflow: {
      label: 'Day Overflow',
      desc: 'Six stops each needing 90 minutes plus travel gaps. The day window is 08:00-21:00 (13 hours). After the first four stops fill day 1, the remaining stops overflow to day 2.',
      stops: [
        { id: 'bm', travelMin: 0, overrideStay: 90 },
        { id: 'km', travelMin: 25, overrideStay: 90 },
        { id: 'bp', travelMin: 20, overrideStay: 90 },
        { id: 'le', travelMin: 22, overrideStay: 90 },
        { id: 'sp', travelMin: 18, overrideStay: 90 },
        { id: 'hp', travelMin: 20, overrideStay: 90 },
      ],
      dayStart: DAY_START,
      dayEnd: DAY_END,
      mode: 'compact',
    },
    desired: {
      label: 'Time Windows',
      desc: 'Borough Market has a desired lunch window (12:00–14:00). The scheduler respects this soft preference and nudges the visit into the window. If travel delays push it past the window, it still schedules but flags the nudge.',
      stops: [
        { id: 'bm', travelMin: 0 },
        { id: 'tb', travelMin: 20 },
        { id: 'sm', travelMin: 15, desiredStart: 720, desiredEnd: 840 },
        { id: 'bb', travelMin: 12 },
      ],
      dayStart: DAY_START,
      dayEnd: DAY_END,
      mode: 'compact',
    },
    multi: {
      label: 'Multi-Constraint',
      desc: 'A complex scenario combining multiple constraints: British Museum has opening hours (10:00), Borough Market has a desired lunch window (12:00–14:00), and Big Ben is fixed at 15:00. The scheduler juggles all constraints to produce a feasible plan.',
      stops: [
        { id: 'bm', travelMin: 0 },
        { id: 'sm', travelMin: 18, desiredStart: 720, desiredEnd: 840 },
        { id: 'bb', travelMin: 15, fixedTime: 900 },
        { id: 'le', travelMin: 20 },
      ],
      dayStart: DAY_START,
      dayEnd: DAY_END,
      mode: 'compact',
    },
    focus: {
      label: 'Focus Shift',
      desc: 'The focus setting offsets where the schedule starts within the day. "Morning" starts at 08:00, "Midday" shifts to ~12:20, and "Afternoon" shifts to ~15:00. Same stops, different pacing — compare how focus changes the feel of the day.',
      stops: [
        { id: 'tb', travelMin: 0 },
        { id: 'cg', travelMin: 15 },
        { id: 'bb', travelMin: 12 },
      ],
      dayStart: DAY_START,
      dayEnd: DAY_END,
      mode: 'focus',
    },
    compact: {
      label: 'Compact vs Sparse',
      desc: 'The same three stops shown in compact mode (tightly packed in the morning) versus sparse mode (evenly distributed across the day with gaps). Toggle the view to compare scheduling strategies.',
      stops: [
        { id: 'tb', travelMin: 0 },
        { id: 'cg', travelMin: 15 },
        { id: 'hp', travelMin: 18 },
      ],
      dayStart: DAY_START,
      dayEnd: DAY_END,
      mode: 'both',
    },
  };

  var currentScenario = 'basic';

  /* ================================================================
   * 4. STEP GENERATORS
   * ================================================================ */

  function generateFocusSteps(sc) {
    var stops = sc.stops;
    var steps = [];
    var span = sc.dayEnd - sc.dayStart;

    steps.push({
      type: 'init',
      pseudoLine: 0,
      stops: stops.map(function (s) { return s.id; }),
      isFocus: true,
    });

    var focuses = [
      { key: 'morning', label: 'Morning Focus', shift: 0, day: 1 },
      { key: 'midday', label: 'Midday Focus', shift: Math.floor(span / 3), day: 2 },
      { key: 'afternoon', label: 'Afternoon Focus', shift: Math.floor(span / 1.8), day: 3 },
    ];

    var allDayStops = [[], [], []];

    for (var fi = 0; fi < focuses.length; fi++) {
      var focus = focuses[fi];
      var cursor = sc.dayStart + focus.shift;

      steps.push({
        type: 'mode_label',
        pseudoLine: 1,
        mode: focus.key,
        label: focus.label + ' — cursor starts at ' + minsToTime(cursor),
      });

      for (var i = 0; i < stops.length; i++) {
        var s = stops[i];
        var data = STOPS_DATA[s.id];
        var stayMin = data.stayMin;
        var travel = i === 0 ? 0 : s.travelMin;
        var propose = cursor + travel;

        steps.push({
          type: 'propose',
          pseudoLine: 6,
          stopId: s.id,
          arrive: propose,
          depart: propose + stayMin,
          day: focus.day,
        });

        steps.push({
          type: 'schedule',
          pseudoLine: 21,
          stopId: s.id,
          arrive: propose,
          depart: propose + stayMin,
          day: focus.day,
          status: 'scheduled',
        });

        allDayStops[fi].push({ id: s.id, arrive: propose, depart: propose + stayMin, status: 'scheduled' });
        cursor = propose + stayMin;
      }

      if (fi < focuses.length - 1) {
        steps.push({
          type: 'compact_done',
          pseudoLine: 23,
          day1: allDayStops[0],
          day2: allDayStops[1],
        });
      }
    }

    steps.push({
      type: 'complete',
      pseudoLine: 23,
      day1: allDayStops[0],
      day2: allDayStops[1],
      day3: allDayStops[2],
      totalDays: 1,
      isFocusComparison: true,
    });

    return steps;
  }

  function generateSteps(scenarioKey) {
    var sc = SCENARIOS[scenarioKey];
    var stops = sc.stops;
    var steps = [];

    if (scenarioKey === 'compact') {
      return generateCompactVsSparseSteps(sc);
    }
    if (scenarioKey === 'focus') {
      return generateFocusSteps(sc);
    }

    // Init
    steps.push({
      type: 'init',
      pseudoLine: 0,
      stops: stops.map(function (s) { return s.id; }),
    });

    var cursor = sc.dayStart;
    var day = 1;
    var scheduled = [];
    var day1 = [];
    var day2 = [];

    // Sort fixed-time stops: place non-fixed first, then fixed at right time
    var ordered = stops.slice();
    if (scenarioKey === 'fixed') {
      // Separate fixed and non-fixed, schedule non-fixed first then fixed
      var nonFixed = [];
      var fixed = [];
      for (var i = 0; i < ordered.length; i++) {
        if (ordered[i].fixedTime) fixed.push(ordered[i]);
        else nonFixed.push(ordered[i]);
      }
      // Insert fixed stops in order by time among non-fixed
      ordered = [];
      var fi = 0;
      for (var i = 0; i < nonFixed.length; i++) {
        // Check if any fixed stop goes before next non-fixed cursor position
        ordered.push(nonFixed[i]);
      }
      for (var i = 0; i < fixed.length; i++) {
        ordered.push(fixed[i]);
      }
      // Actually reorder: we want to schedule them in a sensible order
      // Place morning stops first, then fixed, then afternoon
      ordered = [nonFixed[0]].concat(fixed).concat(nonFixed.slice(1));
    }

    steps.push({
      type: 'order',
      pseudoLine: 2,
      ordered: ordered.map(function (s) { return s.id; }),
    });

    for (var i = 0; i < ordered.length; i++) {
      var s = ordered[i];
      var data = STOPS_DATA[s.id];
      var stayMin = s.overrideStay || data.stayMin;
      var travel = (i === 0) ? 0 : s.travelMin;

      // Travel step
      if (travel > 0) {
        steps.push({
          type: 'travel',
          pseudoLine: 5,
          stopId: s.id,
          from: cursor,
          travelMin: travel,
        });
      }

      var propose = cursor + travel;

      // Fixed time handling
      if (s.fixedTime) {
        propose = s.fixedTime;
        steps.push({
          type: 'propose',
          pseudoLine: 6,
          stopId: s.id,
          arrive: propose,
          depart: propose + stayMin,
          day: day,
          isFixed: true,
        });

        steps.push({
          type: 'check_desired',
          pseudoLine: 15,
          stopId: s.id,
          fixedTime: s.fixedTime,
          arrive: propose,
        });

        // Check if it fits in day
        if (propose + stayMin > sc.dayEnd) {
          steps.push({
            type: 'reject',
            pseudoLine: 19,
            stopId: s.id,
            reason: 'Fixed time exceeds day window',
          });
          steps.push({
            type: 'overflow',
            pseudoLine: 19,
            stopId: s.id,
          });
          continue;
        }

        steps.push({
          type: 'schedule',
          pseudoLine: 21,
          stopId: s.id,
          arrive: propose,
          depart: propose + stayMin,
          day: day,
          status: 'scheduled',
        });

        if (day === 1) day1.push({ id: s.id, arrive: propose, depart: propose + stayMin, status: 'scheduled' });
        else day2.push({ id: s.id, arrive: propose, depart: propose + stayMin, status: 'scheduled' });

        cursor = propose + stayMin;
        scheduled.push(s.id);
        continue;
      }

      // Propose step
      steps.push({
        type: 'propose',
        pseudoLine: 6,
        stopId: s.id,
        arrive: propose,
        depart: propose + stayMin,
        day: day,
      });

      var nudged = false;
      var finalArrive = propose;

      // Check opening hours
      if (data.openingHours) {
        var hours = parseOpeningHours(data.openingHours);
        steps.push({
          type: 'check_opening_hours',
          pseudoLine: 9,
          stopId: s.id,
          openStr: data.openingHours,
          openTime: hours ? hours.open : 0,
          closeTime: hours ? hours.close : 0,
          proposed: propose,
        });

        if (hours && propose < hours.open) {
          // Nudge forward
          finalArrive = hours.open;
          nudged = true;
          steps.push({
            type: 'nudge',
            pseudoLine: 11,
            stopId: s.id,
            from: propose,
            to: finalArrive,
            reason: 'Opens at ' + minsToTime(hours.open) + ', proposed ' + minsToTime(propose),
          });
        } else if (hours && propose + stayMin > hours.close) {
          // Doesn't fit today
          if (day === 1) {
            steps.push({
              type: 'reject',
              pseudoLine: 12,
              stopId: s.id,
              reason: 'Closes at ' + minsToTime(hours.close) + ', not enough time',
            });
            steps.push({
              type: 'advance_day',
              pseudoLine: 19,
              stopId: s.id,
            });
            day = 2;
            cursor = sc.dayStart;
            finalArrive = Math.max(cursor, hours.open);
            nudged = finalArrive !== cursor;
            if (nudged) {
              steps.push({
                type: 'nudge',
                pseudoLine: 11,
                stopId: s.id,
                from: cursor,
                to: finalArrive,
                reason: 'Day 2: opens at ' + minsToTime(hours.open),
              });
            }
          } else {
            steps.push({
              type: 'overflow',
              pseudoLine: 12,
              stopId: s.id,
            });
            continue;
          }
        }
      }

      // Check desired time window
      if (s.desiredStart != null && s.desiredEnd != null) {
        steps.push({
          type: 'check_desired',
          pseudoLine: 15,
          stopId: s.id,
          desiredStart: s.desiredStart,
          desiredEnd: s.desiredEnd,
          proposed: finalArrive,
        });
        if (finalArrive < s.desiredStart) {
          // Too early — nudge into window
          var oldArrive = finalArrive;
          finalArrive = s.desiredStart;
          nudged = true;
          steps.push({
            type: 'nudge',
            pseudoLine: 16,
            stopId: s.id,
            from: oldArrive,
            to: finalArrive,
            reason: 'Desired window starts at ' + minsToTime(s.desiredStart) + ', waiting',
          });
        } else if (finalArrive + stayMin > s.desiredEnd) {
          // Arrives too late for desired window — soft nudge warning, still schedule
          nudged = true;
          steps.push({
            type: 'nudge',
            pseudoLine: 16,
            stopId: s.id,
            from: finalArrive,
            to: finalArrive,
            reason: 'Outside desired window (' + minsToTime(s.desiredStart) + '–' + minsToTime(s.desiredEnd) + '), scheduling anyway',
          });
        }
      }

      // Check active window (day end)
      if (finalArrive + stayMin > sc.dayEnd) {
        if (day === 1) {
          steps.push({
            type: 'check_active_window',
            pseudoLine: 18,
            stopId: s.id,
            depart: finalArrive + stayMin,
            dayEnd: sc.dayEnd,
          });
          steps.push({
            type: 'advance_day',
            pseudoLine: 19,
            stopId: s.id,
          });
          day = 2;
          cursor = sc.dayStart;
          finalArrive = cursor;

          // Re-check opening hours on day 2
          if (data.openingHours) {
            var hours2 = parseOpeningHours(data.openingHours);
            if (hours2 && finalArrive < hours2.open) {
              finalArrive = hours2.open;
              nudged = true;
            }
          }

          steps.push({
            type: 'propose',
            pseudoLine: 6,
            stopId: s.id,
            arrive: finalArrive,
            depart: finalArrive + stayMin,
            day: 2,
          });
        } else {
          steps.push({
            type: 'overflow',
            pseudoLine: 19,
            stopId: s.id,
          });
          continue;
        }
      }

      // Schedule
      var status = nudged ? 'nudged' : 'scheduled';
      steps.push({
        type: 'schedule',
        pseudoLine: 21,
        stopId: s.id,
        arrive: finalArrive,
        depart: finalArrive + stayMin,
        day: day,
        status: status,
      });

      if (day === 1) day1.push({ id: s.id, arrive: finalArrive, depart: finalArrive + stayMin, status: status });
      else day2.push({ id: s.id, arrive: finalArrive, depart: finalArrive + stayMin, status: status });

      cursor = finalArrive + stayMin;
      scheduled.push(s.id);
    }

    // Complete
    steps.push({
      type: 'complete',
      pseudoLine: 23,
      day1: day1,
      day2: day2,
      totalDays: day2.length > 0 ? 2 : 1,
    });

    return steps;
  }

  function generateCompactVsSparseSteps(sc) {
    var stops = sc.stops;
    var steps = [];

    steps.push({
      type: 'init',
      pseudoLine: 0,
      stops: stops.map(function (s) { return s.id; }),
    });

    // Phase 1: Compact scheduling
    steps.push({
      type: 'mode_label',
      pseudoLine: 1,
      mode: 'compact',
      label: 'Compact Mode — packing stops tightly',
    });

    var cursor = 600; // 10:00
    var compactScheduled = [];
    for (var i = 0; i < stops.length; i++) {
      var s = stops[i];
      var data = STOPS_DATA[s.id];
      var travel = (i === 0) ? 0 : s.travelMin;
      var arrive = cursor + travel;

      if (travel > 0) {
        steps.push({
          type: 'travel',
          pseudoLine: 5,
          stopId: s.id,
          from: cursor,
          travelMin: travel,
        });
      }

      steps.push({
        type: 'propose',
        pseudoLine: 6,
        stopId: s.id,
        arrive: arrive,
        depart: arrive + data.stayMin,
        day: 1,
      });

      steps.push({
        type: 'schedule',
        pseudoLine: 21,
        stopId: s.id,
        arrive: arrive,
        depart: arrive + data.stayMin,
        day: 1,
        status: 'scheduled',
      });

      compactScheduled.push({ id: s.id, arrive: arrive, depart: arrive + data.stayMin, status: 'scheduled' });
      cursor = arrive + data.stayMin;
    }

    steps.push({
      type: 'compact_done',
      pseudoLine: 23,
      scheduled: compactScheduled,
    });

    // Phase 2: Sparse scheduling
    steps.push({
      type: 'mode_label',
      pseudoLine: 1,
      mode: 'sparse',
      label: 'Sparse Mode — distributing stops evenly',
    });

    // Distribute across 10:00-18:00 evenly
    var sparseStart = 600;  // 10:00
    var sparseEnd = 1080;   // 18:00
    var totalStay = 0;
    for (var i = 0; i < stops.length; i++) {
      totalStay += STOPS_DATA[stops[i].id].stayMin;
    }
    var totalGap = sparseEnd - sparseStart - totalStay;
    var gapEach = Math.floor(totalGap / (stops.length));
    var sparseCursor = sparseStart;
    var sparseScheduled = [];

    for (var i = 0; i < stops.length; i++) {
      var s = stops[i];
      var data = STOPS_DATA[s.id];
      var arrive = sparseCursor + (i === 0 ? 0 : gapEach);

      steps.push({
        type: 'propose',
        pseudoLine: 6,
        stopId: s.id,
        arrive: arrive,
        depart: arrive + data.stayMin,
        day: 2,
        isSparse: true,
      });

      steps.push({
        type: 'schedule',
        pseudoLine: 21,
        stopId: s.id,
        arrive: arrive,
        depart: arrive + data.stayMin,
        day: 2,
        status: 'scheduled',
        isSparse: true,
      });

      sparseScheduled.push({ id: s.id, arrive: arrive, depart: arrive + data.stayMin, status: 'scheduled' });
      sparseCursor = arrive + data.stayMin;
    }

    steps.push({
      type: 'complete',
      pseudoLine: 23,
      day1: compactScheduled,
      day2: sparseScheduled,
      totalDays: 1,
      isComparison: true,
    });

    return steps;
  }

  /* ================================================================
   * 5. DOM REFS
   * ================================================================ */

  var timelineSvg = document.getElementById('schedTimeline');
  var timeline2Svg = document.getElementById('schedTimeline2');
  var timeline2Wrap = document.getElementById('schedTimeline2Wrap');
  var timeline3Svg = document.getElementById('schedTimeline3');
  var timeline3Wrap = document.getElementById('schedTimeline3Wrap');
  var day2Label = document.getElementById('schedDay2Label');
  var day3Label = document.getElementById('schedDay3Label');
  var openingHoursDiv = document.getElementById('schedOpeningHours');
  var openingSvg = document.getElementById('schedOpeningSvg');
  var constraintText = document.getElementById('schedConstraintText');
  var stopsListEl = document.getElementById('schedStopsList');
  var dayLabel = document.getElementById('schedDayLabel');

  var phaseEl = document.getElementById('schedPhase');
  var statsEl = document.getElementById('schedStats');
  var descEl = document.getElementById('schedDescription');
  var pseudoEl = document.getElementById('schedPseudocode');

  var playBtn = document.getElementById('schedPlayBtn');
  var pauseBtn = document.getElementById('schedPauseBtn');
  var stepBtn = document.getElementById('schedStepBtn');
  var resetBtn = document.getElementById('schedResetBtn');
  var speedSlider = document.getElementById('schedSpeedSlider');
  var speedValue = document.getElementById('schedSpeedValue');

  if (!timelineSvg) return;

  /* ================================================================
   * 6. ANIMATION STATE
   * ================================================================ */

  var state = {
    steps: [],
    stepIndex: 0,
    subProgress: 0,
    playing: false,
    speed: 1,
    day1Blocks: [],
    day2Blocks: [],
    day3Blocks: [],
    currentStopId: null,
    stopStatuses: {},
    compactMode: true,
  };

  var DURATIONS = {
    init: 800,
    order: 600,
    travel: 700,
    propose: 800,
    check_opening_hours: 900,
    nudge: 1000,
    check_desired: 700,
    check_active_window: 700,
    schedule: 700,
    reject: 800,
    advance_day: 900,
    overflow: 800,
    complete: 1200,
    mode_label: 900,
    compact_done: 800,
  };

  var animFrame = null, lastTimestamp = 0;

  /* ================================================================
   * 7. SVG TIMELINE RENDERING
   * ================================================================ */

  var TL_PADDING_LEFT = 50;
  var TL_PADDING_RIGHT = 20;
  var TL_TOP = 20;
  var TL_BLOCK_H = 36;
  var TL_AXIS_Y = TL_TOP + TL_BLOCK_H + 8;

  function timeToX(minutes, svgWidth) {
    var usable = svgWidth - TL_PADDING_LEFT - TL_PADDING_RIGHT;
    var pct = (minutes - DAY_START) / (DAY_END - DAY_START);
    return TL_PADDING_LEFT + pct * usable;
  }

  function buildTimelineGrid(svg, overrideWidth) {
    if (!svg) return { width: 700, baseHtml: '' };
    var w = overrideWidth || svg.getBoundingClientRect().width || 700;
    svg.setAttribute('viewBox', '0 0 ' + w + ' 120');
    var html = '';

    // Hour grid lines and labels
    for (var h = 8; h <= 21; h++) {
      var m = h * 60;
      var x = timeToX(m, w);
      html += '<line x1="' + x + '" y1="' + (TL_TOP - 4) + '" x2="' + x + '" y2="' + (TL_AXIS_Y + 4) + '" class="sched-demo-grid-line"/>';
      html += '<text x="' + x + '" y="' + (TL_AXIS_Y + 18) + '" text-anchor="middle" class="sched-demo-grid-label">' + (h < 10 ? '0' : '') + h + ':00</text>';
    }

    // Axis line
    html += '<line x1="' + TL_PADDING_LEFT + '" y1="' + TL_AXIS_Y + '" x2="' + (w - TL_PADDING_RIGHT) + '" y2="' + TL_AXIS_Y + '" stroke="rgba(255,255,255,0.15)" stroke-width="1"/>';

    return { width: w, baseHtml: html };
  }

  function renderTimeline(svg, blocks, w, baseHtml, cursorMin, proposedBlock) {
    if (!svg) return;
    var html = baseHtml;

    // Cursor line
    if (typeof cursorMin === 'number' && cursorMin >= DAY_START && cursorMin <= DAY_END) {
      var cx = timeToX(cursorMin, w);
      html += '<line x1="' + cx + '" y1="' + (TL_TOP - 8) + '" x2="' + cx + '" y2="' + (TL_AXIS_Y + 4) + '" class="sched-demo-cursor-line"/>';
      html += '<text x="' + cx + '" y="' + (TL_TOP - 10) + '" text-anchor="middle" fill="#ec5643" font-size="9" font-weight="600">' + minsToTime(cursorMin) + '</text>';
    }

    // Scheduled blocks
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      html += renderBlock(b, w);
    }

    // Proposed block (tentative)
    if (proposedBlock) {
      html += renderBlock(proposedBlock, w);
    }

    // Travel lines between blocks
    for (var i = 1; i < blocks.length; i++) {
      var prev = blocks[i - 1];
      var curr = blocks[i];
      if (curr.arrive > prev.depart) {
        var x1 = timeToX(prev.depart, w);
        var x2 = timeToX(curr.arrive, w);
        var y = TL_TOP + TL_BLOCK_H / 2;
        html += '<line x1="' + x1 + '" y1="' + y + '" x2="' + x2 + '" y2="' + y + '" class="sched-demo-travel-line"/>';
        var mid = (x1 + x2) / 2;
        var gap = curr.arrive - prev.depart;
        html += '<text x="' + mid + '" y="' + (y - 6) + '" text-anchor="middle" class="sched-demo-travel-label">' + gap + 'min</text>';
      }
    }

    svg.innerHTML = html;
  }

  function renderBlock(b, w) {
    var x1 = timeToX(b.arrive, w);
    var x2 = timeToX(b.depart, w);
    var bw = Math.max(x2 - x1, 2);
    var cls = 'sched-demo-stop-block sched-demo-stop-block--' + (b.status || 'scheduled');
    var data = STOPS_DATA[b.id];
    var name = data ? data.name : b.id;
    var html = '';
    html += '<rect x="' + x1 + '" y="' + TL_TOP + '" width="' + bw + '" height="' + TL_BLOCK_H + '" class="' + cls + '"/>';
    // Name label
    if (bw > 30) {
      var tx = x1 + bw / 2;
      html += '<text x="' + tx + '" y="' + (TL_TOP + TL_BLOCK_H / 2 - 2) + '" text-anchor="middle" class="sched-demo-stop-label">' + truncName(name, bw) + '</text>';
      html += '<text x="' + tx + '" y="' + (TL_TOP + TL_BLOCK_H / 2 + 10) + '" text-anchor="middle" class="sched-demo-stop-time-label">' + minsToTime(b.arrive) + '-' + minsToTime(b.depart) + '</text>';
    }
    return html;
  }

  function truncName(name, width) {
    var maxChars = Math.floor(width / 6);
    if (name.length <= maxChars) return name;
    return name.substring(0, maxChars - 1) + '\u2026';
  }

  /* ================================================================
   * 8. OPENING HOURS BAR RENDERING
   * ================================================================ */

  function renderOpeningHoursBar(stopId) {
    var data = STOPS_DATA[stopId];
    if (!data || !data.openingHours) {
      openingHoursDiv.hidden = true;
      return;
    }
    openingHoursDiv.hidden = false;
    var hours = parseOpeningHours(data.openingHours);
    if (!hours) { openingHoursDiv.hidden = true; return; }

    var w = openingSvg.getBoundingClientRect().width || 700;
    openingSvg.setAttribute('viewBox', '0 0 ' + w + ' 36');
    var html = '';

    // Closed bar (full day)
    var xStart = timeToX(DAY_START, w);
    var xEnd = timeToX(DAY_END, w);
    html += '<rect x="' + xStart + '" y="6" width="' + (xEnd - xStart) + '" height="16" class="sched-demo-opening-bar sched-demo-opening-bar--closed"/>';

    // Open bar
    var xOpen = timeToX(Math.max(hours.open, DAY_START), w);
    var xClose = timeToX(Math.min(hours.close, DAY_END), w);
    html += '<rect x="' + xOpen + '" y="6" width="' + (xClose - xOpen) + '" height="16" class="sched-demo-opening-bar sched-demo-opening-bar--open"/>';

    // Labels
    html += '<text x="' + xOpen + '" y="32" text-anchor="middle" class="sched-demo-opening-label">' + minsToTime(hours.open) + '</text>';
    html += '<text x="' + xClose + '" y="32" text-anchor="middle" class="sched-demo-opening-label">' + minsToTime(hours.close) + '</text>';

    // Stop name
    html += '<text x="' + ((xOpen + xClose) / 2) + '" y="18" text-anchor="middle" fill="#e8edec" font-size="10" font-weight="600">' + data.name + ' — Open</text>';

    openingSvg.innerHTML = html;
  }

  /* ================================================================
   * 9. STOPS LIST RENDERING
   * ================================================================ */

  function renderStopsList(stopIds) {
    var html = '';
    for (var i = 0; i < stopIds.length; i++) {
      var id = stopIds[i];
      var data = STOPS_DATA[id];
      var status = state.stopStatuses[id] || '';
      var cls = 'sched-demo-stop-item';
      if (status) cls += ' ' + status;
      if (state.currentStopId === id) cls += ' current';

      var icon = '';
      if (status === 'scheduled') icon = '<span class="sched-demo-stop-item-icon" style="color:#4a9e8e">&#10003;</span>';
      else if (status === 'nudged') icon = '<span class="sched-demo-stop-item-icon" style="color:#f97316">&#8634;</span>';
      else if (status === 'rejected') icon = '<span class="sched-demo-stop-item-icon" style="color:#ec5643">&times;</span>';
      else icon = '<span class="sched-demo-stop-item-icon" style="color:#5f7a74">&#9679;</span>';

      var info = data.stayMin + 'min';
      if (data.openingHours) info += ' | ' + data.openingHours;

      html += '<div class="' + cls + '">' +
        icon +
        '<span class="sched-demo-stop-item-name">' + data.name + '</span>' +
        '<span class="sched-demo-stop-item-info">' + info + '</span>' +
        '</div>';
    }
    stopsListEl.innerHTML = html || '<div style="color:#5f7a74;font-size:12px;padding:8px">No stops</div>';
  }

  /* ================================================================
   * 10. PSEUDOCODE
   * ================================================================ */

  function renderPseudo() {
    var code = pseudoEl.querySelector('code');
    var html = '';
    for (var i = 0; i < PSEUDO_SCHEDULE.length; i++) {
      html += '<span class="line" data-line="' + i + '">' +
        PSEUDO_SCHEDULE[i].replace(/</g, '&lt;').replace(/>/g, '&gt;') +
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
   * 11. PHASE & CONSTRAINT INFO
   * ================================================================ */

  function showPhase(step) {
    var msgs = {
      init: 'Initialising scheduler...',
      order: 'Ordering stops...',
      travel: 'Calculating travel to ' + (STOPS_DATA[step.stopId] ? STOPS_DATA[step.stopId].name : ''),
      propose: 'Proposing time for ' + (STOPS_DATA[step.stopId] ? STOPS_DATA[step.stopId].name : ''),
      check_opening_hours: 'Checking opening hours...',
      nudge: 'Nudging arrival time...',
      check_desired: step.fixedTime ? 'Checking fixed time constraint...' : 'Checking desired time window...',
      check_active_window: 'Checking day window...',
      schedule: 'Scheduling ' + (STOPS_DATA[step.stopId] ? STOPS_DATA[step.stopId].name : ''),
      reject: 'Stop rejected for this day',
      advance_day: 'Advancing to next day...',
      overflow: 'Stop overflows — cannot fit',
      complete: 'Scheduling complete!',
      mode_label: step.label || '',
      compact_done: 'Compact scheduling done',
    };
    phaseEl.textContent = msgs[step.type] || '';
  }

  function showConstraint(step) {
    var data = step.stopId ? STOPS_DATA[step.stopId] : null;
    var name = data ? data.name : '';

    switch (step.type) {
      case 'init':
        constraintText.innerHTML = 'Ready to schedule ' + (step.stops ? step.stops.length : 0) + ' stops into the day.';
        break;
      case 'travel':
        constraintText.innerHTML = '<span class="constraint-check">Travel:</span> ' + step.travelMin + ' min from ' + minsToTime(step.from) + ' to ' + name;
        break;
      case 'propose':
        constraintText.innerHTML = '<span class="constraint-check">Proposing:</span> ' + name + ' at ' + minsToTime(step.arrive) + ' - ' + minsToTime(step.depart) + (step.isFixed ? ' (fixed time)' : '') + (step.isSparse ? ' (sparse mode)' : '');
        break;
      case 'check_opening_hours':
        constraintText.innerHTML = '<span class="constraint-check">Checking opening hours for ' + name + '...</span> opens ' + minsToTime(step.openTime) + '-' + minsToTime(step.closeTime) + ', proposed ' + minsToTime(step.proposed);
        break;
      case 'nudge':
        constraintText.innerHTML = '<span class="constraint-fail">' + name + ' nudged:</span> ' + step.reason + ' &#8594; moved to ' + minsToTime(step.to);
        break;
      case 'check_desired':
        if (step.fixedTime) {
          constraintText.innerHTML = '<span class="constraint-check">Fixed time:</span> ' + name + ' must be at ' + minsToTime(step.fixedTime);
        } else if (step.desiredStart != null) {
          constraintText.innerHTML = '<span class="constraint-check">Desired window:</span> ' + name + ' preferred ' + minsToTime(step.desiredStart) + '–' + minsToTime(step.desiredEnd) + ', proposed ' + minsToTime(step.proposed);
        }
        break;
      case 'check_active_window':
        constraintText.innerHTML = '<span class="constraint-fail">Day window exceeded:</span> depart ' + minsToTime(step.depart) + ' &gt; end ' + minsToTime(step.dayEnd);
        break;
      case 'schedule':
        var statusLabel = step.status === 'nudged' ? 'Nudged' : 'Scheduled';
        constraintText.innerHTML = '<span class="constraint-ok">' + statusLabel + ':</span> ' + name + ' at ' + minsToTime(step.arrive) + ' - ' + minsToTime(step.depart) + ' (Day ' + step.day + ')';
        break;
      case 'reject':
        constraintText.innerHTML = '<span class="constraint-fail">Rejected:</span> ' + name + ' — ' + (step.reason || 'does not fit');
        break;
      case 'advance_day':
        constraintText.innerHTML = '<span class="constraint-check">Advancing to Day 2</span> — cursor reset to ' + minsToTime(DAY_START);
        break;
      case 'overflow':
        constraintText.innerHTML = '<span class="constraint-fail">Overflow:</span> ' + name + ' cannot fit in any day';
        break;
      case 'complete':
        var msg = 'Done! ';
        if (step.isFocusComparison) {
          msg += 'Same 3 stops scheduled 3 ways — Morning starts at 08:00, Midday at 12:20, Afternoon at 15:00. The focus setting shifts where the day begins.';
        } else if (step.isComparison) {
          msg += 'Compact: ' + step.day1.length + ' stops packed tightly. Sparse: ' + step.day2.length + ' stops spread out.';
        } else {
          msg += step.day1.length + ' stops on Day 1';
          if (step.day2 && step.day2.length > 0) msg += ', ' + step.day2.length + ' stops on Day 2';
        }
        constraintText.innerHTML = '<span class="constraint-ok">' + msg + '</span>';
        break;
      case 'mode_label':
        constraintText.innerHTML = '<span class="constraint-check">' + (step.label || '') + '</span>';
        break;
      default:
        break;
    }
  }

  /* ================================================================
   * 12. APPLY STEP
   * ================================================================ */

  var tlGrid1 = null, tlGrid2 = null, tlGrid3 = null;
  var currentCursor = DAY_START;
  var proposedBlock = null;

  function rebuildGrids() {
    tlGrid1 = buildTimelineGrid(timelineSvg);
    // Use day 1's width for day 2/3 so they match even when hidden
    tlGrid2 = buildTimelineGrid(timeline2Svg, tlGrid1.width);
    tlGrid3 = buildTimelineGrid(timeline3Svg, tlGrid1.width);
  }

  function applyStep(step) {
    highlightPseudo(step.pseudoLine);
    showPhase(step);
    showConstraint(step);

    var sc = SCENARIOS[currentScenario];
    var allStopIds = sc.stops.map(function (s) { return s.id; });

    switch (step.type) {
      case 'init':
        state.day1Blocks = [];
        state.day2Blocks = [];
        state.day3Blocks = [];
        state.stopStatuses = {};
        state.currentStopId = null;
        currentCursor = sc.dayStart;
        proposedBlock = null;
        timeline2Wrap.hidden = true;
        timeline3Wrap.hidden = true;
        openingHoursDiv.hidden = true;
        if (step.isFocus) {
          dayLabel.textContent = 'Morning Focus';
          timeline2Wrap.hidden = false;
          timeline3Wrap.hidden = false;
          day2Label.textContent = 'Midday Focus';
          day3Label.textContent = 'Afternoon Focus';
        } else {
          dayLabel.textContent = currentScenario === 'compact' ? 'Compact' : 'Day 1';
        }
        rebuildGrids();
        renderTimeline(timelineSvg, [], tlGrid1.width, tlGrid1.baseHtml, currentCursor, null);
        if (step.isFocus) {
          renderTimeline(timeline2Svg, [], tlGrid2.width, tlGrid2.baseHtml, null, null);
          renderTimeline(timeline3Svg, [], tlGrid3.width, tlGrid3.baseHtml, null, null);
        }
        renderStopsList(allStopIds);
        break;

      case 'order':
        renderStopsList(step.ordered || allStopIds);
        break;

      case 'travel':
        state.currentStopId = step.stopId;
        currentCursor = step.from + step.travelMin;
        renderTimeline(timelineSvg, state.day1Blocks, tlGrid1.width, tlGrid1.baseHtml, currentCursor, null);
        renderStopsList(allStopIds);
        break;

      case 'propose':
        state.currentStopId = step.stopId;
        proposedBlock = { id: step.stopId, arrive: step.arrive, depart: step.depart, status: 'proposed' };
        if (step.day === 3) {
          renderTimeline(timeline3Svg, state.day3Blocks, tlGrid3.width, tlGrid3.baseHtml, step.arrive, proposedBlock);
        } else if (step.isSparse || step.day === 2) {
          if (currentScenario === 'compact') {
            timeline2Wrap.hidden = false;
            renderTimeline(timeline2Svg, state.day2Blocks, tlGrid2.width, tlGrid2.baseHtml, null, proposedBlock);
          } else {
            timeline2Wrap.hidden = false;
            renderTimeline(timeline2Svg, state.day2Blocks, tlGrid2.width, tlGrid2.baseHtml, step.arrive, proposedBlock);
          }
        } else {
          renderTimeline(timelineSvg, state.day1Blocks, tlGrid1.width, tlGrid1.baseHtml, step.arrive, proposedBlock);
        }
        renderStopsList(allStopIds);
        break;

      case 'check_opening_hours':
        renderOpeningHoursBar(step.stopId);
        break;

      case 'nudge':
        proposedBlock = { id: step.stopId, arrive: step.to, depart: step.to + (STOPS_DATA[step.stopId] ? STOPS_DATA[step.stopId].stayMin : 60), status: 'nudged' };
        var targetSvg = (state.day2Blocks.length > 0 && currentScenario !== 'compact') ? timeline2Svg : timelineSvg;
        var targetGrid = (state.day2Blocks.length > 0 && currentScenario !== 'compact') ? tlGrid2 : tlGrid1;
        var targetBlocks = (state.day2Blocks.length > 0 && currentScenario !== 'compact') ? state.day2Blocks : state.day1Blocks;
        renderTimeline(targetSvg, targetBlocks, targetGrid.width, targetGrid.baseHtml, step.to, proposedBlock);
        break;

      case 'check_desired':
        // Visual emphasis for fixed time
        break;

      case 'check_active_window':
        break;

      case 'schedule':
        proposedBlock = null;
        state.stopStatuses[step.stopId] = step.status;
        state.currentStopId = null;
        var block = { id: step.stopId, arrive: step.arrive, depart: step.depart, status: step.status };

        if (step.isSparse) {
          state.day2Blocks.push(block);
          timeline2Wrap.hidden = false;
          renderTimeline(timeline2Svg, state.day2Blocks, tlGrid2.width, tlGrid2.baseHtml, null, null);
        } else if (step.day === 3) {
          state.day3Blocks.push(block);
          timeline3Wrap.hidden = false;
          renderTimeline(timeline3Svg, state.day3Blocks, tlGrid3.width, tlGrid3.baseHtml, step.depart, null);
        } else if (step.day === 2) {
          state.day2Blocks.push(block);
          timeline2Wrap.hidden = false;
          renderTimeline(timeline2Svg, state.day2Blocks, tlGrid2.width, tlGrid2.baseHtml, step.depart, null);
        } else {
          state.day1Blocks.push(block);
          renderTimeline(timelineSvg, state.day1Blocks, tlGrid1.width, tlGrid1.baseHtml, step.depart, null);
        }
        currentCursor = step.depart;
        openingHoursDiv.hidden = true;
        renderStopsList(allStopIds);
        break;

      case 'reject':
        proposedBlock = { id: step.stopId, arrive: currentCursor, depart: currentCursor + 30, status: 'rejected' };
        renderTimeline(timelineSvg, state.day1Blocks, tlGrid1.width, tlGrid1.baseHtml, currentCursor, proposedBlock);
        state.stopStatuses[step.stopId] = 'rejected';
        renderStopsList(allStopIds);
        setTimeout(function () {
          proposedBlock = null;
          renderTimeline(timelineSvg, state.day1Blocks, tlGrid1.width, tlGrid1.baseHtml, currentCursor, null);
        }, 400);
        break;

      case 'advance_day':
        timeline2Wrap.hidden = false;
        dayLabel.textContent = 'Day 1';
        currentCursor = sc.dayStart;
        rebuildGrids();
        renderTimeline(timeline2Svg, state.day2Blocks, tlGrid2.width, tlGrid2.baseHtml, currentCursor, null);
        break;

      case 'overflow':
        state.stopStatuses[step.stopId] = 'rejected';
        renderStopsList(allStopIds);
        break;

      case 'mode_label':
        if (step.mode === 'sparse') {
          timeline2Wrap.hidden = false;
          dayLabel.textContent = 'Compact';
          day2Label.textContent = 'Sparse';
          state.day2Blocks = [];
          renderTimeline(timeline2Svg, [], tlGrid2.width, tlGrid2.baseHtml, null, null);
          state.stopStatuses = {};
          renderStopsList(allStopIds);
        } else if (step.mode === 'morning') {
          state.day1Blocks = [];
          state.stopStatuses = {};
          renderTimeline(timelineSvg, [], tlGrid1.width, tlGrid1.baseHtml, null, null);
          renderStopsList(allStopIds);
        } else if (step.mode === 'midday') {
          state.day2Blocks = [];
          state.stopStatuses = {};
          renderTimeline(timeline2Svg, [], tlGrid2.width, tlGrid2.baseHtml, null, null);
          renderStopsList(allStopIds);
        } else if (step.mode === 'afternoon') {
          state.day3Blocks = [];
          state.stopStatuses = {};
          renderTimeline(timeline3Svg, [], tlGrid3.width, tlGrid3.baseHtml, null, null);
          renderStopsList(allStopIds);
        } else {
          dayLabel.textContent = 'Compact';
        }
        break;

      case 'compact_done':
        // Compact phase finished
        break;

      case 'complete':
        proposedBlock = null;
        openingHoursDiv.hidden = true;
        statsEl.hidden = false;
        if (step.isFocusComparison) {
          statsEl.textContent = 'Same 3 stops scheduled at different start times: Morning (08:00), Midday (12:20), Afternoon (15:00).';
        } else if (step.isComparison) {
          statsEl.textContent = 'Compact: ' + step.day1.length + ' stops (morning). Sparse: ' + step.day2.length + ' stops (all day).';
        } else {
          var txt = 'Scheduled: ' + step.day1.length + ' stops on Day 1';
          if (step.day2 && step.day2.length > 0) txt += ', ' + step.day2.length + ' on Day 2';
          statsEl.textContent = txt;
        }
        renderTimeline(timelineSvg, state.day1Blocks, tlGrid1.width, tlGrid1.baseHtml, null, null);
        if (state.day2Blocks.length > 0) {
          renderTimeline(timeline2Svg, state.day2Blocks, tlGrid2.width, tlGrid2.baseHtml, null, null);
        }
        if (state.day3Blocks.length > 0) {
          renderTimeline(timeline3Svg, state.day3Blocks, tlGrid3.width, tlGrid3.baseHtml, null, null);
        }
        break;
    }
  }

  /* ================================================================
   * 13. TICK / ANIMATION LOOP
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
      try { applyStep(step); } catch (e) { console.error('applyStep error:', e); }
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
   * 14. CONTROLS
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
    state.day1Blocks = [];
    state.day2Blocks = [];
    state.day3Blocks = [];
    state.stopStatuses = {};
    state.currentStopId = null;
    currentCursor = SCENARIOS[currentScenario].dayStart;
    proposedBlock = null;

    phaseEl.textContent = '';
    statsEl.hidden = true;
    statsEl.textContent = '';
    constraintText.innerHTML = 'Press Play to start scheduling';
    highlightPseudo(-1);
    openingHoursDiv.hidden = true;
    timeline2Wrap.hidden = true;
    timeline3Wrap.hidden = true;
    dayLabel.textContent = currentScenario === 'compact' ? 'Compact' : currentScenario === 'focus' ? 'Morning Focus' : 'Day 1';

    rebuildGrids();
    renderTimeline(timelineSvg, [], tlGrid1.width, tlGrid1.baseHtml, null, null);

    var sc = SCENARIOS[currentScenario];
    renderStopsList(sc.stops.map(function (s) { return s.id; }));
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
   * 15. SCENARIO SWITCHING
   * ================================================================ */

  function switchScenario(key) {
    currentScenario = key;
    state.steps = generateSteps(key);
    descEl.textContent = SCENARIOS[key].desc;

    var tabs = document.querySelectorAll('.sched-demo-tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('active', tabs[i].getAttribute('data-scenario') === key);
    }

    reset();
  }

  var tabs = document.querySelectorAll('.sched-demo-tab');
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].addEventListener('click', function () {
      switchScenario(this.getAttribute('data-scenario'));
    });
  }

  /* ================================================================
   * 16. RESIZE HANDLING
   * ================================================================ */

  var resizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      rebuildGrids();
      renderTimeline(timelineSvg, state.day1Blocks, tlGrid1.width, tlGrid1.baseHtml, currentCursor, proposedBlock);
      if (!timeline2Wrap.hidden) {
        renderTimeline(timeline2Svg, state.day2Blocks, tlGrid2.width, tlGrid2.baseHtml, null, null);
      }
    }, 150);
  });

  /* ================================================================
   * 17. INIT
   * ================================================================ */

  renderPseudo();
  switchScenario('basic');

})();
