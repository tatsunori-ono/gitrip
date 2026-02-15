Legend

- **Fxx** – feature ID we can reuse later (“implement F07 next” etc.)
    
- **Depends on** – what must exist first
    
- Ordered so that if you go down the list, you never hit a feature whose dependency comes later.
    

---

## Phase 0 – Foundations (mostly done)

**F00 – Project skeleton & tooling (done)**  
Express server, EJS views, SQLite, basic layout, .env, npm scripts.

**F01 – Core data model in DB (done-ish)**  
Repos, branches, commits, snapshot JSON with `plan`.  
_Depends on: F00_

**F02 – Basic repo UI (done-ish)**  
“Repositories” page, create repo, view repo, pick branch.  
_Depends on: F01_

We might tweak schema later, but these are good enough to build on.

---

## Phase 1 – Planner Core

**F10 – `plan.json` schema stabilisation**  
Define the “current truth” of `plan`:

- `transport`, `activeHours`, `days[]`, `stops[]`
    
- fields for `stayMin`, `arrive`, `depart`, `prevTravelMin`, `desiredStart`, `desiredEnd`, `strictOrder`, `startFirst`, `openingHours`, `__nudged`, etc.
    

_Depends on: F01_

---

**F11 – Minimal auto-plan engine (single-day, sequential)** _(already have a version, but we’ll tidy it)_

- Take ordered list of places (name, optional coords, stayMin).
    
- Use **haversine or constant gap** for travel time.
    
- Honour **activeHours** and **breakMinBetweenStops**.
    
- Output a single day’s schedule with non-overlapping stops.
    

_Depends on: F10_

---

**F12 – Multi-day support**

- Respect `startDate`/`endDate`.
    
- Distribute stops across days, spill to next day when time runs out.
    
- `targetDays` cap.
    

_Depends on: F11_

---

## Phase 2 – Constraints & Preferences (fix the “not working” bits)

**F20 – Opening-hours integration (already partially there)**

- Use `openingHours` string on stop (filled from search or manual).
    
- `applyOpeningHours` ensures each stop is inside valid intervals.
    
- Mark nudged stops and reason: `desired`, `opening_hours`, `active_window`.
    

_Depends on: F11, F10_

---

**F21 – Desired window constraints (fix + test)**

Currently some options don’t behave as expected. Here we:

- Make **`desiredStart`** and **`desiredEnd`** truly soft constraints:
    
    - Try to place within `[desiredStart, desiredEnd]`.
        
    - If impossible, nudge to closest feasible time or move day.
        
- Verify behaviour with cases:
    
    - Only start, only end, both, neither.
        

_Depends on: F20_

---

**F22 – Strict order & “start here” semantics (fix + test)**

- If any stop has `strictOrder` → planner must respect that order segment.
    
- `startFirst` defines the starting anchor for NN / initial sequence.
    
- We probably implement:
    
    - Group of strictly ordered stops that the NN algorithm cannot reorder.
        
    - Ensure planner doesn’t reshuffle those segments.
        

_Depends on: F11_

---

**F23 – Compact vs sparse scheduling (fix gap logic)**

- **Compact**: minimal extra gaps, only `breakMinBetweenStops`.
    
- **Sparse**: planner inserts extra “chill” gaps (e.g. +30–60 min) between stops, but still fits inside day window.
    
- This was partially implemented via `cursor` shift; we’ll formalise:
    
    - Decide explicit extra-gap formula.
        
    - Ensure UI text matches behaviour.
        

_Depends on: F11_

---

**F24 – Focus (morning / midday / night)**

- Shift initial cursor inside active window:
    
    - morning ≈ start of window
        
    - midday ≈ middle third
        
    - night ≈ last third
        
- Ensure this works together with multi-day planning.
    

_Depends on: F12_

**F29 – Easy Commit Mode (Beginner Flow) — SHOULD**

**Goal.** Allow non-technical users to update the current trip without
understanding branches, commits, or Git terminology.

**User story.**  
“As someone who just wants to plan a trip, I want a simple ‘Save changes’
button so that when I add or move places on the timeline, the app saves
the latest version of my trip without asking me about branches or
commit messages.”

**Behaviour.**

- When the user is viewing a repo in “Easy mode”:
  - The UI hides most Git jargon (no CLI commands, no branch dropdowns).
  - The primary action is a single **Save trip** button.
- Clicking **Save trip**:
  - Creates a commit on a designated branch (default: `main` or `easy`),
    with an auto-generated commit message (e.g., `Update trip (3 changes)`).
  - Uses the current in-memory `plan` (timeline + map edits) as the new
    snapshot; no need to pick a branch or write a message.
- Internally:
  - Reuses the same commit schema and database tables as the advanced flow.
  - Records parent commit correctly so rollback / branching still work
    later if the user switches to advanced mode.
- Safety:
  - If the server detects a non-fast-forward (someone else edited in
    between), it shows a friendly message:
    “Your trip changed on another device; please refresh and try again,”
    instead of surfacing Git jargon.
- Advanced users can toggle “Advanced mode” in the UI to see branches,
  commit history, and use full Git-style operations (branch, merge, etc.).

**Dependencies.**

- Reuses existing snapshot & commit structures (`commits` table).
- Uses the same `plan` structure produced by the auto-planner.
- UI work on the repo page to support Easy / Advanced mode toggle.


---

## Phase 3 – Routing Modes & Travel Time

