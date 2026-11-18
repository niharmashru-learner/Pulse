// Database layer.
// - Production (Render etc.): set DATABASE_URL -> real PostgreSQL via `pg`.
// - Local dev: no DATABASE_URL -> embedded Postgres (PGlite) stored in ./data.
// Both expose the same tiny API: query(sql, params) -> { rows }.

let impl;

async function init() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    const ssl =
      process.env.DATABASE_SSL === 'false' || /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL)
        ? false
        : { rejectUnauthorized: false };
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl, max: 10 });
    impl = { query: (sql, params) => pool.query(sql, params), kind: 'postgres' };
  } else {
    const { PGlite } = require('@electric-sql/pglite');
    const dir = process.env.PGLITE_DIR || './data/pgdata';
    const db = process.env.PGLITE_MEMORY === '1' ? new PGlite() : new PGlite(dir);
    await db.waitReady;
    impl = {
      query: async (sql, params) => {
        const r = await db.query(sql, params);
        return { rows: r.rows };
      },
      kind: 'pglite',
    };
  }

  const stmts = [
    `CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'staff',
      department TEXT DEFAULT '',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS attendance (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      work_date TEXT NOT NULL,
      punch_in TIMESTAMPTZ,
      punch_out TIMESTAMPTZ,
      break_started_at TIMESTAMPTZ,
      break_minutes INTEGER NOT NULL DEFAULT 0,
      late BOOLEAN NOT NULL DEFAULT FALSE,
      note TEXT DEFAULT '',
      UNIQUE (user_id, work_date)
    )`,
    `CREATE TABLE IF NOT EXISTS tasks (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      priority TEXT NOT NULL DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'pending',
      creator_id INTEGER NOT NULL REFERENCES users(id),
      assignee_id INTEGER NOT NULL REFERENCES users(id),
      due_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id, status)`,
    `CREATE TABLE IF NOT EXISTS task_events (
      id SERIAL PRIMARY KEY,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      kind TEXT NOT NULL DEFAULT 'comment',
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS rooms (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'custom',
      icon TEXT NOT NULL DEFAULT '🏠',
      color TEXT NOT NULL DEFAULT '#6366f1',
      description TEXT DEFAULT '',
      announcement TEXT DEFAULT '',
      x INTEGER NOT NULL DEFAULT 0,
      y INTEGER NOT NULL DEFAULT 0,
      w INTEGER NOT NULL DEFAULT 300,
      h INTEGER NOT NULL DEFAULT 180,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS room_members (
      room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (room_id, user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS room_messages (
      id SERIAL PRIMARY KEY,
      room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_room_messages ON room_messages(room_id, id)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT NOT NULL DEFAULT '🙂'`,
    `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL`,
    `CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
  ];
  for (const s of stmts) await impl.query(s);
  return impl;
}

module.exports = {
  init,
  query: (sql, params) => impl.query(sql, params),
  kind: () => impl.kind,
};
