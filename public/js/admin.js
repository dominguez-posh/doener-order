import {
  api, esc, money, when, clock, $, $$, toast, parseEuro, euroInput, openItemDialog, describeSelection, priceFrom,
} from './common.js';

const app = $('[data-app]');
let me = null;
let menuCache = null;
let usersCache = null;
let current = null;        // aktuell angezeigte Runde (Detail)
let roundTab = 'orders';
let orderFilter = { q: '', status: 'all' };
let refreshTimer = null;
let lastRoundId = null;

const STATUS = {
  open: '<span class="pill pill-warn pill-dot">offen</span>',
  paid: '<span class="pill pill-ok pill-dot">bezahlt</span>',
  cancelled: '<span class="pill pill-muted">storniert</span>',
};
const METHOD = { paypal_api: 'PayPal', paypal_me: 'PayPal.me', cash: 'Bar', other: 'Sonstiges' };
const AUDIT = {
  'round.open': 'Runde geöffnet', 'round.close': 'Runde geschlossen', 'round.reopen': 'Runde wieder geöffnet',
  'round.update': 'Runde bearbeitet', 'round.autoclose': 'Runde automatisch geschlossen', 'order.create': 'Neue Bestellung',
  'order.create_admin': 'Bestellung nachgetragen', 'order.update': 'Bestellung geändert', 'order.delete': 'Bestellung gelöscht',
  'order.cancel': 'Bestellung storniert', 'order.paid': 'Zahlung eingegangen', 'order.claim_paid': 'Besteller meldet Zahlung',
};

const toLocalInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);

async function getMenu(force = false) {
  if (!menuCache || force) menuCache = (await api('/api/admin/menu')).menu;
  return menuCache;
}
async function getUsers(force = false) {
  if (!usersCache || force) usersCache = (await api('/api/admin/users')).users;
  return usersCache;
}

// ---------------- Dialog-Helfer ----------------
function modal({ title, body, foot = '', wide = false, onSubmit }) {
  const dlg = document.createElement('dialog');
  if (wide) dlg.className = 'wide';
  dlg.innerHTML = `<form class="dlg" novalidate>
    <div class="dlg-head"><h2>${title}</h2><button type="button" class="dlg-close btn-ghost" data-close aria-label="Schließen">✕</button></div>
    <div class="dlg-body">${body}<p class="error-text" data-error role="alert"></p></div>
    <div class="dlg-foot">${foot || '<button type="button" class="btn-ghost" data-close>Abbrechen</button><button type="submit" class="btn-primary">Speichern</button>'}</div>
  </form>`;
  document.body.append(dlg);
  const form = dlg.querySelector('form');
  const setError = (msg) => { dlg.querySelector('[data-error]').textContent = msg || ''; };
  dlg.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) dlg.close(); });
  dlg.addEventListener('close', () => dlg.remove());
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!onSubmit) return dlg.close();
    setError('');
    const btn = form.querySelector('button[type=submit]');
    if (btn) btn.disabled = true;
    try {
      const keepOpen = await onSubmit(form, dlg);
      if (!keepOpen) dlg.close();
    } catch (err) {
      setError(err.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  });
  dlg.showModal();
  return { dlg, form, setError };
}

function closePopups() {
  $$('.menu-pop-list').forEach((p) => p.remove());
}
document.addEventListener('click', (e) => { if (!e.target.closest('.menu-pop')) closePopups(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePopups(); });

// ---------------- Anmeldung ----------------
async function boot() {
  const res = await api('/api/auth/me');
  me = res.user;
  if (me) return shell();
  if (res.setupAllowed) return setupView();
  loginView(res.needsSetup);
}

function loginView(needsSetup) {
  app.innerHTML = `<div class="login-wrap"><form class="card login-card" data-login>
    <h1>🥙 Azubi-Portal</h1>
    <p class="muted">Anmelden, um Bestellrunden zu verwalten.</p>
    ${needsSetup ? '<p class="card small">Es gibt noch keinen Zugang. Den ersten Zugang bitte direkt am Server unter <code>http://localhost:…/admin</code> anlegen oder <code>npm run user:add</code> nutzen.</p>' : ''}
    <label for="lg-user">Benutzername</label><input id="lg-user" name="username" type="text" autocomplete="username" required>
    <label for="lg-pw">Passwort</label><input id="lg-pw" name="password" type="password" autocomplete="current-password" required>
    <p class="error-text" data-error role="alert"></p>
    <button class="btn-primary btn-block" type="submit">Anmelden</button>
    <p class="small"><a href="/">← zur Bestellseite</a></p>
  </form></div>`;
  const form = $('[data-login]');
  form.username.focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/auth/login', { method: 'POST', body: { username: form.username.value, password: form.password.value } });
      boot();
    } catch (err) {
      $('[data-error]', form).textContent = err.message;
    }
  });
}

function setupView() {
  app.innerHTML = `<div class="login-wrap"><form class="card login-card" data-setup>
    <h1>Ersten Zugang anlegen</h1>
    <p class="muted small">Es gibt noch keine Zugänge. Dieser erste Zugang kann weitere Azubis anlegen.</p>
    <label for="su-user">Benutzername</label><input id="su-user" name="username" type="text" autocomplete="username" required>
    <label for="su-name">Anzeigename</label><input id="su-name" name="displayName" type="text" required>
    <label for="su-pw">Passwort (min. 8 Zeichen)</label><input id="su-pw" name="password" type="password" autocomplete="new-password" required>
    <p class="error-text" data-error role="alert"></p>
    <button class="btn-primary btn-block" type="submit">Anlegen und anmelden</button>
  </form></div>`;
  const form = $('[data-setup]');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/auth/setup', { method: 'POST', body: { username: form.username.value, displayName: form.displayName.value, password: form.password.value } });
      boot();
    } catch (err) {
      $('[data-error]', form).textContent = err.message;
    }
  });
}

// ---------------- Rahmen & Routing ----------------
const NAV = [
  ['#/', 'Aktuelle Runde'], ['#/archiv', 'Alle Runden'], ['#/karte', 'Speisekarte'], ['#/zugaenge', 'Zugänge'], ['#/einstellungen', 'Einstellungen'],
];

function shell() {
  app.innerHTML = `
  <header class="adm-header"><div class="adm-header-inner">
    <div class="brand">🥙 Azubi-Portal<small>angemeldet als ${esc(me.displayName)}</small></div>
    <nav data-nav>${NAV.map(([h, t]) => `<a href="${h}">${t}</a>`).join('')}<a href="#/profil">Mein Profil</a></nav>
    <a class="btn btn-sm btn-outline-light" href="/" target="_blank" rel="noopener">Bestellseite ↗</a>
    <button type="button" class="btn-sm btn-outline-light" data-logout>Abmelden</button>
  </div></header>
  <main class="adm-main" data-view></main>`;
  $('[data-logout]').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST', body: {} });
    me = null;
    location.hash = '';
    boot();
  });
  window.onhashchange = route;
  route();
}

function view() { return $('[data-view]'); }

async function route() {
  clearInterval(refreshTimer);
  closePopups();
  current = null;
  const v = view();
  v.onclick = v.onchange = v.onkeydown = null;
  const hash = location.hash || '#/';
  $$('[data-nav] a').forEach((a) => {
    const h = a.getAttribute('href');
    a.classList.toggle('active', h === hash || (h === '#/archiv' && hash.startsWith('#/runde/')));
  });
  try {
    if (hash.startsWith('#/runde/')) return await roundView(Number(hash.split('/')[2]));
    if (hash === '#/archiv') return await archiveView();
    if (hash === '#/karte') return await menuView();
    if (hash === '#/zugaenge') return await usersView();
    if (hash === '#/einstellungen') return await settingsView();
    if (hash === '#/profil') return await profileView();
    return await currentView();
  } catch (err) {
    if (err.status === 401) return boot();
    view().innerHTML = `<div class="card"><h2>Fehler</h2><p>${esc(err.message)}</p></div>`;
  }
}

