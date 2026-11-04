import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const envFile = path.join(rootDir, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const env = process.env;
const baseUrl = (env.BASE_URL || '').replace(/\/+$/, '');

export const config = {
  port: Number(env.PORT) || 3000,
  // Öffentliche Adresse (für PayPal-Rücksprung). Leer = aus dem Request ableiten.
  baseUrl,
  dataDir: path.resolve(rootDir, env.DATA_DIR || 'data'),
  cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : baseUrl.startsWith('https://'),
  trustProxy: env.TRUST_PROXY === 'true',
  sessionDays: Number(env.SESSION_DAYS) || 14,
  paypal: {
    clientId: env.PAYPAL_CLIENT_ID || '',
    clientSecret: env.PAYPAL_CLIENT_SECRET || '',
    env: env.PAYPAL_ENV === 'live' ? 'live' : 'sandbox',
  },
};

export const paypalApiConfigured = () => Boolean(config.paypal.clientId && config.paypal.clientSecret);
