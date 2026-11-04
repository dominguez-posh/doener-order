import express from 'express';
import { db, now, audit, tx, getSettings, setSetting } from './db.js';
import {
  requireUser, startSession, endSession, verifyPassword, hashPassword, validatePassword, createUser,
  loginBlocked, registerLoginFailure, clearLoginFailures,
} from './auth.js';
import {
  loadMenu, priceLines, parseTip, getRound, getOpenRound, newToken, serializeOrder, roundTotals,
  aggregateLines, UserError,
} from './orders.js';
import { effectiveMode, cleanPaypalMe, capturePaypalOrder } from './paypal.js';
import { markPaidByPaypal } from './routes-public.js';
import { paypalApiConfigured, config } from './config.js';
import { renderPrint, renderCsv } from './print.js';

export const adminRouter = express.Router();

const clip = (s, n) => (s === undefined || s === null ? null : String(s).trim().slice(0, n) || null);
const isLoopback = (ip) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);
const userCount = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

function isoOrNull(v, label) {
  if (v === undefined || v === null || v === '') return null;
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new UserError(`Ungültige Zeitangabe: ${label}.`);
  return new Date(t).toISOString();
}

// ---------------- Anmeldung ----------------
adminRouter.get('/api/auth/me', (req, res) => {
  const needsSetup = userCount() === 0;
  res.json({
    user: req.user ?? null,
    needsSetup,
    setupAllowed: needsSetup && isLoopback(req.socket.remoteAddress),
  });
});

// Erster Zugang: nur solange es noch keinen Benutzer gibt und nur direkt am Rechner (localhost).
adminRouter.post('/api/auth/setup', (req, res, next) => {
  try {
    if (userCount() > 0) throw new UserError('Es gibt bereits Zugänge.', 409);
    if (!isLoopback(req.socket.remoteAddress)) throw new UserError('Der erste Zugang kann nur direkt am Server angelegt werden (localhost).', 403);
    const { username, displayName, password } = req.body || {};
    validateUsername(username);
    const pwErr = validatePassword(password);
    if (pwErr) throw new UserError(pwErr);
    const id = createUser({ username, displayName: displayName || username, password });
    audit(id, 'user.setup', { detail: username });
    startSession(res, id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const key = `${req.ip}|${String(username || '').toLowerCase()}`;
  if (loginBlocked(key)) return res.status(429).json({ error: 'Zu viele Fehlversuche. Bitte 15 Minuten warten.' });
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(String(username || '').trim());
  if (!user || !verifyPassword(String(password || ''), user.password_hash)) {
    registerLoginFailure(key);
    return res.status(401).json({ error: 'Benutzername oder Passwort falsch.' });
  }
  clearLoginFailures(key);
  startSession(res, user.id);
  audit(user.id, 'user.login');
  res.json({ ok: true });
});

adminRouter.post('/api/auth/logout', (req, res) => {
  endSession(req, res);
  res.json({ ok: true });
});

adminRouter.use('/api/admin', requireUser);
adminRouter.use('/admin/runden', (req, res, next) => (req.user ? next() : res.redirect('/admin')));

adminRouter.patch('/api/admin/me', (req, res, next) => {
  try {
    const { displayName, paypalMe, currentPassword, newPassword } = req.body || {};
    if (displayName !== undefined) {
      const name = clip(displayName, 60);
      if (!name) throw new UserError('Anzeigename darf nicht leer sein.');
      db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(name, req.user.id);
    }
    if (paypalMe !== undefined) {
      const handle = paypalMe ? cleanPaypalMe(paypalMe) : '';
      if (paypalMe && !handle) throw new UserError('PayPal.me-Name ungültig (nur der Name, z. B. „maxmuster“).');
      db.prepare('UPDATE users SET paypal_me = ? WHERE id = ?').run(handle || null, req.user.id);
    }
    if (newPassword !== undefined) {
      const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
      if (!verifyPassword(String(currentPassword || ''), row.password_hash)) throw new UserError('Das aktuelle Passwort stimmt nicht.');
      const pwErr = validatePassword(newPassword);
      if (pwErr) throw new UserError(pwErr);
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), req.user.id);
      audit(req.user.id, 'user.password');
    }
    res.json({ user: userRow(req.user.id) });
  } catch (err) {
    next(err);
  }
});

