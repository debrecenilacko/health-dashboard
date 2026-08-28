// Cloudflare Worker — backend for the Egészség Dashboard.
// It is the ONLY thing that holds the real Notion secret. The phone app
// never sees it; the phone app only knows a much weaker "APP_TOKEN" that
// you choose yourself, just to keep randoms off your endpoint.
//
// Deploy: see ../README.md for the exact `wrangler` commands.

const NOTION_VERSION = '2022-06-28';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization'
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}

function unauthorized() {
  return json({ error: 'unauthorized' }, 401);
}

function checkAuth(request, env) {
  const auth = request.headers.get('Authorization') || '';
  return auth === `Bearer ${env.APP_TOKEN}`;
}

async function notion(env, path, options = {}) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion API ${res.status}: ${text}`);
  }
  return res.json();
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// ---- Property readers (Notion API -> plain JS) -----------------------------
const num = (p) => (p && p.number != null ? p.number : null);
const text = (p) => (p && p.rich_text && p.rich_text[0] ? p.rich_text[0].plain_text : '');
const select = (p) => (p && p.select ? p.select.name : null);
const date = (p) => (p && p.date ? p.date.start : null);
const checkbox = (p) => !!(p && p.checkbox);
const title = (p) => (p && p.title && p.title[0] ? p.title[0].plain_text : '');

// ---- Routes ------------------------------------------------------------

// Each measurement source (manual entry, Renpho, Apple Watch, Mi Fitness) can write its
// own row for the same day, and each only fills in the fields it actually measures — so
// the single newest row is often mostly empty (e.g. an Apple Watch sleep sync with no
// weight/BP at all). Scan back through recent rows and take the latest non-null value
// per field instead, so a BP/waist entry doesn't get masked by a later weight-only sync.
const VITALS_FIELD_READERS = {
  weight: (p) => num(p['Súly (kg)']),
  waist: (p) => num(p['Derékbőség (cm)']),
  sys: (p) => num(p['Sys (Hgmm)']),
  dia: (p) => num(p['Dia (Hgmm)']),
  pulse: (p) => num(p['Pulzus (/perc)']),
  glucose: (p) => num(p['Vércukor (mmol/l)']),
  sleepHours: (p) => num(p['Alvás összesen (óra)']),
  sleepDeepMin: (p) => num(p['Mély alvás (perc)']),
  sleepRemMin: (p) => num(p['REM alvás (perc)']),
  sleepScore: (p) => num(p['Alvás pontszám']),
  sleepRestingPulse: (p) => num(p['Nyugalmi pulzus alvás közben (/perc)']),
  steps: (p) => num(p['Lépésszám']),
  activeEnergy: (p) => num(p['Aktív energia (kcal)']),
  hrv: (p) => num(p['HRV (ms)'])
};

async function getVitalsToday(env) {
  const data = await notion(env, `/databases/${env.DB_MERESEK}/query`, {
    method: 'POST',
    body: JSON.stringify({ sorts: [{ property: 'Dátum', direction: 'descending' }], page_size: 20 })
  });
  if (!data.results.length) return null;

  const out = { date: date(data.results[0].properties['Dátum']) };
  Object.keys(VITALS_FIELD_READERS).forEach((key) => { out[key] = null; });
  for (const row of data.results) {
    const p = row.properties;
    for (const key of Object.keys(VITALS_FIELD_READERS)) {
      if (out[key] == null) {
        const v = VITALS_FIELD_READERS[key](p);
        if (v != null) out[key] = v;
      }
    }
  }
  return out;
}

async function getVitalsRecent(env, limit) {
  const data = await notion(env, `/databases/${env.DB_MERESEK}/query`, {
    method: 'POST',
    body: JSON.stringify({ sorts: [{ property: 'Dátum', direction: 'descending' }], page_size: Math.min(limit || 30, 100) })
  });
  return data.results.map((row) => {
    const p = row.properties;
    const out = {
      id: row.id,
      created: row.created_time,
      date: date(p['Dátum']),
      source: select(p['Forrás']),
      bodyFat: num(p['Testzsír (%)']),
      bmi: num(p['BMI'])
    };
    Object.keys(VITALS_FIELD_READERS).forEach((key) => { out[key] = VITALS_FIELD_READERS[key](p); });
    return out;
  }).reverse();
}

// ---- Strava activity ingest (via IFTTT Webhooks) --------------------------

const STRAVA_TYPE_MAP = {
  Run: 'Futás',
  Ride: 'Kerékpár',
  Swim: 'Úszás',
  Walk: 'Séta',
  Hike: 'Séta'
};

async function findActivityByStravaId(env, stravaId) {
  const data = await notion(env, `/databases/${env.DB_AKTIVITAS}/query`, {
    method: 'POST',
    body: JSON.stringify({ filter: { property: 'Strava ID', rich_text: { equals: String(stravaId) } }, page_size: 1 })
  });
  return data.results[0] || null;
}

async function postActivityStrava(env, body) {
  // Expected body fields (from the IFTTT Strava trigger ingredients):
  // link_to_activity, name, activity_type, distance (meters), elapsed_time_in_seconds, created_at
  // IFTTT's Strava trigger has no bare activity ID or calories field, so the ID
  // is pulled out of the activity URL and calories is left for manual/Strava-MCP enrichment.
  const idMatch = body.link_to_activity ? String(body.link_to_activity).match(/activities\/(\d+)/) : null;
  const stravaId = body.strava_id ? String(body.strava_id) : (idMatch ? idMatch[1] : '');
  if (stravaId) {
    const existing = await findActivityByStravaId(env, stravaId);
    if (existing) return { skipped: true, reason: 'duplicate', id: existing.id };
  }

  const km = body.distance != null ? Math.round((Number(body.distance) / 1000) * 100) / 100 : null;
  const minutes = body.elapsed_time_in_seconds != null ? Math.round(Number(body.elapsed_time_in_seconds) / 60) : null;
  const d = (body.created_at ? String(body.created_at) : new Date().toISOString()).slice(0, 10);
  const typ = STRAVA_TYPE_MAP[body.activity_type] || 'Egyéb';

  const properties = {
    Name: { title: [{ text: { content: body.name || `Strava ${typ}` } }] },
    'Dátum': { date: { start: d } },
    'Típus': { select: { name: typ } },
    'Forrás': { select: { name: 'Automata (Strava)' } }
  };
  if (km != null) properties['Táv (km)'] = { number: km };
  if (minutes != null) properties['Idő (perc)'] = { number: minutes };
  if (body.calories != null) properties['Kalória'] = { number: Number(body.calories) };
  if (stravaId) properties['Strava ID'] = { rich_text: [{ text: { content: stravaId } }] };

  const row = await notion(env, '/pages', {
    method: 'POST',
    body: JSON.stringify({ parent: { database_id: env.DB_AKTIVITAS }, properties })
  });
  return { skipped: false, id: row.id };
}

async function getMealsToday(env) {
  const d = todayISO();
  const data = await notion(env, `/databases/${env.DB_ETKEZESEK}/query`, {
    method: 'POST',
    body: JSON.stringify({ filter: { property: 'Dátum', date: { equals: d } } })
  });
  return data.results.map((row) => {
    const p = row.properties;
    return {
      type: select(p['Típus']),
      desc: text(p['Leírás']),
      calories: num(p['Kalória']),
      protein: num(p['Fehérje (g)']),
      carbs: num(p['Szénhidrát (g)']),
      fat: num(p['Zsír (g)']),
      fiber: num(p['Rost (g)']),
      sugar: num(p['Cukor (g)'])
    };
  });
}

// Unlike getMealsToday (one exact-date filter), this covers a date range and
// aggregates multiple meals on the same day into one point per day, since
// Étkezések rows are per-meal, not per-day, and a trend chart wants one
// value per day.
async function getMealsRecent(env, days) {
  const start = new Date();
  start.setDate(start.getDate() - Math.min(days || 30, 90));
  const data = await notion(env, `/databases/${env.DB_ETKEZESEK}/query`, {
    method: 'POST',
    body: JSON.stringify({
      filter: { property: 'Dátum', date: { on_or_after: start.toISOString().slice(0, 10) } },
      sorts: [{ property: 'Dátum', direction: 'ascending' }],
      page_size: 100
    })
  });
  const byDate = {};
  data.results.forEach((row) => {
    const p = row.properties;
    const d = date(p['Dátum']);
    if (!d) return;
    if (!byDate[d]) byDate[d] = { date: d, calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0 };
    byDate[d].calories += num(p['Kalória']) || 0;
    byDate[d].protein += num(p['Fehérje (g)']) || 0;
    byDate[d].carbs += num(p['Szénhidrát (g)']) || 0;
    byDate[d].fat += num(p['Zsír (g)']) || 0;
    byDate[d].fiber += num(p['Rost (g)']) || 0;
    byDate[d].sugar += num(p['Cukor (g)']) || 0;
  });
  return Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
}

async function postMealLog(env, body) {
  const type = typeof body.type === 'string' && body.type ? body.type : 'Snack';
  const desc = typeof body.desc === 'string' ? body.desc : '';
  const properties = {
    Name: { title: [{ text: { content: desc || type } }] },
    'Dátum': { date: { start: todayISO() } },
    'Típus': { select: { name: type } },
    'Leírás': { rich_text: [{ text: { content: desc } }] }
  };
  if (typeof body.calories === 'number') properties['Kalória'] = { number: body.calories };
  if (typeof body.protein === 'number') properties['Fehérje (g)'] = { number: body.protein };
  if (typeof body.carbs === 'number') properties['Szénhidrát (g)'] = { number: body.carbs };
  if (typeof body.fat === 'number') properties['Zsír (g)'] = { number: body.fat };
  if (typeof body.fiber === 'number') properties['Rost (g)'] = { number: body.fiber };
  if (typeof body.sugar === 'number') properties['Cukor (g)'] = { number: body.sugar };
  const row = await notion(env, '/pages', {
    method: 'POST',
    body: JSON.stringify({ parent: { database_id: env.DB_ETKEZESEK }, properties })
  });
  return { ok: true, id: row.id };
}

async function getActivityRecent(env) {
  const data = await notion(env, `/databases/${env.DB_AKTIVITAS}/query`, {
    method: 'POST',
    body: JSON.stringify({ sorts: [{ property: 'Dátum', direction: 'ascending' }], page_size: 20 })
  });
  return data.results.map((row) => {
    const p = row.properties;
    return {
      date: date(p['Dátum']),
      type: select(p['Típus']),
      km: num(p['Táv (km)']),
      minutes: num(p['Idő (perc)']),
      calories: num(p['Kalória'])
    };
  });
}

async function getLaborRecent(env, limit) {
  const data = await notion(env, `/databases/${env.DB_LABOR}/query`, {
    method: 'POST',
    body: JSON.stringify({ sorts: [{ property: 'Dátum', direction: 'descending' }], page_size: Math.min(limit || 30, 100) })
  });
  return data.results.map((row) => {
    const p = row.properties;
    const out = { date: date(p['Dátum']), source: text(p['Forrás intézmény']) };
    // Include every numeric marker present on the page so the frontend can plot any of them
    // without the Worker needing to know every lab field name in advance.
    Object.keys(p).forEach((key) => {
      if (p[key] && p[key].type === 'number' && p[key].number != null) {
        out[key] = p[key].number;
      }
    });
    return out;
  }).reverse();
}

async function findChecklistPageToday(env) {
  const d = todayISO();
  const data = await notion(env, `/databases/${env.DB_CHECKLIST}/query`, {
    method: 'POST',
    body: JSON.stringify({ filter: { property: 'Dátum', date: { equals: d } } })
  });
  return data.results[0] || null;
}

const CHECKLIST_CHECKBOX_FIELDS = [
  'Rosuvastatin', 'Vidonorm', 'Nebilet', 'Rawel', 'Merckformin', 'Ozempic',
  'Kreatin-glicin-taurin', 'Just Whey', 'Omega-3', 'Multivitamin', 'Nordic walking',
  'Kurkuma-kivonat', 'NAC', 'TUDCA', 'Esti 3 órás étkezési határ', 'Exercise snack'
];

function checklistPageToJson(row) {
  const p = row.properties;
  const out = {
    date: date(p['Dátum']), water: num(p['Víz (pohár, 250ml)']) || 0,
    exercises: text(p['Gyakorlatok']), symptoms: text(p['Emésztési tünetek'])
  };
  CHECKLIST_CHECKBOX_FIELDS.forEach((f) => {
    out[f] = checkbox(p[f]);
  });
  return out;
}

async function getChecklistToday(env) {
  const row = await findChecklistPageToday(env);
  if (!row) {
    const out = { date: todayISO(), water: 0, exercises: '', symptoms: '' };
    CHECKLIST_CHECKBOX_FIELDS.forEach((f) => (out[f] = false));
    return out;
  }
  return checklistPageToJson(row);
}

async function getChecklistRecent(env, days) {
  const data = await notion(env, `/databases/${env.DB_CHECKLIST}/query`, {
    method: 'POST',
    body: JSON.stringify({ sorts: [{ property: 'Dátum', direction: 'descending' }], page_size: Math.min(days || 30, 100) })
  });
  return data.results.map(checklistPageToJson);
}

async function postChecklistToday(env, body) {
  let row = await findChecklistPageToday(env);
  const properties = {};
  if (typeof body.water === 'number') properties['Víz (pohár, 250ml)'] = { number: body.water };
  if (typeof body.exercises === 'string') properties['Gyakorlatok'] = { rich_text: [{ text: { content: body.exercises } }] };
  if (typeof body.symptoms === 'string') properties['Emésztési tünetek'] = { rich_text: [{ text: { content: body.symptoms } }] };
  CHECKLIST_CHECKBOX_FIELDS.forEach((f) => {
    if (typeof body[f] === 'boolean') properties[f] = { checkbox: body[f] };
  });

  if (!row) {
    const d = todayISO();
    row = await notion(env, '/pages', {
      method: 'POST',
      body: JSON.stringify({
        parent: { database_id: env.DB_CHECKLIST },
        properties: {
          Name: { title: [{ text: { content: d } }] },
          'Dátum': { date: { start: d } },
          ...properties
        }
      })
    });
  } else {
    row = await notion(env, `/pages/${row.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ properties })
    });
  }
  return checklistPageToJson(row);
}

