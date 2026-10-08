# untis-to-api

Automatisiert den Vertretungsplan der Example School aus weitergeleiteten IServ-Mails und stellt die Daten als JSON-API bereit.

Die aktuelle Produktivkonfiguration verarbeitet alle unterstützten Klassen; `DEFAULT_CLASS` bleibt für die rückwärtskompatible API-Abkürzung auf `9-G1` gesetzt.

## Architektur

~~~text
IServ
  |
  | automatische Weiterleitung
  v
Cloudflare Email Routing
  |
  v
Cloudflare Worker
  |- Absender prüfen
  |- E-Mail/MIME parsen
  |- PDF-Anhang finden
  |- PDF-Text extrahieren
  |- Datum + Untis-Version erkennen
  |- alle unterstützten Klassen extrahieren
  |- Original-PDF -> R2
  '- strukturierte Daten -> D1
          |
          v
   JSON API /vertretung/plan/...
~~~

postal-mime ist für Cloudflare Email Workers geeignet und kann message.raw direkt verarbeiten. pdf-parse unterstützt Cloudflare Workers und die PDFParse-API zur Textextraktion.

## Warum das Datum aus dem PDF kommt

Der Empfangstag der Mail ist **nicht** das Plan-Datum.

Beim Beispiel-PDF steht:

~~~text
8.10.2026 (2)
Vertretungsplan Klassen 9.10. / Freitag
~~~

Daraus wird:

~~~text
planDate = 2026-10-09
version  = 2
~~~

Eine Mail, die am 08.10. eingeht, kann deshalb einen Plan für den 09.10. enthalten.

## API

### Neueste Version für 9-G1

~~~text
GET /vertretung/plan/2026-10-09
~~~

### Bestimmte Version

~~~text
GET /vertretung/plan/2026-10-09/2
~~~

### Bestimmte Version und Klasse

~~~text
GET /vertretung/plan/2026-10-09/2/9-G1
~~~

Die erste Variante sucht die höchste vorhandene Version.

## Voraussetzungen

- Node.js 20 oder neuer
- npm
- Cloudflare-Konto
- Domain, die in Cloudflare verwaltet wird
- Zugriff auf die IServ-Weiterleitung

Für den PDF-Parser ist Cloudflare Workers Paid für den Produktivbetrieb sinnvoll, weil PDF-Verarbeitung CPU-Zeit benötigt. Prüfe vor dem Betrieb die aktuell geltenden Worker-Limits.

## 1. Repository

~~~bash
git clone https://github.com/henrymmey/untis-to-api.git
cd untis-to-api
npm install
~~~

## 2. Cloudflare CLI anmelden

~~~bash
npx wrangler login
npx wrangler whoami
~~~

Der Browser öffnet sich. Cloudflare-Zugriff erlauben.

## 3. D1-Datenbank erstellen

~~~bash
npx wrangler d1 create untis_to_api --location weur --jurisdiction eu
~~~

Wrangler gibt eine Datenbank-ID zurück.

In wrangler.jsonc die Zeile

~~~json
"database_id": "DEINE-D1-ID"
~~~

eintragen.

## 4. R2-Bucket erstellen

~~~bash
npx wrangler r2 bucket create untis-to-api-pdfs
~~~

Der Name muss mit dem Bucket in wrangler.jsonc übereinstimmen.

R2 enthält die Original-PDFs und ist nicht öffentlich freigegeben.

## 5. D1-Migration auf Produktion anwenden

~~~bash
npx wrangler d1 migrations apply untis_to_api --remote
~~~

Danach:

~~~bash
npx wrangler d1 migrations list untis_to_api --remote
~~~

## 6. Domain konfigurieren

In wrangler.jsonc:

~~~json
"routes": [
  {
    "pattern": "domain.de/vertretung/*",
    "zone_name": "domain.de"
  }
]
~~~

Beide Werte durch deine echte Domain ersetzen.

Beispiel:

~~~json
"routes": [
  {
    "pattern": "api.meinedomain.de/vertretung/*",
    "zone_name": "meinedomain.de"
  }
]
~~~

Die Zone muss in deinem Cloudflare-Konto liegen.

## 7. Einstellungen

In wrangler.jsonc:

~~~json
"vars": {
  "ALLOWED_SENDER": "vertretung@example-school.de",
  "TARGET_CLASS": "9-G1"
}
~~~

ALLOWED_SENDER verhindert, dass beliebige Personen PDFs einschleusen.

DEFAULT_CLASS bestimmt die Klasse für API-Aufrufe ohne explizite Klassenangabe.

## 8. Worker deployen

~~~bash
npm run deploy
~~~

## 9. Cloudflare Email Routing

Im Cloudflare Dashboard deine Domain auswählen und zu **Email → Email Routing** gehen.

Email Routing für die Domain aktivieren.

Eine Adresse anlegen, beispielsweise:

~~~text
vertretung@deinedomain.de
~~~

Die eingehende Route muss an den Worker **untis-to-api** übergeben werden.