**F30 – Routing abstraction & providers (mostly done)**

- `routing.js` with:
    
    - `orsMatrix`, `orsLegs`
        
    - `gmapsTransitLegs`
        
    - `routeLegs`
        
    - `haversineMinutes`, `constantGap`
        
- Transport modes: `driving`, `walking`, `cycling`, `transit`.
    

_Depends on: F11_

---

**F31 – Use correct mode everywhere**

- Planner uses **walking/cycling** in matrix / legs calls.
    
- Transit uses `routeLegs(..., 'transit')` with date/time for departure.
    
- Store `routeMode` per stop so UI can choose correct emoji/icon.
    

_Depends on: F30_

---

**F32 – Recompute-travel endpoint + UI integration (partially there)**

- `/plan/recompute-travel` is already in `server.js`; wire UI:
    
    - Mode dropdown per day.
        
    - Button “Recompute travel” hits API and reloads plan.
        
- Respect new minutes returned, update `prevTravelMin`.
    

_Depends on: F31_

---

## Phase 4 – Beginner-Friendly Planner UI

**F40 – Simplified “Just add places” planner page (in progress)**

- The template you pasted: name-only fields, search button, hidden advanced.
    
- Optional inputs (dates, times) styled as soft/grey.
    
- Single big CTA: **“Run Auto Plan & Commit”**.
    

_Depends on: F11, F12_

---

**F41 – Optional advanced section**

- Collapsible “Show advanced” with:
    
    - Active hours, focus, compactness, break, targetDays.
        
- Defaults chosen for “normal tourist day”.
    

_Depends on: F24, F23_

---

**F42 – Hide techy details by default**

- No lat/lng fields in UI; search fills them silently.
    
- No Git jargon upfront: say “Trip versions” instead of “branches/commits” in beginner screens.
    
- Icons + tooltips for power users.
    

_Depends on: F40_

---

## Phase 5 – Timeline & Map UX

**F50 – Timeline visualisation (already present, refine)**

- Show stop order, durations, travel gaps.
    
- Use different icon per mode (car, walk, bike, train) based on `routeMode`.
    
- Highlight nudged stops (badge/colour).
    

_Depends on: F31, F20_

---

**F51 – Map visualisation per day (already present, refine)**

- Markers in stop order.
    
- Polyline connecting them.
    
- Day selector to switch map view.
    

_Depends on: F50_

---

**F52 – Inline editing flows**

- Clicking a stop in timeline:
    
    - Edit stayMin, arrive/depart (with basic validation).
        
    - Mark stop as “locked” (planner must respect manual times).
        
- Commit button: “Commit timeline edits”.
    

_Depends on: F50, F11_

---

## Phase 6 – Git-Style Trip Repo (with simplified UX)

**F60 – Clean snapshot + commit pipeline (done-ish)**

- After auto-plan or inline edits:
    
    - Build new `snapshot.plan`.
        
    - Insert commit.
        
    - Update branch head.
        

_Depends on: F11, F01_

---

**F61 – Visual history / workflow graph (basic)**

- On repo page:
    
    - Show linear history list first (beginner-friendly).
        
    - Small “Workflow” graph (branch points, merges) for advanced view.
        

_Depends on: F60_

---

**F62 – Simple branching & switching in UI**

- Button: “Try alternative plan” → creates feature branch from current commit.
    
- Basic branch dropdown to switch current view.
    

_Depends on: F61_

---

**F63 – Plan-focused merge + conflict resolution (core)**

- Back-end already has structural merges; refine:
    
    - Conflicts on per-stop fields, shown in a simple UI.
        
    - Choose “Version A” vs “Version B” with timeline preview.
        
- UI hides Git jargon:
    
    - Talk about “Combine plans” rather than “merge branches”.
        

_Depends on: F62, F21, F22_

---

**F64 – Rollback / revert single commit**

- On history:
    
    - “Restore this version” → creates new commit copying old snapshot.
        
- Simple explanation text: “Takes you back to how the trip looked then.”
    

_Depends on: F61_

---

## Phase 7 – Place Search & Data Robustness

**F70 – Geo search with stub + env-based Nominatim (done-ish)**

- The stubbed `/api/geo/search` implementation with local fallback.
    
- When blocked, still return “British Museum / Covent Garden / Tower Bridge”.
    

_Depends on: F00_

---

**F71 – Backend caches & rate limiting (lightweight)**

- Cache responses for same query for short time.
    
- Ensure we never spam Nominatim.
    

_Depends on: F70_

---

## Phase 8 – PWA / Offline

**F80 – PWA shell & installability**

- Manifest, icons, service worker.
    
- Cache app shell + last opened repo read-only.
    

_Depends on: F50, F51, F02_

---

**F81 – Background sync for queued pushes (stretch)**

- If offline when committing via UI:
    
    - Store payload locally.
        
    - Sync when back online.
        

_Depends on: F80, F60_

---

## Phase 9 – Low-Priority / Future (acknowledge, probably not implement fully)

These are the ideas from the survey that we’ll explicitly mark as **future work** in the report:

- Weather-based suggestions & packing checklist.
    
- Google Calendar sync.
    
- Import from Docs/Sheets.
    
- “Starred” public trip repos, popularity.
    
- Cost estimation / budget tracking.
    
- Busy-time avoidance with live data.
    
- Recommendations (restaurants, etc.).
    

We might build **one tiny slice** (e.g. manual cost notes) if time allows, but they’re not core.