// ---------------- Aktuelle Runde ----------------
async function currentView() {
  const { rounds } = await api('/api/admin/rounds?limit=5');
  const open = rounds.find((r) => r.status === 'open');
  if (open) return roundView(open.id);
  const last = rounds[0];
  view().innerHTML = `
    <div class="card closed-card">
      <div class="big" aria-hidden="true">🥙</div>
      <h2>Gerade ist keine Bestellrunde offen</h2>
      <p class="muted">Erst wenn eine Runde offen ist, können die Kollegen auf der Bestellseite bestellen.</p>
      <button type="button" class="btn-primary" data-new-round>Jetzt neue Bestellung öffnen</button>
      ${last ? `<p class="small muted">Letzte Runde: <a href="#/runde/${last.id}">${esc(last.title)}</a> · ${when(last.openedAt)} · ${last.orderCount} Bestellungen</p>` : ''}
    </div>`;
  $('[data-new-round]').addEventListener('click', () => roundDialog());
}

async function roundDialog(round = null) {
  const users = await getUsers();
  const activeUsers = users.filter((u) => u.active || u.id === round?.collectorId);
  const collectorId = round?.collectorId ?? me.id;
  const defaultHandle = round ? round.paypalMe : users.find((u) => u.id === collectorId)?.paypalMe;
  const { form } = modal({
    title: round ? 'Runde bearbeiten' : 'Neue Bestellrunde öffnen',
    body: `
      <label for="r-title">Titel</label>
      <input id="r-title" name="title" type="text" maxlength="80" value="${esc(round?.title ?? `Dönerrunde ${new Date().toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit' })}`)}">
      <div class="field-row">
        <div><label for="r-deadline">Bestellschluss (optional)</label>
          <input id="r-deadline" name="deadline" type="datetime-local" value="${esc(toLocalInput(round?.deadline))}">
          <p class="hint">Danach schließt die Runde automatisch.</p></div>
        <div><label for="r-pickup">Abholung (optional)</label>
          <input id="r-pickup" name="pickupTime" type="text" maxlength="40" placeholder="z. B. 12:15 Uhr" value="${esc(round?.pickupTime ?? '')}"></div>
      </div>
      <div class="field-row">
        <div><label for="r-collector">Kasse (wer sammelt das Geld ein)</label>
          <select id="r-collector" name="collectorId">${activeUsers.map((u) => `<option value="${u.id}" ${u.id === collectorId ? 'selected' : ''}>${esc(u.displayName)}</option>`).join('')}</select></div>
        <div><label for="r-pp">PayPal.me-Name für diese Runde</label>
          <input id="r-pp" name="paypalMe" type="text" maxlength="64" placeholder="z. B. maxmuster" value="${esc(defaultHandle ?? '')}">
          <p class="hint">Nur für den PayPal.me-Modus. Wird beim Wechsel der Kasse aus deren Profil übernommen.</p></div>
      </div>
      <label for="r-code">Bestell-Code (optional)</label>
      <input id="r-code" name="accessCode" type="text" maxlength="32" placeholder="leer = jeder mit dem Link kann bestellen" value="${esc(round?.accessCode ?? '')}">
      <p class="hint">Sinnvoll, sobald die Seite aus dem Internet erreichbar ist.</p>`,
    foot: `<button type="button" class="btn-ghost" data-close>Abbrechen</button><button type="submit" class="btn-primary">${round ? 'Speichern' : 'Runde öffnen'}</button>`,
    onSubmit: async (f) => {
      const body = {
        title: f.title.value, deadline: fromLocalInput(f.deadline.value), pickupTime: f.pickupTime.value,
        collectorId: Number(f.collectorId.value), paypalMe: f.paypalMe.value, accessCode: f.accessCode.value,
      };
      const res = round
        ? await api(`/api/admin/rounds/${round.id}`, { method: 'PATCH', body })
        : await api('/api/admin/rounds', { method: 'POST', body });
      toast(round ? 'Gespeichert' : 'Bestellrunde ist offen – jetzt kann bestellt werden!');
      if (round) showRound(res);
      else if (location.hash === '#/' || !location.hash) route();
      else location.hash = '#/';
    },
  });
  form.collectorId.addEventListener('change', () => {
    const u = users.find((x) => x.id === Number(form.collectorId.value));
    form.paypalMe.value = u?.paypalMe ?? '';
  });
}

// ---------------- Runden-Detail ----------------
async function roundView(id) {
  const detail = await api(`/api/admin/rounds/${id}`);
  if (lastRoundId !== id) { roundTab = 'orders'; orderFilter = { q: '', status: 'all' }; }
  lastRoundId = id;
  showRound(detail);
  refreshTimer = setInterval(async () => {
    if ($('dialog[open]') || $('.menu-pop-list') || document.activeElement?.matches('textarea, input')) return;
    if (current?.round.status !== 'open') return;
    try { showRound(await api(`/api/admin/rounds/${id}`)); } catch { /* nächster Versuch */ }
  }, 15000);
}

function showRound(detail) {
  if (!detail.audit && current?.round.id === detail.round.id) detail.audit = current.audit;
  current = detail;
  const { round: r, totals } = detail;
  const isOpen = r.status === 'open';
  const orderUrl = `${location.origin}/`;
  const flags = [
    `eröffnet ${when(r.openedAt)}${r.openedBy ? ` von ${esc(r.openedBy)}` : ''}`,
    isOpen ? (r.deadline ? `Bestellschluss ${when(r.deadline)}` : 'kein Bestellschluss') : `geschlossen ${when(r.closedAt)}${r.closedBy ? ` von ${esc(r.closedBy)}` : ''}`,
    r.pickupTime ? `Abholung ${esc(r.pickupTime)}` : null,
    r.collector ? `Kasse: ${esc(r.collector)}${r.paypalMe ? ` (paypal.me/${esc(r.paypalMe)})` : ''}` : null,
    r.accessCode ? `Code: <strong>${esc(r.accessCode)}</strong>` : null,
  ].filter(Boolean);

  view().innerHTML = `
    <div class="page-head">
      <div>
        <h1>${esc(r.title)} ${isOpen ? '<span class="pill pill-ok pill-dot">offen</span>' : '<span class="pill pill-muted">geschlossen</span>'}</h1>
        <div class="meta">${flags.join(' · ')}</div>
      </div>
      <div class="btn-row">
        ${isOpen ? '<button type="button" class="btn-primary" data-act="close">Bestellung schließen</button>' : '<button type="button" data-act="reopen">Wieder öffnen</button>'}
        <button type="button" data-act="add">+ Bestellung nachtragen</button>
        <a class="btn" href="/admin/runden/${r.id}/druck" target="_blank" rel="noopener">Drucken / Export</a>
        <a class="btn" href="/admin/runden/${r.id}/export.csv">CSV</a>
        <span class="menu-pop"><button type="button" data-act="more" aria-haspopup="true" aria-label="Weitere Aktionen">⋯</button></span>
      </div>
    </div>
    ${isOpen ? `<div class="card small order-link">
      Bestell-Link für die Kollegen: <a href="${esc(orderUrl)}" target="_blank" rel="noopener">${esc(orderUrl)}</a>
      <button type="button" class="btn-sm" data-act="copylink">Link kopieren</button>
      ${detail.paymentMode === 'api' ? '<span class="pill pill-ok">PayPal Checkout aktiv</span>' : '<span class="pill pill-muted">PayPal.me-Modus: Zahlungen von Hand abhaken</span>'}
    </div>` : ''}
    <div class="kpis">
      <div class="kpi"><span>Bestellungen</span><strong>${totals.orders}</strong></div>
      <div class="kpi"><span>Warenwert</span><strong>${money(totals.subtotal)}</strong></div>
      <div class="kpi ok"><span>Bezahlt (${totals.paidCount})</span><strong>${money(totals.paid)}</strong></div>
      <div class="kpi ${totals.open ? 'warn' : ''}"><span>Offen</span><strong>${money(totals.open)}</strong></div>
      <div class="kpi"><span>TG Dönermann</span><strong>${money(totals.tipDoener)}</strong></div>
      <div class="kpi"><span>TG Azubis</span><strong>${money(totals.tipAzubis)}</strong></div>
    </div>
    <div class="tabs" role="tablist">
      ${[['orders', `Bestellungen (${detail.orders.length})`], ['kitchen', 'Für den Dönermann'], ['notes', 'Notizen'], ['audit', 'Verlauf']]
        .map(([k, t]) => `<button type="button" role="tab" data-tab="${k}" class="${roundTab === k ? 'active' : ''}" aria-selected="${roundTab === k}">${t}</button>`).join('')}
    </div>
    <div data-tab-body></div>`;
  renderTab();
}

function renderTab() {
  const body = $('[data-tab-body]');
  if (!body) return;
  if (roundTab === 'orders') body.innerHTML = ordersTable();
  if (roundTab === 'kitchen') body.innerHTML = kitchenTable();
  if (roundTab === 'notes') body.innerHTML = notesPanel();
  if (roundTab === 'audit') body.innerHTML = auditPanel();
  if (roundTab === 'orders') {
    const q = $('[data-filter-q]');
    if (q) q.value = orderFilter.q;
  }
}

function linesHtml(lines) {
  return `<ul class="line-list">${lines.map((l) => {
    const opts = [l.variant, ...l.options.map((o) => o.label)].filter(Boolean).join(', ');
    return `<li>${l.qty}× ${l.num ? `<span class="num-badge">${esc(l.num)}</span> ` : ''}${esc(l.name)}${l.custom ? ' <span class="pill pill-muted">frei</span>' : ''}
      ${opts || l.comment ? `<div class="o">${esc(opts)}${l.comment ? ` · „${esc(l.comment)}“` : ''}</div>` : ''}</li>`;
  }).join('')}</ul>`;
}

function filteredOrders() {
  const q = orderFilter.q.toLowerCase();
  return current.orders.filter((o) => {
    if (q && !`${o.id} ${o.customerName} ${o.notes ?? ''}`.toLowerCase().includes(q)) return false;
    if (orderFilter.status === 'claimed') return o.paymentStatus === 'open' && o.customerSaysPaid;
    return orderFilter.status === 'all' || o.paymentStatus === orderFilter.status;
  });
}

function ordersTable() {
  const list = filteredOrders();
  return `
  <div class="filters">
    <input type="search" data-filter-q placeholder="Name, Nr. oder Notiz suchen" aria-label="Bestellungen filtern">
    <select data-filter-status aria-label="Status filtern">
      ${[['all', 'Alle'], ['open', 'Offen'], ['claimed', 'Als bezahlt gemeldet'], ['paid', 'Bezahlt'], ['cancelled', 'Storniert']]
        .map(([v, t]) => `<option value="${v}" ${orderFilter.status === v ? 'selected' : ''}>${t}</option>`).join('')}
    </select>
    <span class="muted small">${list.length} von ${current.orders.length}</span>
  </div>
  ${list.length ? `<div class="table-wrap"><table class="data">
    <thead><tr><th>#</th><th>Name</th><th>Bestellung</th><th class="r">Betrag</th><th>Zahlung</th><th>Abgeholt</th><th>Notiz</th><th></th></tr></thead>
    <tbody>${list.map((o) => `
      <tr class="${o.paymentStatus === 'cancelled' ? 'cancelled' : ''}">
        <td class="nowrap">${o.id}<div class="muted small">${clock(o.createdAt)}</div></td>
        <td><strong>${esc(o.customerName)}</strong>${o.createdBy ? `<div class="muted small">nachgetragen von ${esc(o.createdBy)}</div>` : ''}</td>
        <td>${linesHtml(o.lines)}</td>
        <td class="r money">${money(o.total)}${o.tip ? `<div class="muted small">inkl. ${money(o.tip)} TG ${o.tipRecipient === 'doener' ? 'Döner' : 'Azubis'}</div>` : ''}</td>
        <td>${STATUS[o.paymentStatus]}
          <div class="muted small">${esc(METHOD[o.paymentMethod] || '')}${o.paidAt && o.paymentStatus === 'paid' ? ` · ${clock(o.paidAt)}` : ''}${o.paidMarkedBy ? ` · ${esc(o.paidMarkedBy)}` : ''}</div>
          ${o.paymentStatus === 'open' && o.customerSaysPaid ? '<div class="pill pill-warn">meldet: bezahlt</div>' : ''}
          ${o.paymentStatus === 'open' ? `<button type="button" class="btn-sm" data-order="${o.id}" data-oact="paid">✓ bezahlt</button>` : ''}</td>
        <td><label class="inline"><input type="checkbox" data-order="${o.id}" data-oact="pickup" ${o.pickedUp ? 'checked' : ''}> <span class="small">abgeholt</span></label></td>
        <td class="note-cell">${o.notes ? esc(o.notes) : ''}<div><button type="button" class="btn-ghost btn-sm" data-order="${o.id}" data-oact="note">${o.notes ? 'Notiz ändern' : '+ Notiz'}</button></div></td>
        <td><span class="menu-pop"><button type="button" class="btn-sm" data-order="${o.id}" data-oact="menu" aria-haspopup="true" aria-label="Aktionen für Bestellung ${o.id}">⋯</button></span></td>
      </tr>`).join('')}</tbody>
  </table></div>` : `<div class="card empty">${current.orders.length ? 'Keine Bestellung passt zum Filter.' : 'Noch keine Bestellungen in dieser Runde.'}</div>`}`;
}

function kitchenTable() {
  const agg = current.aggregate;
  const count = agg.reduce((s, a) => s + a.qty, 0);
  if (!agg.length) return '<div class="card empty">Noch nichts zu bestellen.</div>';
  return `<p class="muted small">So viel muss beim Dönermann bestellt werden (${count} Artikel, stornierte Bestellungen nicht enthalten).</p>
  <div class="table-wrap"><table class="data">
    <thead><tr><th>Anz.</th><th>Nr.</th><th>Artikel</th><th>Für</th><th class="r">Summe</th></tr></thead>
    <tbody>${agg.map((a) => `<tr>
      <td><strong>${a.qty}×</strong></td><td>${esc(a.num || '')}</td>
      <td><strong>${esc(a.name)}</strong>${a.variant ? ` · ${esc(a.variant)}` : ''}${a.options ? `<div class="muted small">${esc(a.options)}</div>` : ''}${a.comment ? `<div class="muted small">„${esc(a.comment)}“</div>` : ''}</td>
      <td class="small">${esc(a.who.join(', '))}</td><td class="r money">${money(a.total)}</td></tr>`).join('')}</tbody>
    <tfoot><tr><td colspan="4"><strong>An den Dönermann (Warenwert + Trinkgeld Dönermann)</strong></td>
      <td class="r money"><strong>${money(current.totals.subtotal + current.totals.tipDoener)}</strong></td></tr></tfoot>
  </table></div>`;
}

function notesPanel() {
  return `<div class="card">
    <label for="round-notes">Notizen zur Runde</label>
    <textarea id="round-notes" data-round-notes rows="6" placeholder="z. B. Dönermann hat 2 € Rabatt gegeben, Ayran war aus …">${esc(current.round.notes ?? '')}</textarea>
    <div class="btn-row"><button type="button" class="btn-primary" data-act="savenotes">Notizen speichern</button></div>
  </div>`;
}

function auditPanel() {
  const log = current.audit || [];
  if (!log.length) return '<div class="card empty">Noch keine Einträge.</div>';
  return `<div class="card"><ul class="audit-list">${log.map((a) => `
    <li><span class="muted small">${when(a.at)}</span><span>${esc(AUDIT[a.action] || a.action)}${a.order_id ? ` #${a.order_id}` : ''}
      ${a.detail ? ` – ${esc(a.detail)}` : ''} <span class="muted small">${a.user ? `(${esc(a.user)})` : ''}</span></span></li>`).join('')}</ul></div>`;
}

async function patchOrder(id, body, msg) {
  const res = await api(`/api/admin/orders/${id}`, { method: 'PATCH', body });
  showRound(res);
  if (msg) toast(msg);
}

function orderMenu(btn, o) {
  closePopups();
  const items = [];
  if (o.paymentStatus !== 'paid') {
    items.push(['paid-pp', `Bezahlt per ${o.paymentMethod === 'paypal_api' ? 'PayPal' : 'PayPal.me'}`], ['paid-cash', 'Bar bezahlt']);
  }
  if (o.paymentStatus !== 'open') items.push(['reopen', 'Auf „offen“ setzen']);
  if (o.paypalOrderId && o.paymentStatus === 'open') items.push(['ppcheck', 'PayPal-Zahlung prüfen']);
  items.push(['hr'], ['edit', 'Bearbeiten'], ['link', 'Link zur Bestellseite kopieren']);
  if (o.paymentStatus !== 'cancelled') items.push(['cancel', 'Stornieren']);
  items.push(['delete', 'Endgültig löschen']);
  const pop = document.createElement('div');
  pop.className = 'menu-pop-list';
  pop.innerHTML = items.map(([k, t]) => (k === 'hr' ? '<hr>' : `<button type="button" data-pop="${k}" class="${k === 'delete' ? 'btn-danger' : ''}">${t}</button>`)).join('');
  btn.parentElement.append(pop);
  pop.querySelector('button')?.focus();
  pop.addEventListener('click', async (e) => {
    const k = e.target.closest('[data-pop]')?.dataset.pop;
    if (!k) return;
    closePopups();
    try {
      if (k === 'paid-pp') await patchOrder(o.id, { paymentStatus: 'paid', paymentMethod: o.paymentMethod === 'paypal_api' ? 'paypal_api' : 'paypal_me' }, 'Als bezahlt markiert');
      if (k === 'paid-cash') await patchOrder(o.id, { paymentStatus: 'paid', paymentMethod: 'cash' }, 'Als bar bezahlt markiert');
      if (k === 'reopen') await patchOrder(o.id, { paymentStatus: 'open' }, 'Wieder offen');
      if (k === 'cancel' && confirm(`Bestellung #${o.id} von ${o.customerName} stornieren?`)) await patchOrder(o.id, { paymentStatus: 'cancelled' }, 'Storniert');
      if (k === 'delete' && confirm(`Bestellung #${o.id} von ${o.customerName} endgültig löschen? Das lässt sich nicht rückgängig machen.`)) {
        showRound(await api(`/api/admin/orders/${o.id}`, { method: 'DELETE' }));
        toast('Gelöscht');
      }
      if (k === 'ppcheck') {
        const res = await api(`/api/admin/orders/${o.id}/paypal-check`, { method: 'POST', body: {} });
        showRound(res);
        toast(res.paid ? 'Zahlung ist da und wurde verbucht.' : `PayPal-Status: ${res.paypalStatus}`);
      }
      if (k === 'edit') orderEditor(o);
      if (k === 'link') {
        await navigator.clipboard.writeText(`${location.origin}/bestellung/${o.token}`);
        toast('Link kopiert – z. B. an den Besteller schicken.');
      }
    } catch (err) {
      toast(err.message, { error: true });
    }
  });
}

function noteDialog(o) {
  modal({
    title: `Notiz zu #${o.id} · ${esc(o.customerName)}`,
    body: `<textarea name="notes" rows="5" maxlength="2000" aria-label="Notiz">${esc(o.notes ?? '')}</textarea>`,
    onSubmit: async (f) => patchOrder(o.id, { notes: f.notes.value }, 'Notiz gespeichert'),
  });
}

// Klicks im Runden-Detail
document.addEventListener('click', async (e) => {
  if (!current || !e.target.closest('[data-view]')) return;
  const tab = e.target.closest('[data-tab]');
  if (tab) { roundTab = tab.dataset.tab; showRound(current); return; }
  const act = e.target.closest('[data-act]')?.dataset.act;
  const oBtn = e.target.closest('[data-oact]');
  try {
    if (act === 'close') {
      if (!confirm('Bestellrunde schließen? Danach kann niemand mehr bestellen (nachtragen geht weiter).')) return;
      showRound(await api(`/api/admin/rounds/${current.round.id}`, { method: 'PATCH', body: { status: 'closed' } }));
      toast('Runde geschlossen');
    } else if (act === 'reopen') {
      showRound(await api(`/api/admin/rounds/${current.round.id}`, { method: 'PATCH', body: { status: 'open' } }));
      toast('Runde wieder offen');
    } else if (act === 'add') {
      orderEditor(null);
    } else if (act === 'copylink') {
      await navigator.clipboard.writeText(`${location.origin}/`);
      toast('Link kopiert');
    } else if (act === 'savenotes') {
      showRound(await api(`/api/admin/rounds/${current.round.id}`, { method: 'PATCH', body: { notes: $('[data-round-notes]').value } }));
      toast('Notizen gespeichert');
    } else if (act === 'more') {
      closePopups();
      const pop = document.createElement('div');
      pop.className = 'menu-pop-list';
      pop.innerHTML = '<button type="button" data-more="edit">Runde bearbeiten</button><button type="button" data-more="refresh">Aktualisieren</button><hr><button type="button" class="btn-danger" data-more="delete">Runde löschen</button>';
      e.target.closest('.menu-pop').append(pop);
      pop.addEventListener('click', async (ev) => {
        const k = ev.target.closest('[data-more]')?.dataset.more;
        closePopups();
        try {
          if (k === 'edit') roundDialog(current.round);
          if (k === 'refresh') showRound(await api(`/api/admin/rounds/${current.round.id}`));
          if (k === 'delete' && confirm(`Runde „${current.round.title}“ mit allen ${current.orders.length} Bestellungen endgültig löschen?`)) {
            await api(`/api/admin/rounds/${current.round.id}`, { method: 'DELETE' });
            current = null;
            toast('Runde gelöscht');
            location.hash = '#/archiv';
          }
        } catch (err) { toast(err.message, { error: true }); }
      });
    } else if (oBtn) {
      const o = current.orders.find((x) => x.id === Number(oBtn.dataset.order));
      if (!o) return;
      const k = oBtn.dataset.oact;
      if (k === 'paid') await patchOrder(o.id, { paymentStatus: 'paid', paymentMethod: o.paymentMethod === 'paypal_api' ? 'paypal_api' : 'paypal_me' }, `#${o.id} bezahlt`);
      if (k === 'pickup') await patchOrder(o.id, { pickedUp: oBtn.checked });
      if (k === 'note') noteDialog(o);
      if (k === 'menu') orderMenu(oBtn, o);
    }
  } catch (err) {
    toast(err.message, { error: true });
  }
});

document.addEventListener('input', (e) => {
  if (e.target.matches('[data-filter-q]')) {
    orderFilter.q = e.target.value;
    const pos = e.target.selectionStart;
    renderTab();
    const q = $('[data-filter-q]');
    q.focus();
    q.setSelectionRange(pos, pos);
  }
});
document.addEventListener('change', (e) => {
  if (e.target.matches('[data-filter-status]')) { orderFilter.status = e.target.value; renderTab(); }
});

// ---------------- Bestellung nachtragen / bearbeiten ----------------
function toRawLine(l, menu) {
  const item = l.itemId && menu.items.find((i) => i.id === l.itemId);
  if (!l.custom && item && l.selection) {
    return { itemId: l.itemId, variant: l.selection.variant, options: l.selection.options, qty: l.qty, comment: l.comment };
  }
  // Artikel gibt es nicht mehr → als freie Position mit altem Preis übernehmen
  const opts = [l.variant, ...l.options.map((o) => o.label)].filter(Boolean).join(', ');
  return { custom: true, name: `${l.num ? l.num + ' ' : ''}${l.name}${opts && !l.custom ? ` (${opts})` : ''}`.slice(0, 120), unitPrice: l.unitPrice, qty: l.qty, comment: l.comment };
}

async function orderEditor(order) {
  const menu = await getMenu(true);
  const byId = new Map(menu.items.map((i) => [i.id, i]));
  const lines = order ? order.lines.map((l) => toRawLine(l, menu)) : [];
  const describe = (l) => {
    if (l.custom) return { name: l.name, num: null, opts: '', unit: l.unitPrice, total: l.unitPrice * l.qty };
    const d = describeSelection(byId.get(l.itemId), menu.groups, l);
    return { name: d.name, num: d.num, opts: [d.variantLabel, ...d.optionLabels].filter(Boolean).join(', '), unit: d.unit, total: d.total };
  };

  const { dlg, form } = modal({
    wide: true,
    title: order ? `Bestellung #${order.id} bearbeiten` : `Bestellung nachtragen · ${esc(current.round.title)}`,
    body: `
    <div class="editor">
      <div>
        <label for="ed-search">Artikel hinzufügen</label>
        <input id="ed-search" type="search" data-ed-search placeholder="Nummer oder Name">
        <div class="picker-list" data-picker></div>
        <details class="card small">
          <summary>Freie Position (nicht auf der Karte)</summary>
          <div class="line-row">
            <input type="text" data-free-name placeholder="Bezeichnung" maxlength="120" aria-label="Bezeichnung">
            <input type="text" data-free-price inputmode="decimal" placeholder="Preis €" aria-label="Preis in Euro">
            <button type="button" data-free-add>Hinzufügen</button>
          </div>
        </details>
      </div>
      <div>
        <label for="ed-name">Name</label>
        <input id="ed-name" name="customer" type="text" maxlength="60" required value="${esc(order?.customerName ?? '')}">
        <label>Positionen</label>
        <ul class="editor-lines" data-ed-lines></ul>
        <div class="field-row">
          <div><label for="ed-tip">Trinkgeld (€)</label><input id="ed-tip" name="tip" type="text" inputmode="decimal" value="${esc(euroInput(order?.tip ?? 0))}"></div>
          <div><label for="ed-tipr">Trinkgeld für</label>
            <select id="ed-tipr" name="tipRecipient">
              <option value="doener" ${order?.tipRecipient !== 'azubis' ? 'selected' : ''}>Dönermann</option>
              <option value="azubis" ${order?.tipRecipient === 'azubis' ? 'selected' : ''}>Azubis</option>
            </select></div>
        </div>
        ${order ? '' : `<div class="field-row">
          <div><label for="ed-status">Zahlung</label>
            <select id="ed-status" name="paymentStatus"><option value="open">offen</option><option value="paid">schon bezahlt</option></select></div>
          <div><label for="ed-method">Zahlart</label>
            <select id="ed-method" name="paymentMethod"><option value="paypal_me">PayPal.me</option><option value="cash">Bar</option><option value="other">Sonstiges</option></select></div>
        </div>`}
        <label for="ed-notes">Notiz</label>
        <textarea id="ed-notes" name="notes" rows="2" maxlength="2000">${esc(order?.notes ?? '')}</textarea>
        <div class="sum-row total"><span>Gesamt</span><span class="money" data-ed-total></span></div>
        ${order?.paymentStatus === 'paid' ? '<p class="hint">Achtung: Die Bestellung ist schon bezahlt. Ändert sich der Betrag, bitte die Differenz in der Notiz festhalten.</p>' : ''}
      </div>
    </div>`,
    onSubmit: async (f) => {
      if (!lines.length) throw new Error('Mindestens eine Position hinzufügen.');
      const tip = parseEuro(f.tip.value) ?? 0;
      if (!Number.isFinite(tip)) throw new Error('Trinkgeld ist ungültig.');
      const body = { lines, tip, tipRecipient: tip ? f.tipRecipient.value : null, notes: f.notes.value };
      if (order) {
        body.customerName = f.customer.value;
        showRound(await api(`/api/admin/orders/${order.id}`, { method: 'PATCH', body }));
        toast('Bestellung gespeichert');
      } else {
        Object.assign(body, { name: f.customer.value, paymentStatus: f.paymentStatus.value, paymentMethod: f.paymentMethod.value });
        showRound(await api(`/api/admin/rounds/${current.round.id}/orders`, { method: 'POST', body }));
        toast('Bestellung nachgetragen');
      }
    },
  });

  const renderPicker = (q = '') => {
    const ql = q.toLowerCase();
    const list = menu.items.filter((i) => !ql || `${i.num ?? ''} ${i.name}`.toLowerCase().includes(ql)).slice(0, 80);
    $('[data-picker]', dlg).innerHTML = list.map((i) => `<button type="button" data-pick="${i.id}" ${i.variants.every((v) => v.price === null) ? 'disabled' : ''}>
      ${i.num ? `<span class="num-badge">${esc(i.num)}</span>` : ''}<span>${esc(i.name)}${i.active ? '' : ' <span class="pill pill-muted">inaktiv</span>'}</span>
      <span class="price">${priceFrom(i)}</span></button>`).join('') || '<p class="empty">Nichts gefunden</p>';
  };
  const renderLines = () => {
    const ds = lines.map(describe);
    $('[data-ed-lines]', dlg).innerHTML = ds.length ? ds.map((d, i) => `<li>
      <span><strong>${lines[i].qty}×</strong> ${d.num ? `<span class="num-badge">${esc(d.num)}</span> ` : ''}${esc(d.name)}
        ${d.opts || lines[i].comment ? `<div class="muted small">${esc(d.opts)}${lines[i].comment ? ` · „${esc(lines[i].comment)}“` : ''}</div>` : ''}</span>
      <span class="money">${money(d.total)}</span>
      <span class="btn-row">
        <span class="stepper"><button type="button" data-ldec="${i}" aria-label="Weniger">−</button><output>${lines[i].qty}</output><button type="button" data-linc="${i}" aria-label="Mehr">+</button></span>
        ${lines[i].custom ? '' : `<button type="button" class="btn-ghost btn-sm" data-ledit="${i}">Ändern</button>`}
        <button type="button" class="btn-ghost btn-sm btn-danger" data-ldel="${i}">Entfernen</button>
      </span></li>`).join('') : '<li class="muted">Noch keine Positionen – links auswählen.</li>';
    const tip = parseEuro(form.tip.value);
    $('[data-ed-total]', dlg).textContent = money(ds.reduce((s, d) => s + d.total, 0) + (Number.isFinite(tip) && tip ? tip : 0));
  };

  dlg.addEventListener('input', (e) => {
    if (e.target.matches('[data-ed-search]')) renderPicker(e.target.value);
    if (e.target.name === 'tip') renderLines();
  });
  dlg.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.pick) {
      const item = byId.get(Number(b.dataset.pick));
      const sel = await openItemDialog(item, menu.groups);
      if (sel) { lines.push(sel); renderLines(); }
    } else if (b.dataset.ledit !== undefined) {
      const i = Number(b.dataset.ledit);
      const sel = await openItemDialog(byId.get(lines[i].itemId), menu.groups, lines[i]);
      if (sel) { lines[i] = sel; renderLines(); }
    } else if (b.dataset.linc !== undefined) {
      const l = lines[Number(b.dataset.linc)];
      l.qty = Math.min(20, l.qty + 1);
      renderLines();
    } else if (b.dataset.ldec !== undefined) {
      const i = Number(b.dataset.ldec);
      if (lines[i].qty > 1) lines[i].qty -= 1; else lines.splice(i, 1);
      renderLines();
    } else if (b.dataset.ldel !== undefined) {
      lines.splice(Number(b.dataset.ldel), 1);
      renderLines();
    } else if (b.matches('[data-free-add]')) {
      const name = $('[data-free-name]', dlg).value.trim();
      const price = parseEuro($('[data-free-price]', dlg).value);
      if (!name || !Number.isFinite(price) || price === null || price < 0) return toast('Bezeichnung und Preis angeben', { error: true });
      lines.push({ custom: true, name, unitPrice: price, qty: 1, comment: '' });
      $('[data-free-name]', dlg).value = '';
      $('[data-free-price]', dlg).value = '';
      renderLines();
    }
  });
  renderPicker();
  renderLines();
  form.customer.focus();
}

// ---------------- Archiv ----------------
async function archiveView() {
  const { rounds } = await api('/api/admin/rounds?limit=500');
  view().innerHTML = `
    <div class="page-head"><div><h1>Alle Bestellrunden</h1><div class="meta">${rounds.length} Runden</div></div>
      <div class="btn-row"><button type="button" class="btn-primary" data-new-round ${rounds.some((r) => r.status === 'open') ? 'disabled title="Es ist schon eine Runde offen"' : ''}>Neue Bestellrunde öffnen</button></div></div>
    ${rounds.length ? `<div class="table-wrap"><table class="data">
      <thead><tr><th>Datum</th><th>Titel</th><th>Status</th><th>Kasse</th><th class="r">Bestellungen</th><th class="r">Summe</th><th class="r">Bezahlt</th></tr></thead>
      <tbody>${rounds.map((r) => `<tr class="clickable" data-open-round="${r.id}" tabindex="0">
        <td class="nowrap">${when(r.openedAt, { dateStyle: 'medium' })}<div class="muted small">${clock(r.openedAt)}</div></td>
        <td><a href="#/runde/${r.id}">${esc(r.title)}</a></td>
        <td>${r.status === 'open' ? '<span class="pill pill-ok pill-dot">offen</span>' : '<span class="pill pill-muted">geschlossen</span>'}</td>
        <td>${esc(r.collector || '')}</td>
        <td class="r">${r.orderCount}</td><td class="r money">${money(r.sumTotal)}</td>
        <td class="r money">${r.sumPaid < r.sumTotal ? `<span class="pill pill-warn">${money(r.sumPaid)}</span>` : money(r.sumPaid)}</td>
      </tr>`).join('')}</tbody></table></div>` : '<div class="card empty">Noch keine Runden.</div>'}`;
  $('[data-new-round]').addEventListener('click', () => roundDialog());
  view().onclick = (e) => {
    const row = e.target.closest('[data-open-round]');
    if (row && !e.target.closest('a')) location.hash = `#/runde/${row.dataset.openRound}`;
  };
  view().onkeydown = (e) => {
    const row = e.target.closest('[data-open-round]');
    if (row && e.key === 'Enter') location.hash = `#/runde/${row.dataset.openRound}`;
  };
}

// ---------------- Speisekarte ----------------
async function menuView() {
  const menu = await getMenu(true);
  const missing = menu.items.filter((i) => i.variants.some((v) => v.price === null)).length;
  view().innerHTML = `
    <div class="page-head"><div><h1>Speisekarte</h1>
      <div class="meta">${menu.items.length} Artikel · ${menu.items.filter((i) => i.active).length} bestellbar${missing ? ` · <strong>${missing} ohne Preis</strong> (inaktiv)` : ''}</div></div>
      <div class="btn-row"><button type="button" class="btn-primary" data-item-new>+ Artikel</button></div></div>
    <p class="muted small">Preisänderungen gelten nur für neue Bestellungen – alte Bestellungen behalten ihre Preise.</p>
    ${menu.categories.map((c) => {
      const items = menu.items.filter((i) => i.categoryId === c.id);
      return `<section class="menu-admin-cat"><h2>${esc(c.name)} <span class="muted small">${items.length}</span></h2>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Nr.</th><th>Artikel</th><th>Preise</th><th>Optionen</th><th>Bestellbar</th><th></th></tr></thead>
        <tbody>${items.map((i) => `<tr>
          <td>${esc(i.num || '')}</td>
          <td><strong>${esc(i.name)}</strong>${i.description ? `<div class="muted small">${esc(i.description)}</div>` : ''}</td>
          <td class="small">${i.variants.map((v) => `${v.label ? `${esc(v.label)}: ` : ''}${v.price === null ? '<span class="pill pill-warn">fehlt</span>' : money(v.price)}`).join('<br>')}</td>
          <td class="small">${i.groups.map((g) => esc(menu.groups[g]?.name || g)).join(', ')}</td>
          <td><label class="inline"><input type="checkbox" data-item-active="${i.id}" ${i.active ? 'checked' : ''}> <span class="small">${i.active ? 'ja' : 'nein'}</span></label></td>
          <td><button type="button" class="btn-sm" data-item-edit="${i.id}">Bearbeiten</button></td>
        </tr>`).join('')}</tbody></table></div></section>`;
    }).join('')}
    <section class="menu-admin-cat"><h2>Auswahl-Gruppen</h2>
      <p class="muted small">Fleisch, Saucen, Extras usw. – werden den Artikeln über „Bearbeiten“ zugeordnet.</p>
      <div class="table-wrap"><table class="data"><thead><tr><th>Gruppe</th><th>Art</th><th>Auswahl</th><th></th></tr></thead>
      <tbody>${Object.values(menu.groups).map((g) => `<tr>
        <td><strong>${esc(g.name)}</strong> <span class="muted small">${esc(g.id)}</span></td>
        <td class="small">${g.type === 'single' ? 'eine' : 'mehrere'}${g.required ? ', Pflicht' : ''}</td>
        <td class="small">${g.choices.map((c) => `${esc(c.label)}${c.price ? ` (+${money(c.price)})` : ''}`).join(', ')}</td>
        <td><button type="button" class="btn-sm" data-group-edit="${esc(g.id)}">Bearbeiten</button></td></tr>`).join('')}</tbody></table></div>
    </section>`;

  view().onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.matches('[data-item-new]')) itemEditor(menu, null);
    if (b.dataset.itemEdit) itemEditor(menu, menu.items.find((i) => i.id === Number(b.dataset.itemEdit)));
    if (b.dataset.groupEdit) groupEditor(menu.groups[b.dataset.groupEdit]);
  };
  view().onchange = async (e) => {
    const id = e.target.dataset.itemActive;
    if (!id) return;
    const item = menu.items.find((i) => i.id === Number(id));
    try {
      menuCache = (await api(`/api/admin/menu/items/${id}`, { method: 'PUT', body: { ...item, active: e.target.checked } })).menu;
      toast(`${item.name}: ${e.target.checked ? 'bestellbar' : 'ausgeblendet'}`);
      menuView();
    } catch (err) {
      e.target.checked = !e.target.checked;
      toast(err.message, { error: true });
    }
  };
}