Du brauchst für diese Adresse keine normale Mailbox. Die Mail geht direkt an den Email-Handler des Workers.

## 10. IServ einrichten

In IServ die automatische Weiterleitung einrichten:

~~~text
vertretung@example-school.de
        |
        v
vertretung@deinedomain.de
~~~

Der Worker prüft den SMTP/envelope sender und zusätzlich den From-Header, soweit vorhanden.

## 11. Erste Testmail

Schicke einen echten Vertretungsplan durch die Weiterleitung.

Logs beobachten:

~~~bash
npx wrangler tail untis-to-api
~~~

Bei Erfolg erscheint:

~~~text
Substitution plan processed successfully.
~~~

## 12. API testen

Angenommen das PDF enthält:

~~~text
8.10.2026 (2)
Vertretungsplan Klassen 9.10. / Freitag
~~~

Dann:

~~~bash
curl https://deinedomain.de/vertretung/plan/2026-10-09/2
~~~

## 13. Mehrere Versionen

Untis kann beispielsweise senden:

~~~text
8.10.2026 (1)
8.10.2026 (2)
8.10.2026 (3)
8.10.2026 (4)
~~~

Alle werden getrennt gespeichert:

~~~text
/vertretung/plan/2026-10-09/1
/vertretung/plan/2026-10-09/2
/vertretung/plan/2026-10-09/3
/vertretung/plan/2026-10-09/4
~~~

/vertretung/plan/2026-10-09 liefert automatisch Version 4.

## 14. D1 kontrollieren

~~~bash
npx wrangler d1 execute untis_to_api --remote --command "SELECT plan_date, version, class_name, source_filename FROM plans ORDER BY plan_date DESC, version DESC;"
~~~

## 15. R2 kontrollieren

~~~bash
npx wrangler r2 bucket list
~~~

Objekte werden ungefähr so abgelegt:

~~~text
plans/
  2026-10-09/
    2/
      9-G1/
        source.pdf
~~~

## 16. Lokale Entwicklung

~~~bash
npm run types
npm run typecheck
npm run db:migrate:local
npm run dev
~~~

Die lokale D1-Datenbank ist von der Produktion getrennt.

## 17. Code ändern und deployen

~~~bash
git add .
git commit -m "Update parser"
git push
npm run deploy
~~~

Ein GitHub-Push allein deployed noch nicht nach Cloudflare. Später kann GitHub Actions das automatisch übernehmen.

## 18. Parser

Der Parser sucht im PDF insbesondere nach:

- DD.MM.YYYY (Version)
- Vertretungsplan Klassen DD.MM. / Wochentag
- Zeilen für die konfigurierte Klasse
- Entfall
- Freisetzung
- Vertretung
- Betreuung
- Statt-Vertretung
- Raum-Vtr.

Die aktuelle Logik ist an die vorliegende Untis-Struktur angepasst und speichert alle erkannten Klassen. Wenn die Schule das PDF-Layout ändert, muss der Parser mit einem neuen Beispiel getestet werden.

## 19. Warum R2 und D1?

R2 speichert das unveränderte Original-PDF.

D1 speichert die bereits extrahierten JSON-Daten.

Dadurch muss ein API-Aufruf nicht erneut das PDF parsen.

## 20. Datenschutz

Die API kann öffentlich sein, die Original-PDFs bleiben privat im R2-Bucket.

Prüfe vor einer öffentlichen Weitergabe, ob die Schule die Veröffentlichung der Vertretungsplandaten erlaubt.

## 21. Nächste sinnvolle Erweiterungen

- automatische GitHub-Actions-Deployments
- mehrere Klassen
- OpenAPI-Spezifikation
- /vertretung/today
- /vertretung/latest
- iCal
- Discord-Bot
- Parser-Tests mit mehreren echten PDFs
- Monitoring bei ausbleibenden Plänen
- bessere Erkennung verschiedener Untis-PDF-Layouts


## 22. Optional: automatisches Deployment über GitHub Actions

Im Repository liegt bereits .github/workflows/deploy.yml.

Damit jeder Push auf main automatisch nach Cloudflare deployed wird:

1. Cloudflare Dashboard öffnen.
2. Einen API Token mit den für Workers benötigten Berechtigungen erstellen.
3. In GitHub zu Settings → Secrets and variables → Actions gehen.
4. Zwei Repository-Secrets anlegen:
   - CLOUDFLARE_API_TOKEN
   - CLOUDFLARE_ACCOUNT_ID
5. Danach:

~~~bash
git add .
git commit -m "Enable automatic deployment"
git push
~~~

GitHub Actions installiert die Abhängigkeiten, erzeugt die Worker-Typen, führt den Typecheck aus und deployt anschließend.

Wenn du das automatische Deployment nicht möchtest, kannst du .github/workflows/deploy.yml löschen und weiterhin manuell mit npm run deploy arbeiten.

## 23. Fehlerdiagnose

### Mail kommt nicht an

