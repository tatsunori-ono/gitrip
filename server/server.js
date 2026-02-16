/**
 * server/server.js — Express application: API routes, UI routes, and middleware.
 *
 * Responsibilities:
 *   - Authentication (cookie-based sessions with PBKDF2 password hashing)
 *   - CRUD for trip repositories, branches, and commits
 *   - Auto-planner orchestration and "easy add" shortcuts
 *   - Three-way merge with conflict resolution UI
 *   - Geo search proxy, route geometry, weather, and travel alerts
 *   - iCal export, starring, forking, and collaboration management
 */
import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import morgan from 'morgan';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuid } from 'uuid';
import crypto from 'node:crypto';
import expressLayouts from 'express-ejs-layouts';
import rateLimit from 'express-rate-limit';

import { db, migrate, rowToCommit } from './db.js';
import { mergeSnapshots } from './merge.js';
import { autoPlan } from './planner.js';
import { nominatimSearch, nominatimLookup } from './geosearch.js';
import { routeLegs } from './routing.js';
import { optimizeQuickRoute } from './quickroute.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

migrate();

// ---------- Security headers ----------
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(), microphone=()');
  if (process.env.NODE_ENV === 'production' || process.env.FLY_APP_NAME) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' cdn.jsdelivr.net unpkg.com",
      "style-src 'self' 'unsafe-inline' cdnjs.cloudflare.com unpkg.com",
      "font-src 'self' cdnjs.cloudflare.com",
      "img-src 'self' data: https: blob:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
    ].join('; ')
  );
  next();
});

// ---------- Rate limiters ----------
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many attempts, please try again later.',
});

