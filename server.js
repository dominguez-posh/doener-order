import express from 'express';
import path from 'node:path';
import { config, rootDir, paypalApiConfigured } from './src/config.js';
import './src/db.js';
import { loadUser, purgeExpiredSessions } from './src/auth.js';
import { publicRouter } from './src/routes-public.js';
import { adminRouter } from './src/routes-admin.js';
import { UserError } from './src/orders.js';

const app = express();
app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', 1);

app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

app.use(express.json({ limit: '200kb' }));

// Zustandsändernde API-Aufrufe nur als JSON – blockt Formular-basierte CSRF-Angriffe zusätzlich zu SameSite-Cookies.
app.use('/api', (req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !req.is('application/json')) {
    return res.status(415).json({ error: 'Nur JSON-Anfragen erlaubt.' });
  }
  next();
});

app.use(loadUser);
app.use(publicRouter);
app.use(adminRouter);

const pub = path.join(rootDir, 'public');
app.get('/admin', (_req, res) => res.sendFile(path.join(pub, 'admin.html')));
app.get('/bestellung/:token', (_req, res) => res.sendFile(path.join(pub, 'status.html')));
app.use(express.static(pub, { index: 'index.html', maxAge: '5m' }));

app.use('/api', (_req, res) => res.status(404).json({ error: 'Nicht gefunden.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err instanceof UserError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Ungültige Anfrage.' });
  if (err.paypal) return res.status(502).json({ error: 'PayPal hat die Anfrage abgelehnt. Bitte später nochmal versuchen.' });
  console.error(err);
  res.status(500).json({ error: 'Interner Fehler.' });
});

purgeExpiredSessions();
setInterval(purgeExpiredSessions, 6 * 3600 * 1000).unref();

app.listen(config.port, () => {
  console.log(`Dönerbestellung läuft auf http://localhost:${config.port}  (Admin: /admin)`);
  console.log(`Daten: ${config.dataDir} · PayPal-API: ${paypalApiConfigured() ? `eingerichtet (${config.paypal.env})` : 'nicht eingerichtet → PayPal.me-Modus'}`);
});
