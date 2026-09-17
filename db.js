// db.js - PostgreSQL connection, table setup, and password hashing
const { Pool } = require('pg');
const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error(
    'DATABASE_URL is not set. In the Render dashboard, open your web service > Environment ' +
    'and add DATABASE_URL (copy the "Internal Database URL" from your Postgres instance).'
  );
  process.exit(1);
}

// Render's *internal* URL (same region) doesn't need SSL; the *external* URL
// (hostname ending in render.com) does. DATABASE_SSL=true/false overrides this.
const useSSL = process.env.DATABASE_SSL
  ? process.env.DATABASE_SSL === 'true'
  : /\.render\.com/i.test(connectionString);

const pool = new Pool({
  connectionString,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
  max: 10,
});

pool.on('error', (err) => console.error('Unexpected PostgreSQL error:', err));

// ---------------------------------------------------------------------------
// Password hashing (Node's built-in scrypt - no native modules needed)
// ---------------------------------------------------------------------------
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [algorithm, saltHex, keyHex] = String(stored || '').split('$');
  if (algorithm !== 'scrypt' || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = await scrypt(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------
async function withTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Schema - created automatically on startup (safe to run every time)
// ---------------------------------------------------------------------------
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS admins (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL,
  password_hash TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS admins_username_lower_idx ON admins (LOWER(username));

CREATE TABLE IF NOT EXISTS teachers (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  username      TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS teachers_username_lower_idx ON teachers (LOWER(username));

CREATE TABLE IF NOT EXISTS courses (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS courses_name_lower_idx ON courses (LOWER(name));

CREATE TABLE IF NOT EXISTS students (
  id                         SERIAL PRIMARY KEY,
  first_name                 TEXT NOT NULL DEFAULT '',
  last_name                  TEXT NOT NULL,
  student_num                TEXT NOT NULL UNIQUE,
  password_hash              TEXT NOT NULL,
  teacher_advisor_id         INTEGER REFERENCES teachers(id) ON DELETE SET NULL,
  pending_teacher_advisor_id INTEGER REFERENCES teachers(id) ON DELETE SET NULL,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS students_last_name_lower_idx ON students (LOWER(last_name));

CREATE TABLE IF NOT EXISTS passports (
  id               SERIAL PRIMARY KEY,
  student_id       INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  course_id        INTEGER NOT NULL REFERENCES courses(id)  ON DELETE RESTRICT,
  teacher_id       INTEGER NOT NULL REFERENCES teachers(id) ON DELETE RESTRICT,
  delete_requested BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (student_id, course_id)
);
CREATE INDEX IF NOT EXISTS passports_teacher_idx ON passports (teacher_id);

CREATE TABLE IF NOT EXISTS passport_units (
  passport_id    INTEGER  NOT NULL REFERENCES passports(id) ON DELETE CASCADE,
  unit_num       SMALLINT NOT NULL CHECK (unit_num BETWEEN 1 AND 16),
  reflection     TEXT     NOT NULL DEFAULT '',
  approved       BOOLEAN  NOT NULL DEFAULT FALSE,
  needs_revision BOOLEAN  NOT NULL DEFAULT FALSE,
  feedback       TEXT     NOT NULL DEFAULT '',
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (passport_id, unit_num)
);
`;

// Columns each app table must have. Used to detect leftover tables from an
// older version of the app that have the same name but a different layout.
const REQUIRED_COLUMNS = {
  admins: ['id', 'username', 'password_hash'],
  teachers: ['id', 'name', 'username', 'password_hash'],
  courses: ['id', 'name'],
  students: ['id', 'first_name', 'last_name', 'student_num', 'password_hash', 'teacher_advisor_id', 'pending_teacher_advisor_id'],
  passports: ['id', 'student_id', 'course_id', 'teacher_id', 'delete_requested'],
  passport_units: ['passport_id', 'unit_num', 'reflection', 'approved', 'needs_revision', 'feedback'],
};

// If any existing table doesn't match, rename ALL existing app tables to
// old_<name>_<timestamp> (nothing is deleted) so a clean set can be created.
async function setAsideOldTables(client) {
  const { rows } = await client.query(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = ANY($1)`,
    [Object.keys(REQUIRED_COLUMNS)]
  );

  const existing = {};
  for (const { table_name, column_name } of rows) {
    (existing[table_name] = existing[table_name] || new Set()).add(column_name);
  }

  const mismatched = Object.keys(existing).filter((table) =>
    REQUIRED_COLUMNS[table].some((column) => !existing[table].has(column))
  );
  if (mismatched.length === 0) return;

  const suffix = new Date().toISOString().slice(0, 19).replace(/\D/g, '');
  for (const table of Object.keys(existing)) {
    // Table names come from the fixed list above, never from user input
    await client.query(`ALTER TABLE ${table} RENAME TO old_${table}_${suffix}`);
  }
  console.warn(
    `*** Found older tables with a different layout (${mismatched.join(', ')}). ` +
    `Renamed existing tables [${Object.keys(existing).join(', ')}] with the prefix "old_" and suffix "_${suffix}". ` +
    'No data was deleted. New tables have been created. ***'
  );
}

async function initDb() {
  await withTransaction(async (client) => {
    await setAsideOldTables(client);
    await client.query(SCHEMA_SQL);
  });

  // Admin account: ADMIN_USERNAME / ADMIN_PASSWORD environment variables are the
  // source of truth. Changing ADMIN_PASSWORD in Render and redeploying resets it.
  const adminUsername = (process.env.ADMIN_USERNAME || 'admin').trim();

  if (process.env.ADMIN_PASSWORD) {
    const hash = await hashPassword(process.env.ADMIN_PASSWORD);
    await pool.query(
      `INSERT INTO admins (username, password_hash) VALUES ($1, $2)
       ON CONFLICT ((LOWER(username))) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
      [adminUsername, hash]
    );
  } else {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM admins');
    if (rows[0].count === 0) {
      await pool.query('INSERT INTO admins (username, password_hash) VALUES ($1, $2)', [
        adminUsername,
        await hashPassword('admin'),
      ]);
      console.warn(
        '*** WARNING: created admin account with the default password "admin". ' +
        'Set ADMIN_PASSWORD in your Render environment variables and redeploy. ***'
      );
    }
  }

  console.log('Database ready.');
}

module.exports = { pool, initDb, hashPassword, verifyPassword, withTransaction };