// ---------------- Benutzer ----------------
function validateUsername(u) {
  if (typeof u !== 'string' || !/^[A-Za-z0-9._-]{3,32}$/.test(u.trim())) {
    throw new UserError('Benutzername: 3–32 Zeichen, nur Buchstaben, Ziffern, Punkt, Minus, Unterstrich.');
  }
}

function userRow(id) {
  const u = db.prepare('SELECT id, username, display_name, paypal_me, active, created_at FROM users WHERE id = ?').get(id);
  return u && { id: u.id, username: u.username, displayName: u.display_name, paypalMe: u.paypal_me, active: Boolean(u.active), createdAt: u.created_at };
}

adminRouter.get('/api/admin/users', (_req, res) => {
  res.json({ users: db.prepare('SELECT id FROM users ORDER BY active DESC, display_name').all().map((u) => userRow(u.id)) });
});

adminRouter.post('/api/admin/users', (req, res, next) => {
  try {
    const { username, displayName, password, paypalMe } = req.body || {};
    validateUsername(username);
    const pwErr = validatePassword(password);
    if (pwErr) throw new UserError(pwErr);
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username.trim())) throw new UserError('Diesen Benutzernamen gibt es schon.', 409);
    const id = createUser({ username, displayName: clip(displayName, 60) || username, password, paypalMe: cleanPaypalMe(paypalMe) });
    audit(req.user.id, 'user.create', { detail: username });
    res.status(201).json({ user: userRow(id) });
  } catch (err) {
    next(err);
  }
});

adminRouter.patch('/api/admin/users/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const target = userRow(id);
    if (!target) throw new UserError('Benutzer nicht gefunden.', 404);
    const { displayName, paypalMe, active, password } = req.body || {};
    if (displayName !== undefined) {
      const name = clip(displayName, 60);
      if (!name) throw new UserError('Anzeigename darf nicht leer sein.');
      db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(name, id);
    }
    if (paypalMe !== undefined) db.prepare('UPDATE users SET paypal_me = ? WHERE id = ?').run(cleanPaypalMe(paypalMe) || null, id);
    if (active !== undefined) {
      if (id === req.user.id && !active) throw new UserError('Du kannst dich nicht selbst deaktivieren.');
      db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
      if (!active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    }
    if (password !== undefined) {
      const pwErr = validatePassword(password);
      if (pwErr) throw new UserError(pwErr);
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), id);
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND user_id <> ?').run(id, req.user.id);
    }
    audit(req.user.id, 'user.update', { detail: target.username });
    res.json({ user: userRow(id) });
  } catch (err) {
    next(err);
  }
});

// ---------------- Einstellungen ----------------
function settingsView() {
  const s = getSettings();
  return {
    shopName: s.shop_name, paypalMode: s.paypal_mode, defaultPaypalMe: s.default_paypal_me, tipPresets: s.tip_presets,
    effectiveMode: effectiveMode(), apiConfigured: paypalApiConfigured(), paypalEnv: config.paypal.env,
  };
}

adminRouter.get('/api/admin/settings', (_req, res) => res.json({ settings: settingsView() }));

adminRouter.put('/api/admin/settings', (req, res, next) => {
  try {
    const { shopName, paypalMode, defaultPaypalMe, tipPresets } = req.body || {};
    if (shopName !== undefined) setSetting('shop_name', clip(shopName, 60) || 'Dönerbude');
    if (paypalMode !== undefined) {
      if (!['auto', 'api', 'paypalme'].includes(paypalMode)) throw new UserError('Unbekannter Zahlungsmodus.');
      setSetting('paypal_mode', paypalMode);
    }
    if (defaultPaypalMe !== undefined) {
      const h = defaultPaypalMe ? cleanPaypalMe(defaultPaypalMe) : '';
      if (defaultPaypalMe && !h) throw new UserError('PayPal.me-Name ungültig.');
      setSetting('default_paypal_me', h);
    }
    if (tipPresets !== undefined) {
      const list = String(tipPresets).split(/[;,\s]+/).map((x) => Number(x.replace(',', '.'))).filter((n) => n > 0 && n <= 50);
      setSetting('tip_presets', list.slice(0, 5).join(',') || '0.5,1,2');
    }
    audit(req.user.id, 'settings.update');
    res.json({ settings: settingsView() });
  } catch (err) {
    next(err);
  }
});

