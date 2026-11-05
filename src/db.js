import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });
export const db = new DatabaseSync(path.join(config.dataDir, 'doener.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  paypal_me     TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS categories (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  note        TEXT,
  item_prefix TEXT,                 -- steht in Bestellungen vor dem Artikelnamen ("Pizza Schinken")
  sort        INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS option_groups (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  type     TEXT NOT NULL CHECK (type IN ('single', 'multi')),
  required INTEGER NOT NULL DEFAULT 0,
  choices  TEXT NOT NULL            -- JSON [{label, price}] (price in Cent)
);
CREATE TABLE IF NOT EXISTS menu_items (
  id          INTEGER PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES categories(id),
  num         TEXT,
  name        TEXT NOT NULL,
  description TEXT,
  variants    TEXT NOT NULL,        -- JSON [{label, price}] (price in Cent, null = Preis fehlt)
  groups      TEXT NOT NULL DEFAULT '[]', -- JSON [option_group.id]
  active      INTEGER NOT NULL DEFAULT 1,
  sort        INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS rounds (
  id           INTEGER PRIMARY KEY,
  title        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  access_code  TEXT,
  deadline     TEXT,
  pickup_time  TEXT,
  collector_id INTEGER REFERENCES users(id),   -- Kasse; das PayPal-Konto kommt vom Zugang dieser Person
  opened_by    INTEGER REFERENCES users(id),
  opened_at    TEXT NOT NULL,
  closed_by    INTEGER REFERENCES users(id),
  closed_at    TEXT,
  notes        TEXT
);
CREATE TABLE IF NOT EXISTS orders (
  id                 INTEGER PRIMARY KEY,
  round_id           INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  token              TEXT NOT NULL UNIQUE,
  customer_name      TEXT NOT NULL,
  lines              TEXT NOT NULL,  -- JSON-Snapshot der Positionen
  subtotal           INTEGER NOT NULL,
  tip                INTEGER NOT NULL DEFAULT 0,
  tip_recipient      TEXT CHECK (tip_recipient IN ('doener', 'azubis')),
  total              INTEGER NOT NULL,
  payment_method     TEXT,           -- paypal_api | paypal_me | cash | other
  payment_status     TEXT NOT NULL DEFAULT 'open' CHECK (payment_status IN ('open', 'paid', 'cancelled')),
  customer_says_paid INTEGER NOT NULL DEFAULT 0,
  paid_at            TEXT,
  paid_marked_by     INTEGER REFERENCES users(id),
  paypal_order_id    TEXT,
  paypal_capture_id  TEXT,
  notes              TEXT,
  picked_up          INTEGER NOT NULL DEFAULT 0,
  created_by         INTEGER REFERENCES users(id),
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_round ON orders(round_id);
CREATE TABLE IF NOT EXISTS audit (
  id       INTEGER PRIMARY KEY,
  at       TEXT NOT NULL,
  user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  round_id INTEGER,
  order_id INTEGER,
  action   TEXT NOT NULL,
  detail   TEXT
);
CREATE INDEX IF NOT EXISTS audit_round ON audit(round_id);
`);

// ---- Migrationen für Datenbanken, die mit einer älteren Version angelegt wurden ----
const hasColumn = (table, column) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
if (!hasColumn('categories', 'item_prefix')) {
  db.exec("ALTER TABLE categories ADD COLUMN item_prefix TEXT; UPDATE categories SET item_prefix = 'Pizza' WHERE id = 'pizza';");
}

export const now =() => new Date().toISOString();
export const cents = (euro) => (euro === null || euro === undefined ? null : Math.round(euro * 100));

export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function audit(userId, action, { roundId = null, orderId = null, detail = null } = {}) {
  db.prepare('INSERT INTO audit (at, user_id, round_id, order_id, action, detail) VALUES (?, ?, ?, ?, ?, ?)')
    .run(now(), userId ?? null, roundId, orderId, action, detail);
}

// ---- Einstellungen ----
const DEFAULT_SETTINGS = {
  shop_name: 'Dönerbude',
  paypal_mode: 'auto',          // auto | api | paypalme
  default_paypal_me: '',
  tip_presets: '0.5,1,2',
};

export function getSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const row of db.prepare('SELECT key, value FROM settings').all()) out[row.key] = row.value;
  return out;
}

export function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

// ---- Erstbefüllung der Speisekarte ----
function seedMenu() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM categories').get().n;
  if (count > 0) return;
  const seed = JSON.parse(fs.readFileSync(new URL('./menu-seed.json', import.meta.url), 'utf8'));
  tx(() => {
    const insGroup = db.prepare('INSERT INTO option_groups (id, name, type, required, choices) VALUES (?, ?, ?, ?, ?)');
    for (const [id, g] of Object.entries(seed.groups)) {
      const choices = g.choices.map(([label, price]) => ({ label, price: cents(price) }));
      insGroup.run(id, g.name, g.type, g.required ? 1 : 0, JSON.stringify(choices));
    }
    const insCat = db.prepare('INSERT INTO categories (id, name, note, item_prefix, sort) VALUES (?, ?, ?, ?, ?)');
    const insItem = db.prepare(`INSERT INTO menu_items (category_id, num, name, description, variants, groups, active, sort)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    seed.categories.forEach((cat, ci) => {
      insCat.run(cat.id, cat.name, cat.note ?? null, cat.prefix ?? null, ci);
      cat.items.forEach((item, ii) => {
        const variants = item.v
          ? item.v.map(([label, price]) => ({ label, price: cents(price) }))
          : [{ label: '', price: cents(item.price) }];
        const priced = variants.every((v) => v.price !== null);
        const active = item.active === false || !priced ? 0 : 1;
        insItem.run(cat.id, item.num ?? null, item.name, item.desc ?? null,
          JSON.stringify(variants), JSON.stringify(item.g ?? []), active, ii);
      });
    });
  });
}
seedMenu();
