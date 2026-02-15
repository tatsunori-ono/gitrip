#!/usr/bin/env node
/**
 * cli/gitrip.js — GiTrip command-line interface.
 *
 * Provides Git-like commands (init, add, commit, push, pull, branch, merge,
 * clone, status) for managing trip plans from the terminal.  Each command
 * communicates with the GiTrip server API and maintains local state in the
 * .gitrip/ directory (config, index, commits, and last snapshot).
 */
import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { globSync } from 'glob';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const program = new Command();
program.name('gitrip').description('GiTrip CLI').version('0.2.0');

// ---------- Paths ----------
const CWD = process.cwd();
const GI = path.join(CWD, '.gitrip');          // local repo metadata directory
const STAGE = path.join(GI, 'stage');           // staging area
const COMMITS = path.join(GI, 'commits');       // local commit store
const CFG = path.join(GI, 'config.json');       // server URL + repo ID + branch
const INDEX = path.join(GI, 'index.json');      // tracked file list
const LAST_SNAPSHOT = path.join(GI, 'last_snapshot.json'); // most recent snapshot

// ---------- Utility helpers ----------

/** Ensure the .gitrip directory structure exists. */
function ensureDirs() {
  [GI, STAGE, COMMITS].forEach(p => fs.mkdirSync(p, { recursive: true }));
  if (!fs.existsSync(INDEX)) {
    fs.writeFileSync(INDEX, JSON.stringify({ tracked: [] }, null, 2));
  }
}

/** Read and parse a JSON file; returns `def` on any error. */
function readJSON(p, def = null) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return def;
  }
}