// ---------------- Bestellrunden ----------------
const ROUND_SELECT = `
  SELECT r.*, ob.display_name AS opened_by_name, cb.display_name AS closed_by_name, co.display_name AS collector_name,
         co.paypal_me AS collector_paypal_me,
         (SELECT COUNT(*) FROM orders o WHERE o.round_id = r.id AND o.payment_status <> 'cancelled') AS order_count,
         (SELECT COALESCE(SUM(total), 0) FROM orders o WHERE o.round_id = r.id AND o.payment_status <> 'cancelled') AS sum_total,
         (SELECT COALESCE(SUM(total), 0) FROM orders o WHERE o.round_id = r.id AND o.payment_status = 'paid') AS sum_paid
  FROM rounds r
  LEFT JOIN users ob ON ob.id = r.opened_by
  LEFT JOIN users cb ON cb.id = r.closed_by
  LEFT JOIN users co ON co.id = r.collector_id`;

function serializeRound(r) {
  return {
    id: r.id, title: r.title, status: r.status, accessCode: r.access_code, deadline: r.deadline, pickupTime: r.pickup_time,
    paypalMe: r.paypal_me, collectorId: r.collector_id, collector: r.collector_name, openedBy: r.opened_by_name,
    openedAt: r.opened_at, closedBy: r.closed_by_name, closedAt: r.closed_at, notes: r.notes,
    orderCount: r.order_count, sumTotal: r.sum_total, sumPaid: r.sum_paid,
  };
}

function loadRoundRow(id) {
  if (!getRound(id)) return null; // refreshRound: ggf. Auto-Schließen
  return db.prepare(`${ROUND_SELECT} WHERE r.id = ?`).get(id);
}

export function roundOrders(roundId) {
  return db.prepare(`SELECT o.*, cu.display_name AS created_by_name, pu.display_name AS paid_marked_by_name
                     FROM orders o LEFT JOIN users cu ON cu.id = o.created_by LEFT JOIN users pu ON pu.id = o.paid_marked_by
                     WHERE o.round_id = ? ORDER BY o.id`).all(roundId).map(serializeOrder);
}

export function roundDetail(id) {
  const row = loadRoundRow(id);
  if (!row) return null;
  const orders = roundOrders(id);
  return { round: serializeRound(row), orders, totals: roundTotals(orders), aggregate: aggregateLines(orders) };
}

adminRouter.get('/api/admin/rounds', (req, res) => {
  getOpenRound(); // Auto-Schließen anstoßen
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const rows = db.prepare(`${ROUND_SELECT} ORDER BY r.id DESC LIMIT ?`).all(limit);
  res.json({ rounds: rows.map(serializeRound), paymentMode: effectiveMode() });
});

function readRoundFields(body) {
  const out = {};
  if (body.title !== undefined) {
    out.title = clip(body.title, 80);
    if (!out.title) throw new UserError('Die Runde braucht einen Titel.');
  }
  if (body.deadline !== undefined) out.deadline = isoOrNull(body.deadline, 'Bestellschluss');
  if (body.pickupTime !== undefined) out.pickup_time = clip(body.pickupTime, 40);
  if (body.accessCode !== undefined) out.access_code = clip(body.accessCode, 32);
  if (body.notes !== undefined) out.notes = clip(body.notes, 4000);
  if (body.paypalMe !== undefined) {
    const h = body.paypalMe ? cleanPaypalMe(body.paypalMe) : '';
    if (body.paypalMe && !h) throw new UserError('PayPal.me-Name ungültig.');
    out.paypal_me = h || null;
  }
  if (body.collectorId !== undefined) {
    const cid = body.collectorId ? Number(body.collectorId) : null;
    if (cid && !db.prepare('SELECT 1 FROM users WHERE id = ?').get(cid)) throw new UserError('Unbekannter Kassenwart.');
    out.collector_id = cid;
  }
  return out;
}