async function findVitalsPageToday(env) {
  const d = todayISO();
  const data = await notion(env, `/databases/${env.DB_MERESEK}/query`, {
    method: 'POST',
    body: JSON.stringify({ filter: { property: 'Dátum', date: { equals: d } }, sorts: [{ property: 'Dátum', direction: 'descending' }] })
  });
  return data.results[0] || null;
}

async function postVitalsLog(env, body) {
  const properties = {};
  if (typeof body.weight === 'number') properties['Súly (kg)'] = { number: body.weight };
  if (typeof body.bodyFat === 'number') properties['Testzsír (%)'] = { number: body.bodyFat };
  if (typeof body.bmi === 'number') properties['BMI'] = { number: body.bmi };

  // The Renpho sync can fire several times for one weigh-in (partial then
  // corrected readings), so merge same-day writes onto one page instead of
  // creating a new one every time.
  let row = await findVitalsPageToday(env);
  if (row) {
    row = await notion(env, `/pages/${row.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ properties })
    });
  } else {
    const d = todayISO();
    row = await notion(env, '/pages', {
      method: 'POST',
      body: JSON.stringify({
        parent: { database_id: env.DB_MERESEK },
        properties: {
          Name: { title: [{ text: { content: d } }] },
          'Dátum': { date: { start: d } },
          'Forrás': { select: { name: 'Automata (Renpho)' } },
          ...properties
        }
      })
    });
  }
  return { ok: true, id: row.id };
}

// ---- Coach notes (Anthropic API) ------------------------------------------
// A short, dated, wellness-coach-style read of the current vitals + bloodwork
// trend (Attia/Huberman/Rhonda-Patrick framing, never a diagnosis). Only
// regenerated when the underlying data actually changed since the last
// generation — tracked via a SHA-256 fingerprint stored in COACH_KV — so a
// normal page load never pays for or waits on an Anthropic API call.

const COACH_KV_KEY = 'coach-notes';

// Reference ranges as configured on each property in the Notion "Labor"
// database (same source as the frontend's LAB_META — duplicated here since
// the Worker and the static frontend don't share code) so Claude reasons
// against the lab's own stated ranges instead of guessing.
const LAB_REFERENCE_RANGES = {
  'Albumin': '35.0–52.0 g/L', 'Alkalikus foszfatáz': '40–129 U/L', 'Amiláz': '28–100 U/L',
  'B12 (kobalamin)': 'pmol/L, referencia: kb. 150-670 (labortól függően eltérhet)',
  'D-vitamin (25-OH)': 'nmol/L, referencia: kb. 50-125 (elégtelen <50, hiány <30, labortól függően eltérhet)',
  'Ferritin': 'ug/L, referencia: kb. 30-400 (nemtől és labortól függően eltérhet)',
  'Folsav': 'nmol/L, referencia: kb. 7-45 (labortól függően eltérhet)',
  'Bazofil %': '0.0–1.0 %', 'CK': '<172 U/L', 'CRP': '<5.00 mg/L', 'Eozinofil %': '1.0–4.0 %',
  'Foszfát': '0.81–1.45 mmol/L', 'GGT': '<55-60 U/L', 'GOT (AST)': '<50 U/L', 'GPT (ALT)': '<50 U/L',
  'Glükóz': '3.7–6.0 mmol/L (éhgyomri)', 'HDL koleszterin': '>1.04 mmol/L',
  'HbA1c IFCC': '20.0–39.0 mmol/mol', 'HbA1c NGSP': '4.0–5.6 %', 'Hematokrit': '0.40–0.52 L/L',
  'Hemoglobin': '135–175 g/L', 'Húgysav': '202–428 umol/L', 'Kalcium': '2.15–2.65 mmol/L',
  'Karbamid': '2.1–7.2 mmol/L', 'Koleszterin': '<5.2 mmol/L', 'Kreatinin': '62–106 umol/L',
  'Kálium': '3.5–5.1 mmol/L', 'LDH': 'referencia labortól függ (<250 vagy 240-480)',
  'LDL koleszterin': '<3.34 mmol/L', 'Limfocita %': '25.0–40.0 %', 'Lipáz': '<67 U/L',
  'MCH': '28–33 pg', 'MCHC': '310–365 g/L', 'MCV': '80–96 fL', 'MPV': '7.2–13.0 fL',
  'Magnézium': '0.73–1.06 mmol/L', 'Monocita %': '2.0–8.0 %', 'Neutrofil %': '50.0–70.0 %',
  'Nátrium': '136–146 mmol/L', 'PSA': '<4.00 ug/L', 'RBC': '4.5–5.9 T/L', 'RDW': '11.6–15.6 %',
  'TSH': '0.550–4.780 mIU/L', 'Trigliceridek': '<1.71 mmol/L', 'Trombocitaszám': '150–450 G/L',
  'Vas (Fe)': '12.5–32.2 umol/L', 'WBC': '4.4–11.3 G/L', 'We (süllyedés)': '2–10 mm/h',
  'eGFR': '>90 mL/min/1.73m2', 'Összbilirubin': '5.0–21.0 umol/L', 'Összfehérje': '66.0–87.0 g/L'
};

// Five short, tab-scoped sections instead of one long Labor-only blob — each
// analyzes only its own domain's trend so it's readable inline on that tab.
// Generated as 5 independent parallel API calls (see regenerateCoachNotes)
// rather than one call returning structured JSON: that earlier approach
// took 100-125s sequentially and occasionally hit a 524 gateway timeout,
// and Anthropic didn't always return parseable JSON. Parallel plain-text
// calls are both faster (concurrent, not sequential) and simpler (no
// parsing to get wrong).
const COACH_BASE_PROMPT = `Egy felelős wellness coach vagy — NEM orvos —, aki Peter Attia (Outlive), Andrew Huberman és Rhonda Patrick szemléletében, hosszú távú egészség- (healthspan-) és teljesítményszemlélettel elemzi a felhasználó adatait.

Szabályok:
- Ne állíts fel diagnózist, és ne adj konkrét gyógyszerelési/kezelési utasítást — ami ebbe a kategóriába esik, azt jelöld úgy, hogy "ezt érdemes megbeszélni az orvosoddal".
- Konkrét, adatra hivatkozó megfigyelés a trendről (mi javul, mi romlik, mi stagnál — számokkal), rövid MIÉRT (healthspan-szempontú mechanizmus), és egy konkrét következő lépés.
- Ha nincs elég adat az adott területhez, mondd ki röviden ahelyett, hogy kitalálnál valamit.
- Ha a bariatriai_mutet_terv mezőben van dátum és releváns, említsd meg röviden — de a kiegészítők konkrét leállítási határidejét az app külön figyelmezetésben már jelzi, ezt ne ismételd meg.
- Magyarul írj, természetes folyó szöveg — NE markdown, NE JSON, NE lista, csak a bekezdések simán, egymástól üres sorral elválasztva. Ne írj bevezető mondatot vagy címet, kezdd rögtön az elemzéssel.`;

const COACH_SECTIONS = {
  vitals: { label: 'a mérési (testsúly, vérnyomás, alvás, HRV, pulzus) adatokat', length: '1-2 rövid bekezdésben', maxTokens: 1024 },
  activity: { label: 'a mozgás/aktivitás adatokat', length: '1-2 rövid bekezdésben', maxTokens: 1024 },
  nutrition: { label: 'a táplálkozási (kalória, makrók, víz) adatokat', length: '1-2 rövid bekezdésben', maxTokens: 1024 },
  meds: { label: 'a gyógyszer/kiegészítő/napi rutin betartásának adatait', length: '1-2 rövid bekezdésben', maxTokens: 1024 },
  labor: { label: 'a labor (vérkép, vesefunkció, májfunkció, lipidek, anyagcsere) adatokat', length: '3-5 bekezdésben — ez lehet a legrészletesebb', maxTokens: 3072 }
};

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function callAnthropic(env, systemPrompt, userContent, maxTokens) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-opus-5',
      max_tokens: maxTokens || 4096,
      // "medium" effort — one short-to-medium coaching section from
      // structured data doesn't need max-depth reasoning. Generating all 5
      // sections sequentially in a single call used to push past 120s and
      // occasionally hit a 524 gateway timeout; now each section is its own
      // parallel call (see regenerateCoachNotes), so this mainly keeps
      // per-call latency low rather than being the main speed lever.
      output_config: { effort: 'medium' },
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }]
    })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${text}`);
  }
  const data = await res.json();
  const textBlock = (data.content || []).find((b) => b.type === 'text');
  if (!textBlock) throw new Error('Anthropic API: no text block in response');
  return textBlock.text;
}

