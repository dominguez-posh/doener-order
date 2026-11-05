import crypto from 'node:crypto';
import { db, now } from './db.js';

export class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// ---- Speisekarte ----
// Name außerhalb der Karte (Warenkorb, Bestellliste, Ausdruck): „Schinken“ allein sagt nicht, dass es eine Pizza ist.
export function displayName(name, prefix) {
  return prefix && !name.toLowerCase().includes(prefix.toLowerCase()) ? `${prefix} ${name}` : name;
}

export function loadMenu({ includeInactive = false } = {}) {
  const categories = db.prepare('SELECT id, name, note, item_prefix AS prefix FROM categories ORDER BY sort, name').all();
  const prefixOf = new Map(categories.map((c) => [c.id, c.prefix]));
  const groups = {};
  for (const g of db.prepare('SELECT * FROM option_groups').all()) {
    groups[g.id] = { id: g.id, name: g.name, type: g.type, required: Boolean(g.required), choices: JSON.parse(g.choices) };
  }
  const items = db.prepare(`SELECT * FROM menu_items ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY sort, id`).all()
    .map((i) => ({
      id: i.id, categoryId: i.category_id, num: i.num, name: i.name,
      displayName: displayName(i.name, prefixOf.get(i.category_id)), description: i.description,
      variants: JSON.parse(i.variants), groups: JSON.parse(i.groups), active: Boolean(i.active),
    }));
  return { categories, groups, items };
}

const MAX_QTY = 20;
const MAX_LINES = 30;
const clip = (s, n) => String(s ?? '').trim().slice(0, n);

// Rechnet die Positionen eines Warenkorbs gegen die aktuelle Speisekarte nach.
// Der Client schickt nur IDs und Auswahl, Preise kommen ausschließlich vom Server.
// allowCustom: Azubis dürfen im Admin-Panel freie Positionen erfassen.
export function priceLines(rawLines, { allowCustom = false, allowInactive = false } = {}) {
  if (!Array.isArray(rawLines) || rawLines.length === 0) throw new UserError('Der Warenkorb ist leer.');
  if (rawLines.length > MAX_LINES) throw new UserError(`Maximal ${MAX_LINES} Positionen pro Bestellung.`);
  const menu = loadMenu({ includeInactive: true });
  const byId = new Map(menu.items.map((i) => [i.id, i]));

  const lines = rawLines.map((raw) => {
    const qty = Number(raw?.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) throw new UserError(`Menge muss zwischen 1 und ${MAX_QTY} liegen.`);
    const comment = clip(raw.comment, 200);

    if (raw.custom) {
      if (!allowCustom) throw new UserError('Freie Positionen sind nur im Admin-Panel möglich.');
      const name = clip(raw.name, 120);
      const unitPrice = Math.round(Number(raw.unitPrice));
      if (!name) throw new UserError('Freie Position braucht eine Bezeichnung.');
      if (!Number.isInteger(unitPrice) || unitPrice < 0 || unitPrice > 100000) throw new UserError('Ungültiger Preis für die freie Position.');
      return { custom: true, itemId: null, num: null, name, variant: '', options: [], unitPrice, qty, lineTotal: unitPrice * qty, comment };
    }

    const item = byId.get(Number(raw.itemId));
    if (!item || (!item.active && !allowInactive)) throw new UserError('Ein Artikel ist nicht (mehr) bestellbar. Bitte Warenkorb prüfen.');
    const vIndex = Number(raw.variant ?? 0);
    const variant = item.variants[vIndex];
    if (!variant) throw new UserError(`Ungültige Größe/Variante bei „${item.name}“.`);
    if (variant.price === null) throw new UserError(`Für „${item.name}“ ist noch kein Preis hinterlegt.`);

    const options = [];
    let unitPrice = variant.price;
    const chosen = raw.options && typeof raw.options === 'object' ? raw.options : {};
    for (const gid of item.groups) {
      const group = menu.groups[gid];
      if (!group) continue;
      let picks = chosen[gid];
      picks = Array.isArray(picks) ? picks : picks === undefined || picks === null ? [] : [picks];
      picks = [...new Set(picks.map(Number))];
      if (picks.some((p) => !Number.isInteger(p) || !group.choices[p])) throw new UserError(`Ungültige Auswahl bei „${item.name}“ (${group.name}).`);
      if (group.type === 'single' && picks.length > 1) throw new UserError(`Bei „${item.name}“ bitte nur eine Option für ${group.name} wählen.`);
      if (group.required && picks.length === 0) throw new UserError(`Bei „${item.name}“ fehlt die Auswahl: ${group.name}.`);
      for (const p of picks) {
        const c = group.choices[p];
        options.push({ group: group.name, label: c.label, price: c.price || 0 });
        unitPrice += c.price || 0;
      }
    }
    return {
      custom: false, itemId: item.id, num: item.num, name: item.displayName, variant: variant.label,
      // Rohe Auswahl mitspeichern, damit das Admin-Panel die Position wieder bearbeiten kann.
      selection: { variant: vIndex, options: Object.fromEntries(item.groups.map((g) => [g, chosen[g] ?? []])) },
      options, unitPrice, qty, lineTotal: unitPrice * qty, comment,
    };
  });
  const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
  return { lines, subtotal };
}

