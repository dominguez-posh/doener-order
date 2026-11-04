// Legt einen Azubi-Zugang an:  npm run user:add -- <benutzername> "<Anzeigename>" [<passwort>]
// Ohne Passwort wird eins erzeugt und ausgegeben.
import crypto from 'node:crypto';
import { createUser, validatePassword } from '../src/auth.js';
import { db } from '../src/db.js';

const [username, displayName, given] = process.argv.slice(2);
if (!username) {
  console.error('Aufruf: npm run user:add -- <benutzername> "<Anzeigename>" [<passwort>]');
  process.exit(1);
}
if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
  console.error(`Benutzer „${username}“ gibt es schon.`);
  process.exit(1);
}
const password = given || crypto.randomBytes(9).toString('base64url');
const err = validatePassword(password);
if (err) {
  console.error(err);
  process.exit(1);
}
createUser({ username, displayName: displayName || username, password });
console.log(`Zugang „${username}“ angelegt.${given ? '' : ` Passwort: ${password}`}`);
