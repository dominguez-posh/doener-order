export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const money = (c) => ((c ?? 0) / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
export const when = (iso, opts = { dateStyle: 'medium', timeStyle: 'short' }) => (iso ? new Date(iso).toLocaleString('de-DE', opts) : '–');
export const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : '');
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// Eingabe "7,50" / "7.5" → Cent
export function parseEuro(v) {
  const s = String(v ?? '').trim().replace(/\s|€/g, '').replace(',', '.');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}
export const euroInput = (c) => (c === null || c === undefined ? '' : (c / 100).toFixed(2).replace('.', ','));

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Fehler ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

let toastWrap;
export function toast(message, { error = false, ms = 3500 } = {}) {
  if (!toastWrap) {
    toastWrap = document.createElement('div');
    toastWrap.className = 'toast-wrap';
    toastWrap.setAttribute('role', 'status');
    toastWrap.setAttribute('aria-live', 'polite');
    document.body.append(toastWrap);
  }
  const el = document.createElement('div');
  el.className = `toast${error ? ' error' : ''}`;
  el.textContent = message;
  toastWrap.append(el);
  setTimeout(() => el.remove(), ms);
}

export const storage = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* privates Fenster o. ä. */ }
  },
};

export function priceFrom(item) {
  const prices = item.variants.map((v) => v.price).filter((p) => p !== null);
  if (!prices.length) return 'Preis folgt';
  const min = Math.min(...prices);
  return item.variants.length > 1 ? `ab ${money(min)}` : money(min);
}

// Zeigt den Preis einer Auswahl an – nur zur Anzeige, der Server rechnet verbindlich nach.
export function linePreview(item, groups, sel) {
  const variant = item.variants[sel.variant ?? 0];
  let unit = variant?.price ?? 0;
  const labels = [];
  for (const gid of item.groups) {
    const g = groups[gid];
    if (!g) continue;
    for (const idx of sel.options[gid] || []) {
      const c = g.choices[idx];
      if (c) { unit += c.price || 0; labels.push(c.label); }
    }
  }
  return { unit, labels, variantLabel: variant?.label || '' };
}

export function optionLabels(line) {
  return [line.variant, ...(line.options || []).map((o) => (typeof o === 'string' ? o : o.label))].filter(Boolean).join(', ');
}

/**
 * Dialog zum Konfigurieren eines Artikels (Größe, Fleisch, Sauce, Extras, Menge, Kommentar).
 * Liefert ein Promise mit { itemId, variant, options, qty, comment } oder null bei Abbruch.
 */