app.use(morgan('dev'));
app.use(bodyParser.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/public', express.static(path.join(__dirname, 'public')));
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
app.use(expressLayouts);
app.set('layout', 'layout');

const nowISO = () => new Date().toISOString();

// ---------- SEO helpers ----------
function baseUrl(req) {
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  const host = req.get('x-forwarded-host') || req.get('host');
  return `${proto}://${host}`;
}
function canonical(req, pathOverride) {
  return baseUrl(req) + (pathOverride || req.originalUrl.split('?')[0]);
}

// ---------- DB helpers ----------
const getRepo = db.prepare('SELECT * FROM repos WHERE id=?');
const listRepos = db.prepare('SELECT * FROM repos ORDER BY created_at DESC');
const listPublicReposRecent = db.prepare(`
  SELECT r.*,
         u.email AS owner_email,
         u.name  AS owner_name,
         COUNT(rs.id) AS star_count
  FROM repos r
  LEFT JOIN users u ON u.id = r.owner_user_id
  LEFT JOIN repo_stars rs ON rs.repo_id = r.id
  WHERE r.visibility = 'public'
  GROUP BY r.id
  ORDER BY r.created_at DESC
`);
const listPublicReposStars = db.prepare(`
  SELECT r.*,
         u.email AS owner_email,
         u.name  AS owner_name,
         COUNT(rs.id) AS star_count
  FROM repos r
  LEFT JOIN users u ON u.id = r.owner_user_id
  LEFT JOIN repo_stars rs ON rs.repo_id = r.id
  WHERE r.visibility = 'public'
  GROUP BY r.id
  ORDER BY star_count DESC, r.created_at DESC
`);
const listReposOwnedByUser = db.prepare(
  'SELECT * FROM repos WHERE owner_user_id=? ORDER BY created_at DESC'
);
const listReposCollaborating = db.prepare(`
  SELECT r.*
  FROM repos r
  JOIN repo_collaborators rc ON rc.repo_id = r.id
  WHERE rc.user_id = ?
  ORDER BY r.created_at DESC
`);
const insertRepo = db.prepare(
  'INSERT INTO repos (id,title,created_at,owner_user_id,visibility,current_branch,forked_from_repo_id) VALUES (?,?,?,?,?,?,?)'
);

const getBranch = db.prepare(
  'SELECT * FROM branches WHERE repo_id=? AND name=?'
);
const listBranches = db.prepare(
  'SELECT * FROM branches WHERE repo_id=? ORDER BY name ASC'
);
const insertBranch = db.prepare(
  'INSERT INTO branches (id,repo_id,name,head_commit_id,created_at) VALUES (?,?,?,?,?)'
);
const updateBranchHead = db.prepare(
  'UPDATE branches SET head_commit_id=? WHERE id=?'
);

// remember last-used branch per repo
const updateRepoCurrentBranch = db.prepare(
  'UPDATE repos SET current_branch=? WHERE id=?'
);
const updateRepoVisibility = db.prepare(
  'UPDATE repos SET visibility=? WHERE id=?'
);
const updateRepoTitle = db.prepare(
  'UPDATE repos SET title=? WHERE id=?'
);

const getCommit = db.prepare('SELECT * FROM commits WHERE id=?');
const insertCommit = db.prepare(
  `INSERT INTO commits (
     id,
     repo_id,
     author,
     message,
     parents,
     snapshot,
     created_at,
     key_change_score,
     key_change_auto,
     key_change_manual,
     key_change_reason
   ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
);
const listCommits = db.prepare(
  'SELECT * FROM commits WHERE repo_id=? ORDER BY created_at DESC'
);
const updateCommitKeyManual = db.prepare(
  'UPDATE commits SET key_change_manual=? WHERE id=?'
);

const getTravelAlerts = db.prepare(
  'SELECT * FROM travel_alerts WHERE repo_id=?'
);
const upsertTravelAlerts = db.prepare(
  'INSERT INTO travel_alerts (repo_id,notes,updated_at) VALUES (?,?,?) ON CONFLICT(repo_id) DO UPDATE SET notes=excluded.notes, updated_at=excluded.updated_at'
);
const getPackingChecklist = db.prepare(
  'SELECT * FROM packing_checklists WHERE repo_id=?'
);
const upsertPackingChecklist = db.prepare(
  'INSERT INTO packing_checklists (repo_id,items,updated_at) VALUES (?,?,?) ON CONFLICT(repo_id) DO UPDATE SET items=excluded.items, updated_at=excluded.updated_at'
);

// collaborators
const getCollaborator = db.prepare(
  'SELECT * FROM repo_collaborators WHERE repo_id=? AND user_id=?'
);
const insertCollaborator = db.prepare(
  'INSERT INTO repo_collaborators (id,repo_id,user_id,role,created_at) VALUES (?,?,?,?,?)'
);
const updateCollaboratorRole = db.prepare(
  'UPDATE repo_collaborators SET role=? WHERE repo_id=? AND user_id=?'
);
const listCollaborators = db.prepare(`
  SELECT rc.id,
         rc.repo_id,
         rc.user_id,
         rc.role,
         rc.created_at,
         u.email,
         u.name,
         u.profile_image_url
  FROM repo_collaborators rc
  JOIN users u ON u.id = rc.user_id
  WHERE rc.repo_id = ?
  ORDER BY rc.role DESC, u.email ASC
`);

const listStarredReposByUser = db.prepare(`
  SELECT r.*,
         u.email AS owner_email,
         u.name  AS owner_name,
         COUNT(rs2.id) AS star_count
  FROM repo_stars rs
  JOIN repos r ON r.id = rs.repo_id
  LEFT JOIN users u ON u.id = r.owner_user_id
  LEFT JOIN repo_stars rs2 ON rs2.repo_id = r.id
  WHERE rs.user_id = ?
    AND (
      r.visibility = 'public'
      OR r.owner_user_id = ?
      OR EXISTS (
        SELECT 1 FROM repo_collaborators rc
        WHERE rc.repo_id = r.id AND rc.user_id = ?
      )
    )
  GROUP BY r.id
  ORDER BY rs.created_at DESC
`);

// stars
const getStarForUser = db.prepare(
  'SELECT 1 FROM repo_stars WHERE repo_id=? AND user_id=?'
);
const countStarsForRepo = db.prepare(
  'SELECT COUNT(*) AS count FROM repo_stars WHERE repo_id=?'
);
const insertStar = db.prepare(
  'INSERT INTO repo_stars (id,repo_id,user_id,created_at) VALUES (?,?,?,?)'
);
const deleteStar = db.prepare(
  'DELETE FROM repo_stars WHERE repo_id=? AND user_id=?'
);
const deleteStarsForRepo = db.prepare(
  'DELETE FROM repo_stars WHERE repo_id=?'
);

// deletion helpers
const deleteRepo = db.prepare('DELETE FROM repos WHERE id=?');
const deleteBranchesForRepo = db.prepare('DELETE FROM branches WHERE repo_id=?');
const deleteCommitsForRepo = db.prepare('DELETE FROM commits WHERE repo_id=?');
const deleteCollaboratorsForRepo = db.prepare(
  'DELETE FROM repo_collaborators WHERE repo_id=?'
);

// Users + sessions (optional auth)
const getUserById = db.prepare('SELECT * FROM users WHERE id=?');
const getUserByEmail = db.prepare('SELECT * FROM users WHERE email=?');
const insertUser = db.prepare(
  'INSERT INTO users (id,email,name,password_hash,created_at) VALUES (?,?,?,?,?)'
);
const updateUserProfileImage = db.prepare(
  'UPDATE users SET profile_image_url=? WHERE id=?'
);
const insertSession = db.prepare(
  'INSERT INTO sessions (id,user_id,created_at) VALUES (?,?,?)'
);
const getSession = db.prepare('SELECT * FROM sessions WHERE id=?');
const deleteSession = db.prepare('DELETE FROM sessions WHERE id=?');

// ---------- Auth helpers (PBKDF2 with random salt) ----------

/** Hash a password with a random 16-byte salt; returns "salt:hash". */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto
    .pbkdf2Sync(password, salt, 100_000, 32, 'sha256')
    .toString('hex');
  return `${salt}:${hash}`;
}

/** Verify a password against a stored "salt:hash" using timing-safe comparison. */
function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const check = crypto
    .pbkdf2Sync(password, salt, 100_000, 32, 'sha256')
    .toString('hex');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(hash, 'hex'),
      Buffer.from(check, 'hex')
    );
  } catch {
    return false;
  }
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  const parts = header.split(';');
  for (const part of parts) {
    const [k, ...rest] = part.trim().split('=');
    if (!k) continue;
    out[k] = decodeURIComponent(rest.join('=') || '');
  }
  return out;
}

/** Validate redirect targets to prevent open redirects. */
function isSafeRedirect(url) {
  if (typeof url !== 'string') return false;
  // Must start with single slash, not double slash (protocol-relative)
  if (!url.startsWith('/') || url.startsWith('//')) return false;
  // Block backslash tricks
  if (url.includes('\\')) return false;
  return true;
}

function safeRedirectUrl(raw) {
  return isSafeRedirect(raw) ? raw : '/';
}

function setSessionCookie(res, sessionId) {
  const isProduction = !!(process.env.NODE_ENV === 'production' || process.env.FLY_APP_NAME);
  const cookie =
    `gitrip_sid=${encodeURIComponent(sessionId)}; ` +
    `Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${isProduction ? '; Secure' : ''}`;
  res.setHeader('Set-Cookie', cookie);
}

function clearSessionCookie(res) {
  const isProduction = !!(process.env.NODE_ENV === 'production' || process.env.FLY_APP_NAME);
  const cookie =
    `gitrip_sid=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${isProduction ? '; Secure' : ''}`;
  res.setHeader('Set-Cookie', cookie);
}

/** Require that the user is logged in and is the owner or a collaborator with write access. */
function requireWriteAccess(repo, user) {
  if (!repo) return 'Repo not found';
  if (!user) return 'You must be logged in to modify this trip.';
  if (repo.owner_user_id === user.id) return null; // owner
  const collab = getCollaborator.get(repo.id, user.id);
  if (collab && (collab.role === 'owner' || collab.role === 'editor')) return null;
  return 'You do not have permission to modify this trip.';
}

// ---------- CSRF protection (double-submit cookie pattern) ----------
function generateCsrfToken() {
  return crypto.randomBytes(32).toString('hex');
}

function setCsrfCookie(res, token) {
  const isProduction = !!(process.env.NODE_ENV === 'production' || process.env.FLY_APP_NAME);
  const cookie =
    `gitrip_csrf=${encodeURIComponent(token)}; ` +
    `Path=/; SameSite=Lax; Max-Age=86400${isProduction ? '; Secure' : ''}`;
  // Note: NOT HttpOnly — JavaScript needs to read it for AJAX requests
  res.setHeader('Set-Cookie', [
    res.getHeader('Set-Cookie') || [],
    cookie,
  ].flat().filter(Boolean));
}

// Middleware: set CSRF token and make it available to templates
app.use((req, res, next) => {
  const cookies = parseCookies(req.headers.cookie || '');
  let csrfToken = cookies.gitrip_csrf;
  if (!csrfToken) {
    csrfToken = generateCsrfToken();
    setCsrfCookie(res, csrfToken);
  }
  req.csrfToken = csrfToken;
  res.locals.csrfToken = csrfToken;
  next();
});

// Verify CSRF token on state-changing requests
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next();
  }

  const cookies = parseCookies(req.headers.cookie || '');
  const cookieToken = cookies.gitrip_csrf;

  // Accept token from form body or from X-CSRF-Token header (for AJAX)
  const bodyToken = req.body?._csrf;
  const headerToken = req.headers['x-csrf-token'];
  const submittedToken = bodyToken || headerToken;

  if (!cookieToken || !submittedToken || cookieToken !== submittedToken) {
    // For API JSON requests, return JSON error
    const isApi = req.path.startsWith('/api/');
    if (isApi) {
      return res.status(403).json({ error: 'csrf_invalid', message: 'Invalid or missing CSRF token.' });
    }
    return res.status(403).send('Invalid or missing CSRF token. Please refresh the page and try again.');
  }
  next();
});

// attach req.user if logged in (but never required)
app.use((req, res, next) => {
  try {
    const cookies = parseCookies(req.headers.cookie || '');
    const sid = cookies.gitrip_sid;
    if (!sid) {
      req.user = null;
      res.locals.currentUser = null;
      return next();
    }
    const sess = getSession.get(sid);
    if (!sess) {
      req.user = null;
      res.locals.currentUser = null;
      return next();
    }
    const user = getUserById.get(sess.user_id);
    if (!user) {
      req.user = null;
      res.locals.currentUser = null;
      return next();
    }
    req.user = user;
    res.locals.currentUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      profileImageUrl: user.profile_image_url || null,
    };
    return next();
  } catch (e) {
    console.error('attachUser error', e);
    req.user = null;
    res.locals.currentUser = null;
    return next();
  }
});

// ---------- helpers ----------
function createInitialCommit(repoId) {
  const commitId = uuid();
  const snapshot = { files: {}, plan: { days: [] } };
  insertCommitWithKeyChange({
    id: commitId,
    repoId,
    author: 'system',
    message: 'Initial commit',
    parents: [],
    snapshot,
    createdAt: nowISO(),
  });
  return commitId;
}

/** Count how many times each stop appears in a plan (by id/name). */
function collectStopCounts(plan) {
  const counts = new Map();
  let total = 0;
  const days = Array.isArray(plan?.days) ? plan.days : [];
  days.forEach((day) => {
    const stops = Array.isArray(day?.stops) ? day.stops : [];
    stops.forEach((stop, idx) => {
      const key =
        stop?.id ||
        stop?.fullName ||
        stop?.name ||
        `stop-${idx}`;
      counts.set(key, (counts.get(key) || 0) + 1);
      total += 1;
    });
  });
  return { counts, total, dayCount: days.length };
}

/** Compare two stop-count maps and return how many stops were added/removed. */
function diffStopCounts(base, next) {
  let added = 0;
  let removed = 0;
  const allKeys = new Set([
    ...Array.from(base.counts.keys()),
    ...Array.from(next.counts.keys()),
  ]);
  allKeys.forEach((key) => {
    const a = base.counts.get(key) || 0;
    const b = next.counts.get(key) || 0;
    if (b > a) added += b - a;
    if (a > b) removed += a - b;
  });
  return { added, removed };
}

/**
 * Heuristic impact score for "key change" detection on commits.
 * Compares stop counts and day counts between base and next snapshots.
 * A commit is auto-flagged as "key" if >= 3 stops changed, any day was
 * added/removed, or total stops changed by >= 30%.
 */
function computeKeyChange(baseSnap, nextSnap) {
  if (!baseSnap || !nextSnap) {
    return { score: 0, auto: 0, reason: null };
  }
  const basePlan = baseSnap.plan || { days: [] };
  const nextPlan = nextSnap.plan || { days: [] };
  const baseStats = collectStopCounts(basePlan);
  const nextStats = collectStopCounts(nextPlan);
  const { added, removed } = diffStopCounts(baseStats, nextStats);
  const dayDelta = nextStats.dayCount - baseStats.dayCount;

  const baseTotal = baseStats.total;
  const nextTotal = nextStats.total;
  const pctChange =
    baseTotal > 0
      ? Math.abs(nextTotal - baseTotal) / baseTotal
      : nextTotal > 0
      ? 1
      : 0;

  const score =
    added +
    removed +
    Math.abs(dayDelta) * 2 +
    (pctChange >= 0.3 ? 2 : 0);

  const auto =
    added + removed >= 3 ||
    Math.abs(dayDelta) >= 1 ||
    pctChange >= 0.3;

  const reasons = [];
  if (added || removed) {
    reasons.push(`Stops changed: +${added} / -${removed}`);
  }
  if (dayDelta !== 0) {
    const sign = dayDelta > 0 ? '+' : '';
    reasons.push(`Days changed: ${sign}${dayDelta}`);
  }
  if (pctChange >= 0.3) {
    reasons.push(`Total stops change: ${Math.round(pctChange * 100)}%`);
  }

  return {
    score,
    auto: auto ? 1 : 0,
    reason: reasons.length ? reasons.join(' • ') : null,
  };
}

function insertCommitWithKeyChange({
  id,
  repoId,
  author,
  message,
  parents,
  snapshot,
  createdAt,
  manualKey = 0,
}) {
  const parentList = Array.isArray(parents) ? parents : [];
  const baseId = parentList[0] || null;
  let score = 0;
  let auto = 0;
  let reason = null;

  if (baseId) {
    const baseRow = getCommit.get(baseId);
    if (baseRow) {
      const baseCommit = rowToCommit(baseRow);
      const diff = computeKeyChange(baseCommit?.snapshot, snapshot);
      score = diff.score;
      auto = diff.auto;
      reason = diff.reason;
    }
  }

  insertCommit.run(
    id,
    repoId,
    author,
    message,
    JSON.stringify(parentList),
    JSON.stringify(snapshot),
    createdAt,
    score,
    auto,
    manualKey ? 1 : 0,
    reason
  );
}

function extractCitiesFromPlan(plan) {
  const cities = new Set();
  const days = Array.isArray(plan?.days) ? plan.days : [];
  days.forEach((day) => {
    const stops = Array.isArray(day?.stops) ? day.stops : [];
    stops.forEach((stop) => {
      const raw = String(stop?.fullName || stop?.name || '').trim();
      if (!raw) return;
      const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
      if (!parts.length) return;
      const pick = parts.length > 1 ? parts[parts.length - 2] : parts[0];
      if (pick) cities.add(pick);
    });
  });
  return Array.from(cities);
}

function weatherLabelFromCode(code) {
  const c = Number(code);
  if (Number.isNaN(c)) return 'Unknown';
  if (c === 0) return 'Clear';
  if (c === 1) return 'Mostly clear';
  if (c === 2) return 'Partly cloudy';
  if (c === 3) return 'Overcast';
  if (c === 45 || c === 48) return 'Fog';
  if (c >= 51 && c <= 57) return 'Drizzle';
  if (c >= 61 && c <= 67) return 'Rain';
  if (c >= 71 && c <= 77) return 'Snow';
  if (c >= 80 && c <= 82) return 'Rain showers';
  if (c >= 85 && c <= 86) return 'Snow showers';
  if (c >= 95 && c <= 99) return 'Thunderstorm';
  return 'Mixed';
}

function pickDayCoord(day) {
  const stops = Array.isArray(day?.stops) ? day.stops : [];
  for (const stop of stops) {
    const lat = Number(stop?.lat);
    const lng = Number(stop?.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      return { lat, lng };
    }
  }
  return null;
}

function getBranchSnapshot(repoId, branchName) {
  const br = getBranch.get(repoId, branchName);
  if (!br || !br.head_commit_id) return null;
  const row = getCommit.get(br.head_commit_id);
  if (!row) return null;
  const commit = rowToCommit(row);
  return commit ? commit.snapshot : null;
}

function normalizeChecklistItems(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map((item) => {
      const text = String(item?.text || '').trim();
      if (!text) return null;
      return {
        text: text.slice(0, 200),
        done: !!item?.done,
      };
    })
    .filter(Boolean);
}

function icalEscape(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function formatIcalDateTime(dateIso, timeStr) {
  const parts = String(timeStr || '').split(':').map(Number);
  const h = parts[0] || 0;
  const m = parts[1] || 0;
  const base = String(dateIso || '').replace(/-/g, '');
  return `${base}T${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}00`;
}

/** Generate an iCalendar (.ics) string from a trip plan for calendar export. */
function buildIcalFromPlan(repoTitle, plan) {
  const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const calName = icalEscape(repoTitle || 'GiTrip');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//GiTrip//Trip Plan//EN',
    `X-WR-CALNAME:${calName}`,
    'CALSCALE:GREGORIAN',
  ];

  const days = Array.isArray(plan?.days) ? plan.days : [];
  days.forEach((day, di) => {
    const dateIso = day?.date;
    const stops = Array.isArray(day?.stops) ? day.stops : [];
    stops.forEach((stop, si) => {
      const arrive = stop?.arrive;
      const depart = stop?.depart;
      if (!dateIso || !arrive || !depart) return;
      const dtStart = formatIcalDateTime(dateIso, arrive);
      const dtEnd = formatIcalDateTime(dateIso, depart);
      const uid = `${crypto.randomUUID()}@gitrip`;
      const summary = icalEscape(stop?.name || stop?.fullName || `Stop ${si + 1}`);
      const location = icalEscape(stop?.fullName || stop?.name || '');
      const description = icalEscape(`Trip: ${repoTitle || 'GiTrip'} — Day ${di + 1}`);

      lines.push('BEGIN:VEVENT');
      lines.push(`UID:${uid}`);
      lines.push(`DTSTAMP:${now}`);
      lines.push(`DTSTART:${dtStart}`);
      lines.push(`DTEND:${dtEnd}`);
      lines.push(`SUMMARY:${summary}`);
      if (location) lines.push(`LOCATION:${location}`);
      lines.push(`DESCRIPTION:${description}`);
      lines.push('END:VEVENT');
    });
  });

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

function canUserAccessRepo(repo, user) {
  if (!repo) return false;
  if (repo.visibility === 'public') return true;
  if (!user) return false;
  if (repo.owner_user_id && repo.owner_user_id === user.id) return true;
  const collab = getCollaborator.get(repo.id, user.id);
  return !!collab;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function normPoints(src) {
  return (Array.isArray(src) ? src : [])
    .map((p) => ({
      lat: Number(p?.lat ?? p?.latitude ?? p?.y ?? NaN),
      lng: Number(p?.lng ?? p?.lon ?? p?.longitude ?? p?.x ?? NaN),
    }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
}

function normSubMode(raw, fallback) {
  const x = String(raw || '').toLowerCase();
  if (x.includes('walk')) return 'walking';
  if (x.includes('cycle') || x.includes('bike')) return 'cycling';
  if (
    x.includes('transit') ||
    x.includes('rail') ||
    x.includes('train') ||
    x.includes('subway') ||
    x.includes('metro') ||
    x.includes('bus')
  ) {
    return 'transit';
  }
  if (x.includes('car') || x.includes('drive')) return 'driving';
  return fallback || 'driving';
}

/**
 * Extract polyline segments and per-leg sub-modes from a routeLegs() result.
 * Handles three possible formats: segmentsByLeg, flat segments, or raw geometries.
 * Returns { segments, perLegSubModes } for map rendering and mode inference.
 */
function extractRouteSegments(result, travelMode, legCount, opts = {}) {
  const includeSegments = opts.includeSegments !== false;
  const segments = includeSegments ? [] : null;
  const perLegSubModes = Array.from({ length: Math.max(legCount, 0) }, () => []);
  const geoms = Array.isArray(result?.geometries) ? result.geometries : [];

  const record = (legIdx, pts2, subMode) => {
    if (!pts2.length) return;
    if (includeSegments) {
      segments.push({ points: pts2, subMode });
    }
    if (
      Number.isInteger(legIdx) &&
      legIdx >= 0 &&
      legIdx < perLegSubModes.length
    ) {
      perLegSubModes[legIdx].push(subMode);
    }
  };

  if (Array.isArray(result?.segmentsByLeg) && result.segmentsByLeg.length) {
    result.segmentsByLeg.forEach((legSegs, legIdx) => {
      let added = false;
      if (Array.isArray(legSegs)) {
        legSegs.forEach((seg) => {
          if (!seg) return;
          const pts2 = normPoints(seg.points || seg.coords);
          if (!pts2.length) return;
          const subMode = normSubMode(
            seg.subMode || seg.mode || seg.type,
            travelMode
          );
          record(legIdx, pts2, subMode);
          added = true;
        });
      }
      if (!added) {
        const fallbackPts = normPoints(geoms[legIdx]);
        if (fallbackPts.length) {
          record(legIdx, fallbackPts, travelMode);
        }
      }
    });
  } else if (Array.isArray(result?.segments) && result.segments.length) {
    result.segments.forEach((seg) => {
      if (!seg) return;
      const pts2 = normPoints(seg.points || seg.coords || seg);
      if (!pts2.length) return;
      const subMode = normSubMode(seg.subMode || seg.type, travelMode);
      if (includeSegments) {
        segments.push({ points: pts2, subMode });
      }
    });
  } else if (Array.isArray(geoms) && geoms.length) {
    geoms.forEach((coords, idx) => {
      const pts2 = normPoints(coords);
      record(idx, pts2, travelMode);
    });
  }

  return { segments: segments || [], perLegSubModes };
}

/** Extract per-leg transit step metadata (walk/ride instructions) from a route result. */
function collectTransitStepsFromRouteResult(result, legCount) {
  const arr = Array.from({ length: Math.max(legCount, 0) }, () => []);
  if (!result) return arr;

  const assign = (steps, idx) => {
    if (!Array.isArray(steps)) return;
    if (idx >= 0 && idx < arr.length) {
      arr[idx] = steps;
    }
  };

  if (Array.isArray(result.transitLegs) && result.transitLegs.length) {
    result.transitLegs.forEach((leg, idx) => assign(leg?.steps, idx));
  } else if (Array.isArray(result.legSteps) && result.legSteps.length) {
    result.legSteps.forEach((steps, idx) => assign(steps, idx));
  }

  return arr;
}

/**
 * Determine the effective transport mode for each leg based on the sub-mode
 * tags collected during segment extraction and transit step analysis.
 */
function inferLegModes(perLegSubModes, fallbackMode, legCount, transitSteps) {
  const out = [];
  const fallback = String(fallbackMode || 'driving').toLowerCase();
  for (let idx = 0; idx < Math.max(legCount, 0); idx++) {
    const tags = Array.isArray(perLegSubModes?.[idx])
      ? perLegSubModes[idx]
      : [];
    const normalized = tags.map((t) => String(t || '').toLowerCase());
    let mode = fallback;
    if (normalized.includes('transit')) {
      mode = 'transit';
    } else if (normalized.includes('walking')) {
      mode = 'walking';
    } else if (normalized.includes('cycling')) {
      mode = 'cycling';
    } else if (normalized.includes('driving')) {
      mode = 'driving';
    } else if (fallback === 'transit') {
      const steps = transitSteps?.[idx] || [];
      if (Array.isArray(steps) && steps.length) {
        const hasTransit = steps.some((st) => st && st.kind === 'transit');
        mode = hasTransit ? 'transit' : 'walking';
      } else {
        mode = 'walking';
      }
    }
    out.push(mode);
  }
  return out;
}

/**
 * Convert an existing snapshot.plan into an autoPlan() payload.
 * Keeps the current ordering; each existing stop becomes a "place".
 */
function planToAutoPayload(plan) {
  const days = (plan && Array.isArray(plan.days)) ? plan.days : [];

  let startDate = todayIso();
  let endDate   = todayIso();

  if (days.length) {
    // derive min/max date from existing plan
    startDate = days[0].date || todayIso();
    endDate   = days[0].date || todayIso();
    for (const d of days) {
      if (!d.date) continue;
      if (d.date < startDate) startDate = d.date;
      if (d.date > endDate)   endDate   = d.date;
    }
  }

  const places = [];
  let hasStartFirst = false;

  for (const day of days) {
    const stops = Array.isArray(day.stops) ? day.stops : [];
    for (const stop of stops) {
      if (!stop || !stop.name) continue;

      // Preserve any existing strictOrder / startFirst so user intent survives.
      const strictRaw = stop.strictOrder;
      let strictOrder;
      if (
        strictRaw !== undefined &&
        strictRaw !== null &&
        strictRaw !== ''
      ) {
        const n = Number(strictRaw);
        strictOrder = Number.isFinite(n) ? n : undefined;
      }

      const startFirst = !!stop.startFirst;
      if (startFirst) hasStartFirst = true;

      places.push({
        id:        stop.id || undefined,
        name:      stop.name,
        fullName:  stop.fullName || stop.name,
        lat:       Number.isFinite(stop.lat) ? stop.lat : undefined,
        lng:       Number.isFinite(stop.lng) ? stop.lng : undefined,
        stayMin:   Number(stop.stayMin || 60) || 60,
        desiredStart: stop.desiredStart || undefined,
        desiredEnd:   stop.desiredEnd   || undefined,
        strictOrder,
        startFirst,
        enabled:      stop.enabled !== false,
        openingHours: stop.openingHours || null
      });
    }
  }

  // If nothing is explicitly marked as "start here", treat the first place
  // as the natural starting point so NN ordering keeps the trip anchored.
  if (!hasStartFirst && places.length > 0) {
    places[0].startFirst = true;
  }

  return {
    startDate,
    endDate,
    activeHours: { start: '08:00', end: '21:00' },
    breakMinBetweenStops: 10,
    targetDays: undefined,
    compactness: 'compact',
    orderingMode: 'relative',
    focus: 'midday',
    transport: plan?.transport || 'driving',
    places
  };
}

// ---------- Fuzzy matching helpers for place name search ----------

/** Strip diacritics, lowercase, and collapse non-alphanumeric to spaces. */
function normalizeForMatch(str) {
  if (!str) return '';
  return String(str)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Levenshtein edit distance (space-optimised single-row DP).
 * Used to rank Nominatim search results by similarity to the user's query.
 */
function levenshtein(a, b) {
  a = normalizeForMatch(a);
  b = normalizeForMatch(b);
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;

  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    const chA = a.charAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      const cost = chA === b.charAt(j - 1) ? 0 : 1;
      dp[j] = Math.min(
        dp[j] + 1,        // deletion
        dp[j - 1] + 1,    // insertion
        prev + cost       // substitution
      );
      prev = tmp;
    }
  }
  return dp[n];
}

/**
 * Take raw nominatimSearch results and sort them so that the
 * place whose primary label is closest to the user's query
 * (edit‑distance wise) comes first.
 */
function rankPlacesBySimilarity(query, results) {
  const list = Array.isArray(results) ? results : [];
  const normQ = normalizeForMatch(query);
  if (!normQ) return list;

  const scored = list.map((item) => {
    const labelRaw =
      item.name ||
      item.display_name ||
      item.label ||
      '';
    const primary = String(labelRaw).split(',')[0]; // focus on main name
    const normPrimary = normalizeForMatch(primary);
    if (!normPrimary) {
      return { item, score: Number.POSITIVE_INFINITY };
    }

    const distance = levenshtein(normQ, primary);
    const denom = Math.max(normPrimary.length, normQ.length, 1);
    let score = distance / denom; // length-normalized distance makes partial matches less harsh

    if (normPrimary.includes(normQ)) {
      score *= 0.5; // direct substring match: treat as nearly exact
    } else if (normQ.includes(normPrimary)) {
      score *= 0.7; // query fully contains candidate name
    }

    return { item, score };
  });

  scored.sort((a, b) => a.score - b.score);
  return scored.map((x) => x.item);
}

/**
 * Wrapper around nominatimSearch that:
 *  - asks Nominatim for a few more items than we need
 *  - sorts them by string similarity to the query
 *  - returns only the best `limit` matches
 */
async function fuzzySearchPlaces(q, limit) {
  const safeLimit = Math.max(Number(limit) || 6, 1);
  const upstreamLimit = Math.max(safeLimit * 2, 6); // grab a few extra to rank
  const raw = await nominatimSearch(q, upstreamLimit);
  const ranked = rankPlacesBySimilarity(q, raw);
  return ranked.slice(0, safeLimit);
}

// ---------- SEO: robots.txt and sitemap ----------
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send([
    'User-agent: *',
    'Allow: /',
    'Disallow: /api/',
    'Disallow: /ui/account',
    'Disallow: /ui/users/',
    '',
    `Sitemap: ${baseUrl(req)}/sitemap.xml`,
  ].join('\n'));
});

app.get('/sitemap.xml', (req, res) => {
  const base = baseUrl(req);
  const publicRepos = listPublicReposRecent.all();
  const staticPages = [
    { loc: '/', priority: '1.0', changefreq: 'daily' },
    { loc: '/ui/about', priority: '0.8', changefreq: 'monthly' },
    { loc: '/ui/public', priority: '0.9', changefreq: 'daily' },
    { loc: '/ui/explore', priority: '0.7', changefreq: 'monthly' },
    { loc: '/ui/login', priority: '0.3', changefreq: 'yearly' },
    { loc: '/ui/signup', priority: '0.3', changefreq: 'yearly' },
  ];
  const urls = staticPages.map(p =>
    `  <url><loc>${base}${p.loc}</loc><changefreq>${p.changefreq}</changefreq><priority>${p.priority}</priority></url>`
  );
  publicRepos.forEach(r => {
    urls.push(`  <url><loc>${base}/ui/repos/${r.id}</loc><changefreq>weekly</changefreq><priority>0.6</priority></url>`);
  });
  res.type('application/xml').send([
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    '</urlset>',
  ].join('\n'));
});

// ---------- AUTH UI (optional; only used when user chooses) ----------
app.get('/ui/signup', authLimiter, (req, res) => {
  const next = typeof req.query.next === 'string' ? req.query.next : '/';
  res.render('signup', {
    error: null,
    values: { email: '', name: '' },
    next,
    pageTitle: 'Sign Up',
    pageDescription: 'Create a free GiTrip account to collaborate on trip plans, share itineraries, and version-control your travel schedules.',
    canonicalUrl: canonical(req, '/ui/signup'),
  });
});

app.get('/ui/about', (req, res) => {
  res.render('about', {
    pageTitle: 'About',
    pageDescription: 'Learn how GiTrip brings Git-style version control to trip planning. Branch, merge, and collaborate on travel itineraries with ease.',
    canonicalUrl: canonical(req, '/ui/about'),
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'WebApplication',
      name: 'GiTrip',
      description: 'A web-based trip-planning platform that integrates Git-style version control to travel scheduling.',
      applicationCategory: 'TravelApplication',
      operatingSystem: 'Web',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'GBP' },
    },
  });
});

app.post('/ui/signup', authLimiter, (req, res) => {
  try {
    const emailRaw = String(req.body.email || '').trim();
    const name = String(req.body.name || '').trim() || null;
    const password = String(req.body.password || '');
    const confirm = String(req.body.confirm || '');
    const next = typeof req.body.next === 'string' ? req.body.next : '/';

    const errorRender = (msg) =>
      res.status(400).render('signup', {
        error: msg,
        values: { email: emailRaw, name },
        next,
      });

    if (!emailRaw || !password) {
      return errorRender('Email and password are required.');
    }
    if (password.length < 10) {
      return errorRender('Password must be at least 10 characters.');
    }
    if (!/[A-Z]/.test(password)) {
      return errorRender('Password must include at least one uppercase letter.');
    }
    if (!/[a-z]/.test(password)) {
      return errorRender('Password must include at least one lowercase letter.');
    }
    if (!/[0-9]/.test(password)) {
      return errorRender('Password must include at least one number.');
    }
    if (password !== confirm) {
      return errorRender('Passwords do not match.');
    }

    const email = emailRaw.toLowerCase();
    const existing = getUserByEmail.get(email);
    if (existing) {
      return errorRender('That email is already registered. Try signing in.');
    }

    const id = uuid();
    const pwHash = hashPassword(password);
    insertUser.run(id, email, name, pwHash, nowISO());

    const sid = uuid();
    insertSession.run(sid, id, nowISO());
    setSessionCookie(res, sid);

    res.redirect(safeRedirectUrl(next));
  } catch (e) {
    console.error('signup error', e);
    res.status(500).render('signup', {
      error: 'Sign up failed. Please try again.',
      values: { email: req.body.email || '', name: req.body.name || '' },
      next: req.body.next || '/',
    });
  }
});

app.get('/ui/login', authLimiter, (req, res) => {
  const next = typeof req.query.next === 'string' ? req.query.next : '/';
  res.render('login', {
    error: null,
    values: { email: '' },
    next,
    pageTitle: 'Sign In',
    pageDescription: 'Sign in to your GiTrip account to manage, share, and collaborate on trip itineraries.',
    canonicalUrl: canonical(req, '/ui/login'),
  });
});

app.post('/ui/login', authLimiter, (req, res) => {
  try {
    const emailRaw = String(req.body.email || '').trim();
    const password = String(req.body.password || '');
    const next = typeof req.body.next === 'string' ? req.body.next : '/';

    const errorRender = (msg) =>
      res.status(400).render('login', {
        error: msg,
        values: { email: emailRaw },
        next,
      });

    if (!emailRaw || !password) {
      return errorRender('Email and password are required.');
    }

    const email = emailRaw.toLowerCase();
    const user = getUserByEmail.get(email);

    // Prevent user enumeration: always hash even if user doesn't exist,
    // and use a generic error message for both cases.
    if (!user) {
      // Hash a dummy password to equalise timing
      hashPassword(password);
      return errorRender('Invalid email or password.');
    }

    if (!verifyPassword(password, user.password_hash)) {
      return errorRender('Invalid email or password.');
    }

    const sid = uuid();
    insertSession.run(sid, user.id, nowISO());
    setSessionCookie(res, sid);

    res.redirect(safeRedirectUrl(next));
  } catch (e) {
    console.error('login error', e);
    res.status(500).render('login', {
      error: 'Login failed. Please try again.',
      values: { email: req.body.email || '' },
      next: req.body.next || '/',
    });
  }
});

app.post('/ui/logout', (req, res) => {
  try {
    const cookies = parseCookies(req.headers.cookie || '');
    const sid = cookies.gitrip_sid;
    if (sid) {
      deleteSession.run(sid);
    }
  } catch (e) {
    console.error('logout error', e);
  }
  clearSessionCookie(res);
  res.redirect('/');
});

// simple account page for "Settings"
app.get('/ui/account', (req, res) => {
  if (!req.user) {
    return res.redirect('/ui/login?next=/ui/account');
  }
  const success =
    typeof req.query.saved === 'string' ? 'Profile updated.' : null;
  // Use only server-generated error messages (not raw query params) to prevent XSS
  const ERROR_CODES = {
    invalid_url: 'Enter a valid https:// URL.',
    update_failed: 'Could not update image.',
  };
  const error =
    typeof req.query.error === 'string'
      ? (ERROR_CODES[req.query.error] || 'An error occurred.')
      : null;
  res.render('account', {
    currentUser: res.locals.currentUser || null,
    success,
    error,
    pageTitle: 'Account Settings',
    pageDescription: 'Manage your GiTrip profile, accessibility preferences, and account settings.',
    canonicalUrl: canonical(req, '/ui/account'),
  });
});

// ---------- User page (starred repos) ----------
app.get('/ui/users/:userId', (req, res) => {
  if (!req.user) {
    return res.redirect(`/ui/login?next=/ui/users/${req.params.userId}`);
  }
  const userId = String(req.params.userId || '').trim();
  if (!userId || userId !== req.user.id) {
    return res.status(403).send('Only the owner can view this page.');
  }

  const starred = listStarredReposByUser.all(userId, userId, userId);
  res.render('user', {
    currentUser: res.locals.currentUser || null,
    starredRepos: starred,
    pageTitle: 'Your Profile',
    pageDescription: 'View your starred trips and profile on GiTrip.',
  });
});

app.post('/ui/account/profile-image', (req, res) => {
  if (!req.user) {
    return res.redirect('/ui/login?next=/ui/account');
  }
  const raw = String(req.body.profileImageUrl || '').trim();
  let value = raw;
  if (value && !/^https:\/\//i.test(value)) {
    return res.redirect('/ui/account?error=invalid_url');
  }
  if (!value) value = null;
  try {
    updateUserProfileImage.run(value, req.user.id);
    req.user.profile_image_url = value;
    if (res.locals.currentUser) {
      res.locals.currentUser.profileImageUrl = value;
    }
    return res.redirect('/ui/account?saved=1');
  } catch (e) {
    console.error('profile image update failed', e);
    return res.redirect('/ui/account?error=update_failed');
  }
});

// ---------- HOME ----------
app.get('/', (req, res) => {
  let repos = [];
  if (!req.user) {
    repos = listPublicReposRecent.all();
  } else {
    const seen = new Map();
    const addRepos = (rows) => {
      rows.forEach((r) => {
        if (!seen.has(r.id)) {
          seen.set(r.id, r);
        }
      });
    };
    addRepos(listReposOwnedByUser.all(req.user.id));
    addRepos(listReposCollaborating.all(req.user.id));
    addRepos(listPublicReposRecent.all());
    repos = Array.from(seen.values());
  }
  res.render('index', {
    repos,
    currentUser: res.locals.currentUser || null,
    pageTitle: 'Your Trips',
    pageDescription: 'View and manage your trip repositories on GiTrip. Create new trips, collaborate with others, and version-control your itineraries.',
    canonicalUrl: canonical(req, '/'),
  });
});

// ---------- QUICK MAP (Google-like route optimizer page) ----------
app.get('/ui/explore', (req, res) => {
  res.render('explore', {
    currentUser: res.locals.currentUser || null,
    pageTitle: 'Quick Route',
    pageDescription: 'Plan a quick route by adding destinations and computing the shortest travel order. Preview your trip on an interactive map.',
    canonicalUrl: canonical(req, '/ui/explore'),
  });
});

// ---------- QUICK MAP API: optimize order + route geometry ----------
app.post('/api/quick/optimize', async (req, res) => {
  try {
    const result = await optimizeQuickRoute(req.body || {});
    res.json(result);
  } catch (e) {
    console.error('quick optimize error', e);
    res.status(500).json({ ok: false, error: 'quick_optimize_failed' });
  }
});

// ---------- QUICK MAP API: start a repo from the computed trip ----------
app.post('/api/quick/start-repo', (req, res) => {
  try {
    const title = String(req.body.title || 'Untitled Trip').trim() || 'Untitled Trip';
    const mode = String(req.body.mode || 'walking').toLowerCase();

    const stopsRaw = Array.isArray(req.body.stops) ? req.body.stops : [];
    const minsRaw = Array.isArray(req.body.minutes) ? req.body.minutes : [];

    const dateIso =
      typeof req.body.dateIso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.body.dateIso)
        ? req.body.dateIso
        : todayIso();

    // normalize stops
    const stops = stopsRaw
      .map((s) => {
        const safeId = (s && s.id) ? String(s.id) : uuid();
        return {
          id: safeId,
          name: String(s?.name || '').trim() || 'Stop',
          fullName: String(s?.fullName || s?.name || '').trim() || String(s?.name || 'Stop'),
          lat: Number(s?.lat),
          lng: Number(s?.lng),
        };
      })
      .filter((s) => s.name);

    if (!stops.length) {
      return res.status(400).json({ ok: false, error: 'no_stops' });
    }

    // Build a minimal “nice” schedule so repo page/timeline doesn’t look empty.
    const stayMin = 60;
    const breakMin = 10;

    let cursor = 9 * 60; // 09:00
    const dayStops = [];

    for (let i = 0; i < stops.length; i++) {
      const prevTravel = (i === 0) ? 0 : (Number(minsRaw[i - 1]) || 0);

      if (i > 0) cursor += prevTravel + breakMin;

      const arriveMin = cursor;
      const departMin = cursor + stayMin;
      cursor = departMin;

      const toHHMM = (min) => {
        min = Math.max(0, Math.round(min || 0));
        const h = Math.floor(min / 60);
        const m = min % 60;
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      };

      dayStops.push({
        ...stops[i],
        arrive: toHHMM(arriveMin),
        depart: toHHMM(departMin),
        prevTravelMin: prevTravel,
        routeMode: mode,
      });
    }

    const plan = {
      transport: mode,
      days: [
        {
          id: `day-${dateIso}`,
          date: dateIso,
          stops: dayStops,
        },
      ],
    };

    // Also store planInput so planner can rehydrate nicely
    const planInput = {
      startDate: dateIso,
      endDate: dateIso,
      activeHours: { start: '08:00', end: '21:00' },
      breakMinBetweenStops: breakMin,
      compactness: 'compact',
      focus: 'midday',
      transport: mode,
      places: dayStops.map((s, idx) => ({
        id: s.id || `place-${Date.now()}-${idx}`,
        name: s.name,
        fullName: s.fullName,
        lat: s.lat,
        lng: s.lng,
        stayMin,
        enabled: true,
        startFirst: idx === 0,
        strictOrder: idx + 1,
      })),
    };

    const repoId = uuid();
    const ownerId = req.user ? req.user.id : null;
    const visibility = ownerId ? 'private' : 'public';

    insertRepo.run(
      repoId,
      title,
      nowISO(),
      ownerId,
      visibility,
      'main',
      null
    );

    // ensure owner recorded as collaborator
    if (ownerId) {
      const existing = getCollaborator.get(repoId, ownerId);
      if (!existing) {
        insertCollaborator.run(uuid(), repoId, ownerId, 'owner', nowISO());
      } else if (existing.role !== 'owner') {
        updateCollaboratorRole.run('owner', repoId, ownerId);
      }
    }

    const commitId = uuid();
    const author =
      res.locals.currentUser?.email ||
      res.locals.currentUser?.name ||
      'quick-map';

    const snapshot = {
      files: {},
      plan,
      planInput,
    };

    insertCommitWithKeyChange({
      id: commitId,
      repoId,
      author,
      message: 'Start trip from Quick route map',
      parents: [],
      snapshot,
      createdAt: nowISO(),
    });

    insertBranch.run(uuid(), repoId, 'main', commitId, nowISO());
    updateRepoCurrentBranch.run('main', repoId);

    res.json({ ok: true, repoId, redirect: `/ui/repos/${repoId}` });
  } catch (e) {
    console.error('quick start-repo error', e);
    res.status(500).json({ ok: false, error: 'quick_start_repo_failed' });
  }
});

// Public gallery of trips
app.get('/ui/public', (req, res) => {
  const sort = String(req.query.sort || 'recent');
  const repos =
    sort === 'stars' ? listPublicReposStars.all() : listPublicReposRecent.all();
  res.render('public-gallery', {
    repos,
    currentUser: res.locals.currentUser || null,
    sort,
    pageTitle: 'Public Trips',
    pageDescription: 'Browse publicly shared trip itineraries on GiTrip. Discover travel plans, fork them, and customise them for your own adventures.',
    canonicalUrl: canonical(req, '/ui/public'),
  });
});

// ---------- REPO CREATION ----------
app.post('/ui/repos', (req, res) => {
  const id = uuid();
  const title = req.body.title || 'Untitled Trip';
  const ownerId = req.user ? req.user.id : null;
  const visibility = ownerId ? 'private' : 'public';

  insertRepo.run(
    id,
    title,
    nowISO(),
    ownerId,
    visibility,
    'main',
    null
  );

  // ensure owner is recorded as collaborator
  if (ownerId) {
    const existing = getCollaborator.get(id, ownerId);
    if (!existing) {
      insertCollaborator.run(
        uuid(),
        id,
        ownerId,
        'owner',
        nowISO()
      );
    } else if (existing.role !== 'owner') {
      updateCollaboratorRole.run('owner', id, ownerId);
    }
  }

  const initCommit = createInitialCommit(id);
  insertBranch.run(uuid(), id, 'main', initCommit, nowISO());
  updateRepoCurrentBranch.run('main', id);

  res.redirect(`/ui/repos/${id}`);
});

// ---------- REPO PAGE (branch switcher) ----------
app.get('/ui/repos/:repoId', (req, res) => {
  const repo = getRepo.get(req.params.repoId);
  if (!repo) return res.status(404).send('Repo not found');
  if (!canUserAccessRepo(repo, req.user)) {
    return res.status(404).send('Trip not found');
  }

  let forkedFrom = null;
  let forkedFromRestricted = false;
  if (repo.forked_from_repo_id) {
    const parent = getRepo.get(repo.forked_from_repo_id);
    if (parent && canUserAccessRepo(parent, req.user)) {
      forkedFrom = { id: parent.id, title: parent.title };
    } else {
      forkedFromRestricted = true;
    }
  }

  const requested = req.query.branch ? String(req.query.branch) : null;
  const branches = listBranches.all(repo.id);

  // Start from requested branch, else remembered branch, else main, else first branch
  let currentBranch = requested || repo.current_branch || 'main';
  let br = getBranch.get(repo.id, currentBranch);

  if (!br && branches.length) {
    // Fallback: first known branch
    br = branches[0];
    currentBranch = br.name;
  }

  // Persist last-used branch for this repo
  if (br) {
    updateRepoCurrentBranch.run(currentBranch, repo.id);
  }

  const commits = listCommits.all(repo.id).map(rowToCommit);
  let snapshot = { files: {}, plan: { days: [] } };
  let currentHeadId = null;

  if (br?.head_commit_id) {
    const row = getCommit.get(br.head_commit_id);
    if (row) {
      currentHeadId = row.id;
      snapshot = JSON.parse(row.snapshot);
    }
  }

  const collaborators = listCollaborators.all(repo.id);
  const starCountRow = countStarsForRepo.get(repo.id);
  const starCount = starCountRow ? Number(starCountRow.count || 0) : 0;
  const currentUserId = res.locals.currentUser?.id || null;
  const isStarred = currentUserId
    ? !!getStarForUser.get(repo.id, currentUserId)
    : false;

  res.render('repo', {
    repo,
    branches,
    commits,
    snapshot,
    currentBranch,
    currentHeadId,
    currentUser: res.locals.currentUser || null,
    collaborators,
    forkedFrom,
    forkedFromRestricted,
    starCount,
    isStarred,
    pageTitle: repo.title,
    pageDescription: `View and edit the "${repo.title}" trip itinerary on GiTrip. Branch, merge, and collaborate on this travel plan.`,
    canonicalUrl: canonical(req, `/ui/repos/${repo.id}`),
    ogType: 'article',
  });
});

app.get('/ui/repos/:repoId/ical', (req, res) => {
  const repo = getRepo.get(req.params.repoId);
  if (!repo) return res.status(404).send('Repo not found');
  if (!canUserAccessRepo(repo, req.user)) {
    return res.status(404).send('Trip not found');
  }

  const branchName = String(req.query.branch || repo.current_branch || 'main');
  const snapshot = getBranchSnapshot(repo.id, branchName);
  const plan = snapshot?.plan || { days: [] };
  const ical = buildIcalFromPlan(repo.title, plan);
  const safeTitle = String(repo.title || 'gitrip').replace(/[^\w\-]+/g, '_');

  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${safeTitle}.ics"`
  );
  res.send(ical);
});

