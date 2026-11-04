# doener-order

Internes Döner-Bestellsystem für die Azubis (Node 22.13+ / Express / eingebautes `node:sqlite`, Frontend ohne Build).
Siehe README für Funktionen und Betrieb.

## Regeln
- Repo ist **öffentlich**: keine `.env`, keine `data/`, keine Menü-Fotos (`*.zip`, `_menu_src/`) einchecken.
- Preise nur serverseitig berechnen (`src/orders.js` → `priceLines`). Bestellungen speichern einen Snapshot der Positionen.
- CSP ist streng (`script-src 'self'; style-src 'self'`): keine Inline-Skripte, keine `style="…"`-Attribute.
- Jede neue Funktion bekommt einen asserting Schritt in `scripts/smoke.js` (`npm run smoke`).

## Stand (2026-11-04)
- v1.0.0 gebaut, Smoke-Test grün, UI per Headless-Edge geprüft. Noch nicht committet/gepusht.
- Läuft vorerst lokal; später eigener Server oder Azure Web App (DATA_DIR=/home/data, TRUST_PROXY=true).
- PayPal Checkout (REST) ist implementiert, aber noch nicht gegen die PayPal-Sandbox getestet (keine Zugangsdaten).
- Cheezy-Kebap-Preise fehlen auf dem Aushang → Artikel inaktiv, Azubis tragen Preise im Portal ein.
- Sauce-/Salat-Auswahl ("Knoblauch/Kräuter/Scharf", "ohne Zwiebeln" …) ist eine Annahme, nicht vom Aushang.