function rowsEditor(rows, { labelPh, pricePh }) {
  return rows.map((r, i) => `<div class="variant-row" data-row="${i}">
    <input type="text" data-r-label value="${esc(r.label)}" placeholder="${labelPh}" maxlength="60" aria-label="Bezeichnung">
    <input type="text" data-r-price inputmode="decimal" value="${esc(euroInput(r.price))}" placeholder="${pricePh}" aria-label="Preis in Euro">
    <button type="button" class="btn-ghost btn-sm btn-danger" data-r-del="${i}" aria-label="Zeile entfernen">✕</button>
  </div>`).join('');
}
function readRows(root) {
  return $$('[data-row]', root).map((row) => {
    const price = parseEuro($('[data-r-price]', row).value);
    if (Number.isNaN(price)) throw new Error('Ein Preis ist ungültig.');
    return { label: $('[data-r-label]', row).value.trim(), price };
  });
}

function itemEditor(menu, item) {
  let variants = item ? item.variants.map((v) => ({ ...v })) : [{ label: '', price: null }];
  const { dlg } = modal({
    title: item ? 'Artikel bearbeiten' : 'Neuer Artikel',
    body: `
      <div class="field-row">
        <div><label for="it-cat">Kategorie</label><select id="it-cat" name="categoryId">${menu.categories.map((c) => `<option value="${esc(c.id)}" ${c.id === item?.categoryId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
        <div><label for="it-num">Nr. auf der Karte</label><input id="it-num" name="num" type="text" maxlength="8" value="${esc(item?.num ?? '')}"></div>
      </div>
      <label for="it-name">Name</label><input id="it-name" name="name" type="text" maxlength="120" required value="${esc(item?.name ?? '')}">
      <label for="it-desc">Beschreibung</label><input id="it-desc" name="description" type="text" maxlength="300" value="${esc(item?.description ?? '')}">
      <label>Größen / Preise</label>
      <p class="hint">Eine Zeile ohne Bezeichnung = ein Preis. Mehrere Zeilen = Auswahl (z. B. 24 cm / 30 cm).</p>
      <div data-variants></div>
      <button type="button" class="btn-sm" data-variant-add>+ Größe</button>
      <label>Auswahl-Gruppen</label>
      <div class="check-grid">${Object.values(menu.groups).map((g) => `<label><input type="checkbox" name="groups" value="${esc(g.id)}" ${item?.groups.includes(g.id) ? 'checked' : ''}> ${esc(g.name)} <span class="muted small">(${esc(g.id)})</span></label>`).join('')}</div>
      <label class="inline"><input type="checkbox" name="active" ${item?.active ?? true ? 'checked' : ''}> Bestellbar</label>`,
    foot: `${item ? '<button type="button" class="btn-ghost btn-danger" data-item-del>Löschen</button>' : ''}<button type="button" class="btn-ghost" data-close>Abbrechen</button><button type="submit" class="btn-primary">Speichern</button>`,
    onSubmit: async (f) => {
      const body = {
        categoryId: f.categoryId.value, num: f.num.value, name: f.name.value, description: f.description.value,
        variants: readRows($('[data-variants]', dlg)), groups: $$('input[name=groups]:checked', f).map((x) => x.value), active: f.active.checked,
      };
      const res = item
        ? await api(`/api/admin/menu/items/${item.id}`, { method: 'PUT', body })
        : await api('/api/admin/menu/items', { method: 'POST', body });
      menuCache = res.menu;
      toast('Gespeichert');
      menuView();
    },
  });
  const draw = () => { $('[data-variants]', dlg).innerHTML = rowsEditor(variants, { labelPh: 'z. B. 30 cm (optional)', pricePh: 'Preis €' }); };
  dlg.addEventListener('click', async (e) => {
    if (e.target.closest('[data-variant-add]')) {
      variants = readRowsLoose(dlg);
      variants.push({ label: '', price: null });
      draw();
    }
    const del = e.target.closest('[data-r-del]');
    if (del) {
      variants = readRowsLoose(dlg);
      if (variants.length > 1) variants.splice(Number(del.dataset.rDel), 1);
      draw();
    }
    if (e.target.closest('[data-item-del]') && confirm(`„${item.name}“ wirklich löschen? Alte Bestellungen bleiben erhalten.`)) {
      try {
        menuCache = (await api(`/api/admin/menu/items/${item.id}`, { method: 'DELETE' })).menu;
        dlg.close();
        toast('Gelöscht');
        menuView();
      } catch (err) { toast(err.message, { error: true }); }
    }
  });
  draw();
}

function readRowsLoose(root) {
  return $$('[data-row]', root).map((row) => {
    const price = parseEuro($('[data-r-price]', row).value);
    return { label: $('[data-r-label]', row).value, price: Number.isFinite(price) ? price : null };
  });
}

function groupEditor(group) {
  let choices = group.choices.map((c) => ({ ...c }));
  const { dlg } = modal({
    title: `Auswahl-Gruppe „${esc(group.name)}“`,
    body: `
      <label for="gr-name">Überschrift im Bestell-Dialog</label><input id="gr-name" name="name" type="text" maxlength="60" value="${esc(group.name)}">
      <div class="field-row">
        <div><label for="gr-type">Auswahl</label><select id="gr-type" name="type">
          <option value="single" ${group.type === 'single' ? 'selected' : ''}>genau eine</option>
          <option value="multi" ${group.type === 'multi' ? 'selected' : ''}>mehrere möglich</option></select></div>
        <div><label>&nbsp;</label><label class="inline"><input type="checkbox" name="required" ${group.required ? 'checked' : ''}> Pflichtauswahl</label></div>
      </div>
      <label>Möglichkeiten (Aufpreis optional)</label>
      <div data-variants></div>
      <button type="button" class="btn-sm" data-variant-add>+ Möglichkeit</button>`,
    onSubmit: async (f) => {
      const rows = readRows($('[data-variants]', dlg)).filter((r) => r.label).map((r) => ({ label: r.label, price: r.price ?? 0 }));
      menuCache = (await api(`/api/admin/menu/groups/${encodeURIComponent(group.id)}`, {
        method: 'PUT', body: { name: f.name.value, type: f.type.value, required: f.required.checked, choices: rows },
      })).menu;
      toast('Gespeichert');
      menuView();
    },
  });
  const draw = () => { $('[data-variants]', dlg).innerHTML = rowsEditor(choices, { labelPh: 'Bezeichnung', pricePh: 'Aufpreis €' }); };
  dlg.addEventListener('click', (e) => {
    if (e.target.closest('[data-variant-add]')) { choices = readRowsLoose(dlg); choices.push({ label: '', price: 0 }); draw(); }
    const del = e.target.closest('[data-r-del]');
    if (del) { choices = readRowsLoose(dlg); choices.splice(Number(del.dataset.rDel), 1); draw(); }
  });
  draw();
}

// ---------------- Zugänge ----------------
async function usersView() {
  const users = await getUsers(true);
  view().innerHTML = `
    <div class="page-head"><div><h1>Zugänge</h1><div class="meta">Jeder Azubi bekommt einen eigenen Login. Alle Zugänge haben die gleichen Rechte.</div></div>
      <div class="btn-row"><button type="button" class="btn-primary" data-user-new>+ Zugang anlegen</button></div></div>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>Name</th><th>Benutzername</th><th>PayPal.me</th><th>Status</th><th>Angelegt</th><th></th></tr></thead>
      <tbody>${users.map((u) => `<tr>
        <td><strong>${esc(u.displayName)}</strong>${u.id === me.id ? ' <span class="pill pill-muted">du</span>' : ''}</td>
        <td>${esc(u.username)}</td><td>${u.paypalMe ? esc(u.paypalMe) : '<span class="muted">–</span>'}</td>
        <td>${u.active ? '<span class="pill pill-ok">aktiv</span>' : '<span class="pill pill-muted">deaktiviert</span>'}</td>
        <td class="small">${when(u.createdAt, { dateStyle: 'medium' })}</td>
        <td><button type="button" class="btn-sm" data-user-edit="${u.id}">Bearbeiten</button></td></tr>`).join('')}</tbody>
    </table></div>`;
  view().onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.matches('[data-user-new]')) userDialog(null);
    if (b.dataset.userEdit) userDialog(users.find((u) => u.id === Number(b.dataset.userEdit)));
  };
}

function userDialog(user) {
  modal({
    title: user ? `Zugang „${esc(user.username)}“` : 'Neuer Zugang',
    body: `
      ${user ? '' : '<label for="u-user">Benutzername</label><input id="u-user" name="username" type="text" maxlength="32" autocomplete="off" required>'}
      <label for="u-name">Anzeigename</label><input id="u-name" name="displayName" type="text" maxlength="60" value="${esc(user?.displayName ?? '')}">
      <label for="u-pp">PayPal.me-Name</label><input id="u-pp" name="paypalMe" type="text" maxlength="64" placeholder="z. B. maxmuster" value="${esc(user?.paypalMe ?? '')}">
      <p class="hint">Wird vorgeschlagen, wenn diese Person bei einer Runde die Kasse übernimmt.</p>
      <label for="u-pw">${user ? 'Neues Passwort (leer lassen = unverändert)' : 'Passwort (min. 8 Zeichen)'}</label>
      <input id="u-pw" name="password" type="password" autocomplete="new-password">
      ${user && user.id !== me.id ? `<label class="inline"><input type="checkbox" name="active" ${user.active ? 'checked' : ''}> Zugang aktiv</label>` : ''}`,
    onSubmit: async (f) => {
      if (user) {
        const body = { displayName: f.displayName.value, paypalMe: f.paypalMe.value };
        if (f.password.value) body.password = f.password.value;
        if (f.active) body.active = f.active.checked;
        await api(`/api/admin/users/${user.id}`, { method: 'PATCH', body });
      } else {
        await api('/api/admin/users', { method: 'POST', body: { username: f.username.value, displayName: f.displayName.value, paypalMe: f.paypalMe.value, password: f.password.value } });
      }
      toast('Gespeichert');
      usersCache = null;
      usersView();
    },
  });
}

// ---------------- Einstellungen ----------------
async function settingsView() {
  const { settings: s } = await api('/api/admin/settings');
  view().innerHTML = `
    <div class="page-head"><div><h1>Einstellungen</h1></div></div>
    <form class="card" data-settings>
      <label for="s-shop">Name der Dönerbude</label><input id="s-shop" name="shopName" type="text" maxlength="60" value="${esc(s.shopName)}">
      <label>Bezahlung</label>
      <label class="inline"><input type="radio" name="paypalMode" value="auto" ${s.paypalMode === 'auto' ? 'checked' : ''}> Automatisch: PayPal Checkout, wenn eingerichtet, sonst PayPal.me</label>
      <label class="inline"><input type="radio" name="paypalMode" value="api" ${s.paypalMode === 'api' ? 'checked' : ''}> PayPal Checkout (Business-Konto, Bezahlt-Status automatisch)</label>
      <label class="inline"><input type="radio" name="paypalMode" value="paypalme" ${s.paypalMode === 'paypalme' ? 'checked' : ''}> PayPal.me-Link (Zahlung von Hand abhaken)</label>
      <p class="hint">PayPal-API: ${s.apiConfigured ? `<span class="pill pill-ok">eingerichtet (${esc(s.paypalEnv)})</span>` : '<span class="pill pill-muted">nicht eingerichtet</span> – Zugangsdaten in der Datei <code>.env</code> eintragen (siehe README)'}
        · Aktiv ist gerade: <strong>${s.effectiveMode === 'api' ? 'PayPal Checkout' : 'PayPal.me'}</strong></p>
      <label for="s-pp">Standard-PayPal.me-Name</label><input id="s-pp" name="defaultPaypalMe" type="text" maxlength="64" value="${esc(s.defaultPaypalMe)}">
      <p class="hint">Wird genommen, wenn bei der Runde kein eigener PayPal.me-Name hinterlegt ist.</p>
      <label for="s-tip">Trinkgeld-Vorschläge (Euro, mit Komma getrennt)</label><input id="s-tip" name="tipPresets" type="text">
      <p class="hint">z. B. 0.5; 1; 2 – maximal 5 Vorschläge.</p>
      <p class="error-text" data-error></p>
      <button type="submit" class="btn-primary">Speichern</button>
    </form>`;
  const form = $('[data-settings]');
  form.tipPresets.value = s.tipPresets.split(',').map((x) => x.replace('.', ',')).join('; ');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/admin/settings', {
        method: 'PUT',
        body: {
          shopName: form.shopName.value, paypalMode: form.paypalMode.value, defaultPaypalMe: form.defaultPaypalMe.value,
          tipPresets: form.tipPresets.value.split(';').map((x) => x.trim().replace(',', '.')).join(','),
        },
      });
      toast('Gespeichert');
      settingsView();
    } catch (err) {
      $('[data-error]', form).textContent = err.message;
    }
  });
}

// ---------------- Profil ----------------
async function profileView() {
  const user = (await getUsers(true)).find((u) => u.id === me.id);
  view().innerHTML = `
    <div class="page-head"><div><h1>Mein Profil</h1><div class="meta">${esc(user.username)}</div></div></div>
    <div class="field-row">
      <form class="card" data-profile>
        <h2>Angaben</h2>
        <label for="p-name">Anzeigename</label><input id="p-name" name="displayName" type="text" maxlength="60" value="${esc(user.displayName)}">
        <label for="p-pp">Mein PayPal.me-Name</label><input id="p-pp" name="paypalMe" type="text" maxlength="64" placeholder="z. B. maxmuster" value="${esc(user.paypalMe ?? '')}">
        <p class="hint">Nur der Name hinter paypal.me/ – wird für Runden vorgeschlagen, in denen du die Kasse machst.</p>
        <button type="submit" class="btn-primary">Speichern</button>
      </form>
      <form class="card" data-password>
        <h2>Passwort ändern</h2>
        <label for="p-cur">Aktuelles Passwort</label><input id="p-cur" name="current" type="password" autocomplete="current-password" required>
        <label for="p-new">Neues Passwort (min. 8 Zeichen)</label><input id="p-new" name="next" type="password" autocomplete="new-password" required>
        <p class="error-text" data-error></p>
        <button type="submit" class="btn-primary">Passwort ändern</button>
      </form>
    </div>`;
  $('[data-profile]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const res = await api('/api/admin/me', { method: 'PATCH', body: { displayName: f.displayName.value, paypalMe: f.paypalMe.value } });
      me.displayName = res.user.displayName;
      usersCache = null;
      toast('Gespeichert');
    } catch (err) { toast(err.message, { error: true }); }
  });
  $('[data-password]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('/api/admin/me', { method: 'PATCH', body: { currentPassword: f.current.value, newPassword: f.next.value } });
      f.reset();
      $('[data-error]', f).textContent = '';
      toast('Passwort geändert');
    } catch (err) { $('[data-error]', f).textContent = err.message; }
  });
}

boot().catch((err) => { app.innerHTML = `<p class="adm-main">Server nicht erreichbar: ${esc(err.message)}</p>`; });
