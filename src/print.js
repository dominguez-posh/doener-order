const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (c) => (c / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
const when = (iso) => (iso ? new Date(iso).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'medium', timeStyle: 'short' }) : '–');

const PAY_LABEL = { paypal_api: 'PayPal', paypal_me: 'PayPal.me', cash: 'Bar', other: 'Sonstiges' };

function lineText(l) {
  const parts = [`<strong>${esc(l.name)}</strong>`];
  if (l.variant) parts.push(esc(l.variant));
  let html = parts.join(' · ');
  if (l.options?.length) html += `<div class="opts">${esc(l.options.map((o) => o.label).join(', '))}</div>`;
  if (l.comment) html += `<div class="comment">„${esc(l.comment)}“</div>`;
  return html;
}

export function renderPrint({ round, orders, totals, aggregate }, settings, view) {
  const live = orders.filter((o) => o.paymentStatus !== 'cancelled');
  const cancelled = orders.filter((o) => o.paymentStatus === 'cancelled');
  const itemCount = aggregate.reduce((s, a) => s + a.qty, 0);

  const kitchen = `
  <section>
    <h2>Bestellliste für ${esc(settings.shop_name)} <span class="muted">(${itemCount} Artikel)</span></h2>
    <table class="kitchen">
      <thead><tr><th class="chk">✓</th><th class="qty">Anz.</th><th class="num">Nr.</th><th>Artikel</th><th>Für</th><th class="amt">Summe</th></tr></thead>
      <tbody>
        ${aggregate.map((a) => `
        <tr>
          <td class="chk"><span class="box"></span></td>
          <td class="qty">${a.qty}×</td>
          <td class="num">${esc(a.num || '')}</td>
          <td>${lineText({ name: a.name, variant: a.variant, options: a.options ? [{ label: a.options }] : [], comment: a.comment })}</td>
          <td class="who">${esc(a.who.join(', '))}</td>
          <td class="amt">${money(a.total)}</td>
        </tr>`).join('')}
      </tbody>
      <tfoot>
        <tr><td colspan="5">Warenwert laut Karte</td><td class="amt">${money(totals.subtotal)}</td></tr>
        ${totals.tipDoener ? `<tr><td colspan="5">+ Trinkgeld für den Dönermann</td><td class="amt">${money(totals.tipDoener)}</td></tr>` : ''}
        <tr class="grand"><td colspan="5">An den Dönermann zahlen</td><td class="amt">${money(totals.subtotal + totals.tipDoener)}</td></tr>
      </tfoot>
    </table>
  </section>`;

  const people = `
  <section class="${view === 'alles' ? 'page-break' : ''}">
    <h2>Ausgabe je Person <span class="muted">(${live.length} Bestellungen)</span></h2>
    <table class="people">
      <thead><tr><th class="chk">✓</th><th class="num">#</th><th>Name</th><th>Positionen</th><th class="amt">Betrag</th><th>Zahlung</th></tr></thead>
      <tbody>
        ${live.map((o) => `
        <tr class="${o.paymentStatus === 'paid' ? '' : 'unpaid'}">
          <td class="chk"><span class="box">${o.pickedUp ? '✓' : ''}</span></td>
          <td class="num">${o.id}</td>
          <td><strong>${esc(o.customerName)}</strong>${o.notes ? `<div class="comment">Notiz: ${esc(o.notes)}</div>` : ''}</td>
          <td>${o.lines.map((l) => `<div class="pl">${l.qty}× ${l.num ? `<span class="n">${esc(l.num)}</span> ` : ''}${lineText(l)}</div>`).join('')}</td>
          <td class="amt">${money(o.total)}${o.tip ? `<div class="muted small">inkl. ${money(o.tip)} TG ${o.tipRecipient === 'doener' ? 'Döner' : 'Azubis'}</div>` : ''}</td>
          <td>${o.paymentStatus === 'paid'
            ? `<span class="paid">bezahlt</span><div class="muted small">${esc(PAY_LABEL[o.paymentMethod] || '')}</div>`
            : `<span class="open">OFFEN</span>${o.customerSaysPaid ? '<div class="muted small">laut Besteller bezahlt</div>' : ''}`}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    ${cancelled.length ? `<p class="muted small">Storniert (nicht bestellen): ${cancelled.map((o) => `#${o.id} ${esc(o.customerName)}`).join(', ')}</p>` : ''}
  </section>`;

  const summary = `
  <section class="summary">
    <div><span>Eingenommen</span><strong>${money(totals.paid)}</strong></div>
    <div><span>Noch offen</span><strong class="${totals.open ? 'open' : ''}">${money(totals.open)}</strong></div>
    <div><span>Trinkgeld Dönermann</span><strong>${money(totals.tipDoener)}</strong></div>
    <div><span>Trinkgeld Azubis</span><strong>${money(totals.tipAzubis)}</strong></div>
  </section>`;

  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(round.title)} – Bestellliste</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/print.css">
</head>
<body>
  <div class="toolbar no-print">
    <button type="button" id="print">Drucken</button>
    <a href="?ansicht=alles">Alles</a>
    <a href="?ansicht=personen">Nur Ausgabe-Liste</a>
    <a href="/admin#/runde/${round.id}">Zurück zur Runde</a>
  </div>
  <header>
    <div>
      <h1>${esc(round.title)}</h1>
      <p>${esc(settings.shop_name)} · eröffnet ${when(round.openedAt)}${round.openedBy ? ` von ${esc(round.openedBy)}` : ''}
         · ${round.status === 'open' ? '<strong>Runde noch offen</strong>' : `geschlossen ${when(round.closedAt)}`}</p>
    </div>
    <div class="meta">
      ${round.pickupTime ? `<div>Abholung: <strong>${esc(round.pickupTime)}</strong></div>` : ''}
      ${round.collector ? `<div>Kasse: <strong>${esc(round.collector)}</strong></div>` : ''}
      <div>Gedruckt: ${when(new Date().toISOString())}</div>
    </div>
  </header>
  ${round.notes ? `<p class="notes">${esc(round.notes)}</p>` : ''}
  ${summary}
  ${view === 'personen' ? '' : kitchen}
  ${people}
  <script src="/print.js"></script>
</body>
</html>`;
}

export function renderCsv({ round, orders }) {
  const cell = (v) => {
    let s = String(v ?? '');
    // Excel wertet Zellen aus, die mit = + - @ beginnen. Namen und Kommentare kommen von der öffentlichen Bestellseite.
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const eur = (c) => (c / 100).toFixed(2).replace('.', ',');
  const rows = [['Bestellung', 'Name', 'Menge', 'Nr', 'Artikel', 'Variante', 'Optionen', 'Kommentar', 'Einzelpreis', 'Positionssumme',
    'Trinkgeld', 'Trinkgeld für', 'Gesamt Bestellung', 'Status', 'Zahlart', 'Bezahlt am', 'Abgeholt', 'Notiz', 'Runde']];
  for (const o of orders) {
    o.lines.forEach((l, i) => {
      const first = i === 0;
      rows.push([o.id, o.customerName, l.qty, l.num || '', l.name, l.variant, l.options.map((x) => x.label).join(', '), l.comment,
        eur(l.unitPrice), eur(l.lineTotal),
        first ? eur(o.tip) : '', first && o.tipRecipient ? (o.tipRecipient === 'doener' ? 'Dönermann' : 'Azubis') : '',
        first ? eur(o.total) : '', { open: 'offen', paid: 'bezahlt', cancelled: 'storniert' }[o.paymentStatus],
        PAY_LABEL[o.paymentMethod] || '', o.paidAt || '', o.pickedUp ? 'ja' : 'nein', first ? o.notes || '' : '', round.title]);
    });
  }
  return '﻿' + rows.map((r) => r.map(cell).join(';')).join('\r\n') + '\r\n';
}