// ---- Surgery plan (bariatric consultation/op dates) ------------------------
// Stored in the same COACH_KV namespace — just two dates, no need for a
// dedicated resource. consultationDate defaults to the known 2026-11-13
// consultation; estimatedSurgeryDate starts unset and is filled in once known.

const SURGERY_PLAN_KV_KEY = 'surgery-plan';
const DEFAULT_SURGERY_PLAN = { consultationDate: '2026-11-13', estimatedSurgeryDate: null };
// Supplements the checklist tracks that must stop before surgery (per their
// own Notion property descriptions — bleeding-risk/GI reasons, 1-2 weeks out).
const PRE_OP_STOP_SUPPLEMENTS = ['Kurkuma-kivonat', 'NAC', 'TUDCA'];

async function getSurgeryPlan(env) {
  const plan = await env.COACH_KV.get(SURGERY_PLAN_KV_KEY, 'json');
  return plan || DEFAULT_SURGERY_PLAN;
}

async function saveSurgeryPlan(env, body) {
  const plan = {
    consultationDate: typeof body.consultationDate === 'string' && body.consultationDate ? body.consultationDate : DEFAULT_SURGERY_PLAN.consultationDate,
    estimatedSurgeryDate: typeof body.estimatedSurgeryDate === 'string' && body.estimatedSurgeryDate ? body.estimatedSurgeryDate : null
  };
  await env.COACH_KV.put(SURGERY_PLAN_KV_KEY, JSON.stringify(plan));
  return plan;
}

