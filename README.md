# Dönerbestellung

Internes Bestellsystem für die Dönerrunde der Azubis. Die Dönerbude nimmt keine Online-Bestellungen an – die Azubis
sammeln deshalb alle Bestellungen, kassieren per PayPal und holen gesammelt ab.

- **Bestellseite** (`/`): Speisekarte mit Suche, Auswahl von Größe/Fleisch/Sauce/Extras, Warenkorb. Beim Klick auf
  „Bestellen“ werden Kosten und freiwilliges Trinkgeld (für den Dönermann oder die Azubis) angezeigt, danach geht es
  direkt zu PayPal.
- **Bestellrunden**: Bestellen geht nur, wenn ein Azubi eine Runde geöffnet hat. Wird sie geschlossen (von Hand oder
  automatisch zum Bestellschluss), ist keine Bestellung mehr möglich. Nachtragen geht weiterhin über das Admin-Portal.
- **Azubi-Portal** (`/admin`): eigener Login je Azubi, Live-Liste aller Bestellungen, Bezahlt-Status, Notizen pro
  Bestellung und Runde, Nachtragen/Bearbeiten/Stornieren, Archiv aller alten Runden, Verlauf (wer hat was geändert),
  Pflege der Speisekarte und der Zugänge.
- **Export**: Druckansicht (A4) mit der zusammengefassten Bestellliste zum Abhaken beim Dönermann und einer
  Ausgabe-Liste je Person (inkl. „OFFEN“-Markierung), außerdem CSV für Excel.

## PayPal

Zwei Modi, umschaltbar unter *Einstellungen*:

| Modus | Voraussetzung | Bezahlt-Status |
|---|---|---|
| **PayPal Checkout** | PayPal-**Business**-Konto + REST-App (Client-ID/Secret in `.env`) | automatisch, sobald gezahlt |
| **PayPal.me** | privates PayPal-Konto, PayPal.me-Name im Profil oder an der Runde | Besteller tippt „Ich habe bezahlt“, Azubi hakt im Portal ab |

„Automatisch“ (Standard) nimmt Checkout, sobald Zugangsdaten hinterlegt sind, sonst PayPal.me.
Hinweis: Beim Checkout berechnet PayPal Gebühren pro Zahlung. PayPal.me über „Freunde und Familie“ ist kostenlos.

Checkout einrichten: auf <https://developer.paypal.com> unter *Apps & Credentials* eine REST-App anlegen, Client-ID und
Secret in `.env` eintragen, zuerst mit `PAYPAL_ENV=sandbox` testen, dann auf `live` stellen. Für den Rücksprung von
PayPal muss die Seite unter `BASE_URL` erreichbar sein.

## Starten (lokal)

Voraussetzung: Node.js 22.13 oder neuer (die Datenbank ist das eingebaute SQLite von Node).

```bash
npm install
cp .env.example .env      # optional, nur für PayPal Checkout / anderen Port
npm start                 # http://localhost:3000
```

Beim ersten Aufruf von `http://localhost:3000/admin` **direkt am Rechner** wird der erste Zugang angelegt
(aus dem Netzwerk ist das gesperrt). Alternativ: `npm run user:add -- lena "Lena M." [passwort]`.
Weitere Azubis legt man danach im Portal unter *Zugänge* an.

Die Daten liegen in `data/doener.db`. Für ein Backup reicht es, diese Datei zu kopieren (bei gestopptem Server).

## Ablauf für die Azubis

1. *Aktuelle Runde* → **Jetzt neue Bestellung öffnen** (optional mit Bestellschluss, Abholzeit, Kasse, Bestell-Code).
2. Bestell-Link (`/`) an die Kollegen schicken.
3. Im Portal laufen die Bestellungen ein (aktualisiert sich alle 15 s). Zahlungen abhaken, Notizen ergänzen.
4. **Bestellung schließen** → **Drucken / Export** → mitnehmen und beim Dönermann abhaken.
5. Bei der Ausgabe „abgeholt“ anhaken. Vergessene Bestellungen mit **+ Bestellung nachtragen** ergänzen.

## Speisekarte

Die Startwerte stehen in [`src/menu-seed.json`](src/menu-seed.json) (abgetippt von den Aushängen, Stand 11/2026) und
werden beim ersten Start übernommen. Danach wird die Karte im Portal unter *Speisekarte* gepflegt. Die Cheezy-Kebap-Artikel
hatten auf dem Aushang keine Preise: Sie sind inaktiv, bis jemand Preise einträgt und sie freischaltet.
Preisänderungen betreffen nur neue Bestellungen, alte Bestellungen speichern eine Kopie ihrer Positionen.

## Betrieb auf einem Server oder als Azure Web App

- Läuft überall, wo Node.js läuft. `PORT` wird übernommen.
- Azure Web App (Linux, Node 22+): Startbefehl `npm start`, App-Einstellungen `DATA_DIR=/home/data`, `TRUST_PROXY=true`,
  `BASE_URL=https://<app>.azurewebsites.net`, ggf. PayPal-Werte. Nur **eine** Instanz betreiben (SQLite).
- Sobald die Seite aus dem Internet erreichbar ist: HTTPS verwenden (`BASE_URL` mit `https://` setzt sichere Cookies)
  und pro Runde einen **Bestell-Code** vergeben.

## Entwicklung

```bash
npm run dev     # Neustart bei Dateiänderungen
npm run smoke   # End-to-End-Test gegen einen frischen Server mit leerer Datenbank
```

Aufbau: `server.js` (Express), `src/` (Datenbank, Preisberechnung, PayPal, Routen, Druckansicht), `public/`
(Bestellseite, Status-Seite, Admin-Portal, alles ohne Build-Schritt). Preise werden immer auf dem Server aus der
Speisekarte berechnet, der Browser schickt nur Artikel-IDs und Auswahl.
