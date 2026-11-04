// End-to-End-Smoke-Test gegen einen frischen Server mit leerer Datenbank:  npm run smoke
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doener-smoke-'));
const port = 3900 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${port}`;

const server = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, PAYPAL_CLIENT_ID: '', PAYPAL_CLIENT_SECRET: '', BASE_URL: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });

let cookie = '';
async function call(method, url, body, { auth = true, raw = false } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(auth && cookie ? { Cookie: cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie && auth) cookie = setCookie.split(';')[0];
  if (raw) return res;
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

let passed = 0;
async function step(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

async function waitForServer() {
  for (let i = 0; i < 50; i += 1) {
    try { await fetch(`${base}/api/auth/me`); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error(`Server startet nicht:\n${log}`);
}

try {
  await waitForServer();
  let roundId;
  let state;
  let orderToken;

  await step('Erst-Einrichtung nur ohne Benutzer, danach gesperrt', async () => {
    let r = await call('GET', '/api/auth/me');
    assert.equal(r.data.needsSetup, true);
    assert.equal(r.data.setupAllowed, true);
    r = await call('POST', '/api/auth/setup', { username: 'azubi1', displayName: 'Azubi Eins', password: 'geheim123' });
    assert.equal(r.status, 200);
    r = await call('POST', '/api/auth/setup', { username: 'x', displayName: 'x', password: 'geheim123' }, { auth: false });
    assert.equal(r.status, 409);
  });

  await step('Admin-API ohne Anmeldung gesperrt, Login mit falschem Passwort scheitert', async () => {
    let r = await call('GET', '/api/admin/rounds', undefined, { auth: false });
    assert.equal(r.status, 401);
    r = await call('POST', '/api/auth/login', { username: 'azubi1', password: 'falsch' }, { auth: false });
    assert.equal(r.status, 401);
    const res = await call('GET', '/admin/runden/1/druck', undefined, { auth: false, raw: true });
    assert.equal(res.status, 302);
  });

  await step('Formular-Posts (kein JSON) werden abgelehnt', async () => {
    const res = await fetch(`${base}/api/admin/rounds`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'title=x' });
    assert.equal(res.status, 415);
  });

  await step('Speisekarte geladen, Cheezy ohne Preis ist inaktiv', async () => {
    const r = await call('GET', '/api/admin/menu');
    const items = r.data.menu.items;
    assert.ok(items.length > 120, `nur ${items.length} Artikel`);
    const cheezy = items.filter((i) => i.categoryId === 'cheezy');
    assert.ok(cheezy.length >= 6 && cheezy.every((i) => !i.active));
    const tasche = items.find((i) => i.num === '01');
    assert.equal(tasche.variants[0].price, 780);
  });

  await step('Ohne offene Runde keine Bestellung möglich', async () => {
    state = (await call('GET', '/api/public/state', undefined, { auth: false })).data;
    assert.equal(state.round, null);
    const r = await call('POST', '/api/public/orders', { roundId: 1, name: 'Test', lines: [] }, { auth: false });
    assert.equal(r.status, 409);
  });

  await step('Azubi öffnet Runde mit Bestell-Code und PayPal.me', async () => {
    await call('PATCH', '/api/admin/me', { paypalMe: 'https://paypal.me/azubikasse' });
    const r = await call('POST', '/api/admin/rounds', { title: 'Smoke-Runde', accessCode: 'Döner42', pickupTime: '12:15 Uhr' });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    roundId = r.data.round.id;
    assert.equal(r.data.round.paypalMe, 'azubikasse');
    const again = await call('POST', '/api/admin/rounds', { title: 'zweite' });
    assert.equal(again.status, 409);
  });

  const tasche = () => state.menu.items.find((i) => i.num === '01');
  const pizza = () => state.menu.items.find((i) => i.num === '15');

  await step('Bestellung: Code, Pflichtauswahl und Preise werden serverseitig geprüft', async () => {
    state = (await call('GET', '/api/public/state', undefined, { auth: false })).data;
    assert.equal(state.round.isOpen, true);
    assert.equal(state.round.needsCode, true);
    const extras = state.menu.groups.extras.choices.findIndex((c) => c.label === 'Käse');
    const line = { itemId: tasche().id, variant: 0, options: { fleisch: [0], extras: [extras] }, qty: 2, comment: 'scharf', unitPrice: 1 };
    let r = await call('POST', '/api/public/orders', { roundId, code: 'falsch', name: 'Max', lines: [line] }, { auth: false });
    assert.equal(r.status, 403);
    r = await call('POST', '/api/public/orders', { roundId, code: 'döner42', name: 'Max', lines: [{ ...line, options: {} }] }, { auth: false });
    assert.equal(r.status, 400, 'Fleisch-Auswahl ist Pflicht');
    r = await call('POST', '/api/public/orders', {
      roundId, code: 'döner42', name: 'Max Muster',
      lines: [line, { itemId: pizza().id, variant: 1, options: {}, qty: 1 }],
      tip: 120, tipRecipient: 'doener',
    }, { auth: false });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const o = r.data.order;
    // 2 × (7,80 + 0,70 Käse) + Pizza 30 cm 7,50 = 24,50, + 1,20 Trinkgeld
    assert.equal(o.subtotal, 2450);
    assert.equal(o.total, 2570);
    assert.equal(r.data.approveUrl, null);
    assert.equal(o.pay.paypalMeLink, 'https://paypal.me/azubikasse/25.70EUR');
    orderToken = o.token;
  });

  await step('Trinkgeld ohne Empfänger wird abgelehnt', async () => {
    const r = await call('POST', '/api/public/orders', {
      roundId, code: 'Döner42', name: 'Erika', lines: [{ itemId: pizza().id, variant: 0, qty: 1 }], tip: 100,
    }, { auth: false });
    assert.equal(r.status, 400);
  });

  await step('Besteller meldet Zahlung, Status-Seite zeigt es', async () => {
    const r = await call('POST', `/api/public/orders/${orderToken}/claim-paid`, {}, { auth: false });
    assert.equal(r.data.order.customerSaysPaid, true);
    assert.equal(r.data.order.paymentStatus, 'open');
    const page = await call('GET', `/bestellung/${orderToken}`, undefined, { auth: false, raw: true });
    assert.equal(page.status, 200);
  });

  let orderId;
  await step('Azubi sieht die Bestellung und hakt sie als bezahlt ab', async () => {
    let r = await call('GET', `/api/admin/rounds/${roundId}`);
    assert.equal(r.data.orders.length, 1);
    orderId = r.data.orders[0].id;
    r = await call('PATCH', `/api/admin/orders/${orderId}`, { paymentStatus: 'paid', notes: 'Eingang geprüft' });
    assert.equal(r.data.orders[0].paymentStatus, 'paid');
    assert.equal(r.data.orders[0].paidMarkedBy, 'Azubi Eins');
    assert.equal(r.data.totals.paid, 2570);
    assert.equal(r.data.totals.tipDoener, 120);
  });

  await step('Runde schließen: öffentliche Bestellung danach gesperrt', async () => {
    let r = await call('PATCH', `/api/admin/rounds/${roundId}`, { status: 'closed' });
    assert.equal(r.data.round.status, 'closed');
    r = await call('POST', '/api/public/orders', { roundId, code: 'Döner42', name: 'Zu spät', lines: [{ itemId: pizza().id, variant: 0, qty: 1 }] }, { auth: false });
    assert.equal(r.status, 409);
  });

  await step('Nachträglich über das Admin-Portal hinzufügen (inkl. freier Position)', async () => {
    const r = await call('POST', `/api/admin/rounds/${roundId}/orders`, {
      name: 'Nachzügler', paymentStatus: 'paid', paymentMethod: 'cash',
      lines: [{ itemId: pizza().id, variant: 0, qty: 1 }, { custom: true, name: 'Extra Tzaziki', unitPrice: 150, qty: 2 }],
      tip: 50, tipRecipient: 'azubis',
    });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.orders.length, 2);
    const o = r.data.orders[1];
    assert.equal(o.total, 600 + 300 + 50);
    assert.equal(o.createdBy, 'Azubi Eins');
    assert.equal(r.data.totals.tipAzubis, 50);
  });

  await step('Öffentlich keine freien Positionen', async () => {
    await call('PATCH', `/api/admin/rounds/${roundId}`, { status: 'open' });
    const r = await call('POST', '/api/public/orders', {
      roundId, code: 'Döner42', name: 'Trickser', lines: [{ custom: true, name: 'Gratis', unitPrice: 0, qty: 1 }],
    }, { auth: false });
    assert.equal(r.status, 400);
    await call('PATCH', `/api/admin/rounds/${roundId}`, { status: 'closed' });
  });

  await step('Druck-Export und CSV', async () => {
    let res = await call('GET', `/admin/runden/${roundId}/druck`, undefined, { raw: true });
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /Bestellliste für/);
    assert.match(html, /Max Muster/);
    assert.match(html, /An den Dönermann zahlen/);
    assert.match(html, /2×/);
    res = await call('GET', `/admin/runden/${roundId}/export.csv`, undefined, { raw: true });
    const csv = await res.text();
    assert.match(res.headers.get('content-disposition'), /attachment/);
    assert.match(csv, /Nachzügler/);
    assert.match(csv, /Extra Tzaziki/);
  });

  await step('Bestellschluss schließt die Runde automatisch', async () => {
    const r = await call('POST', '/api/admin/rounds', { title: 'Kurz', deadline: new Date(Date.now() + 1500).toISOString() });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    await new Promise((res) => setTimeout(res, 2000));
    const s = (await call('GET', '/api/public/state', undefined, { auth: false })).data;
    assert.equal(s.round, null);
    const rounds = (await call('GET', '/api/admin/rounds')).data.rounds;
    assert.equal(rounds[0].status, 'closed');
  });

  await step('Zugänge anlegen, Speisekarte pflegen', async () => {
    let r = await call('POST', '/api/admin/users', { username: 'azubi2', displayName: 'Azubi Zwei', password: 'kurz' });
    assert.equal(r.status, 400);
    r = await call('POST', '/api/admin/users', { username: 'azubi2', displayName: 'Azubi Zwei', password: 'auch-geheim' });
    assert.equal(r.status, 201);
    const menu = (await call('GET', '/api/admin/menu')).data.menu;
    const cheezy = menu.items.find((i) => i.name === 'Cheezy Tasche');
    r = await call('PUT', `/api/admin/menu/items/${cheezy.id}`, { ...cheezy, active: true });
    assert.equal(r.status, 400, 'ohne Preis nicht aktivierbar');
    r = await call('PUT', `/api/admin/menu/items/${cheezy.id}`, { ...cheezy, variants: [{ label: '', price: 950 }], active: true });
    assert.equal(r.status, 200);
    assert.ok(r.data.menu.items.find((i) => i.id === cheezy.id).active);
  });

  await step('Statische Seiten liefern aus', async () => {
    for (const p of ['/', '/admin', '/js/order.js', '/js/admin.js', '/css/app.css']) {
      const res = await fetch(base + p);
      assert.equal(res.status, 200, p);
      assert.ok(res.headers.get('content-security-policy'));
    }
  });

  console.log(`\nSmoke-Test bestanden (${passed} Schritte).`);
} catch (err) {
  console.error(`\nSmoke-Test FEHLGESCHLAGEN nach ${passed} Schritten:\n`, err);
  console.error('\nServer-Log:\n', log);
  process.exitCode = 1;
} finally {
  server.kill();
  await new Promise((r) => setTimeout(r, 300));
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows: DB-Datei evtl. noch gesperrt */ }
}
