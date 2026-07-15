# Egészség Dashboard

Személyes egészség-dashboard telefonra: mérések, mozgás, táplálkozás és
napi gyógyszer/kiegészítő/víz checklist — **élőben szinkronban a
Notionoddal**.

## Hogyan függ össze

```
telefon (index.html + app.js)
        │  fetch, Bearer APP_TOKEN
        ▼
Cloudflare Worker (worker/)
        │  Notion API, Bearer NOTION_TOKEN
        ▼
Notion — 4 tábla a "🩺 Egészség napló" oldal alatt:
  · Mérések        (súly, derék, vérnyomás, pulzus, vércukor)
  · Aktivitás       (Strava mozgások)
  · Étkezések       (napi étkezések)
  · Napi checklist  (gyógyszerek, kiegészítők, Nordic walking, víz, gyakorlatok)
```

A telefon **soha nem** látja a Notion tokent — csak a Worker látja. A
telefon egy sokkal gyengébb, magad választotta `APP_TOKEN`-nel jelentkezik
be a Workerbe, hogy ne bárki tudja hívogatni.

A checklist-pipálások (gyógyszer, víz, Nordic walking, gyakorlatok) most
már **valóban visszaírnak a Notion "Napi checklist" táblájába** — ha
megnyitod Notionban, ugyanazt látod, amit a telefonon pipáltál.

## 1. lépés — Notion integráció létrehozása (te csinálod)

Ezt neked kell megtenned, mert ez egy fiók-szintű titkos kulcs, amit nem
oszthatok meg/kezelhetek helyetted:

1. Menj ide: <https://www.notion.so/my-integrations>
2. "New integration" → adj neki nevet (pl. "Egészség Dashboard") →
   Create.
3. Másold ki az "Internal Integration Secret"-et (`ntn_...` vagy
   `secret_...` kezdetű) — ez lesz a `NOTION_TOKEN`.
4. Notionban nyisd meg a **"🩺 Egészség napló"** oldalt, és a jobb
   felső "..." → "Connections" → add hozzá az imént létrehozott
   integrációt. Ez a 4 alatta lévő táblára is kiterjed.

## 2. lépés — Cloudflare Worker deploy (te csinálod, én megírtam a kódot)

Szükséged lesz egy ingyenes Cloudflare fiókra.

```bash
cd health-dashboard/worker
npm install -g wrangler   # ha még nincs telepítve
wrangler login             # böngészőben bejelentkezés a saját Cloudflare fiókodba

wrangler secret put NOTION_TOKEN
# illeszd be az 1. lépésben kapott tokent

wrangler secret put APP_TOKEN
# gondolj ki egy saját jelszót, pl. egy hosszú random string — ezt kéri majd az app

wrangler deploy
```

A `wrangler deploy` a végén kiírja a Worker URL-jét, valami ilyesmi:
`https://egeszseg-dashboard-api.<felhasznalonev>.workers.dev` — ez kell
a következő lépéshez.

A `wrangler.toml`-ban már benne vannak a 4 Notion adatbázis ID-je (ezek
nem titkosak önmagukban, csak a tokennel együtt érnek valamit).

## 3. lépés — Frontend

```bash
cd health-dashboard
git remote add origin https://github.com/<felhasznalonev>/health-dashboard.git
git push -u origin main
```

Utána a GitHub repo → Settings → Pages → Source: `main` / `/ (root)`.
Pár perc múlva elérhető: `https://<felhasznalonev>.github.io/health-dashboard/`

Nyisd meg a telefonon. Első betöltéskor két mezőt kér:
1. a Worker URL-jét (2. lépés végén kaptad)
2. az `APP_TOKEN`-t (amit te választottál)

Ezeket egyszer kell megadni, utána a telefon localStorage-ában marad.

**"Kezdőképernyőhöz adás"**: Safari/Chrome megosztás menü → így egy
önálló app-ikonként fog megnyílni, böngészősáv nélkül.

## Amit magamtól megcsináltam (nincs más teendőd rajta)

- A 4 Notion tábla létrehozva és feltöltve a meglévő adatokkal
- A teljes Worker backend kód (`worker/src/index.js`)
- A teljes frontend, ami ehhez a backendhez van drótozva
- Mostantól amikor itt a chatben diktálod/fényképezed az adatokat, azokat
  továbbra is beírom a Notionba — és a telefonos app ugyanazt fogja
  mutatni, mert onnan olvas.

## Amit neked kell csinálnod (fiók/titok miatt nem tehetem meg helyetted)

- Notion integráció létrehozása + megosztása (1. lépés)
- Cloudflare fiók + `wrangler login` + `wrangler deploy` (2. lépés)
- GitHub repo push + Pages bekapcsolása (3. lépés)

Ha bármelyik lépésnél elakadsz, másold ide a hibaüzenetet és
végigmegyünk rajta.

## Fájlstruktúra

```
health-dashboard/
├── index.html         — UI (fülek, checklistek, grafikon)
├── app.js              — frontend logika, API-hívások a Workerhez
├── manifest.json        — PWA manifeszt (kezdőképernyő ikon)
├── worker/
│   ├── src/index.js     — Cloudflare Worker: Notion API híd
│   └── wrangler.toml    — Worker konfiguráció (database ID-k)
└── README.md            — ez a fájl
```