// ---------- Star / unstar repo ----------
app.post('/ui/repos/:repoId/star', (req, res) => {
  const repo = getRepo.get(req.params.repoId);
  if (!repo) return res.status(404).send('Repo not found');
  if (!canUserAccessRepo(repo, req.user)) {
    return res.status(404).send('Trip not found');
  }
  if (!req.user || !req.user.id) {
    const next = encodeURIComponent(`/ui/repos/${repo.id}?tab=view`);
    return res.redirect(`/ui/login?next=${next}`);
  }

  const userId = req.user.id;
  const hasStar = !!getStarForUser.get(repo.id, userId);
  if (hasStar) {
    deleteStar.run(repo.id, userId);
  } else {
    insertStar.run(uuid(), repo.id, userId, nowISO());
  }

  const nextRaw = req.body?.next || req.query?.next;
  const safeNext = isSafeRedirect(nextRaw)
    ? nextRaw
    : `/ui/repos/${repo.id}?tab=view`;
  res.redirect(safeNext);
});

// ---------- Share settings: visibility + collaborators ----------
app.post('/ui/repos/:repoId/visibility', (req, res) => {
  const repo = getRepo.get(req.params.repoId);
  if (!repo) return res.status(404).send('Repo not found');

  // Only owner can change visibility if there is an owner
  if (repo.owner_user_id && (!req.user || repo.owner_user_id !== req.user.id)) {
    return res.status(403).send('Only the owner can change visibility.');
  }

  const v = String(req.body.visibility || '').toLowerCase();
  const visibility = v === 'public' ? 'public' : 'private';

  updateRepoVisibility.run(visibility, repo.id);
  res.redirect(`/ui/repos/${repo.id}`);
});