// ---- Suggested tests (persistent checklist) --------------------------------
// A simple user-editable list the coach's own past recommendations seed —
// stored whole in COACH_KV and replaced wholesale on every save (no per-item
// diffing needed at this scale).

const SUGGESTED_TESTS_KV_KEY = 'suggested-tests';
const DEFAULT_SUGGESTED_TESTS = [
  { id: 'apob', text: 'ApoB', done: false },
  { id: 'lpa', text: 'Lp(a)', done: false },
  { id: 'hscrp', text: 'hsCRP', done: false },
  { id: 'transzferrin-szat', text: 'Transzferrin szaturáció', done: false },
  { id: 'alvasvizsgalat', text: 'Alvásvizsgálat (poliszomnográfia)', done: false },
  { id: 'fib4', text: 'FIB-4 / májelasztográfia', done: false },
  { id: 'kalcium-recheck', text: 'Kalcium-recheck', done: false }
];

async function getSuggestedTests(env) {
  const tests = await env.COACH_KV.get(SUGGESTED_TESTS_KV_KEY, 'json');
  return tests || DEFAULT_SUGGESTED_TESTS;
}

async function saveSuggestedTests(env, body) {
  const items = Array.isArray(body.items)
    ? body.items
        .filter((it) => it && typeof it.text === 'string' && it.text.trim())
        .map((it) => ({
          id: typeof it.id === 'string' && it.id ? it.id : crypto.randomUUID(),
          text: it.text.trim(),
          done: !!it.done
        }))
    : DEFAULT_SUGGESTED_TESTS;
  await env.COACH_KV.put(SUGGESTED_TESTS_KV_KEY, JSON.stringify(items));
  return items;
}

