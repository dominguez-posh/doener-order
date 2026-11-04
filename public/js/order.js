import { api, esc, money, clock, $, toast, storage, priceFrom, openItemDialog, describeSelection, parseEuro } from './common.js';

let state = null;          // Antwort von /api/public/state
let cart = [];             // [{ itemId, variant, options, qty, comment }]
let query = '';

const CART_KEY = 'doener.cart';
const NAME_KEY = 'doener.name';
const MY_KEY = 'doener.myOrders';

const itemsById = () => new Map(state.menu.items.map((i) => [i.id, i]));
const isOpen = () => Boolean(state?.round?.isOpen);

async function load() {
  try {
    const prevRound = state?.round?.id;
    state = await api('/api/public/state');
    document.title = `Bestellen · ${state.shopName}`;
    $('[data-shop]').textContent = state.shopName;
    const saved = storage.get(CART_KEY, null);
    if (!state.round) cart = [];
    else if (saved && saved.roundId === state.round.id) cart = saved.lines;
    else if (prevRound !== undefined && prevRound !== state.round.id) cart = [];
    // Positionen entfernen, die es nicht (mehr) gibt
    const ids = itemsById();
    cart = cart.filter((l) => ids.has(l.itemId));
    renderRound();
    renderMenu();
    renderCart();
    renderMyOrders();
  } catch (err) {
    $('[data-round-box]').innerHTML = `<strong>Server nicht erreichbar</strong><span class="small">${esc(err.message)}</span>`;
  }
}

function saveCart() {
  if (state?.round) storage.set(CART_KEY, { roundId: state.round.id, lines: cart });
}

function minutesLeft(iso) {
  return Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60000));
}

function renderRound() {
  const box = $('[data-round-box]');
  const closed = $('[data-closed]');
  const r = state.round;
  if (r) {
    const bits = [];
    if (r.deadline) bits.push(`Bestellschluss ${clock(r.deadline)} Uhr <span class="small">(noch ${minutesLeft(r.deadline)} Min.)</span>`);
    if (r.pickupTime) bits.push(`Abholung: ${esc(r.pickupTime)}`);
    if (r.collector) bits.push(`Kasse: ${esc(r.collector)}`);
    box.innerHTML = `<span class="pill pill-ok pill-dot">Bestellrunde offen</span>
      <strong>${esc(r.title)}</strong>${bits.map((b) => `<div class="small">${b}</div>`).join('')}`;
    closed.classList.add('hidden');
  } else {
    box.innerHTML = `<span class="pill pill-bad pill-dot">Keine Bestellrunde offen</span>
      <div class="small">Sobald ein Azubi eine Runde öffnet, kannst du hier bestellen.</div>`;
    closed.classList.remove('hidden');
    closed.innerHTML = `<div class="card closed-card">
      <div class="big" aria-hidden="true">🥙</div>
      <h2>Gerade wird nicht bestellt</h2>
      <p class="muted">Die Speisekarte kannst du dir trotzdem schon anschauen. Diese Seite aktualisiert sich von selbst.</p>
    </div>`;
  }
}

function matches(item) {
  if (!query) return true;
  const q = query.toLowerCase();
  return (item.num && item.num.toLowerCase().replace(/^0+/, '') === q.replace(/^0+/, ''))
    || `${item.num ?? ''} ${item.name} ${item.description ?? ''}`.toLowerCase().includes(q);
}

function renderMenu() {
  const wrap = $('[data-menu]');
  const nav = $('[data-cat-nav]');
  const groups = state.menu.categories.map((c) => ({ ...c, items: state.menu.items.filter((i) => i.categoryId === c.id && matches(i)) }))
    .filter((c) => c.items.length);
  nav.innerHTML = groups.map((c) => `<a href="#kat-${esc(c.id)}">${esc(c.name)}</a>`).join('');
  wrap.innerHTML = groups.map((c) => `
    <section class="cat-section" id="kat-${esc(c.id)}">
      <header><h2>${esc(c.name)}</h2>${c.note ? `<span class="muted small">${esc(c.note)}</span>` : ''}</header>
      <div class="items">
        ${c.items.map((i) => `
        <button type="button" class="item" data-item="${i.id}" ${isOpen() ? '' : 'disabled'}
                aria-label="${esc(`${i.num ? i.num + ' ' : ''}${i.name}, ${priceFrom(i)}${isOpen() ? ', hinzufügen' : ''}`)}">
          ${i.num ? `<span class="num-badge">${esc(i.num)}</span>` : ''}
          <span class="body">
            <span class="name">${esc(i.name)}</span>
            ${i.description ? `<span class="desc">${esc(i.description)}</span>` : ''}
            <span class="price money">${priceFrom(i)}</span>
          </span>
          <span class="add" aria-hidden="true">+</span>
        </button>`).join('')}
      </div>
    </section>`).join('');
  $('[data-empty]').classList.toggle('hidden', groups.length > 0);
}