adminRouter.post('/api/admin/rounds', (req, res, next) => {
  try {
    const body = req.body || {};
    const id = tx(() => {
      if (getOpenRound()) throw new UserError('Es ist schon eine Bestellrunde offen. Bitte die erst schließen.', 409);
      const f = readRoundFields({ ...body, title: body.title || `Dönerrunde ${new Date().toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' })}` });
      if (f.deadline && Date.parse(f.deadline) <= Date.now()) throw new UserError('Der Bestellschluss liegt in der Vergangenheit.');
      const collectorId = f.collector_id ?? req.user.id;
      const collectorHandle = db.prepare('SELECT paypal_me FROM users WHERE id = ?').get(collectorId)?.paypal_me;
      const paypalMe = f.paypal_me !== undefined && f.paypal_me !== null ? f.paypal_me : collectorHandle || null;
      const info = db.prepare(`INSERT INTO rounds (title, status, access_code, deadline, pickup_time, paypal_me, collector_id, opened_by, opened_at, notes)
                               VALUES (?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(f.title, f.access_code ?? null, f.deadline ?? null, f.pickup_time ?? null, paypalMe, collectorId, req.user.id, now(), f.notes ?? null);
      return Number(info.lastInsertRowid);
    });
    audit(req.user.id, 'round.open', { roundId: id });
    res.status(201).json(roundDetail(id));
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/api/admin/rounds/:id', (req, res) => {
  const detail = roundDetail(Number(req.params.id));
  if (!detail) return res.status(404).json({ error: 'Runde nicht gefunden.' });
  const log = db.prepare(`SELECT a.at, a.action, a.detail, a.order_id, u.display_name AS user FROM audit a
                          LEFT JOIN users u ON u.id = a.user_id WHERE a.round_id = ? ORDER BY a.id DESC LIMIT 200`).all(detail.round.id);
  res.json({ ...detail, audit: log, paymentMode: effectiveMode() });
});

adminRouter.patch('/api/admin/rounds/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const round = getRound(id);
    if (!round) throw new UserError('Runde nicht gefunden.', 404);
    const body = req.body || {};
    tx(() => {
      const f = readRoundFields(body);
      if (body.status === 'closed' && round.status === 'open') {
        f.status = 'closed';
        f.closed_at = now();
        f.closed_by = req.user.id;
      } else if (body.status === 'open' && round.status === 'closed') {
        const other = getOpenRound();
        if (other && other.id !== id) throw new UserError(`Runde „${other.title}“ ist noch offen. Bitte die erst schließen.`, 409);
        const deadline = f.deadline !== undefined ? f.deadline : round.deadline;
        // Abgelaufenen Bestellschluss beim Wiedereröffnen entfernen, sonst schließt die Runde sofort wieder.
        if (deadline && Date.parse(deadline) <= Date.now()) f.deadline = null;
        f.status = 'open';
        f.closed_at = null;
        f.closed_by = null;
      } else if (f.deadline && round.status === 'open' && Date.parse(f.deadline) <= Date.now()) {
        throw new UserError('Der Bestellschluss liegt in der Vergangenheit.');
      }
      const keys = Object.keys(f);
      if (keys.length) {
        db.prepare(`UPDATE rounds SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => f[k]), id);
      }
    });
    const action = body.status === 'closed' ? 'round.close' : body.status === 'open' ? 'round.reopen' : 'round.update';
    audit(req.user.id, action, { roundId: id });
    res.json(roundDetail(id));
  } catch (err) {
    next(err);
  }
});