app.post('/ui/repos/:repoId/collaborators', (req, res) => {
  const repo = getRepo.get(req.params.repoId);
  if (!repo) return res.status(404).send('Repo not found');

  // Only owner can add collaborators
  if (!req.user || !repo.owner_user_id || repo.owner_user_id !== req.user.id) {
    return res.status(403).send('Only the owner can add collaborators.');
  }

  const email = String(req.body.email || '').trim().toLowerCase();
  const roleRaw = String(req.body.role || 'editor').toLowerCase();

  if (!email) {
    return res.status(400).send('Missing email.');
  }

  const user = getUserByEmail.get(email);
  if (!user) {
    return res
      .status(400)
      .send('No user with that email. Ask them to sign up first.');
  }

  const role = roleRaw === 'viewer' ? 'viewer' : 'editor';

  const existing = getCollaborator.get(repo.id, user.id);
  if (existing) {
    if (existing.role !== role) {
      updateCollaboratorRole.run(role, repo.id, user.id);
    }
  } else {
    insertCollaborator.run(
      uuid(),
      repo.id,
      user.id,
      role,
      nowISO()
    );
  }

  res.redirect(`/ui/repos/${repo.id}`);
});

// ---------- Repo delete (with name confirmation) ----------
app.post('/ui/repos/:repoId/delete', (req, res) => {
  const repo = getRepo.get(req.params.repoId);
  if (!repo) return res.status(404).send('Repo not found');

  // Only owner can delete if there is an owner
  if (repo.owner_user_id && (!req.user || req.user.id !== repo.owner_user_id)) {
    return res.status(403).send('Only the owner can delete this trip.');
  }

  const confirmName = String(req.body.confirmName || '').trim();
  if (confirmName !== String(repo.title || '').trim()) {
    return res.status(400).send('Name confirmation did not match trip title.');
  }

  deleteCollaboratorsForRepo.run(repo.id);
  deleteStarsForRepo.run(repo.id);
  deleteBranchesForRepo.run(repo.id);
  deleteCommitsForRepo.run(repo.id);
  deleteRepo.run(repo.id);

  res.redirect('/');
});