function cartView() {
  const ids = itemsById();
  return cart.map((sel, idx) => ({ idx, ...describeSelection(ids.get(sel.itemId), state.menu.groups, sel) }));
}
const cartSubtotal = (view) => view.reduce((s, l) => s + l.total, 0);
const cartCount = () => cart.reduce((s, l) => s + l.qty, 0);

function lineHtml(l, editable) {
  const opts = [l.variantLabel, ...l.optionLabels].filter(Boolean).join(', ');
  return `<li class="cart-line">
    <span class="t">${l.qty}× ${l.num ? `<span class="num-badge">${esc(l.num)}</span> ` : ''}${esc(l.name)}</span>
    <span class="money">${money(l.total)}</span>
    ${opts || l.comment ? `<span class="o">${esc(opts)}${l.comment ? `${opts ? ' · ' : ''}„${esc(l.comment)}“` : ''}</span>` : ''}
    ${editable ? `<span class="ctrl">
      <span class="stepper"><button type="button" data-dec="${l.idx}" aria-label="Weniger">−</button><output>${l.qty}</output><button type="button" data-inc="${l.idx}" aria-label="Mehr">+</button></span>
      <button type="button" class="btn-ghost btn-sm" data-edit="${l.idx}">Ändern</button>
      <button type="button" class="btn-ghost btn-sm btn-danger" data-del="${l.idx}">Entfernen</button>
    </span>` : ''}
  </li>`;
}

function renderCart() {
  const view = cartView();
  const sub = cartSubtotal(view);
  const side = $('[data-cart-side]');
  side.innerHTML = `
    <h2>Warenkorb <span class="muted small">${cartCount()} Artikel</span></h2>
    ${view.length ? `<ul class="cart-lines">${view.map((l) => lineHtml(l, true)).join('')}</ul>`
      : `<p class="cart-empty">${isOpen() ? 'Noch leer – such dir was Leckeres aus.' : 'Bestellen geht erst, wenn eine Runde offen ist.'}</p>`}
    <div class="sum-row total"><span>Zwischensumme</span><span class="money">${money(sub)}</span></div>
    <button type="button" class="btn-primary btn-block" data-checkout ${view.length && isOpen() ? '' : 'disabled'}>Bestellen</button>`;
  const bar = $('[data-cart-bar]');
  bar.classList.toggle('hidden', !view.length || !isOpen());
  $('[data-bar-count]').textContent = `Warenkorb ansehen · ${cartCount()} Artikel`;
  $('[data-bar-total]').textContent = money(sub);
}

function renderMyOrders() {
  const mine = storage.get(MY_KEY, []).slice(0, 8);
  const sec = $('[data-my-orders]');
  sec.classList.toggle('hidden', mine.length === 0);
  sec.querySelector('ul').innerHTML = mine.map((o) => `
    <li><a href="/bestellung/${encodeURIComponent(o.token)}">
      <span>#${o.id} · ${esc(o.roundTitle || '')}<span class="muted small"> · ${new Date(o.at).toLocaleDateString('de-DE')}</span></span>
      <span class="money">${money(o.total)}</span></a></li>`).join('');
}

async function addItem(itemId) {
  const item = itemsById().get(itemId);
  if (!item || !isOpen()) return;
  const sel = await openItemDialog(item, state.menu.groups);
  if (!sel) return;
  cart.push(sel);
  saveCart();
  renderCart();
  toast(`${sel.qty}× ${item.name} im Warenkorb`);
}

async function editLine(idx) {
  const sel = cart[idx];
  const item = itemsById().get(sel.itemId);
  const next = await openItemDialog(item, state.menu.groups, sel);
  if (!next) return;
  cart[idx] = next;
  saveCart();
  renderAll();
}

