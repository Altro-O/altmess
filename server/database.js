const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = process.env.DATABASE_PATH || path.join(DATA_DIR, 'altmess.sqlite');

let dbPromise;

async function getDb() {
  if (!dbPromise) {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    dbPromise = open({
      filename: DB_PATH,
      driver: sqlite3.Database,
    });
  }

  return dbPromise;
}

async function initDatabase() {
  const db = await getDb();

  await db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      sender_id TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'sent',
      delivered_at TEXT,
      read_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (sender_id) REFERENCES users(id),
      FOREIGN KEY (recipient_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS calls (
      id TEXT PRIMARY KEY,
      caller_id TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      FOREIGN KEY (caller_id) REFERENCES users(id),
      FOREIGN KEY (recipient_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_pair_created
      ON messages(sender_id, recipient_id, created_at);

    CREATE INDEX IF NOT EXISTS idx_messages_recipient_status
      ON messages(recipient_id, status);

    CREATE INDEX IF NOT EXISTS idx_users_username
      ON users(username);
  `);

  return db;
}

module.exports = {
  DB_PATH,
  getDb,
  initDatabase,
};