// ---------- Rollback / Restore a previous snapshot ----------
app.post('/ui/repos/:repoId/restore', (req, res) => {
  try {
    const repo = getRepo.get(req.params.repoId);
    if (!repo) return res.status(404).send('Repo not found');
    const writeErr = requireWriteAccess(repo, req.user);
    if (writeErr) return res.status(403).send(writeErr);

    const targetBranchName = String(req.body.targetBranch || '').trim() || 'main';
    const commitId = String(req.body.commitId || '').trim();

    if (!commitId) {
      return res.status(400).send('Missing commitId');
    }

    const br = getBranch.get(repo.id, targetBranchName);
    if (!br) return res.status(404).send('Branch not found');

    const srcRow = getCommit.get(commitId);
    if (!srcRow) return res.status(404).send('Commit not found');

    const srcCommit = rowToCommit(srcRow);

    const parentId = br.head_commit_id || null;
    const newId = uuid();

    const author =
      res.locals.currentUser?.email ||
      res.locals.currentUser?.name ||
      'web';

    insertCommitWithKeyChange({
      id: newId,
      repoId: repo.id,
      author,
      message: `Restore ${targetBranchName} to ${commitId.slice(0, 7)}`,
      parents: [parentId].filter(Boolean),
      snapshot: srcCommit.snapshot,
      createdAt: nowISO(),
    });

    updateBranchHead.run(newId, br.id);
    updateRepoCurrentBranch.run(targetBranchName, repo.id);

    res.redirect(`/ui/repos/${repo.id}?branch=${encodeURIComponent(targetBranchName)}`);
  } catch (e) {
    console.error('restore error', e);
    res.status(500).send('Restore failed: ' + String(e.message || e));
  }
});

// ---------- PLANNER ----------
app.get('/ui/planner/:repoId', (req, res) => {
  const repo = getRepo.get(req.params.repoId);
  if (!repo) return res.status(404).send('Repo not found');

  // Try to recover previous planner input from the current branch's snapshot.
  let plannerDefaults = null;

  try {
    const branchName = repo.current_branch || 'main';
    let br = getBranch.get(repo.id, branchName);
    if (!br && branchName !== 'main') {
      br = getBranch.get(repo.id, 'main');
    }

    if (br && br.head_commit_id) {
      const row = getCommit.get(br.head_commit_id);
      if (row) {
        const head = rowToCommit(row);
        const snap = head.snapshot || {};
        const plan = snap.plan || null;
        const storedInput =
          snap.planInput && typeof snap.planInput === 'object'
            ? snap.planInput
            : null;

        if (storedInput) {
          // Preferred: explicit stored planner input
          const {
            startDate,
            endDate,
            activeHours,
            breakMinBetweenStops,
            targetDays,
            compactness,
            orderingMode,
            focus,
            transport,
            places,
            branchName: storedBranchName,
          } = storedInput;

          plannerDefaults = {
            startDate: startDate || null,
            endDate: endDate || null,
            activeHours: activeHours || null,
            breakMinBetweenStops:
              typeof breakMinBetweenStops === 'number'
                ? breakMinBetweenStops
                : null,
            targetDays:
              typeof targetDays === 'number' && targetDays > 0
                ? targetDays
                : null,
            compactness: compactness || null,
            orderingMode: orderingMode || null,
            focus: focus || null,
            transport: transport || null,
            branchName: storedBranchName || branchName || null,
            places: Array.isArray(places) ? places : null,
          };
        } else if (plan) {
          // Fallback for older commits: derive a payload from the existing plan
          const derived = planToAutoPayload(plan);
          plannerDefaults = {
            ...derived,
            branchName: branchName || null,
          };
        }
      }
    }
  } catch (e) {
    console.warn('planner defaults error', e);
  }

  res.render('planner', {
    repo,
    plannerDefaults,
    pageTitle: `Auto-Schedule – ${repo.title}`,
    pageDescription: `Auto-schedule and optimise the "${repo.title}" trip with GiTrip's planner. Set dates, active hours, and let the algorithm plan your itinerary.`,
  });
});


// Planner can commit to any branch (default planner/YYYY-MM-DD)
app.post('/ui/planner/:repoId/run', async (req, res) => {
  try {
    const repo = getRepo.get(req.params.repoId);
    if (!repo) return res.status(404).send('Repo not found');
    const writeErr = requireWriteAccess(repo, req.user);
    if (writeErr) return res.status(403).send(writeErr);

    // ---- robust JSON parse of payload ----
    let payloadRaw = req.body?.payload;
    let payload;

    if (!payloadRaw || typeof payloadRaw !== 'string' || !payloadRaw.trim()) {
      console.warn('planner: empty payload, using {}');
      payload = {};
    } else {
      try {
        payload = JSON.parse(payloadRaw);
      } catch (e) {
        console.error('planner: bad JSON payload:', payloadRaw, e);
        payload = {};
      }
    }

    const plan = await autoPlan(payload); // async routing + opening-hours

    // Store the input we actually used so we can re-hydrate the planner UI later.
    const planInput = { ...(payload || {}) };

    const today = todayIso();
    const plannerBranchName =
      (payload.branchName && String(payload.branchName).trim()) ||
      `planner/${today}`;

    const main = getBranch.get(repo.id, 'main');
    const mainHead = main?.head_commit_id
      ? rowToCommit(getCommit.get(main.head_commit_id))
      : null;

    let pbr = getBranch.get(repo.id, plannerBranchName);
    if (!pbr) {
      insertBranch.run(
        uuid(),
        repo.id,
        plannerBranchName,
        mainHead?.id || null,
        nowISO()
      );
      pbr = getBranch.get(repo.id, plannerBranchName);
    }

    const baseCommitRow = pbr.head_commit_id
      ? getCommit.get(pbr.head_commit_id)
      : null;
    const baseCommit = baseCommitRow
      ? rowToCommit(baseCommitRow)
      : mainHead;

    const newSnap = baseCommit?.snapshot || { files: {}, plan: { days: [] } };
    newSnap.plan = plan;
    newSnap.planInput = planInput;

    const commitId = uuid();
    const author =
      res.locals.currentUser?.email ||
      res.locals.currentUser?.name ||
      'planner';

    insertCommitWithKeyChange({
      id: commitId,
      repoId: repo.id,
      author,
      message: `Auto plan → ${plannerBranchName}`,
      parents: [baseCommit?.id].filter(Boolean),
      snapshot: newSnap,
      createdAt: nowISO(),
    });
    updateBranchHead.run(commitId, pbr.id);

    // Remember this planner branch as the current branch
    updateRepoCurrentBranch.run(plannerBranchName, repo.id);

    res.redirect(
      `/ui/repos/${repo.id}?branch=${encodeURIComponent(plannerBranchName)}`
    );
  } catch (err) {
    console.error('planner run error', err);
    res.status(500).send('Planner error: ' + String(err.message || err));
  }
});