function changeQty(idx, delta) {
  const l = cart[idx];
  if (!l) return;
  l.qty = Math.min(20, l.qty + delta);
  if (l.qty < 1) cart.splice(idx, 1);
  saveCart();
  renderAll();
}

function renderAll() {
  renderCart();
  const dlg = $('dialog[data-checkout-dlg]');
  if (dlg) dlg.dispatchEvent(new Event('refresh'));
}

// ---------------- Kasse ----------------
function openCheckout() {
  if (!cart.length || !isOpen()) return;
  const dlg = document.createElement('dialog');
  dlg.dataset.checkoutDlg = '';
  const presets = state.tipPresets;
  const tip = { mode: '0', custom: '', recipient: 'doener' };

  dlg.innerHTML = `
  <form class="dlg" novalidate>
    <div class="dlg-head"><h2>Deine Bestellung</h2><button type="button" class="dlg-close btn-ghost" data-close aria-label="Schließen">✕</button></div>
    <div class="dlg-body">
      <ul class="cart-lines" data-lines></ul>
      <label for="co-name">Dein Name</label>
      <input id="co-name" name="customer" type="text" maxlength="60" autocomplete="name" required placeholder="Vorname Nachname" value="${esc(storage.get(NAME_KEY, ''))}">
      ${state.round.needsCode ? `<label for="co-code">Bestell-Code</label><input id="co-code" name="code" type="text" maxlength="32" autocomplete="off" placeholder="steht in der Einladung der Azubis">` : ''}

      <div class="tip-box">
        <h3>Freiwilliges Trinkgeld</h3>
        <div class="chips" data-tip-chips>
          <label class="chip"><input type="radio" name="tip" value="0" checked><span>Kein Trinkgeld</span></label>
          ${presets.map((c) => `<label class="chip"><input type="radio" name="tip" value="${c}"><span>${money(c)}</span></label>`).join('')}
          <label class="chip" data-roundup><input type="radio" name="tip" value="roundup"><span>Aufrunden</span></label>
          <label class="chip"><input type="radio" name="tip" value="custom"><span>Eigener Betrag</span></label>
        </div>
        <input type="text" inputmode="decimal" name="customTip" class="hidden" placeholder="z. B. 1,50" aria-label="Eigener Trinkgeld-Betrag in Euro">
        <div data-recipient class="hidden">
          <p class="small muted">Wer soll es bekommen?</p>
          <div class="seg">
            <label class="chip"><input type="radio" name="recipient" value="doener" checked><span>🥙 Der Dönermann</span></label>
            <label class="chip"><input type="radio" name="recipient" value="azubis"><span>🎓 Die Azubis</span></label>
          </div>
        </div>
      </div>

      <div class="sum-row"><span>Bestellung</span><span class="money" data-sub></span></div>
      <div class="sum-row"><span>Trinkgeld</span><span class="money" data-tip></span></div>
      <div class="sum-row total"><span>Zu bezahlen</span><span class="money" data-total></span></div>
      <p class="pay-note">${state.paymentMode === 'api'
        ? 'Du wirst direkt zu PayPal weitergeleitet. Sobald du bezahlt hast, sehen die Azubis das automatisch.'
        : 'Im nächsten Schritt bekommst du einen PayPal-Link mit dem fertigen Betrag. Die Azubis haken deine Zahlung dann ab.'}</p>
      <p class="error-text" data-error role="alert"></p>
    </div>
    <div class="dlg-foot">
      <button type="button" class="btn-ghost" data-close>Weiter aussuchen</button>
      <button type="submit" class="btn-paypal" data-pay>Jetzt bezahlen</button>
    </div>
  </form>`;
  document.body.append(dlg);
  const form = dlg.querySelector('form');

  const tipCents = (sub) => {
    if (tip.mode === 'custom') {
      const c = parseEuro(tip.custom);
      return Number.isFinite(c) && c > 0 ? c : 0;
    }
    if (tip.mode === 'roundup') return (100 - (sub % 100)) % 100;
    return Number(tip.mode) || 0;
  };

  const refresh = () => {
    const view = cartView();
    if (!view.length) { dlg.close(); return; }
    const sub = cartSubtotal(view);
    tip.mode = form.tip.value;
    tip.custom = form.customTip.value;
    tip.recipient = form.recipient.value;
    const t = tipCents(sub);
    dlg.querySelector('[data-lines]').innerHTML = view.map((l) => lineHtml(l, true)).join('');
    dlg.querySelector('[data-sub]').textContent = money(sub);
    dlg.querySelector('[data-tip]').textContent = t ? `${money(t)} für ${tip.recipient === 'doener' ? 'den Dönermann' : 'die Azubis'}` : money(0);
    dlg.querySelector('[data-total]').textContent = money(sub + t);
    dlg.querySelector('[data-pay]').textContent = `Jetzt ${money(sub + t)} bezahlen`;
    form.customTip.classList.toggle('hidden', tip.mode !== 'custom');
    dlg.querySelector('[data-recipient]').classList.toggle('hidden', t === 0);
    // "Aufrunden" nur zeigen, wenn es etwas aufzurunden gibt
    dlg.querySelector('[data-roundup]').classList.toggle('hidden', sub % 100 === 0);
  };
  form.addEventListener('change', refresh);
  form.addEventListener('input', (e) => { if (e.target.name === 'customTip') refresh(); });
  dlg.addEventListener('refresh', refresh);
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg || e.target.closest('[data-close]')) dlg.close();
    cartClick(e);
  });
  dlg.addEventListener('close', () => dlg.remove());

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = dlg.querySelector('[data-error]');
    err.textContent = '';
    const name = form.customer.value.trim();
    if (name.length < 2) { err.textContent = 'Bitte gib deinen Namen an, damit die Azubis wissen, wem was gehört.'; form.customer.focus(); return; }
    const sub = cartSubtotal(cartView());
    const t = tipCents(sub);
    if (tip.mode === 'custom' && form.customTip.value && !Number.isFinite(parseEuro(form.customTip.value))) {
      err.textContent = 'Der Trinkgeld-Betrag ist ungültig.'; return;
    }
    const btn = dlg.querySelector('[data-pay]');
    btn.disabled = true;
    btn.textContent = 'Wird angelegt …';
    try {
      storage.set(NAME_KEY, name);
      const res = await api('/api/public/orders', {
        method: 'POST',
        body: {
          roundId: state.round.id, code: form.code?.value, name, lines: cart,
          tip: t, tipRecipient: t ? tip.recipient : null,
        },
      });
      const mine = storage.get(MY_KEY, []);
      mine.unshift({ token: res.order.token, id: res.order.id, total: res.order.total, at: res.order.createdAt, roundTitle: state.round.title });
      storage.set(MY_KEY, mine.slice(0, 20));
      cart = [];
      saveCart();
      if (res.approveUrl) {
        btn.textContent = 'Weiter zu PayPal …';
        location.href = res.approveUrl;
      } else {
        location.href = `/bestellung/${encodeURIComponent(res.order.token)}${res.paypalError ? '?fehler=paypal' : '?neu=1'}`;
      }
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false;
      refresh();
      if (ex.status === 409) load();
    }
  });
  refresh();
  dlg.showModal();
}

function cartClick(e) {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.inc !== undefined) changeQty(Number(b.dataset.inc), 1);
  else if (b.dataset.dec !== undefined) changeQty(Number(b.dataset.dec), -1);
  else if (b.dataset.del !== undefined) changeQty(Number(b.dataset.del), -99);
  else if (b.dataset.edit !== undefined) editLine(Number(b.dataset.edit));
}

document.addEventListener('DOMContentLoaded', () => {
  $('[data-menu]').addEventListener('click', (e) => {
    const b = e.target.closest('[data-item]');
    if (b) addItem(Number(b.dataset.item));
  });
  $('[data-cart-side]').addEventListener('click', (e) => {
    if (e.target.closest('[data-checkout]')) openCheckout();
    else cartClick(e);
  });
  $('[data-open-cart]').addEventListener('click', openCheckout);
  let t;
  $('[data-search]').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => { query = e.target.value.trim(); if (state) renderMenu(); }, 120);
  });
  load();
  // Runde öffnet/schließt sich im Hintergrund – regelmäßig nachsehen, außer ein Dialog ist offen
  setInterval(() => { if (!$('dialog[open]')) load(); }, 45000);
  setInterval(() => { if (state?.round?.deadline) renderRound(); }, 30000);
});

