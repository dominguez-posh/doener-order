import express from 'express';
import { db, now, audit, getSettings } from './db.js';
import { loadMenu, priceLines, parseTip, getOpenRound, getRound, newToken, codeMatches, UserError } from './orders.js';
import { effectiveMode, paypalMeLink, createPaypalOrder, capturePaypalOrder } from './paypal.js';
import { config } from './config.js';

export const publicRouter = express.Router();

const baseUrl = (req) => config.baseUrl || `${req.protocol}://${req.get('host')}`;

// Wer die Kasse macht, bestimmt das PayPal-Konto – es ist einmal fest am Zugang hinterlegt.
function collectorOf(round) {
  return round?.collector_id
    ? db.prepare('SELECT display_name, paypal_me FROM users WHERE id = ?').get(round.collector_id) : undefined;
}

function publicRound(round) {
  if (!round) return null;
  return {
    id: round.id, title: round.title, isOpen: round.status === 'open', deadline: round.deadline,
    pickupTime: round.pickup_time, needsCode: Boolean(round.access_code),
    collector: collectorOf(round)?.display_name ?? null,
  };
}

function payInfo(order, round) {
  const settings = getSettings();
  const handle = collectorOf(round)?.paypal_me || settings.default_paypal_me;
  return {
    method: order.payment_method,
    canPayApi: order.payment_method === 'paypal_api' && effectiveMode() === 'api',
    paypalMeLink: paypalMeLink(handle, order.total),
    reference: `${settings.shop_name} #${order.id} ${order.customer_name}`,
  };
}

function publicOrder(o) {
  const round = getRound(o.round_id);
  return {
    id: o.id, token: o.token, customerName: o.customer_name, lines: JSON.parse(o.lines),
    subtotal: o.subtotal, tip: o.tip, tipRecipient: o.tip_recipient, total: o.total,
    paymentStatus: o.payment_status, customerSaysPaid: Boolean(o.customer_says_paid), paidAt: o.paid_at,
    pickedUp: Boolean(o.picked_up), createdAt: o.created_at,
    round: publicRound(round), pay: payInfo(o, round),
  };
}

const orderByToken = (token) => db.prepare('SELECT * FROM orders WHERE token = ?').get(String(token));

// Zahlung bei PayPal anlegen und Freigabe-Link liefern.
async function startPaypal(req, order) {
  const base = baseUrl(req);
  const o = encodeURIComponent(order.token);
  const pp = await createPaypalOrder({
    order,
    returnUrl: `${base}/pay/return?o=${o}`,
    cancelUrl: `${base}/pay/cancel?o=${o}`,
  });
  db.prepare('UPDATE orders SET paypal_order_id = ?, updated_at = ? WHERE id = ?').run(pp.id, now(), order.id);
  return pp.approveUrl;
}

// sehr einfache Bremse gegen Spam-Bestellungen
const RATE_WINDOW_MS = 10 * 60 * 1000;
const recent = new Map();
function rateLimited(ip) {
  const list = (recent.get(ip) || []).filter((t) => t > Date.now() - RATE_WINDOW_MS);
  list.push(Date.now());
  recent.set(ip, list);
  return list.length > 15;
}
setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [ip, list] of recent) if (list.every((t) => t < cutoff)) recent.delete(ip);
}, RATE_WINDOW_MS).unref();

publicRouter.get('/api/public/state', (_req, res) => {
  const settings = getSettings();
  const round = getOpenRound();
  const last = round ? null : db.prepare('SELECT * FROM rounds ORDER BY id DESC LIMIT 1').get();
  res.json({
    shopName: settings.shop_name,
    tipPresets: settings.tip_presets.split(',').map(Number).filter((n) => n > 0).map((n) => Math.round(n * 100)),
    paymentMode: effectiveMode(),
    round: publicRound(round),
    lastClosedAt: last?.closed_at ?? null,
    menu: loadMenu(),
  });
});