// ---------- EASY ADD (beginner mode: add place(s) + auto-plan + commit) ----------
app.post('/ui/repos/:repoId/easy-add', async (req, res) => {
  try {
    const repo = getRepo.get(req.params.repoId);
    if (!repo) return res.status(404).send('Repo not found');
    const writeErr = requireWriteAccess(repo, req.user);
    if (writeErr) return res.status(403).send(writeErr);

    const branch = String(req.body.branch || repo.current_branch || 'main');

    // NOTE: support both "placeNames" (new multi-place textarea) and "placeName" (old single-input)
    const rawNames = (req.body.placeNames || req.body.placeName || '').trim();
    const stayRaw = req.body.stayMin;

    if (!rawNames) {
      return res.redirect(
        `/ui/repos/${repo.id}?branch=${encodeURIComponent(branch)}`
      );
    }

    // Support one or many places (newline or comma separated)
    const names = rawNames
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);

    if (!names.length) {
      return res.redirect(
        `/ui/repos/${repo.id}?branch=${encodeURIComponent(branch)}`
      );
    }

    const br = getBranch.get(repo.id, branch);
    if (!br) return res.status(404).send('Branch not found');

    const headRow = br.head_commit_id && getCommit.get(br.head_commit_id);
    const head = headRow
      ? rowToCommit(headRow)
      : { id: null, snapshot: { files: {}, plan: { days: [] } } };

    const baseSnap = head.snapshot || { files: {}, plan: { days: [] } };
    const basePlan = baseSnap.plan || { days: [] };

    // Start from an autoPlan-style payload derived from the current plan
    const payload = planToAutoPayload(basePlan);

    // If we have previous planner input, carry over its preferences
    if (baseSnap.planInput && typeof baseSnap.planInput === 'object') {
      const prev = baseSnap.planInput;
      if (prev.startDate) payload.startDate = prev.startDate;
      if (prev.endDate) payload.endDate = prev.endDate;
      if (prev.activeHours) payload.activeHours = prev.activeHours;
      if (typeof prev.breakMinBetweenStops === 'number') {
        payload.breakMinBetweenStops = prev.breakMinBetweenStops;
      }
      if (typeof prev.targetDays === 'number') {
        payload.targetDays = prev.targetDays;
      }
      if (prev.compactness) payload.compactness = prev.compactness;
      if (prev.orderingMode) payload.orderingMode = prev.orderingMode;
      if (prev.focus) payload.focus = prev.focus;
      if (prev.transport) payload.transport = prev.transport;
    }

    // Try to fill in missing coordinates for existing places so that
    // re-planning can consider the full trip geometry, not just the newly
    // added stops. This lets the scheduler insert new places *between*
    // existing ones instead of always appending them.
    if (Array.isArray(payload.places)) {
      for (let idx = 0; idx < payload.places.length; idx++) {
        const p = payload.places[idx];
        if (!p) continue;

        const hasLat = Number.isFinite(p.lat);
        const hasLng = Number.isFinite(p.lng);
        if (hasLat && hasLng) continue;

        const q = p.fullName || p.name;
        if (!q) continue;

        try {
          const hits = await fuzzySearchPlaces(q, 1);
          const best = Array.isArray(hits) && hits[0];
          if (!best) continue;

          const lat = Number(best.lat);
          const lng = Number(best.lng);
          if (Number.isFinite(lat) && Number.isFinite(lng)) {
            p.lat = lat;
            p.lng = lng;
          }

          if (!p.openingHours) {
            p.openingHours =
              best.opening_hours ||
              (best.extratags && best.extratags.opening_hours) ||
              null;
          }

          if (!p.fullName || p.fullName === p.name) {
            p.fullName =
              best.display_name ||
              best.name ||
              p.fullName ||
              p.name;
          }
        } catch (err) {
          console.warn(
            'easy-add geosearch (existing place) failed for',
            q,
            err
          );
        }
      }
    }

    // Remember which branch this plan belongs to (for planner defaults)
    payload.branchName = branch;

    const stayMin = Number(stayRaw || 60) || 60;

    // Add all requested places into the payload, then run autoPlan once
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const newPlace = {
        id: 'place-' + Date.now() + '-' + i,
        name,
        fullName: name,
        stayMin,
        enabled: true,
        startFirst: false,
      };

      try {
        // Fuzzy search so small typos still resolve to the most likely place.
        const hits = await fuzzySearchPlaces(name, 3);
        const best = Array.isArray(hits) && hits[0];
        if (best) {
          newPlace.fullName =
            best.display_name ||
            best.name ||
            name;
          newPlace.lat = Number(best.lat);
          newPlace.lng = Number(best.lng);
          newPlace.openingHours =
            best.opening_hours ||
            (best.extratags && best.extratags.opening_hours) ||
            null;
        }
      } catch (e) {
        console.warn('easy-add geosearch failed for', name, e);
      }

      payload.places.push(newPlace);
    }

    const plan = await autoPlan(payload);

    const newSnap = {
      ...baseSnap,
      plan,
      planInput: payload,
    };

    const label =
      names.length === 1
        ? names[0]
        : `${names[0]} + ${names.length - 1} more`;

    const commitId = uuid();
    const author =
      res.locals.currentUser?.email ||
      res.locals.currentUser?.name ||
      'easy';

    insertCommitWithKeyChange({
      id: commitId,
      repoId: repo.id,
      author,
      message: `Easy add: ${label}`,
      parents: [head.id].filter(Boolean),
      snapshot: newSnap,
      createdAt: nowISO(),
    });
    updateBranchHead.run(commitId, br.id);

    // update remembered branch
    updateRepoCurrentBranch.run(branch, repo.id);

    res.redirect(`/ui/repos/${repo.id}?branch=${encodeURIComponent(branch)}`);
  } catch (e) {
    console.error('easy-add error:', e);
    res.status(500).send('Easy add failed: ' + String(e.message || e));
  }
});

app.post('/ui/repos/:repoId/fork', (req, res) => {
  if (!req.user) {
    const next = encodeURIComponent(`/ui/repos/${req.params.repoId}`);
    return res.redirect(`/ui/login?next=${next}`);
  }

  const source = getRepo.get(req.params.repoId);
  if (!source) return res.status(404).send('Repo not found');

  if (!canUserAccessRepo(source, req.user)) {
    return res.status(403).send('You do not have permission to fork this trip.');
  }

  const newRepoId = uuid();
  const titleRaw = String(req.body.title || '').trim();
  const forkTitle = titleRaw || `${source.title} (fork)`;
  const visibility = source.visibility || 'private';
  const branchName = source.current_branch || 'main';

  insertRepo.run(
    newRepoId,
    forkTitle,
    nowISO(),
    req.user.id,
    visibility,
    branchName,
    source.id
  );

  // ensure owner recorded as collaborator
  const ownerId = req.user.id;
  if (ownerId) {
    const existing = getCollaborator.get(newRepoId, ownerId);
    if (!existing) {
      insertCollaborator.run(
        uuid(),
        newRepoId,
        ownerId,
        'owner',
        nowISO()
      );
    } else if (existing.role !== 'owner') {
      updateCollaboratorRole.run('owner', newRepoId, ownerId);
    }
  }

  const srcBranch = getBranch.get(source.id, branchName);
  let snapshot = { files: {}, plan: { days: [] } };
  if (srcBranch?.head_commit_id) {
    const srcCommitRow = getCommit.get(srcBranch.head_commit_id);
    if (srcCommitRow) {
      snapshot = JSON.parse(srcCommitRow.snapshot || '{"files":{},"plan":{"days":[]}}');
    }
  }

  const forkCommitId = uuid();
  const author =
    res.locals.currentUser?.email ||
    res.locals.currentUser?.name ||
    'fork';

  insertCommitWithKeyChange({
    id: forkCommitId,
    repoId: newRepoId,
    author,
    message: `Forked from ${source.title}`,
    parents: [],
    snapshot,
    createdAt: nowISO(),
  });

  insertBranch.run(uuid(), newRepoId, branchName, forkCommitId, nowISO());
  updateRepoCurrentBranch.run(branchName, newRepoId);

  res.redirect(`/ui/repos/${newRepoId}`);
});

// ---------- CLI API ----------
app.post('/api/repos/init', (req, res) => {
  const { title } = req.body;
  const id = uuid();
  insertRepo.run(
    id,
    title || 'Untitled Trip',
    nowISO(),
    null,
    'private',
    'main',
    null
  );
  const init = createInitialCommit(id);
  insertBranch.run(uuid(), id, 'main', init, nowISO());
  updateRepoCurrentBranch.run('main', id);
  res.json({ repoId: id, defaultBranch: 'main', head: init });
});

app.get('/api/repos/:repoId/branches', (req, res) => {
  const repo = getRepo.get(req.params.repoId);
  if (!repo) return res.status(404).json({ error: 'not_found' });
  res.json(listBranches.all(repo.id));
});

app.get('/api/repos/:repoId/branches/:name', (req, res) => {
  const repo = getRepo.get(req.params.repoId);
  if (!repo) return res.status(404).json({ error: 'not_found' });
  const br = getBranch.get(repo.id, req.params.name);
  if (!br) return res.status(404).json({ error: 'branch_not_found' });
  const headRow = br.head_commit_id && getCommit.get(br.head_commit_id);
  const head = headRow ? rowToCommit(headRow) : null;
  res.json({ branch: br, headCommit: head });
});

app.post('/api/repos/:repoId/branches', (req, res) => {
  const { name, fromCommitId } = req.body;
  const repo = getRepo.get(req.params.repoId);
  if (!repo) return res.status(404).json({ error: 'not_found' });
  const writeErr = requireWriteAccess(repo, req.user);
  if (writeErr) return res.status(403).json({ error: 'forbidden', message: writeErr });
  const id = uuid();
  insertBranch.run(id, repo.id, name, fromCommitId || null, nowISO());
  res.json({ ok: true, id });
});

app.post('/api/repos/:repoId/commits', (req, res) => {
  const {
    branch,
    baseCommitId,
    message,
    author = 'cli',
    snapshot,
  } = req.body;
  const repo = getRepo.get(req.params.repoId);
  if (!repo) return res.status(404).json({ error: 'not_found' });
  const writeErr = requireWriteAccess(repo, req.user);
  if (writeErr) return res.status(403).json({ error: 'forbidden', message: writeErr });
  const br = getBranch.get(repo.id, branch);
  if (!br) return res.status(404).json({ error: 'branch_not_found' });
  if (br.head_commit_id !== baseCommitId) {
    return res
      .status(409)
      .json({ error: 'non_fast_forward', head: br.head_commit_id });
  }
  const id = uuid();
  insertCommitWithKeyChange({
    id,
    repoId: repo.id,
    author,
    message,
    parents: [baseCommitId].filter(Boolean),
    snapshot,
    createdAt: nowISO(),
  });
  updateBranchHead.run(id, br.id);
  res.json({ ok: true, commitId: id });
});