export function parseTip(tip, recipient) {
  const t = Math.round(Number(tip) || 0);
  if (t < 0 || t > 5000) throw new UserError('Das Trinkgeld muss zwischen 0 und 50 € liegen.');
  if (t === 0) return { tip: 0, tipRecipient: null };
  if (recipient !== 'doener' && recipient !== 'azubis') throw new UserError('Bitte wählen, wer das Trinkgeld bekommt.');
  return { tip: t, tipRecipient: recipient };
}

// ---- Bestellrunden ----
// Rundet ab, ob eine Runde über ihren Bestellschluss gelaufen ist, und schließt sie dann.
export function refreshRound(round) {
  if (round && round.status === 'open' && round.deadline && Date.parse(round.deadline) <= Date.now()) {
    db.prepare("UPDATE rounds SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'open'").run(round.deadline, round.id);
    db.prepare('INSERT INTO audit (at, user_id, round_id, action, detail) VALUES (?, NULL, ?, ?, ?)')
      .run(now(), round.id, 'round.autoclose', 'Bestellschluss erreicht');
    return { ...round, status: 'closed', closed_at: round.deadline };
  }
  return round;
}

export function getRound(id) {
  return refreshRound(db.prepare('SELECT * FROM rounds WHERE id = ?').get(id));
}

export function getOpenRound() {
  const round = db.prepare("SELECT * FROM rounds WHERE status = 'open' ORDER BY id DESC LIMIT 1").get();
  const refreshed = refreshRound(round);
  return refreshed && refreshed.status === 'open' ? refreshed : null;
}

export function newToken() {
  return crypto.randomBytes(18).toString('base64url');
}

export function codeMatches(expected, given) {
  const a = Buffer.from(String(expected ?? '').trim().toLowerCase());
  const b = Buffer.from(String(given ?? '').trim().toLowerCase());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function serializeOrder(o) {
  return {
    id: o.id, roundId: o.round_id, token: o.token, customerName: o.customer_name, lines: JSON.parse(o.lines),
    subtotal: o.subtotal, tip: o.tip, tipRecipient: o.tip_recipient, total: o.total,
    paymentMethod: o.payment_method, paymentStatus: o.payment_status, customerSaysPaid: Boolean(o.customer_says_paid),
    paidAt: o.paid_at, paidMarkedBy: o.paid_marked_by_name ?? null, paypalOrderId: o.paypal_order_id,
    paypalCaptureId: o.paypal_capture_id, notes: o.notes, pickedUp: Boolean(o.picked_up),
    createdBy: o.created_by_name ?? null, createdAt: o.created_at, updatedAt: o.updated_at,
  };
}

export function roundTotals(orders) {
  const live = orders.filter((o) => o.paymentStatus !== 'cancelled');
  const sum = (arr, f) => arr.reduce((s, o) => s + f(o), 0);
  return {
    orders: live.length,
    subtotal: sum(live, (o) => o.subtotal),
    tipDoener: sum(live.filter((o) => o.tipRecipient === 'doener'), (o) => o.tip),
    tipAzubis: sum(live.filter((o) => o.tipRecipient === 'azubis'), (o) => o.tip),
    total: sum(live, (o) => o.total),
    paid: sum(live.filter((o) => o.paymentStatus === 'paid'), (o) => o.total),
    open: sum(live.filter((o) => o.paymentStatus === 'open'), (o) => o.total),
    paidCount: live.filter((o) => o.paymentStatus === 'paid').length,
  };
}

// Fasst gleiche Positionen über alle Bestellungen zusammen – das ist der Zettel für den Dönermann.
export function aggregateLines(orders) {
  const map = new Map();
  for (const o of orders) {
    if (o.paymentStatus === 'cancelled') continue;
    for (const l of o.lines) {
      const opts = l.options.map((x) => x.label).join(', ');
      const key = [l.num, l.name, l.variant, opts, l.comment].join('|');
      const entry = map.get(key) || { num: l.num, name: l.name, variant: l.variant, options: opts, comment: l.comment, qty: 0, total: 0, who: [] };
      entry.qty += l.qty;
      entry.total += l.lineTotal;
      entry.who.push(l.qty > 1 ? `${o.customerName} (${l.qty}×)` : o.customerName);
      map.set(key, entry);
    }
  }
  return [...map.values()].sort((a, b) => compareNum(a.num, b.num) || a.name.localeCompare(b.name, 'de'));
}

// Sortiert Karten-Nummern wie "01", "01a", "15", "102b"; Positionen ohne Nummer ans Ende.
function compareNum(a, b) {
  const split = (n) => {
    const m = /^(\d+)(.*)$/.exec(n || '');
    return m ? [Number(m[1]), m[2]] : [Infinity, n || ''];
  };
  const [an, as] = split(a);
  const [bn, bs] = split(b);
  return an === bn ? as.localeCompare(bs) : an < bn ? -1 : 1;
}
