const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const DATA_FILE = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'altmess-db.json');
const DATABASE_URL = process.env.DATABASE_URL || '';

let state = { users: [], messages: [], calls: [] };
let pool = null;

function ensureFile() {
  const dataDir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), 'utf8');
  }
}

function normalizeState(input) {
  return {
    users: Array.isArray(input?.users) ? input.users : [],
    messages: Array.isArray(input?.messages) ? input.messages : [],
    calls: Array.isArray(input?.calls) ? input.calls : [],
  };
}

function readFileState() {
  ensureFile();

  try {
    return normalizeState(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
  } catch {
    return { users: [], messages: [], calls: [] };
  }
}

async function initPostgres() {
  if (!DATABASE_URL) {
    return null;
  }

  if (!pool) {
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      id INTEGER PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  return pool;
}

async function loadState() {
  state = readFileState();

  if (!DATABASE_URL) {
    return state;
  }

  const client = await initPostgres();
  const result = await client.query('SELECT data FROM app_state WHERE id = 1');

  if (result.rows[0]?.data) {
    state = normalizeState(result.rows[0].data);
    ensureFile();
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), 'utf8');
    return state;
  }

  await client.query(
    'INSERT INTO app_state (id, data, updated_at) VALUES (1, $1::jsonb, NOW()) ON CONFLICT (id) DO NOTHING',
    [JSON.stringify(state)],
  );

  return state;
}

async function saveState(nextState) {
  state = normalizeState(nextState);
  ensureFile();
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), 'utf8');

  if (!DATABASE_URL) {
    return;
  }

  const client = await initPostgres();
  await client.query(
    `INSERT INTO app_state (id, data, updated_at)
     VALUES (1, $1::jsonb, NOW())
     ON CONFLICT (id)
     DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [JSON.stringify(state)],
  );
}

function getState() {
  return state;
}

module.exports = {
  DATABASE_URL,
  getState,
  loadState,
  saveState,
};