app.post('/api/commits/:commitId/key-change', (req, res) => {
  const commitId = String(req.params.commitId || '').trim();
  if (!commitId) return res.status(400).json({ error: 'missing_commit_id' });

  const row = getCommit.get(commitId);
  if (!row) return res.status(404).json({ error: 'commit_not_found' });

  if (!req.user) {
    return res.status(403).json({ error: 'login_required' });
  }

  const repo = getRepo.get(row.repo_id);
  if (!repo || !canUserAccessRepo(repo, req.user)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const manual = req.body && req.body.manual ? 1 : 0;
  updateCommitKeyManual.run(manual, commitId);
  res.json({ ok: true, commitId, manual });
});

app.get('/api/repos/:repoId/travel-alerts', async (req, res) => {
  try {
    const repoId = String(req.params.repoId || '').trim();
    const repo = getRepo.get(repoId);
    if (!repo || !canUserAccessRepo(repo, req.user)) {
      return res.status(404).json({ error: 'not_found' });
    }

    const branchName = String(req.query.branch || repo.current_branch || 'main');
    const snapshot = getBranchSnapshot(repoId, branchName);
    const plan = snapshot?.plan || { days: [] };
    const days = Array.isArray(plan.days) ? plan.days : [];
    const dates = days.map((d) => d.date).filter(Boolean);
    const cities = extractCitiesFromPlan(plan);

    const notesRow = getTravelAlerts.get(repoId);
    const notes = notesRow ? notesRow.notes || '' : '';

    const eventsByDate = {};
    const warningDates = new Set();

    const apiKey = process.env.NEWS_API_KEY;
    const apiUrl =
      process.env.NEWS_API_URL || 'https://gnews.io/api/v4/search';

    if (apiKey && dates.length && cities.length) {
      const from = dates.slice().sort()[0];
      const to = dates.slice().sort()[dates.length - 1];
      const cityQuery = cities.slice(0, 5).map((c) => `"${c}"`).join(' OR ');
      const q = `${cityQuery} (strike OR holiday OR disruption OR closure OR cancelled OR cancellation OR protest OR outage)`;
      const url = new URL(apiUrl);
      url.searchParams.set('q', q);
      url.searchParams.set('from', from);
      url.searchParams.set('to', to);
      url.searchParams.set('lang', 'en');
      url.searchParams.set('max', '10');
      url.searchParams.set('token', apiKey);

      const resp = await fetch(url.toString());
      if (resp.ok) {
        const data = await resp.json().catch(() => ({}));
        const articles = Array.isArray(data.articles) ? data.articles : [];
        articles.forEach((item) => {
          const published = item.publishedAt || item.date || null;
          if (!published) return;
          const date = new Date(published).toISOString().slice(0, 10);
          if (!date || !dates.includes(date)) return;
          const entry = {
            title: item.title || 'Travel advisory',
            url: item.url || null,
            source: item.source?.name || null,
          };
          if (!eventsByDate[date]) eventsByDate[date] = [];
          eventsByDate[date].push(entry);
          warningDates.add(date);
        });
      }
    }

    res.json({
      ok: true,
      notes,
      eventsByDate,
      warningDates: Array.from(warningDates),
      cities,
      dates,
      hasApiKey: !!apiKey,
    });
  } catch (e) {
    console.error('travel alerts error', e);
    res.status(500).json({ error: 'travel_alerts_failed' });
  }
});

app.post('/api/repos/:repoId/travel-alerts/manual', (req, res) => {
  const repoId = String(req.params.repoId || '').trim();
  const repo = getRepo.get(repoId);
  if (!repo || !canUserAccessRepo(repo, req.user)) {
    return res.status(404).json({ error: 'not_found' });
  }
  if (!req.user) return res.status(403).json({ error: 'login_required' });

  const notes = String(req.body.notes || '').trim();
  upsertTravelAlerts.run(repoId, notes || null, nowISO());
  res.json({ ok: true });
});

app.get('/api/repos/:repoId/weather', async (req, res) => {
  try {
    const repoId = String(req.params.repoId || '').trim();
    const repo = getRepo.get(repoId);
    if (!repo || !canUserAccessRepo(repo, req.user)) {
      return res.status(404).json({ error: 'not_found' });
    }

    const branchName = String(req.query.branch || repo.current_branch || 'main');
    const snapshot = getBranchSnapshot(repoId, branchName);
    const plan = snapshot?.plan || { days: [] };
    const days = Array.isArray(plan.days) ? plan.days : [];

    if (!days.length) {
      return res.json({ ok: true, forecasts: [] });
    }

    const today = todayIso();
    const requests = days.map(async (day) => {
      const date = day?.date || null;
      const coord = pickDayCoord(day);
      if (!date || !coord) return null;

      const isPast = date < today;
      const baseUrl = isPast
        ? 'https://archive-api.open-meteo.com/v1/archive'
        : 'https://api.open-meteo.com/v1/forecast';
      const url = new URL(baseUrl);
      url.searchParams.set('latitude', String(coord.lat));
      url.searchParams.set('longitude', String(coord.lng));
      url.searchParams.set('daily', 'temperature_2m_max,temperature_2m_min,precipitation_probability_max,weathercode');
      url.searchParams.set('timezone', 'auto');
      if (isPast) {
        url.searchParams.set('start_date', date);
        url.searchParams.set('end_date', date);
      } else {
        url.searchParams.set('forecast_days', '16');
      }

      const resp = await fetch(url.toString());
      if (!resp.ok) return null;
      const data = await resp.json().catch(() => null);
      if (!data || !data.daily || !Array.isArray(data.daily.time)) return null;

      const idx = data.daily.time.indexOf(date);
      if (idx < 0) return null;

      const tmax = data.daily.temperature_2m_max?.[idx];
      const tmin = data.daily.temperature_2m_min?.[idx];
      const precip = data.daily.precipitation_probability_max?.[idx];
      const code = data.daily.weathercode?.[idx];

      return {
        date,
        tmax: Number.isFinite(tmax) ? Math.round(tmax) : null,
        tmin: Number.isFinite(tmin) ? Math.round(tmin) : null,
        precip: Number.isFinite(precip) ? Math.round(precip) : null,
        code: Number.isFinite(code) ? code : null,
        label: weatherLabelFromCode(code),
      };
    });

    const results = (await Promise.all(requests)).filter(Boolean);
    res.json({ ok: true, forecasts: results, provider: 'Open-Meteo' });
  } catch (e) {
    console.error('weather fetch error', e);
    res.status(500).json({ error: 'weather_failed' });
  }
});

app.get('/api/repos/:repoId/checklist', (req, res) => {
  const repoId = String(req.params.repoId || '').trim();
  const repo = getRepo.get(repoId);
  if (!repo || !canUserAccessRepo(repo, req.user)) {
    return res.status(404).json({ error: 'not_found' });
  }

  const row = getPackingChecklist.get(repoId);
  let items = [];
  if (row && row.items) {
    try {
      items = normalizeChecklistItems(JSON.parse(row.items));
    } catch {}
  }
  res.json({ ok: true, items });
});

app.post('/api/repos/:repoId/checklist', (req, res) => {
  const repoId = String(req.params.repoId || '').trim();
  const repo = getRepo.get(repoId);
  if (!repo || !canUserAccessRepo(repo, req.user)) {
    return res.status(404).json({ error: 'not_found' });
  }
  if (!req.user) return res.status(403).json({ error: 'login_required' });

  const items = normalizeChecklistItems(req.body?.items);
  upsertPackingChecklist.run(repoId, JSON.stringify(items), nowISO());
  res.json({ ok: true, items });
});

// Easy Commit Mode – save current plan with friendly non-fast-forward handling
app.post('/api/repos/:repoId/easy-save', (req, res) => {
  try {
    const repoId = req.params.repoId;
    const repo = getRepo.get(repoId);
    if (!repo) {
      return res.status(404).json({ ok: false, error: 'repo_not_found' });
    }
    const writeErr = requireWriteAccess(repo, req.user);
    if (writeErr) return res.status(403).json({ ok: false, error: 'forbidden', message: writeErr });

    const branchName = String(req.body.branch || 'main');
    const expectedParentId =
      req.body.parentId && String(req.body.parentId).trim()
        ? String(req.body.parentId).trim()
        : null;
    const clientPlan = req.body.plan || null;

    const br = getBranch.get(repo.id, branchName);
    if (!br) {
      return res.status(404).json({ ok: false, error: 'branch_not_found' });
    }

    const headRow = br.head_commit_id ? getCommit.get(br.head_commit_id) : null;
    const head = headRow ? rowToCommit(headRow) : null;
    const currentHeadId = head ? head.id : null;

    // Non-fast-forward check: branch head moved since client loaded page
    if (expectedParentId && currentHeadId && expectedParentId !== currentHeadId) {
      return res.status(409).json({
        ok: false,
        error: 'non_fast_forward',
        message:
          'Your trip changed on another device or tab. Please refresh this page and try again.',
        currentHeadId,
      });
    }

    const baseSnap =
      head && head.snapshot
        ? head.snapshot
        : { files: {}, plan: { days: [] } };
    const basePlan = baseSnap.plan || { days: [] };

    const clientDays = Array.isArray(clientPlan?.days)
      ? clientPlan.days
      : basePlan.days || [];

    // Ensure every stop has an id so later merges can match stops reliably.
    clientDays.forEach((d) => {
      if (!d || !Array.isArray(d.stops)) return;
      d.stops.forEach((s) => {
        if (!s) return;
        if (s.id == null || String(s.id).trim() === '') {
          s.id = uuid();
        }
      });
    });

    const newPlan = {
      ...basePlan,
      ...(clientPlan || {}),
      days: clientDays,
    };

    const newSnap = {
      ...baseSnap,
      plan: newPlan,
    };

    const commitId = uuid();
    const author =
      res.locals.currentUser?.email ||
      res.locals.currentUser?.name ||
      'easy';

    insertCommitWithKeyChange({
      id: commitId,
      repoId: repo.id,
      author,
      message: 'Update trip (easy save)',
      parents: currentHeadId ? [currentHeadId] : [],
      snapshot: newSnap,
      createdAt: nowISO(),
    });
    updateBranchHead.run(commitId, br.id);

    res.json({
      ok: true,
      commitId,
      headBefore: currentHeadId,
      headAfter: commitId,
    });
  } catch (e) {
    console.error('easy-save error', e);
    res
      .status(500)
      .json({ ok: false, error: String(e.message || e) });
  }
});

app.post('/api/repos/:repoId/merge', (req, res) => {
  const { ours, theirs, targetBranch, author = 'cli' } = req.body;
  const repo = getRepo.get(req.params.repoId);
  if (!repo) return res.status(404).json({ error: 'not_found' });
  const writeErr = requireWriteAccess(repo, req.user);
  if (writeErr) return res.status(403).json({ error: 'forbidden', message: writeErr });

  const oursId = String(ours || '').trim();
  const theirsId = String(theirs || '').trim();
  const target = String(targetBranch || '').trim() || 'main';

  if (!oursId || !theirsId) {
    return res.status(400).json({ error: 'missing_commits' });
  }

  const br = getBranch.get(repo.id, target);
  if (!br) return res.status(404).json({ error: 'branch_not_found' });

  // Non-fast-forward safety: ensure the target branch is still what the client compared against
  if (br.head_commit_id && br.head_commit_id !== theirsId) {
    return res.status(409).json({
      error: 'non_fast_forward',
      message:
        'Target branch moved since you opened the merge page. Reload and try again.',
      currentHeadId: br.head_commit_id,
    });
  }

  // Compute merge base on the server (don’t trust client-provided base)
  const baseId = findLCA(oursId, theirsId);
  if (!baseId) {
    return res.status(400).json({ error: 'no_common_base' });
  }

  const baseRow = getCommit.get(baseId);
  const ourRow = getCommit.get(oursId);
  const theirRow = getCommit.get(theirsId);

  const baseC = baseRow ? rowToCommit(baseRow) : null;
  const ourC = ourRow ? rowToCommit(ourRow) : null;
  const theirC = theirRow ? rowToCommit(theirRow) : null;

  if (!baseC || !ourC || !theirC) {
    return res.status(400).json({ error: 'bad_commits' });
  }

  const { snapshot, conflicts } = mergeSnapshots(
    baseC.snapshot,
    ourC.snapshot,
    theirC.snapshot
  );
  if (conflicts.length) return res.status(409).json({ conflicts });

  const id = uuid();
  insertCommitWithKeyChange({
    id,
    repoId: repo.id,
    author,
    message: `Merge ${oursId.slice(0, 7)} into ${target}`,
    parents: [ourC.id, theirC.id],
    snapshot,
    createdAt: nowISO(),
  });
  updateBranchHead.run(id, br.id);
  res.json({ ok: true, commitId: id });
});

app.get('/api/repos/:repoId/clone', (req, res) => {
  const { branch = 'main' } = req.query;
  const repo = getRepo.get(req.params.repoId);
  if (!repo) return res.status(404).json({ error: 'not_found' });
  const br = getBranch.get(repo.id, branch);
  if (!br) return res.status(404).json({ error: 'branch_not_found' });
  const head =
    br.head_commit_id && rowToCommit(getCommit.get(br.head_commit_id));
  res.json({
    repoId: repo.id,
    branch: br.name,
    headCommitId: head?.id,
    snapshot: head?.snapshot || { files: {}, plan: { days: [] } },
  });
});

app.post('/api/repos/:repoId/push', (req, res) => {
  const {
    branch,
    baseCommitId,
    message,
    author = 'cli',
    snapshot,
  } = req.body;
  const repo = getRepo.get(req.params.repoId);
  if (!repo) return res.status(404).json({ error: 'not_found' });
  const writeErr = requireWriteAccess(repo, req.user);
  if (writeErr) return res.status(403).json({ error: 'forbidden', message: writeErr });
  const br = getBranch.get(repo.id, branch);
  if (!br) return res.status(404).json({ error: 'branch_not_found' });
  if (br.head_commit_id !== baseCommitId) {
    return res
      .status(409)
      .json({ error: 'non_fast_forward', head: br.head_commit_id });
  }
  const id = uuid();
  insertCommitWithKeyChange({
    id,
    repoId: repo.id,
    author,
    message,
    parents: [baseCommitId].filter(Boolean),
    snapshot,
    createdAt: nowISO(),
  });
  updateBranchHead.run(id, br.id);
  res.json({ ok: true, commitId: id });
});

// ---------- Geo proxy (Nominatim via geosearch.js) ----------
app.get('/api/geo/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const limit = Number(req.query.limit || 6) || 6;

    if (!q) {
      return res.status(400).json({ ok: false, error: 'missing_query' });
    }

    // Fuzzy search: results are ranked so the closest name match is first,
    // and we still return up to `limit` suggestions.
    const results = await fuzzySearchPlaces(q, limit);

    res.json({
      ok: true,
      results,
    });
  } catch (e) {
    console.error('Geo search error:', e);
    res
      .status(502)
      .json({ ok: false, error: String(e.message || e) });
  }
});

app.get('/api/geo/lookup', async (req, res) => {
  try {
    const { osm_type, osm_id } = req.query;
    if (!osm_type || !osm_id) {
      return res
        .status(400)
        .json({ ok: false, error: 'missing_params' });
    }
    const data = await nominatimLookup(String(osm_type), String(osm_id));
    res.json({ ok: true, result: data });
  } catch (e) {
    console.error('Geo lookup error:', e);
    res
      .status(502)
      .json({ ok: false, error: String(e.message || e) });
  }
});

// ---------- Merge UI helpers (commit graph traversal) ----------

function getCommitRow(id) {
  return id ? getCommit.get(id) : null;
}

function parentsOf(row) {
  try {
    return row ? JSON.parse(row.parents) : [];
  } catch {
    return [];
  }
}

/** BFS to collect the full set of ancestor commit IDs from a starting commit. */
function ancestorsSet(startId) {
  const seen = new Set();
  const q = [startId];
  while (q.length) {
    const cur = q.shift();
    if (!cur || seen.has(cur)) continue;
    seen.add(cur);
    const row = getCommitRow(cur);
    const ps = parentsOf(row);
    ps.forEach((p) => q.push(p));
  }
  return seen;
}
/**
 * Find the Lowest Common Ancestor (merge base) of two commits.
 * Collects all ancestors of A, then BFS from B until hitting one → that's the LCA.
 */