adminRouter.delete('/api/admin/rounds/:id', (req, res) => {
  const id = Number(req.params.id);
  const round = db.prepare('SELECT title FROM rounds WHERE id = ?').get(id);
  if (!round) return res.status(404).json({ error: 'Runde nicht gefunden.' });
  db.prepare('DELETE FROM rounds WHERE id = ?').run(id);
  audit(req.user.id, 'round.delete', { detail: `#${id} ${round.title}` });
  res.json({ ok: true });
});

// ---------------- Bestellungen (Admin) ----------------
const PAYMENT_METHODS = ['paypal_api', 'paypal_me', 'cash', 'other'];
const PAYMENT_STATUS = ['open', 'paid', 'cancelled'];

adminRouter.post('/api/admin/rounds/:id/orders', (req, res, next) => {
  try {
    const round = getRound(Number(req.params.id));
    if (!round) throw new UserError('Runde nicht gefunden.', 404);
    const { name, lines, tip, tipRecipient, paymentStatus = 'open', paymentMethod = 'paypal_me', notes } = req.body || {};
    const customerName = clip(name, 60);
    if (!customerName) throw new UserError('Bitte den Namen angeben.');
    if (!PAYMENT_STATUS.includes(paymentStatus) || !PAYMENT_METHODS.includes(paymentMethod)) throw new UserError('Ungültiger Zahlungsstatus.');
    const priced = priceLines(lines, { allowCustom: true, allowInactive: true });
    const t = parseTip(tip, tipRecipient);
    const ts = now();
    const paid = paymentStatus === 'paid';
    const info = db.prepare(`INSERT INTO orders (round_id, token, customer_name, lines, subtotal, tip, tip_recipient, total, payment_method,
                               payment_status, paid_at, paid_marked_by, notes, created_by, created_at, updated_at)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(round.id, newToken(), customerName, JSON.stringify(priced.lines), priced.subtotal, t.tip, t.tipRecipient,
        priced.subtotal + t.tip, paymentMethod, paymentStatus, paid ? ts : null, paid ? req.user.id : null,
        clip(notes, 2000), req.user.id, ts, ts);
    audit(req.user.id, 'order.create_admin', { roundId: round.id, orderId: Number(info.lastInsertRowid), detail: customerName });
    res.status(201).json(roundDetail(round.id));
  } catch (err) {
    next(err);
  }
});

adminRouter.patch('/api/admin/orders/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    if (!order) throw new UserError('Bestellung nicht gefunden.', 404);
    const body = req.body || {};
    const f = {};
    const changes = [];
    if (body.customerName !== undefined) {
      f.customer_name = clip(body.customerName, 60);
      if (!f.customer_name) throw new UserError('Name darf nicht leer sein.');
    }
    if (body.notes !== undefined) { f.notes = clip(body.notes, 2000); changes.push('Notiz'); }
    if (body.pickedUp !== undefined) { f.picked_up = body.pickedUp ? 1 : 0; changes.push(body.pickedUp ? 'abgeholt' : 'nicht abgeholt'); }
    if (body.paymentMethod !== undefined) {
      if (!PAYMENT_METHODS.includes(body.paymentMethod)) throw new UserError('Ungültige Zahlungsart.');
      f.payment_method = body.paymentMethod;
    }
    if (body.paymentStatus !== undefined && body.paymentStatus !== order.payment_status) {
      if (!PAYMENT_STATUS.includes(body.paymentStatus)) throw new UserError('Ungültiger Zahlungsstatus.');
      f.payment_status = body.paymentStatus;
      if (body.paymentStatus === 'paid') { f.paid_at = now(); f.paid_marked_by = req.user.id; }
      if (body.paymentStatus === 'open') { f.paid_at = null; f.paid_marked_by = null; f.customer_says_paid = 0; }
      changes.push({ open: 'auf offen gesetzt', paid: 'als bezahlt markiert', cancelled: 'storniert' }[body.paymentStatus]);
    }
    if (body.lines !== undefined || body.tip !== undefined || body.tipRecipient !== undefined) {
      const priced = body.lines !== undefined
        ? priceLines(body.lines, { allowCustom: true, allowInactive: true })
        : { lines: JSON.parse(order.lines), subtotal: order.subtotal };
      const t = parseTip(body.tip !== undefined ? body.tip : order.tip, body.tipRecipient !== undefined ? body.tipRecipient : order.tip_recipient);
      Object.assign(f, { lines: JSON.stringify(priced.lines), subtotal: priced.subtotal, tip: t.tip, tip_recipient: t.tipRecipient, total: priced.subtotal + t.tip });
      if (f.total !== order.total) changes.push(`Betrag ${(order.total / 100).toFixed(2)} → ${(f.total / 100).toFixed(2)} €`);
      else changes.push('Positionen geändert');
    }
    const keys = Object.keys(f);
    if (keys.length) {
      f.updated_at = now();
      const all = Object.keys(f);
      db.prepare(`UPDATE orders SET ${all.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...all.map((k) => f[k]), id);
      audit(req.user.id, 'order.update', { roundId: order.round_id, orderId: id, detail: `${order.customer_name}: ${changes.join(', ') || 'bearbeitet'}` });
    }
    res.json(roundDetail(order.round_id));
  } catch (err) {
    next(err);
  }
});

