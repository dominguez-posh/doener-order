import { api, esc, money, when, $, toast } from './common.js';

const token = decodeURIComponent(location.pathname.split('/').pop());
const params = new URLSearchParams(location.search);
let order = null;
let timer = null;

async function load() {
  try {
    order = (await api(`/api/public/orders/${encodeURIComponent(token)}`)).order;
    render();
    // Solange offen: alle 20 s nachsehen, ob die Azubis die Zahlung abgehakt haben
    clearTimeout(timer);
    if (order.paymentStatus === 'open') timer = setTimeout(load, 20000);
  } catch (err) {
    $('[data-root]').innerHTML = `<div class="card"><h2>Bestellung nicht gefunden</h2><p class="muted">${esc(err.message)}</p><a class="btn" href="/">Zur Speisekarte</a></div>`;
  }
}

function head() {
  if (order.paymentStatus === 'paid') {
    return { icon: '✅', title: 'Bezahlt – danke!', text: 'Die Azubis haben deine Bestellung. Guten Appetit!', pill: '<span class="pill pill-ok pill-dot">bezahlt</span>' };
  }
  if (order.paymentStatus === 'cancelled') {
    return { icon: '🚫', title: 'Storniert', text: 'Diese Bestellung wird nicht mitbestellt.', pill: '<span class="pill pill-bad pill-dot">storniert</span>' };
  }
  if (order.customerSaysPaid) {
    return { icon: '⏳', title: 'Zahlung gemeldet', text: 'Die Azubis prüfen gleich den Eingang bei PayPal.', pill: '<span class="pill pill-warn pill-dot">wird geprüft</span>' };
  }
  return { icon: '💳', title: 'Fast geschafft – jetzt bezahlen', text: 'Deine Bestellung ist angelegt. Erst nach der Zahlung ist sie fest dabei.', pill: '<span class="pill pill-warn pill-dot">noch offen</span>' };
}

function payActions() {
  if (order.paymentStatus !== 'open') return '';
  const p = order.pay;
  const parts = [];
  if (p.canPayApi) {
    parts.push(`<button type="button" class="btn-paypal btn-block" data-pay-api>Mit PayPal bezahlen · ${money(order.total)}</button>`);
  } else if (p.paypalMeLink) {
    parts.push(`<a class="btn btn-paypal btn-block" href="${esc(p.paypalMeLink)}" target="_blank" rel="noopener" data-paypalme>PayPal öffnen · ${money(order.total)}</a>
      <p class="small muted">Bitte bei PayPal „Freunde und Familie“ wählen und diese Nachricht mitschicken:</p>
      <div class="ref-box"><code data-ref>${esc(p.reference)}</code><button type="button" class="btn-sm" data-copy>Kopieren</button></div>`);
    if (!order.customerSaysPaid) parts.push('<button type="button" class="btn-block" data-claim>Ich habe bezahlt</button>');
  } else {
    parts.push('<p class="card small">Für diese Runde ist kein PayPal-Konto hinterlegt. Bitte direkt bei den Azubis bezahlen.</p>');
  }
  if (order.round?.isOpen && !order.customerSaysPaid) parts.push('<button type="button" class="btn-ghost btn-danger btn-block" data-cancel>Bestellung stornieren</button>');
  return `<div class="actions">${parts.join('')}</div>`;
}

function render() {
  const h = head();
  const notices = [];
  if (params.get('fehler') === 'zahlung') notices.push('Die PayPal-Zahlung wurde nicht abgeschlossen. Du kannst es einfach nochmal versuchen.');
  if (params.get('fehler') === 'paypal') notices.push('PayPal war gerade nicht erreichbar. Bitte nochmal auf „Mit PayPal bezahlen“ tippen.');
  if (params.get('abgebrochen')) notices.push('Zahlung abgebrochen – die Bestellung ist noch offen.');
  $('[data-root]').innerHTML = `
    ${notices.map((n) => `<p class="card small">${esc(n)}</p>`).join('')}
    <div class="status-head">
      <div class="icon" aria-hidden="true">${h.icon}</div>
      <h1>${esc(h.title)}</h1>
      <p class="muted">${esc(h.text)}</p>
      ${h.pill}
    </div>
    <div class="card">
      <h2>Bestellung #${order.id} · ${esc(order.customerName)}</h2>
      <p class="muted small">${esc(order.round?.title || '')} · ${when(order.createdAt)}${order.round?.pickupTime ? ` · Abholung ${esc(order.round.pickupTime)}` : ''}</p>
      <ul class="status-lines">
        ${order.lines.map((l) => {
          const opts = [l.variant, ...l.options.map((o) => o.label)].filter(Boolean).join(', ');
          return `<li><span>${l.qty}× ${l.num ? `<span class="num-badge">${esc(l.num)}</span> ` : ''}${esc(l.name)}
            ${opts || l.comment ? `<span class="o">${esc(opts)}${l.comment ? ` · „${esc(l.comment)}“` : ''}</span>` : ''}</span>
            <span class="money">${money(l.lineTotal)}</span></li>`;
        }).join('')}
      </ul>
      ${order.tip ? `<div class="sum-row"><span>Trinkgeld für ${order.tipRecipient === 'doener' ? 'den Dönermann' : 'die Azubis'}</span><span class="money">${money(order.tip)}</span></div>` : ''}
      <div class="sum-row total"><span>Gesamt</span><span class="money">${money(order.total)}</span></div>
      ${payActions()}
    </div>
    <p class="small muted">Speicher dir den Link dieser Seite, falls du später nochmal nachsehen willst.</p>`;
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  try {
    if (b.matches('[data-pay-api]')) {
      b.disabled = true;
      b.textContent = 'Weiter zu PayPal …';
      const res = await api(`/api/public/orders/${encodeURIComponent(token)}/pay`, { method: 'POST', body: {} });
      if (res.paid) return load();
      location.href = res.approveUrl;
    } else if (b.matches('[data-claim]')) {
      order = (await api(`/api/public/orders/${encodeURIComponent(token)}/claim-paid`, { method: 'POST', body: {} })).order;
      render();
      toast('Danke! Die Azubis wissen Bescheid.');
    } else if (b.matches('[data-cancel]')) {
      if (!confirm('Bestellung wirklich stornieren?')) return;
      order = (await api(`/api/public/orders/${encodeURIComponent(token)}/cancel`, { method: 'POST', body: {} })).order;
      render();
    } else if (b.matches('[data-copy]')) {
      await navigator.clipboard.writeText($('[data-ref]').textContent);
      toast('Kopiert');
    }
  } catch (err) {
    toast(err.message, { error: true });
    b.disabled = false;
    load();
  }
});

load();