// Everything the coach prompt reasons over, gathered once per request/tick.
async function gatherCoachInputs(env) {
  const [vitals, laborHistory, surgeryPlan, checklistHistory, activityHistory, mealsHistory] = await Promise.all([
    getVitalsToday(env),
    getLaborRecent(env, 100),
    getSurgeryPlan(env),
    getChecklistRecent(env, 30),
    getActivityRecent(env),
    getMealsRecent(env, 30)
  ]);
  return { vitals, laborHistory, surgeryPlan, checklistHistory, activityHistory, mealsHistory };
}

async function regenerateCoachNotes(env, inputs, fingerprint) {
  // Kept so a section that fails this round can fall back to its last good
  // text instead of going blank — a partial failure shouldn't regress a tab
  // that was working, and since dataHash advances regardless (see below),
  // an untouched failure here wouldn't get retried until data changes again.
  const previous = await env.COACH_KV.get(COACH_KV_KEY, 'json');
  const previousSections = (previous && previous.sections) || {};

  const userContent = JSON.stringify({
    ma: todayISO(),
    legutobbi_ismert_meresek: inputs.vitals,
    labor_teljes_tortenet: inputs.laborHistory,
    labor_referenciatartomanyok: LAB_REFERENCE_RANGES,
    bariatriai_mutet_terv: inputs.surgeryPlan,
    napi_checklist_30_nap: inputs.checklistHistory,
    mozgas_tortenet: inputs.activityHistory,
    taplalkozas_napi_osszesitve_30_nap: inputs.mealsHistory
  });

  const keys = Object.keys(COACH_SECTIONS);
  const results = await Promise.allSettled(keys.map((key) => {
    const cfg = COACH_SECTIONS[key];
    const systemPrompt = COACH_BASE_PROMPT + `\n\nEbben a válaszban KIZÁRÓLAG ${cfg.label} elemezd, ${cfg.length}.`;
    return callAnthropic(env, systemPrompt, userContent, cfg.maxTokens);
  }));

  const sections = {};
  let anySuccess = false;
  results.forEach((r, i) => {
    const key = keys[i];
    if (r.status === 'fulfilled' && r.value && r.value.trim()) {
      sections[key] = r.value.trim();
      anySuccess = true;
    } else {
      console.error('coach section failed:', key, r.status === 'rejected' ? r.reason : 'empty response');
      sections[key] = previousSections[key] || null;
    }
  });
  if (!anySuccess) return; // total failure — leave the old cache/hash untouched so this gets retried next tick

  await env.COACH_KV.put(COACH_KV_KEY, JSON.stringify({
    sections,
    generatedAt: new Date().toISOString(),
    dataHash: fingerprint
  }));
}