adminRouter.delete('/api/admin/orders/:id', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(req.params.id));
  if (!order) return res.status(404).json({ error: 'Bestellung nicht gefunden.' });
  db.prepare('DELETE FROM orders WHERE id = ?').run(order.id);
  audit(req.user.id, 'order.delete', { roundId: order.round_id, detail: `#${order.id} ${order.customer_name}` });
  res.json(roundDetail(order.round_id));
});

adminRouter.post('/api/admin/orders/:id/paypal-check', async (req, res, next) => {
  try {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(req.params.id));
    if (!order) throw new UserError('Bestellung nicht gefunden.', 404);
    if (!order.paypal_order_id) throw new UserError('Zu dieser Bestellung gibt es keinen PayPal-Vorgang.');
    if (!paypalApiConfigured()) throw new UserError('PayPal-API ist nicht eingerichtet.');
    const result = await capturePaypalOrder(order.paypal_order_id);
    if (result.paid) markPaidByPaypal(order, result.captureId);
    res.json({ ...roundDetail(order.round_id), paypalStatus: result.status, paid: result.paid });
  } catch (err) {
    next(err);
  }
});

// ---------------- Speisekarte ----------------
adminRouter.get('/api/admin/menu', (_req, res) => res.json({ menu: loadMenu({ includeInactive: true }) }));

function readItem(body) {
  const name = clip(body.name, 120);
  if (!name) throw new UserError('Der Artikel braucht einen Namen.');
  const categoryId = String(body.categoryId || '');
  if (!db.prepare('SELECT 1 FROM categories WHERE id = ?').get(categoryId)) throw new UserError('Unbekannte Kategorie.');
  if (!Array.isArray(body.variants) || body.variants.length === 0 || body.variants.length > 6) throw new UserError('1 bis 6 Größen/Varianten angeben.');
  const variants = body.variants.map((v) => {
    const price = v.price === null || v.price === '' || v.price === undefined ? null : Math.round(Number(v.price));
    if (price !== null && (!Number.isInteger(price) || price < 0 || price > 100000)) throw new UserError('Ungültiger Preis.');
    return { label: clip(v.label, 40) || '', price };
  });
  if (variants.length > 1 && variants.some((v) => !v.label)) throw new UserError('Bei mehreren Varianten braucht jede eine Bezeichnung.');
  const groupIds = new Set(db.prepare('SELECT id FROM option_groups').all().map((g) => g.id));
  const groups = (Array.isArray(body.groups) ? body.groups : []).filter((g) => groupIds.has(g));
  const active = Boolean(body.active);
  if (active && variants.some((v) => v.price === null)) throw new UserError('Ohne Preis kann der Artikel nicht freigeschaltet werden.');
  return {
    category_id: categoryId, num: clip(body.num, 8), name, description: clip(body.description, 300),
    variants: JSON.stringify(variants), groups: JSON.stringify(groups), active: active ? 1 : 0,
  };
}

