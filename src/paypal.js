import { config, paypalApiConfigured } from './config.js';
import { getSettings } from './db.js';

const API_BASE = () => (config.paypal.env === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com');

// Welcher Zahlweg gilt gerade? 'api' = PayPal Checkout mit automatischem Bezahlt-Status,
// 'paypalme' = PayPal.me-Link, die Azubis haken die Zahlung von Hand ab.
export function effectiveMode() {
  const mode = getSettings().paypal_mode;
  if (mode === 'paypalme') return 'paypalme';
  if (mode === 'api') return paypalApiConfigured() ? 'api' : 'paypalme';
  return paypalApiConfigured() ? 'api' : 'paypalme';
}

export const euro = (c) => (c / 100).toFixed(2);

export function cleanPaypalMe(handle) {
  const h = String(handle || '').trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^(www\.)?paypal\.(me|com\/paypalme)\//i, '')
    .replace(/\/.*$/, '');
  return /^[A-Za-z0-9._-]{1,64}$/.test(h) ? h : '';
}

export function paypalMeLink(handle, totalCents) {
  const h = cleanPaypalMe(handle);
  return h ? `https://paypal.me/${h}/${euro(totalCents)}EUR` : null;
}

let tokenCache = { token: null, expires: 0 };

async function accessToken() {
  if (tokenCache.token && tokenCache.expires > Date.now() + 60_000) return tokenCache.token;
  const auth = Buffer.from(`${config.paypal.clientId}:${config.paypal.clientSecret}`).toString('base64');
  const res = await fetch(`${API_BASE()}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`PayPal-Anmeldung fehlgeschlagen (${res.status})`);
  const data = await res.json();
  tokenCache = { token: data.access_token, expires: Date.now() + data.expires_in * 1000 };
  return tokenCache.token;
}

async function call(method, path, body, requestId) {
  const headers = { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' };
  if (requestId) headers['PayPal-Request-Id'] = requestId;
  const res = await fetch(`${API_BASE()}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const issue = data?.details?.[0]?.issue || data?.name || res.status;
    const err = new Error(`PayPal-Fehler: ${issue}`);
    err.paypal = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

export async function createPaypalOrder({ order, returnUrl, cancelUrl }) {
  const shop = getSettings().shop_name;
  const tipLine = order.tip > 0 ? [{
    name: order.tip_recipient === 'doener' ? 'Trinkgeld für den Dönermann' : 'Trinkgeld für die Azubis',
    quantity: '1', unit_amount: { currency_code: 'EUR', value: euro(order.tip) },
  }] : [];
  const items = JSON.parse(order.lines).map((l) => ({
    name: `${l.num ? l.num + ' ' : ''}${l.name}${l.variant ? ' ' + l.variant : ''}`.slice(0, 127),
    quantity: String(l.qty),
    unit_amount: { currency_code: 'EUR', value: euro(l.unitPrice) },
  }));
  const data = await call('POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id: `bestellung-${order.id}`,
      custom_id: String(order.id),
      description: `${shop}: Bestellung #${order.id} (${order.customer_name})`.slice(0, 127),
      amount: {
        currency_code: 'EUR',
        value: euro(order.total),
        breakdown: { item_total: { currency_code: 'EUR', value: euro(order.total) } },
      },
      items: [...items, ...tipLine],
    }],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: shop.slice(0, 127),
          locale: 'de-DE',
          shipping_preference: 'NO_SHIPPING',
          user_action: 'PAY_NOW',
          return_url: returnUrl,
          cancel_url: cancelUrl,
        },
      },
    },
  }, `create-${order.token}-${order.total}-${Date.now()}`);
  const link = data.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve');
  if (!link) throw new Error('PayPal hat keinen Zahlungslink geliefert.');
  return { id: data.id, approveUrl: link.href };
}

// Zieht eine freigegebene Zahlung ein. Liefert { paid, captureId, status }.
export async function capturePaypalOrder(paypalOrderId) {
  const order = await call('GET', `/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}`);
  if (order.status === 'COMPLETED') return { paid: true, captureId: findCapture(order), status: order.status };
  if (order.status !== 'APPROVED') return { paid: false, status: order.status };
  const captured = await call('POST', `/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`, {}, `capture-${paypalOrderId}`);
  const captureId = findCapture(captured);
  const captureStatus = captured.purchase_units?.[0]?.payments?.captures?.[0]?.status;
  return { paid: captured.status === 'COMPLETED' && captureStatus === 'COMPLETED', captureId, status: captureStatus || captured.status };
}

function findCapture(order) {
  return order.purchase_units?.[0]?.payments?.captures?.[0]?.id ?? null;
}
