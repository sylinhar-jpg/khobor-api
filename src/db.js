'use strict';
// Storage: Postgres when DATABASE_URL is set, otherwise a local SQLite file.
// All SQL is written with ? placeholders and portable types (INTEGER ms timestamps, 0/1 flags).

const path = require('path');
const fs = require('fs');

const SCHEMA = (pg) => {
  const ID = pg ? 'BIGSERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  const BLOB = pg ? 'BYTEA' : 'BLOB';
  const BIG = pg ? 'BIGINT' : 'INTEGER';
  return `
CREATE TABLE IF NOT EXISTS categories (
  id ${ID}, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, name_en TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS channels (
  id ${ID}, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '', district TEXT NOT NULL DEFAULT '', logo_url TEXT NOT NULL DEFAULT '',
  verified INTEGER NOT NULL DEFAULT 0, is_sample INTEGER NOT NULL DEFAULT 0, created_at ${BIG} NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id ${ID}, identifier TEXT UNIQUE NOT NULL, name TEXT NOT NULL, username TEXT UNIQUE, bio TEXT NOT NULL DEFAULT '',
  district TEXT NOT NULL DEFAULT '', photo_url TEXT NOT NULL DEFAULT '', pin_hash TEXT NOT NULL,
  failed_pins INTEGER NOT NULL DEFAULT 0, locked_until ${BIG} NOT NULL DEFAULT 0, created_at ${BIG} NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id ${BIG} NOT NULL, created_at ${BIG} NOT NULL
);
CREATE TABLE IF NOT EXISTS otps (
  id ${ID}, identifier TEXT NOT NULL, purpose TEXT NOT NULL, code_hash TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  expires_at ${BIG} NOT NULL, created_at ${BIG} NOT NULL, verify_token_hash TEXT, used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS news (
  id ${ID}, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '',
  image_url TEXT NOT NULL DEFAULT '', category_id ${BIG}, channel_id ${BIG}, district TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '', guid TEXT UNIQUE, published_at ${BIG} NOT NULL,
  status TEXT NOT NULL DEFAULT 'published', author_user_id ${BIG}, is_featured INTEGER NOT NULL DEFAULT 0,
  is_sample INTEGER NOT NULL DEFAULT 0, haram_auto INTEGER NOT NULL DEFAULT 0, haram_terms TEXT NOT NULL DEFAULT '',
  haram_override INTEGER, author_marked_haram INTEGER NOT NULL DEFAULT 0, views INTEGER NOT NULL DEFAULT 0,
  created_at ${BIG} NOT NULL
);
CREATE INDEX IF NOT EXISTS news_pub ON news (status, published_at);
CREATE INDEX IF NOT EXISTS news_cat ON news (category_id, published_at);
CREATE INDEX IF NOT EXISTS news_chan ON news (channel_id, published_at);
CREATE TABLE IF NOT EXISTS news_likes (user_id ${BIG} NOT NULL, news_id ${BIG} NOT NULL, created_at ${BIG} NOT NULL, PRIMARY KEY (user_id, news_id));
CREATE TABLE IF NOT EXISTS bookmarks (user_id ${BIG} NOT NULL, news_id ${BIG} NOT NULL, created_at ${BIG} NOT NULL, PRIMARY KEY (user_id, news_id));
CREATE TABLE IF NOT EXISTS follows (user_id ${BIG} NOT NULL, channel_id ${BIG} NOT NULL, alerts INTEGER NOT NULL DEFAULT 1, created_at ${BIG} NOT NULL, PRIMARY KEY (user_id, channel_id));
CREATE TABLE IF NOT EXISTS comments (
  id ${ID}, news_id ${BIG} NOT NULL, user_id ${BIG} NOT NULL, parent_id ${BIG}, body TEXT NOT NULL,
  anonymous INTEGER NOT NULL DEFAULT 0, created_at ${BIG} NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_news ON comments (news_id, created_at);
CREATE TABLE IF NOT EXISTS comment_likes (user_id ${BIG} NOT NULL, comment_id ${BIG} NOT NULL, PRIMARY KEY (user_id, comment_id));
CREATE TABLE IF NOT EXISTS notifications (
  id ${ID}, user_id ${BIG} NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
  news_id ${BIG}, actor_name TEXT NOT NULL DEFAULT '', read INTEGER NOT NULL DEFAULT 0, created_at ${BIG} NOT NULL
);
CREATE INDEX IF NOT EXISTS notif_user ON notifications (user_id, created_at);
CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, user_id ${BIG}, mime TEXT NOT NULL, data ${BLOB} NOT NULL, created_at ${BIG} NOT NULL);
CREATE TABLE IF NOT EXISTS suggestions (
  id ${ID}, user_id ${BIG}, name TEXT NOT NULL, website TEXT NOT NULL DEFAULT '', district TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', created_at ${BIG} NOT NULL,
  logo_url TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS feeds (
  id ${ID}, url TEXT UNIQUE NOT NULL, channel_id ${BIG} NOT NULL, category_id ${BIG}, enabled INTEGER NOT NULL DEFAULT 1,
  last_run ${BIG} NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;
};

function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => '$' + (++i));
}

async function open() {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: url,
      // No TLS for local and Render-internal hosts (no dot in the name, e.g. dpg-xxxx-a); TLS for external URLs. PGSSL=0/1 overrides.
      ssl: process.env.PGSSL ? (process.env.PGSSL === '1' ? { rejectUnauthorized: false } : false)
        : (/@(localhost|127\.0\.0\.1|[^.:/@]+)(:\d+)?\//.test(url) ? false : { rejectUnauthorized: false }),
      max: 5,
    });
    // BIGINT comes back as string by default; our ids and ms timestamps fit in a JS number.
    require('pg').types.setTypeParser(20, (v) => Number(v));
    const db = {
      kind: 'postgres',
      async all(sql, p = []) { return (await pool.query(toPg(sql), p)).rows; },
      async get(sql, p = []) { return (await pool.query(toPg(sql), p)).rows[0]; },
      async run(sql, p = []) { const r = await pool.query(toPg(sql), p); return { changes: r.rowCount, rows: r.rows }; },
      async exec(sql) { await pool.query(sql); },
      async close() { await pool.end(); },
    };
    await db.exec(SCHEMA(true));
    await migrate(db);
    return db;
  }
  const { DatabaseSync } = require('node:sqlite');
  const file = process.env.SQLITE_FILE || path.join(__dirname, '..', 'data', 'khobor.db');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const s = new DatabaseSync(file);
  s.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = OFF;');
  const norm = (p) => p.map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v === undefined ? null : v));
  const fix = (row) => {
    if (!row) return row;
    for (const k of Object.keys(row)) if (row[k] instanceof Uint8Array) row[k] = Buffer.from(row[k]);
    return { ...row };
  };
  const db = {
    kind: 'sqlite',
    async all(sql, p = []) { return s.prepare(sql).all(...norm(p)).map(fix); },
    async get(sql, p = []) { return fix(s.prepare(sql).get(...norm(p))); },
    async run(sql, p = []) {
      const st = s.prepare(sql);
      if (/\breturning\b/i.test(sql)) { const rows = st.all(...norm(p)).map(fix); return { changes: rows.length, rows }; }
      const r = st.run(...norm(p)); return { changes: Number(r.changes), rows: [] };
    },
    async exec(sql) { s.exec(sql); },
    async close() { s.close(); },
  };
  await db.exec(SCHEMA(false));
  await migrate(db);
  return db;
}

// Columns added after the first release. Each one is tried once; "already exists" errors are ignored.
async function migrate(db) {
  const adds = [["suggestions", "logo_url TEXT NOT NULL DEFAULT ''"]];
  for (const [table, col] of adds) {
    try { await db.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`); } catch (e) { /* column exists */ }
  }
}

module.exports = { open };