function findLCA(aId, bId) {
  if (!aId || !bId) return null;
  const A = ancestorsSet(aId);
  const q = [bId];
  const visited = new Set();
  while (q.length) {
    const cur = q.shift();
    if (!cur || visited.has(cur)) continue;
    if (A.has(cur)) return cur;
    visited.add(cur);
    const row = getCommitRow(cur);
    const ps = parentsOf(row);
    ps.forEach((p) => q.push(p));
  }
  return null;
}

// ---------- Merge UI ----------
app.get('/ui/repos/:repoId/merge', (req, res) => {
  const repo = getRepo.get(req.params.repoId);
  if (!repo) return res.status(404).send('Repo not found');

  const branches = listBranches.all(repo.id);
  const source = req.query.source || (branches[0]?.name || 'main');
  const target = req.query.target || 'main';

  const sbr = getBranch.get(repo.id, source);
  const tbr = getBranch.get(repo.id, target);

  const oursId = sbr?.head_commit_id || null;
  const theirsId = tbr?.head_commit_id || null;
  const baseId = findLCA(oursId, theirsId);

  const ourRow = oursId ? getCommit.get(oursId) : null;
  const theirRow = theirsId ? getCommit.get(theirsId) : null;
  const ourC = ourRow ? rowToCommit(ourRow) : null;
  const theirC = theirRow ? rowToCommit(theirRow) : null;

  let baseC = null;
  if (baseId) {
    const baseRow = getCommit.get(baseId);
    baseC = baseRow ? rowToCommit(baseRow) : null;
  }

  let conflicts = [];
  let mergedPlan = null;
  if (baseC && ourC && theirC) {
    const resMerge = mergeSnapshots(
      baseC.snapshot,
      ourC.snapshot,
      theirC.snapshot
    );
    conflicts = resMerge.conflicts || [];
    mergedPlan = resMerge.snapshot?.plan || null;
  }

  res.render('merge', {
    repo,
    branches,
    source,
    target,
    baseId,
    oursId,
    theirsId,
    conflicts,
    basePlan: baseC?.snapshot?.plan || null,
    ourPlan: ourC?.snapshot?.plan || null,
    theirPlan: theirC?.snapshot?.plan || null,
    pageTitle: `Merge – ${repo.title}`,
    pageDescription: `Merge branches for the "${repo.title}" trip on GiTrip. Compare plans, resolve conflicts, and unify your itinerary.`,
    mergedPlan,
  });
});

app.post('/ui/repos/:repoId/merge-resolve', (req, res) => {
  const repo = getRepo.get(req.params.repoId);
  if (!repo) return res.status(404).send('Repo not found');
  const writeErr = requireWriteAccess(repo, req.user);
  if (writeErr) return res.status(403).send(writeErr);

  const { baseId, oursId, theirsId, targetBranch, resolutions } = req.body;

  const baseRow = getCommit.get(baseId);
  const ourRow = getCommit.get(oursId);
  const theirRow = getCommit.get(theirsId);

  if (!baseRow || !ourRow || !theirRow) {
    return res.status(400).send('Bad commit ids');
  }

  const baseC = rowToCommit(baseRow);
  const ourC = rowToCommit(ourRow);
  const theirC = rowToCommit(theirRow);

  const { snapshot } = mergeSnapshots(
    baseC.snapshot,
    ourC.snapshot,
    theirC.snapshot
  );
  let merged = snapshot;

  let decisions = [];
  try {
    decisions = JSON.parse(resolutions || '[]');
    if (!Array.isArray(decisions)) decisions = [];
  } catch {
    decisions = [];
  }

  for (const d of decisions) {
    if (d.type === 'file') {
      const key = d.path;
      if (!merged.files) merged.files = {};
      if (d.choice === 'ours') {
        merged.files[key] = (ourC.snapshot.files || {})[key];
      } else if (d.choice === 'theirs') {
        merged.files[key] = (theirC.snapshot.files || {})[key];
      } else {
        merged.files[key] = (baseC.snapshot.files || {})[key];
      }
    } else if (d.type === 'plan-stop-time') {
      const { dayId, stopId, choice } = d;
      const days = merged.plan?.days || [];
      const day = days.find((x) => x.id === dayId);
      if (!day) continue;
      const stop = day.stops.find((s) => s.id === stopId);
      if (!stop) continue;

      const pick =
        choice === 'ours'
          ? ourC
          : choice === 'theirs'
          ? theirC
          : baseC;

      const pd = pick.snapshot.plan?.days?.find((x) => x.id === dayId);
      const ps = pd ? (pd.stops || []).find((s) => s.id === stopId) : null;
      if (ps) {
        stop.arrive = ps.arrive;
        stop.depart = ps.depart;
      }
    } else if (d.type === 'plan-whole') {
      const choice = d.choice || 'base';
      if (!merged.plan) merged.plan = {};
      if (choice === 'ours') {
        merged.plan = ourC.snapshot.plan || null;
      } else if (choice === 'theirs') {
        merged.plan = theirC.snapshot.plan || null;
      } else {
        merged.plan = baseC.snapshot.plan || null;
      }
    } else if (d.type === 'plan-stop-delete') {
      const { dayId, stopId, choice } = d;

      const day = merged.plan?.days?.find((x) => x.id === dayId);
      if (!day || !Array.isArray(day.stops)) continue;

      const idx = day.stops.findIndex((s) => s && s.id === stopId);
      if (idx < 0) continue;

      const pick =
        choice === 'ours'
          ? ourC
          : choice === 'theirs'
          ? theirC
          : baseC;

      const pd = pick.snapshot.plan?.days?.find((x) => x.id === dayId);
      const ps = pd ? (pd.stops || []).find((s) => s && s.id === stopId) : null;

      if (ps) {
        day.stops[idx] = ps;
      } else {
        // chosen version deleted it
        day.stops.splice(idx, 1);
      }
    }
  }

  const br = getBranch.get(repo.id, targetBranch);
  if (!br) return res.status(404).send('Branch not found');

  // Non-fast-forward safety: don't resolve/merge if target moved
  if (br.head_commit_id && br.head_commit_id !== theirsId) {
    return res
      .status(409)
      .send('Target branch changed since you opened this merge. Please re-run the merge page.');
  }

  const id = uuid();
  insertCommitWithKeyChange({
    id,
    repoId: repo.id,
    author: 'web',
    message: `Merge ${oursId.slice(0, 7)} into ${targetBranch} (resolved)`,
    parents: [ourC.id, theirC.id],
    snapshot: merged,
    createdAt: nowISO(),
  });
  updateBranchHead.run(id, br.id);
  res.redirect(`/ui/repos/${repo.id}`);
});

// Rename trip title
app.post('/ui/repos/:repoId/rename', (req, res) => {
  const repo = getRepo.get(req.params.repoId);
  if (!repo) return res.status(404).send('Repo not found');

  // If there is an owner, only they can rename
  if (repo.owner_user_id && (!req.user || req.user.id !== repo.owner_user_id)) {
    return res.status(403).send('Only the owner can rename this trip.');
  }

  const title = String(req.body.title || '').trim();
  if (!title) {
    return res.redirect(`/ui/repos/${repo.id}`);
  }

  updateRepoTitle.run(title, repo.id);
  res.redirect(`/ui/repos/${repo.id}`);
});

// ---------- Route geometry for map (Google-like routes) ----------
// Compute route geometry + transit leg details for one day
app.post('/api/repos/:id/plan/route-geometry', async (req, res) => {
  try {
    // We ignore repo id here and just use the posted day data
    const { mode, date, stops } = req.body || {};
    const travelMode = String(mode || 'driving').toLowerCase();

    const rawStops = Array.isArray(stops) ? stops : [];

    // Convert posted stops into points for routing
    const pts = rawStops
      .map((s) => ({
        lat: Number(s.lat),
        lng: Number(s.lng),
      }))
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));

    if (pts.length < 2) {
      return res.json({
        ok: true,
        segments: [],
        transitStops: [],
        transitLegs: [],
        legModes: [],
      });
    }

    // Approximate start time: arrival time at first stop
    let startTimeMin = null;
    if (rawStops[0] && typeof rawStops[0].arrive === 'string') {
      const parts = rawStops[0].arrive.split(':').map(Number);
      const h = parts[0] || 0;
      const m = parts[1] || 0;
      startTimeMin = h * 60 + m;
    }

    const legCount = pts.length - 1;
    const result = await routeLegs(pts, travelMode, {
      dateIso: date || null,
      startTimeMin,
      collectStops: travelMode === 'transit',
    });

    const { segments, perLegSubModes } = extractRouteSegments(
      result,
      travelMode,
      legCount
    );
    const rawTransitSteps =
      travelMode === 'transit'
        ? collectTransitStepsFromRouteResult(result, legCount)
        : Array.from({ length: legCount }, () => []);

    // Build transitLegs for the textual sub‑list under each stop
    let transitLegs = [];
    if (travelMode === 'transit') {
      transitLegs = rawTransitSteps
        .map((steps, idx) => ({
          fromIndex: idx,
          toIndex: idx + 1,
          steps: Array.isArray(steps) ? steps : [],
        }))
        .filter((leg) => leg.steps.length);
    }

    // Normalise transitStops too
    const transitStops = Array.isArray(result.transitStops)
      ? result.transitStops
          .map((s) => ({
            lat: Number(s.lat),
            lng: Number(s.lng),
            name: s.name || null,
          }))
          .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng))
      : [];

    const legModes = inferLegModes(
      perLegSubModes,
      travelMode,
      legCount,
      rawTransitSteps
    );

    res.json({
      ok: true,
      segments,
      transitStops,
      transitLegs,
      legModes,
    });
  } catch (err) {
    console.error('route-geometry error', err);
    res.status(500).json({
      ok: false,
      error: 'route-geometry failed',
    });
  }
});

// ---------- Recompute travel ----------
app.post(
  '/api/repos/:repoId/plan/recompute-travel',
  async (req, res) => {
    try {
      const { branch, dayId, mode } = req.body || {};
      const repo = getRepo.get(req.params.repoId);
      if (!repo) {
        return res.status(404).json({ error: 'repo_not_found' });
      }
      const writeErr = requireWriteAccess(repo, req.user);
      if (writeErr) return res.status(403).json({ error: 'forbidden', message: writeErr });

      const br = getBranch.get(repo.id, branch);
      const head = br?.head_commit_id
        ? rowToCommit(getCommit.get(br.head_commit_id))
        : null;
      if (!head) {
        return res.status(400).json({ error: 'no_head' });
      }

      const snap = head.snapshot;
      const day = snap?.plan?.days?.find((d) => d.id === dayId);
      if (!day || day.stops.length < 2) {
        return res.json({ ok: true, updated: false });
      }

      const pts = day.stops.map((s) => ({
        lat: Number(s.lat),
        lng: Number(s.lng),
      }));
      const effectiveMode = String(
        mode || snap.plan?.transport || 'driving'
      ).toLowerCase();
      const legs = await routeLegs(pts, effectiveMode, {
        dateIso: day.date,
        startTimeMin: 9 * 60,
      });
      const legCount = Math.max(day.stops.length - 1, 0);
      const { perLegSubModes } = extractRouteSegments(
        legs,
        effectiveMode,
        legCount,
        { includeSegments: false }
      );
      const transitSteps =
        effectiveMode === 'transit'
          ? collectTransitStepsFromRouteResult(legs, legCount)
          : Array.from({ length: legCount }, () => []);
      const inferredModes = inferLegModes(
        perLegSubModes,
        effectiveMode,
        legCount,
        transitSteps
      );
      const mins = legs.minutes || [];

      for (let i = 1; i < day.stops.length; i++) {
        day.stops[i].prevTravelMin = Number.isFinite(mins[i - 1])
          ? mins[i - 1]
          : day.stops[i].prevTravelMin || 0;
        day.stops[i].routeMode =
          inferredModes[i - 1] || effectiveMode || 'driving';
      }

      if (!snap.plan) snap.plan = { days: [] };
      snap.plan.transport = effectiveMode || snap.plan.transport || 'driving';

      const commitId = uuid();
      insertCommitWithKeyChange({
        id: commitId,
        repoId: repo.id,
        author: 'planner',
        message: `Recompute travel for ${dayId} (${mode})`,
        parents: [head.id],
        snapshot: snap,
        createdAt: nowISO(),
      });
      updateBranchHead.run(commitId, br.id);
      res.json({ ok: true, commitId });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  }
);

// ---------- START (auto-port fallback) ----------
const DESIRED = Number(process.env.PORT) || 4000;
function start(port) {
  const server = app.listen(port, () => {
    console.log(`GiTrip server running http://localhost:${port}`);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && !process.env.PORT) {
      console.warn(`Port ${port} in use, trying ${port + 1}...`);
      start(port + 1);
    } else {
      throw err;
    }
  });
}
start(DESIRED);