// A page load just reads whatever's cached — instant, no external calls.
// Regeneration itself happens on a cron schedule (see `scheduled` below),
// never inside a request: an earlier version tried to kick it off via
// ctx.waitUntil() after the response, but Cloudflare only grants a background
// task a short window post-response, and a multi-paragraph Opus 5 generation
// (with adaptive thinking) doesn't reliably fit — the task got silently
// cancelled ("waitUntil() tasks did not complete within the allowed time").
// A cron invocation gets its own full execution budget instead.
async function getCoachNotes(env) {
  const [inputs, cached] = await Promise.all([gatherCoachInputs(env), env.COACH_KV.get(COACH_KV_KEY, 'json')]);
  if (!cached) return { sections: null, generatedAt: null, stale: true };
  const fingerprint = await sha256Hex(JSON.stringify(inputs));
  return { sections: cached.sections, generatedAt: cached.generatedAt, stale: cached.dataHash !== fingerprint };
}

// Runs on the cron schedule in wrangler.toml. Cheap on every tick (a handful
// of Notion reads + one KV read) unless the data fingerprint actually
// changed, in which case it calls the Anthropic API and writes the fresh
// sections to COACH_KV.
async function checkAndRegenerateCoachNotes(env) {
  const inputs = await gatherCoachInputs(env);
  const fingerprint = await sha256Hex(JSON.stringify(inputs));
  const cached = await env.COACH_KV.get(COACH_KV_KEY, 'json');
  if (cached && cached.dataHash === fingerprint) return;
  await regenerateCoachNotes(env, inputs, fingerprint);
}