export function openItemDialog(item, groups, initial = null) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    const sel = {
      variant: initial?.variant ?? 0,
      options: Object.fromEntries(item.groups.map((g) => [g, [...(initial?.options?.[g] ?? [])].map(Number)])),
      qty: initial?.qty ?? 1,
      comment: initial?.comment ?? '',
    };
    const variantHtml = item.variants.length > 1 ? `
      <div class="opt-group">
        <h3>Größe / Variante <span class="req">Pflicht</span></h3>
        <div class="chips">${item.variants.map((v, i) => `
          <label class="chip"><input type="radio" name="variant" value="${i}" ${i === sel.variant ? 'checked' : ''} ${v.price === null ? 'disabled' : ''}>
          <span>${esc(v.label)} <small>${v.price === null ? 'Preis fehlt' : money(v.price)}</small></span></label>`).join('')}
        </div>
      </div>` : '';
    const groupsHtml = item.groups.map((gid) => {
      const g = groups[gid];
      if (!g) return '';
      const type = g.type === 'single' ? 'radio' : 'checkbox';
      return `
      <div class="opt-group" data-group="${esc(gid)}">
        <h3>${esc(g.name)} ${g.required ? '<span class="req">Pflicht</span>' : `<span class="muted small">${g.type === 'multi' ? 'optional, mehrere möglich' : 'optional'}</span>`}</h3>
        <div class="chips">${g.choices.map((c, i) => `
          <label class="chip"><input type="${type}" name="g-${esc(gid)}" value="${i}" ${sel.options[gid].includes(i) ? 'checked' : ''}>
          <span>${esc(c.label)}${c.price ? ` <small>+${money(c.price)}</small>` : ''}</span></label>`).join('')}
        </div>
      </div>`;
    }).join('');

    dlg.innerHTML = `
      <form method="dialog" class="dlg">
        <div class="dlg-head">
          <div>
            <h2>${item.num ? `<span class="num-badge">${esc(item.num)}</span> ` : ''}${esc(item.name)}</h2>
            ${item.description ? `<p class="muted small">${esc(item.description)}</p>` : ''}
          </div>
          <button type="button" class="dlg-close btn-ghost" data-close aria-label="Schließen">✕</button>
        </div>
        <div class="dlg-body">
          ${variantHtml}
          ${groupsHtml}
          <div class="opt-group">
            <h3>Sonderwunsch <span class="muted small">optional</span></h3>
            <input type="text" name="comment" maxlength="200" placeholder="z. B. extra scharf, ohne Käse …" value="${esc(sel.comment)}">
          </div>
          <p class="error-text" data-error></p>
        </div>
        <div class="dlg-foot">
          <div class="stepper" aria-label="Menge">
            <button type="button" data-qty="-1" aria-label="Weniger">−</button>
            <output data-qty-out>${sel.qty}</output>
            <button type="button" data-qty="1" aria-label="Mehr">+</button>
          </div>
          <button type="submit" class="btn-primary" data-submit>${initial ? 'Übernehmen' : 'In den Warenkorb'} · <span data-price></span></button>
        </div>
      </form>`;
    document.body.append(dlg);

    const form = dlg.querySelector('form');
    const read = () => {
      const v = form.querySelector('input[name=variant]:checked');
      sel.variant = v ? Number(v.value) : 0;
      for (const gid of item.groups) {
        sel.options[gid] = $$(`input[name="g-${CSS.escape(gid)}"]:checked`, form).map((i) => Number(i.value));
      }
      sel.comment = form.comment.value;
    };
    const update = () => {
      read();
      const p = linePreview(item, groups, sel);
      dlg.querySelector('[data-price]').textContent = money(p.unit * sel.qty);
      dlg.querySelector('[data-qty-out]').textContent = sel.qty;
    };
    // Radio-Chips einer optionalen Gruppe per zweitem Klick abwählbar machen
    // (Klick auf das Label: input.checked zeigt hier noch den Zustand vor dem Klick)
    form.addEventListener('click', (e) => {
      if (e.target.tagName === 'INPUT') return;
      const input = e.target.closest('label.chip')?.querySelector('input[type=radio]');
      if (!input || input.name === 'variant' || groups[input.name.slice(2)]?.required) return;
      if (input.checked) {
        e.preventDefault();
        input.checked = false;
        update();
      }
    });
    form.addEventListener('change', update);
    form.addEventListener('input', update);
    dlg.querySelectorAll('[data-qty]').forEach((b) => b.addEventListener('click', () => {
      sel.qty = Math.min(20, Math.max(1, sel.qty + Number(b.dataset.qty)));
      update();
    }));

    let result = null;
    form.addEventListener('submit', (e) => {
      read();
      const missing = item.groups.map((g) => groups[g]).filter((g) => g?.required && !sel.options[g.id]?.length);
      if (missing.length) {
        e.preventDefault();
        dlg.querySelector('[data-error]').textContent = `Bitte noch auswählen: ${missing.map((g) => g.name).join(', ')}`;
        return;
      }
      result = { itemId: item.id, variant: sel.variant, options: sel.options, qty: sel.qty, comment: sel.comment.trim() };
    });
    dlg.querySelector('[data-close]').addEventListener('click', () => dlg.close());
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
    dlg.addEventListener('close', () => { dlg.remove(); resolve(result); });
    update();
    dlg.showModal();
  });
}

// Baut aus einer Auswahl eine Warenkorb-Zeile zur Anzeige
export function describeSelection(item, groups, sel) {
  const p = linePreview(item, groups, sel);
  return {
    ...sel,
    name: item.name, num: item.num, variantLabel: p.variantLabel, optionLabels: p.labels,
    unit: p.unit, total: p.unit * sel.qty,
  };
}
