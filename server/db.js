/**
 * server/db.js — SQLite database setup and schema migrations.
 *
 * Opens (or creates) gitrip.db using better-sqlite3, runs the table-creation
 * DDL statements, and exports the db handle plus a helper to deserialise
 * commit rows from their JSON-encoded columns.
 */
import Database from 'better-sqlite3';

const DB_PATH = process.env.DATABASE_PATH || 'gitrip.db';
export const db = new Database(DB_PATH);

export function rowToCommit(row) {
  if (!row) return null;
  return {
    id: row.id,
    repoId: row.repo_id,
    author: row.author,
    message: row.message,
    parents: JSON.parse(row.parents || '[]'),
    snapshot: JSON.parse(row.snapshot || '{"files":{},"plan":{"days":[]}}'),
    createdAt: row.created_at,
    keyChangeScore: Number(row.key_change_score || 0),
    keyChangeAuto: !!row.key_change_auto,
    keyChangeManual: !!row.key_change_manual,
    keyChangeReason: row.key_change_reason || null,
  };
}

export function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS repos (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      forked_from_repo_id TEXT
      -- owner_user_id, visibility, current_branch added via ALTER TABLE
    );

    CREATE TABLE IF NOT EXISTS branches (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      name TEXT NOT NULL,
      head_commit_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS commits (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      author TEXT NOT NULL,
      message TEXT NOT NULL,
      parents TEXT NOT NULL,
      snapshot TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS travel_alerts (
      repo_id TEXT PRIMARY KEY,
      notes TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS packing_checklists (
      repo_id TEXT PRIMARY KEY,
      items TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS repo_collaborators (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS repo_stars (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(repo_id, user_id)
    );
  `);

  // Add current_branch if missing
  try {
    db.exec(`ALTER TABLE repos ADD COLUMN current_branch TEXT DEFAULT 'main'`);
  } catch (e) {
    if (!/duplicate column name/i.test(String(e.message))) throw e;
  }

  // Add owner_user_id if missing
  try {
    db.exec(`ALTER TABLE repos ADD COLUMN owner_user_id TEXT`);
  } catch (e) {
    if (!/duplicate column name/i.test(String(e.message))) throw e;
  }

  // Add visibility if missing
  try {
    db.exec(
      `ALTER TABLE repos ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'`
    );
  } catch (e) {
    if (!/duplicate column name/i.test(String(e.message))) throw e;
  }

  // Add profile image url for users if missing
  try {
    db.exec(`ALTER TABLE users ADD COLUMN profile_image_url TEXT`);
  } catch (e) {
    if (!/duplicate column name/i.test(String(e.message))) throw e;
  }

  // Add commit key-change metadata if missing
  try {
    db.exec(`ALTER TABLE commits ADD COLUMN key_change_score INTEGER DEFAULT 0`);
  } catch (e) {
    if (!/duplicate column name/i.test(String(e.message))) throw e;
  }
  try {
    db.exec(`ALTER TABLE commits ADD COLUMN key_change_auto INTEGER DEFAULT 0`);
  } catch (e) {
    if (!/duplicate column name/i.test(String(e.message))) throw e;
  }
  try {
    db.exec(`ALTER TABLE commits ADD COLUMN key_change_manual INTEGER DEFAULT 0`);
  } catch (e) {
    if (!/duplicate column name/i.test(String(e.message))) throw e;
  }
  try {
    db.exec(`ALTER TABLE commits ADD COLUMN key_change_reason TEXT`);
  } catch (e) {
    if (!/duplicate column name/i.test(String(e.message))) throw e;
  }

  // Add forked_from reference if missing
  try {
    db.exec(`ALTER TABLE repos ADD COLUMN forked_from_repo_id TEXT`);
  } catch (e) {
    if (!/duplicate column name/i.test(String(e.message))) throw e;
  }

  // Backfill defaults
  db.exec(`
    UPDATE repos
    SET current_branch = 'main'
    WHERE current_branch IS NULL OR current_branch = '';
  `);

  db.exec(`
    UPDATE repos
    SET visibility = 'private'
    WHERE visibility IS NULL OR visibility = '';
  `);
}