/** Write an object as pretty-printed JSON. */
function writeJSON(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

/** SHA-1 hash of a buffer, used to generate local commit IDs. */
function sha1(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

/** Load the repo config or throw if not initialised. */
function loadCfg() {
  const c = readJSON(CFG);
  if (!c) {
    throw new Error(
      'Not a gitrip repo (missing .gitrip/config.json). Run `gitrip init`.'
    );
  }
  return c;
}

/** Expand glob patterns into a list of tracked file paths. */
function listAllFiles(patterns) {
  const pats = patterns.length ? patterns : ['**/*'];
  const files = new Set();
  pats.forEach(p => {
    globSync(p, {
      dot: false,
      nodir: true,
      cwd: CWD,
      ignore: ['.gitrip/**', 'node_modules/**'],
    }).forEach(f => files.add(f));
  });
  return Array.from(files);
}

/**
 * Build a snapshot from the current index (tracked files + plan/plan.json).
 * The snapshot structure mirrors the server format: { files, plan }.
 */
function snapshotFromIndex() {
  const { tracked } = readJSON(INDEX, { tracked: [] });
  const base = readJSON(LAST_SNAPSHOT, { files: {}, plan: { days: [] } });
  const files = { ...base.files };

  // Re-read tracked files from disk into the snapshot
  for (const rel of tracked) {
    if (!fs.existsSync(path.join(CWD, rel))) continue;
    const data = fs.readFileSync(path.join(CWD, rel), 'utf8');
    files[rel] = data;
  }

  // plan/plan.json is the canonical trip plan source
  let plan = base.plan || { days: [] };
  const planPath = path.join(CWD, 'plan', 'plan.json');
  if (fs.existsSync(planPath)) {
    try {
      plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    } catch { /* keep base plan on parse error */ }
    files['plan/plan.json'] = JSON.stringify(plan, null, 2);
  }

  return { files, plan };
}

// ----------------- Commands -----------------

program
  .command('init')
  .description('Create a new GiTrip repo on the server and wire the current folder')
  .requiredOption('-t, --title <title>', 'Title for the trip repo')
  .option('-s, --server <url>', 'Server URL', 'http://localhost:4000')
  .action(async (opts) => {
    ensureDirs();
    const res = await fetch(`${opts.server}/api/repos/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: opts.title }),
    });
    if (!res.ok) {
      console.error('Init failed:', res.statusText);
      process.exit(1);
    }
    const j = await res.json();
    const cfg = {
      server: opts.server,
      repoId: j.repoId,
      branch: j.defaultBranch || 'main',
    };
    writeJSON(CFG, cfg);
    writeJSON(LAST_SNAPSHOT, { files: {}, plan: { days: [] } });
    console.log(
      `Initialized GiTrip repo ${j.repoId} on ${opts.server} (branch ${cfg.branch})`
    );
  });

program
  .command('add')
  .description('Stage files (like git add). Use "." to stage everything.')
  .argument('[patterns...]', 'files or globs')
  .action((patterns = []) => {
    ensureDirs();
    if (patterns.length === 1 && patterns[0] === '.') patterns = ['**/*'];
    const files = listAllFiles(patterns);
    const idx = readJSON(INDEX, { tracked: [] });
    const set = new Set(idx.tracked);
    files.forEach(f => set.add(f));
    writeJSON(INDEX, { tracked: Array.from(set).sort() });
    console.log(`Staged ${files.length} file(s).`);
  });

program
  .command('commit')
  .description('Create a local commit from staged changes')
  .requiredOption('-m, --message <msg>', 'Commit message')
  .action((opts) => {
    ensureDirs();
    const cfg = loadCfg();
    const snap = snapshotFromIndex();
    const id = sha1(Buffer.from(Date.now() + opts.message));
    writeJSON(path.join(COMMITS, `${id}.json`), {
      id,
      message: opts.message,
      snapshot: snap,
      createdAt: new Date().toISOString(),
    });
    writeJSON(LAST_SNAPSHOT, snap);
    console.log(`Local commit ${id.slice(0, 8)}: ${opts.message}`);
  });

program
  .command('push')
  .description('Push current working snapshot as a commit to the server')
  .argument('[remote]', 'remote name (ignored, just use "origin")', 'origin')
  .argument('[branch]', 'branch name', null)
  .action(async (remote, branch) => {
    ensureDirs();
    const cfg = loadCfg();
    const br = branch || cfg.branch;

    // Fetch the current branch head to use as the parent commit
    const headRes = await fetch(
      `${cfg.server}/api/repos/${cfg.repoId}/branches/${encodeURIComponent(br)}`
    );
    if (!headRes.ok) {
      console.error('Cannot read branch head');
      process.exit(1);
    }
    const { headCommit } = await headRes.json();

    const snap = snapshotFromIndex();
    const body = {
      branch: br,
      baseCommitId: headCommit?.id || null,
      message: 'push from CLI',
      author: 'cli',
      snapshot: snap,
    };
    const res = await fetch(`${cfg.server}/api/repos/${cfg.repoId}/commits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (res.status === 409) {
      const j = await res.json().catch(() => ({}));
      console.error(
        'Push rejected (non fast-forward). Pull and try again. Head is',
        j.head
      );
      process.exit(2);
    }
    if (!res.ok) {
      console.error('Push failed:', res.statusText);
      process.exit(1);
    }
    const jj = await res.json();
    console.log(`Pushed commit ${jj.commitId.slice(0, 8)} to ${br}`);
  });

program
  .command('pull')
  .description('Pull the current branch from server and update working files')
  .argument('[remote]', 'remote name (ignored)', 'origin')
  .argument('[branch]', 'branch name', null)
  .action(async (remote, branch) => {
    const cfg = loadCfg();
    const br = branch || cfg.branch;

    const res = await fetch(
      `${cfg.server}/api/repos/${cfg.repoId}/clone?branch=${encodeURIComponent(br)}`
    );
    if (!res.ok) {
      console.error('Pull failed:', res.statusText);
      process.exit(1);
    }
    const { snapshot } = await res.json();

    // Write snapshot files to disk
    fs.mkdirSync(path.join(CWD, 'plan'), { recursive: true });
    if (snapshot.plan) {
      fs.writeFileSync(
        path.join(CWD, 'plan', 'plan.json'),
        JSON.stringify(snapshot.plan, null, 2)
      );
    }
    for (const [rel, data] of Object.entries(snapshot.files || {})) {
      const abs = path.join(CWD, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, data, 'utf8');
    }
    writeJSON(LAST_SNAPSHOT, snapshot);
    console.log(`Pulled branch ${br}. Working tree updated.`);
  });

program
  .command('branch')
  .description('List or create a branch')
  .option('-c, --create <name>', 'create branch from current HEAD')
  .action(async (opts) => {
    const cfg = loadCfg();

    if (opts.create) {
      const headRes = await fetch(
        `${cfg.server}/api/repos/${cfg.repoId}/branches/${encodeURIComponent(cfg.branch)}`
      );
      const { headCommit } = await headRes.json();
      const res = await fetch(`${cfg.server}/api/repos/${cfg.repoId}/branches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: opts.create,
          fromCommitId: headCommit?.id || null,
        }),
      });
      if (!res.ok) {
        console.error('Create branch failed');
        process.exit(1);
      }
      console.log(`Created branch ${opts.create}`);
      return;
    }

    // List all branches, marking the current one with *
    const res = await fetch(`${cfg.server}/api/repos/${cfg.repoId}/branches`);
    const arr = await res.json();
    arr.forEach(b => {
      console.log(`${b.name}${b.name === cfg.branch ? ' *' : ''}`);
    });
  });

program
  .command('merge')
  .description('Merge source into target (server-side, fast-forward if clean)')
  .requiredOption('-s, --source <name>', 'source branch')
  .requiredOption('-t, --target <name>', 'target branch')
  .action(async (opts) => {
    const cfg = loadCfg();

    // Fetch both branch heads; the server computes the LCA internally.
    // If conflicts exist the API returns 409 — use the web UI to resolve.
    const b1 = await (
      await fetch(`${cfg.server}/api/repos/${cfg.repoId}/branches/${encodeURIComponent(opts.source)}`)
    ).json();
    const b2 = await (
      await fetch(`${cfg.server}/api/repos/${cfg.repoId}/branches/${encodeURIComponent(opts.target)}`)
    ).json();

    const body = {
      ours: b1.headCommit?.id,
      theirs: b2.headCommit?.id,
      targetBranch: opts.target,
      author: 'cli',
    };
    const res = await fetch(`${cfg.server}/api/repos/${cfg.repoId}/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (res.status === 409) {
      console.error('Merge has conflicts. Use the web resolver.');
      process.exit(2);
    }
    if (!res.ok) {
      console.error('Merge failed:', res.statusText);
      process.exit(1);
    }
    const j = await res.json();
    console.log('Merged, new commit', j.commitId.slice(0, 8));
  });

program
  .command('clone')
  .description('Clone a remote branch into the current empty folder')
  .requiredOption('-r, --repo <id>', 'repo id')
  .option('-b, --branch <name>', 'branch', 'main')
  .option('-s, --server <url>', 'server', 'http://localhost:4000')
  .action(async (opts) => {
    ensureDirs();
    const cfg = {
      server: opts.server,
      repoId: opts.repo,
      branch: opts.branch,
    };
    writeJSON(CFG, cfg);

    const res = await fetch(
      `${opts.server}/api/repos/${opts.repo}/clone?branch=${encodeURIComponent(opts.branch)}`
    );
    if (!res.ok) {
      console.error('Clone failed:', res.statusText);
      process.exit(1);
    }
    const { snapshot } = await res.json();

    // Write snapshot files to disk
    fs.mkdirSync(path.join(CWD, 'plan'), { recursive: true });
    if (snapshot.plan) {
      fs.writeFileSync(
        path.join(CWD, 'plan', 'plan.json'),
        JSON.stringify(snapshot.plan, null, 2)
      );
    }
    for (const [rel, data] of Object.entries(snapshot.files || {})) {
      const abs = path.join(CWD, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, data, 'utf8');
    }
    writeJSON(LAST_SNAPSHOT, snapshot);
    console.log(`Cloned repo ${opts.repo} branch ${opts.branch} into ${CWD}`);
  });

program
  .command('status')
  .description('Show tracked files and staged count')
  .action(() => {
    const idx = readJSON(INDEX, { tracked: [] });
    console.log('Tracked files:');
    idx.tracked.forEach(f => console.log('  ', f));
  });

program.parseAsync(process.argv);