// ---- Entry point ---------------------------------------------------------

export default {
  // Awaited directly (not wrapped in ctx.waitUntil) — the invocation stays
  // alive for as long as this function hasn't returned, which is simpler and
  // more reliable here than the fire-and-forget pattern: that returns
  // immediately and relies on a separate, shorter post-completion grace
  // window for the background promise, which a multi-paragraph Opus 5
  // generation didn't reliably fit into (confirmed both on the deployed
  // Worker and against /__scheduled in `wrangler dev --remote`).
  async scheduled(event, env, ctx) {
    await checkAndRegenerateCoachNotes(env);
  },

  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });
    if (!checkAuth(request, env)) return unauthorized();

    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/vitals/today' && request.method === 'GET') {
        return json(await getVitalsToday(env));
      }
      if (url.pathname === '/api/vitals/recent' && request.method === 'GET') {
        const limit = Number(url.searchParams.get('limit')) || 30;
        return json(await getVitalsRecent(env, limit));
      }
      if (url.pathname === '/api/meals/today' && request.method === 'GET') {
        return json(await getMealsToday(env));
      }
      if (url.pathname === '/api/meals/log' && request.method === 'POST') {
        const body = await request.json();
        return json(await postMealLog(env, body));
      }
      if (url.pathname === '/api/meals/recent' && request.method === 'GET') {
        const days = Number(url.searchParams.get('days')) || 30;
        return json(await getMealsRecent(env, days));
      }
      if (url.pathname === '/api/activity/recent' && request.method === 'GET') {
        return json(await getActivityRecent(env));
      }
      if (url.pathname === '/api/activity/strava-log' && request.method === 'POST') {
        const body = await request.json();
        return json(await postActivityStrava(env, body));
      }
      if (url.pathname === '/api/labor/recent' && request.method === 'GET') {
        const limit = Number(url.searchParams.get('limit')) || 30;
        return json(await getLaborRecent(env, limit));
      }
      if (url.pathname === '/api/checklist/today' && request.method === 'GET') {
        return json(await getChecklistToday(env));
      }
      if (url.pathname === '/api/checklist/recent' && request.method === 'GET') {
        const days = Number(url.searchParams.get('days')) || 30;
        return json(await getChecklistRecent(env, days));
      }
      if (url.pathname === '/api/checklist/today' && request.method === 'POST') {
        const body = await request.json();
        return json(await postChecklistToday(env, body));
      }
      if (url.pathname === '/api/vitals/log' && request.method === 'POST') {
        const body = await request.json();
        return json(await postVitalsLog(env, body));
      }
      if (url.pathname === '/api/coach-notes' && request.method === 'GET') {
        return json(await getCoachNotes(env));
      }
      if (url.pathname === '/api/surgery-plan' && request.method === 'GET') {
        return json(await getSurgeryPlan(env));
      }
      if (url.pathname === '/api/surgery-plan' && request.method === 'POST') {
        const body = await request.json();
        return json(await saveSurgeryPlan(env, body));
      }
      if (url.pathname === '/api/suggested-tests' && request.method === 'GET') {
        return json(await getSuggestedTests(env));
      }
      if (url.pathname === '/api/suggested-tests' && request.method === 'POST') {
        const body = await request.json();
        return json(await saveSuggestedTests(env, body));
      }
      return json({ error: 'not found' }, 404);
    } catch (err) {
      return json({ error: String(err) }, 500);
    }
  }
};
