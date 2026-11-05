import crypto from 'node:crypto';
import { db, now } from './db.js';
import { config } from './config.js';

const COOKIE = 'doener_session';

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltB64, hashB64] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(actual, expected);
}

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8) return 'Das Passwort muss mindestens 8 Zeichen haben.';
  return null;
}

export function createUser({ username, displayName, password, paypalMe = null }) {
  const info = db.prepare(`INSERT INTO users (username, display_name, password_hash, paypal_me, created_at)
                           VALUES (?, ?, ?, ?, ?)`)
    .run(username.trim(), displayName.trim(), hashPassword(password), paypalMe || null, now());
  return Number(info.lastInsertRowid);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieAttrs(maxAgeSeconds) {
  return [`Path=/`, `HttpOnly`, `SameSite=Strict`, `Max-Age=${maxAgeSeconds}`, config.cookieSecure ? 'Secure' : null]
    .filter(Boolean).join('; ');
}

export function startSession(res, userId) {
  const id = crypto.randomBytes(32).toString('hex');
  const maxAge = config.sessionDays * 86400;
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(id, userId, Date.now() + maxAge * 1000);
  res.setHeader('Set-Cookie', `${COOKIE}=${id}; ${cookieAttrs(maxAge)}`);
}

export function endSession(req, res) {
  const id = parseCookies(req.headers.cookie)[COOKIE];
  if (id) db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  res.setHeader('Set-Cookie', `${COOKIE}=; ${cookieAttrs(0)}`);
}

// Hängt req.user an, wenn eine gültige Sitzung existiert.
export function loadUser(req, _res, next) {
  const id = parseCookies(req.headers.cookie)[COOKIE];
  if (id) {
    const row = db.prepare(`SELECT u.id, u.username, u.display_name, u.paypal_me, s.expires_at
                            FROM sessions s JOIN users u ON u.id = s.user_id
                            WHERE s.id = ? AND u.active = 1`).get(id);
    if (row && row.expires_at > Date.now()) {
      req.user = { id: row.id, username: row.username, displayName: row.display_name, paypalMe: row.paypal_me };
    } else if (row) {
      db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    }
  }
  next();
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Bitte zuerst anmelden.' });
  next();
}

export function purgeExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  for (const [key, f] of failures) if (f.until < Date.now()) failures.delete(key);
}

// ---- einfacher Schutz gegen Passwort-Raten ----
const failures = new Map(); // key -> { count, until }
const MAX_FAILS = 8;
const LOCK_MS = 15 * 60 * 1000;

export function loginBlocked(key) {
  const f = failures.get(key);
  return Boolean(f && f.count >= MAX_FAILS && f.until > Date.now());
}

export function registerLoginFailure(key) {
  const f = failures.get(key);
  if (!f || f.until < Date.now()) failures.set(key, { count: 1, until: Date.now() + LOCK_MS });
  else f.count += 1;
}

export function clearLoginFailures(key) {
  failures.delete(key);
}