adminRouter.post('/api/admin/menu/items', (req, res, next) => {
  try {
    const f = readItem(req.body || {});
    const sort = db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM menu_items WHERE category_id = ?').get(f.category_id).s;
    db.prepare(`INSERT INTO menu_items (category_id, num, name, description, variants, groups, active, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(f.category_id, f.num, f.name, f.description, f.variants, f.groups, f.active, sort);
    audit(req.user.id, 'menu.create', { detail: f.name });
    res.status(201).json({ menu: loadMenu({ includeInactive: true }) });
  } catch (err) {
    next(err);
  }
});

adminRouter.put('/api/admin/menu/items/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM menu_items WHERE id = ?').get(id)) throw new UserError('Artikel nicht gefunden.', 404);
    const f = readItem(req.body || {});
    db.prepare(`UPDATE menu_items SET category_id = ?, num = ?, name = ?, description = ?, variants = ?, groups = ?, active = ? WHERE id = ?`)
      .run(f.category_id, f.num, f.name, f.description, f.variants, f.groups, f.active, id);
    audit(req.user.id, 'menu.update', { detail: f.name });
    res.json({ menu: loadMenu({ includeInactive: true }) });
  } catch (err) {
    next(err);
  }
});

adminRouter.delete('/api/admin/menu/items/:id', (req, res) => {
  const item = db.prepare('SELECT name FROM menu_items WHERE id = ?').get(Number(req.params.id));
  if (!item) return res.status(404).json({ error: 'Artikel nicht gefunden.' });
  // Alte Bestellungen bleiben unberührt, sie speichern eine Kopie der Positionen.
  db.prepare('DELETE FROM menu_items WHERE id = ?').run(Number(req.params.id));
  audit(req.user.id, 'menu.delete', { detail: item.name });
  res.json({ menu: loadMenu({ includeInactive: true }) });
});

adminRouter.put('/api/admin/menu/groups/:id', (req, res, next) => {
  try {
    const id = String(req.params.id);
    if (!db.prepare('SELECT 1 FROM option_groups WHERE id = ?').get(id)) throw new UserError('Optionsgruppe nicht gefunden.', 404);
    const { name, type, required, choices } = req.body || {};
    if (!clip(name, 60)) throw new UserError('Name fehlt.');
    if (!['single', 'multi'].includes(type)) throw new UserError('Typ muss single oder multi sein.');
    if (!Array.isArray(choices) || choices.length === 0 || choices.length > 30) throw new UserError('1 bis 30 Auswahlmöglichkeiten angeben.');
    const clean = choices.map((c) => {
      const price = Math.round(Number(c.price) || 0);
      if (!clip(c.label, 60) || price < 0 || price > 10000) throw new UserError('Ungültige Auswahlmöglichkeit.');
      return { label: clip(c.label, 60), price };
    });
    db.prepare('UPDATE option_groups SET name = ?, type = ?, required = ?, choices = ? WHERE id = ?')
      .run(clip(name, 60), type, required ? 1 : 0, JSON.stringify(clean), id);
    audit(req.user.id, 'menu.group', { detail: id });
    res.json({ menu: loadMenu({ includeInactive: true }) });
  } catch (err) {
    next(err);
  }
});

// ---------------- Export ----------------
adminRouter.get('/admin/runden/:id/druck', (req, res) => {
  const detail = roundDetail(Number(req.params.id));
  if (!detail) return res.status(404).send('Runde nicht gefunden.');
  res.type('html').send(renderPrint(detail, getSettings(), req.query.ansicht === 'personen' ? 'personen' : 'alles'));
});

adminRouter.get('/admin/runden/:id/export.csv', (req, res) => {
  const detail = roundDetail(Number(req.params.id));
  if (!detail) return res.status(404).send('Runde nicht gefunden.');
  const date = (detail.round.openedAt || '').slice(0, 10);
  res.setHeader('Content-Disposition', `attachment; filename="doenerrunde-${detail.round.id}-${date}.csv"`);
  res.type('text/csv; charset=utf-8').send(renderCsv(detail));
});
