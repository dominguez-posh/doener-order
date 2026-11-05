// Legt einen Azubi-Zugang an:  npm run user:add -- <benutzername> "<Anzeigename>" [<passwort>] [--paypal=<paypal.me-name>]
// Ohne Passwort wird eins erzeugt und ausgegeben.
import crypto from 'node:crypto';
import { createUser, validatePassword } from '../src/auth.js';
import { cleanPaypalMe } from '../src/paypal.js';
import { db } from '../src/db.js';

const args = process.argv.slice(2);
const paypalArg = args.find((a) => a.startsWith('--paypal='));
const [username, displayName, given] = args.filter((a) => !a.startsWith('--'));
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

if (!username) fail('Aufruf: npm run user:add -- <benutzername> "<Anzeigename>" [<passwort>] [--paypal=<paypal.me-name>]');
if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) fail(`Benutzer „${username}“ gibt es schon.`);
const paypalMe = paypalArg ? cleanPaypalMe(paypalArg.slice('--paypal='.length)) : null;
if (paypalArg && !paypalMe) fail('PayPal.me-Name ungültig – bitte nur den Namen hinter paypal.me/ angeben.');
const password = given || crypto.randomBytes(9).toString('base64url');
const err = validatePassword(password);
if (err) fail(err);

createUser({ username, displayName: displayName || username, password, paypalMe });
console.log(`Zugang „${username}“ angelegt.${given ? '' : ` Passwort: ${password}`}${paypalMe ? ` PayPal: paypal.me/${paypalMe}` : ''}`);