publicRouter.post('/api/public/orders', async (req, res, next) => {
  try {
    const { roundId, code, name, lines, tip, tipRecipient } = req.body || {};
    if (rateLimited(req.ip)) throw new UserError('Zu viele Bestellungen in kurzer Zeit. Bitte kurz warten.', 429);
    const round = getOpenRound();
    if (!round || round.id !== Number(roundId)) throw new UserError('Diese Bestellrunde ist geschlossen. Bitte bei den Azubis melden.', 409);
    if (round.access_code && !codeMatches(round.access_code, code)) throw new UserError('Der Bestell-Code stimmt nicht.', 403);
    const customerName = String(name ?? '').trim().slice(0, 60);
    if (customerName.length < 2) throw new UserError('Bitte deinen Namen angeben.');
    const priced = priceLines(lines);
    const t = parseTip(tip, tipRecipient);
    const mode = effectiveMode();
    const ts = now();
    const info = db.prepare(`INSERT INTO orders (round_id, token, customer_name, lines, subtotal, tip, tip_recipient, total,
                               payment_method, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(round.id, newToken(), customerName, JSON.stringify(priced.lines), priced.subtotal, t.tip, t.tipRecipient,
        priced.subtotal + t.tip, mode === 'api' ? 'paypal_api' : 'paypal_me', ts, ts);
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(info.lastInsertRowid);
    audit(null, 'order.create', { roundId: round.id, orderId: order.id, detail: `${customerName}, ${priced.lines.length} Pos.` });

    let approveUrl = null;
    let paypalError = null;
    if (mode === 'api') {
      try {
        approveUrl = await startPaypal(req, order);
      } catch (err) {
        console.error('[paypal] create failed:', err.message, JSON.stringify(err.paypal ?? {}));
        paypalError = 'PayPal ist gerade nicht erreichbar. Du kannst es auf der Bestellseite gleich nochmal versuchen.';
      }
    }
    res.status(201).json({ order: publicOrder(order), approveUrl, paypalError });
  } catch (err) {
    next(err);
  }
});

publicRouter.get('/api/public/orders/:token', (req, res) => {
  const order = orderByToken(req.params.token);
  if (!order) return res.status(404).json({ error: 'Bestellung nicht gefunden.' });
  res.json({ order: publicOrder(order) });
});

publicRouter.post('/api/public/orders/:token/pay', async (req, res, next) => {
  try {
    const order = orderByToken(req.params.token);
    if (!order) throw new UserError('Bestellung nicht gefunden.', 404);
    if (order.payment_status !== 'open') throw new UserError('Diese Bestellung ist nicht mehr offen.', 409);
    if (effectiveMode() !== 'api') throw new UserError('PayPal Checkout ist nicht eingerichtet – bitte den PayPal.me-Link nutzen.', 409);
    if (order.paypal_order_id) {
      // Falls schon bezahlt, aber der Rücksprung verloren ging: erst nachsehen.
      const result = await capturePaypalOrder(order.paypal_order_id).catch(() => null);
      if (result?.paid) {
        markPaidByPaypal(order, result.captureId);
        return res.json({ paid: true });
      }
    }
    if (order.payment_method !== 'paypal_api') db.prepare("UPDATE orders SET payment_method = 'paypal_api' WHERE id = ?").run(order.id);
    res.json({ approveUrl: await startPaypal(req, order) });
  } catch (err) {
    next(err);
  }
});

publicRouter.post('/api/public/orders/:token/claim-paid', (req, res) => {
  const order = orderByToken(req.params.token);
  if (!order) return res.status(404).json({ error: 'Bestellung nicht gefunden.' });
  if (order.payment_status === 'open' && !order.customer_says_paid) {
    db.prepare('UPDATE orders SET customer_says_paid = 1, updated_at = ? WHERE id = ?').run(now(), order.id);
    audit(null, 'order.claim_paid', { roundId: order.round_id, orderId: order.id, detail: order.customer_name });
  }
  res.json({ order: publicOrder(orderByToken(req.params.token)) });
});

publicRouter.post('/api/public/orders/:token/cancel', (req, res, next) => {
  try {
    const order = orderByToken(req.params.token);
    if (!order) throw new UserError('Bestellung nicht gefunden.', 404);
    const round = getRound(order.round_id);
    if (round.status !== 'open') throw new UserError('Die Runde ist geschlossen – Stornieren bitte über die Azubis.', 409);
    if (order.payment_status !== 'open' || order.customer_says_paid) {
      throw new UserError('Bezahlte Bestellungen können nur die Azubis stornieren.', 409);
    }
    db.prepare("UPDATE orders SET payment_status = 'cancelled', updated_at = ? WHERE id = ?").run(now(), order.id);
    audit(null, 'order.cancel', { roundId: order.round_id, orderId: order.id, detail: `vom Besteller: ${order.customer_name}` });
    res.json({ order: publicOrder(orderByToken(req.params.token)) });
  } catch (err) {
    next(err);
  }
});

export function markPaidByPaypal(order, captureId) {
  const res = db.prepare(`UPDATE orders SET payment_status = 'paid', payment_method = 'paypal_api', paid_at = ?,
                            paypal_capture_id = ?, updated_at = ? WHERE id = ? AND payment_status = 'open'`)
    .run(now(), captureId, now(), order.id);
  if (res.changes) audit(null, 'order.paid', { roundId: order.round_id, orderId: order.id, detail: `PayPal ${captureId ?? ''}`.trim() });
}

// PayPal schickt den Käufer hierher zurück (…&token=<PayPal-Order>&PayerID=…).
publicRouter.get('/pay/return', async (req, res) => {
  const order = orderByToken(req.query.o);
  if (!order) return res.redirect('/');
  const target = `/bestellung/${encodeURIComponent(order.token)}`;
  if (order.payment_status === 'paid') return res.redirect(`${target}?bezahlt=1`);
  // Inzwischen storniert: kein Geld mehr einziehen.
  if (order.payment_status !== 'open') return res.redirect(target);
  const paypalId = order.paypal_order_id;
  if (!paypalId || (req.query.token && req.query.token !== paypalId)) return res.redirect(`${target}?fehler=zahlung`);
  try {
    const result = await capturePaypalOrder(paypalId);
    if (result.paid) {
      markPaidByPaypal(order, result.captureId);
      return res.redirect(`${target}?bezahlt=1`);
    }
    console.warn(`[paypal] order ${order.id}: capture status ${result.status}`);
    return res.redirect(`${target}?fehler=zahlung`);
  } catch (err) {
    console.error('[paypal] capture failed:', err.message, JSON.stringify(err.paypal ?? {}));
    return res.redirect(`${target}?fehler=zahlung`);
  }
});

publicRouter.get('/pay/cancel', (req, res) => {
  const order = orderByToken(req.query.o);
  res.redirect(order ? `/bestellung/${encodeURIComponent(order.token)}?abgebrochen=1` : '/');
});