Prüfen:

- Cloudflare Email Routing ist für die Domain aktiviert.
- Die Empfangsadresse existiert.
- Die Route zeigt auf untis-to-api.
- IServ leitet tatsächlich weiter.
- Im Cloudflare Email-Routing-Log ist die Mail sichtbar.
- npx wrangler tail untis-to-api zeigt keinen Reject.

### PDF wird nicht erkannt

Prüfen:

- Die Mail enthält wirklich einen PDF-Anhang.
- Die PDF ist textbasiert und nicht nur ein Scan.
- Im PDF steht die Klasse als K 9-G1.
- Im PDF steht die Untis-Version im Format DD.MM.YYYY (N).
- Im PDF steht die Überschrift Vertretungsplan Klassen DD.MM. / ...

### Falsches Datum

Der Parser nimmt bewusst nicht den Mail-Empfangstag. Wenn das PDF ein anderes Datumsformat verwendet, muss findPlanDate in src/parser.ts angepasst werden.

### CPU-Fehler

PDF-Parsing ist der teuerste Teil. Wenn der Worker wegen CPU-Limits abbricht, zuerst den Cloudflare-Tarif und die aktuelle Worker-Limit-Dokumentation prüfen. Bei größeren PDFs sollte die Architektur ggf. auf eine asynchrone Verarbeitung über eine Queue erweitert werden.


## API authentication

The plan API requires a Bearer API key. The key is stored as a Cloudflare Worker Secret and must not be committed to Git.

Set it once from the repository root:

```bash
npx wrangler secret put API_KEY
```

Enter a long random value when Wrangler asks for it. After that, API requests must include:

```http
Authorization: Bearer YOUR_API_KEY
```

Example:

```bash
curl -H "Authorization: Bearer YOUR_API_KEY" https://api.grueneeule.de/vertretung/plan/2026-10-09
```

Requests without the correct key receive HTTP 401. API responses use `Cache-Control: no-store` so authenticated plan data is not publicly cached.


## Mehrbenutzer-Dashboard

Das Dashboard auf `obs.henrymeyer.de` verwendet eine eigene E-Mail-Code-Anmeldung.

Ablauf:

1. Der Nutzer gibt nur den Benutzernamen vor dem `@` ein, z. B. `henry.meyer`.
2. Der Worker ergänzt automatisch `@obs-hagen-atw.de`.
3. Ein sechsstelliger Einmalcode wird an die IServ-Adresse gesendet.
4. Nach erfolgreicher Anmeldung wählt der Nutzer seine Klasse aus.
5. Das Dashboard zeigt anschließend immer den Plan dieser Klasse.
6. Unter **Einstellungen** kann die Klasse jederzeit geändert werden.

Unterstützte Auswahl:

- Klassenstufe 5 bis 10
- Gymnasium (G)
- Oberschule (O)
- Realschule (R)
- Hauptschule (H)
- Klassennummer frei als Zahl

Die Klassen werden bewusst nicht serverseitig gegen eine Klassenliste geprüft. Der Nutzer darf eine andere Klasse auswählen und sieht dann deren Plan.

### Zentrale Plan-Einspeisung

Nur der Betreiber muss den IServ-Vertretungsplan einmalig weiterleiten:

~~~text
IServ Vertretungsplan
        |
        v
vertretung@api.grueneeule.de
        |
        v
Cloudflare Worker
        |
        +--> alle erkannten Klassen -> D1
        +--> Original-PDF -> R2
~~~

Andere Nutzer müssen keine Mailweiterleitung einrichten.

### Outbound E-Mail

Die Login-Codes werden über den Cloudflare Email Service aus dem Worker versendet. Dafür ist in `wrangler.jsonc` ein `send_email`-Binding mit dem Absender `noreply.homelab@henrymeyer.de` konfiguriert.

Vor dem ersten produktiven Versand muss `henrymeyer.de` im Cloudflare Email Service für Email Sending onboarded sein. Cloudflare verlangt dafür die entsprechende Domain-Konfiguration einschließlich SPF/DKIM. Das Binding ist auf den genannten Absender beschränkt.

### D1-Migration

Nach dem Deploy der neuen Version muss die Auth-Migration einmalig auf Produktion angewendet werden:

~~~bash
npx wrangler d1 migrations apply untis_to_api --remote
~~~

Danach existieren die Tabellen:

~~~text
users
login_codes
sessions
plans
~~~

### API

Die bisherige API bleibt erhalten. Ohne Klassenangabe verwendet sie weiterhin `DEFAULT_CLASS`, aktuell `9-G1`.

Für eine andere Klasse:

~~~text
GET /vertretung/plan/2026-10-09/2/9-G2
~~~

Für eine bestimmte Version:

~~~text
GET /vertretung/plan/2026-10-09/2/9-G2
~~~

Die API bleibt über den Bearer-API-Key geschützt. Das Web-Dashboard verwendet dagegen die E-Mail-Code-Session und benötigt keinen API-Key.
