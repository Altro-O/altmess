const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const DATA_FILE = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'altmess-db.json');
const DATABASE_URL = process.env.DATABASE_URL || '';

let saveTimer = null;
const SAVE_DEBOUNCE_MS = 150;

function normalizeDatabaseUrl(connectionString) {
  if (!connectionString) {
    return '';
  }

  try {
    const url = new URL(connectionString);
    const sslMode = url.searchParams.get('sslmode');

    if (sslMode === 'require' || sslMode === 'prefer' || sslMode === 'verify-ca') {
      url.searchParams.set('sslmode', 'verify-full');
    }

    return url.toString();
  } catch {
    return connectionString;
  }
}

const NORMALIZED_DATABASE_URL = normalizeDatabaseUrl(DATABASE_URL);

let state = { users: [], groups: [], messages: [], calls: [], pushSubscriptions: [] };
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
    groups: Array.isArray(input?.groups) ? input.groups : [],
    messages: Array.isArray(input?.messages) ? input.messages : [],
    calls: Array.isArray(input?.calls) ? input.calls : [],
    pushSubscriptions: Array.isArray(input?.pushSubscriptions) ? input.pushSubscriptions : [],
  };
}

function readFileState() {
  ensureFile();

  try {
    return normalizeState(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
  } catch {
    return { users: [], groups: [], messages: [], calls: [], pushSubscriptions: [] };
  }
}

async function initPostgres() {
  if (!NORMALIZED_DATABASE_URL) {
    return null;
  }

  if (!pool) {
    pool = new Pool({
      connectionString: NORMALIZED_DATABASE_URL,
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

  if (!NORMALIZED_DATABASE_URL) {
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

async function flushState() {
  const serialized = JSON.stringify(state, null, 2);
  ensureFile();

  try {
    await fs.promises.writeFile(DATA_FILE, serialized, 'utf8');
  } catch (writeErr) {
    console.error('Failed to write state file:', writeErr);
  }

  if (!NORMALIZED_DATABASE_URL) {
    return;
  }

  try {
    const client = await initPostgres();
    await client.query(
      `INSERT INTO app_state (id, data, updated_at)
       VALUES (1, $1::jsonb, NOW())
       ON CONFLICT (id)
       DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [serialized],
    );
  } catch (pgErr) {
    console.error('Failed to persist state to Postgres:', pgErr);
  }
}

function saveState(nextState) {
  state = normalizeState(nextState);

  if (saveTimer) {
    clearTimeout(saveTimer);
  }

  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushState().catch((err) => console.error('State flush error:', err));
  }, SAVE_DEBOUNCE_MS);
}

async function forceFlush() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }

  await flushState();
}

function getState() {
  return state;
}

module.exports = {
  DATABASE_URL: NORMALIZED_DATABASE_URL,
  getState,
  loadState,
  saveState,
  forceFlush,
};
