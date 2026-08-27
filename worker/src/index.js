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
    return {
      id: row.id,
      created: row.created_time,
      date: date(p['Dátum']),
      source: select(p['Forrás']),
      weight: num(p['Súly (kg)']),
      bodyFat: num(p['Testzsír (%)']),
      bmi: num(p['BMI'])
    };
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
      fat: num(p['Zsír (g)'])
    };
  });
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
  'Kreatin-glicin-taurin', 'Just Whey', 'Omega-3', 'Multivitamin', 'Nordic walking'
];

function checklistPageToJson(row) {
  const p = row.properties;
  const out = { date: date(p['Dátum']), water: num(p['Víz (pohár, 250ml)']) || 0, exercises: text(p['Gyakorlatok']) };
  CHECKLIST_CHECKBOX_FIELDS.forEach((f) => {
    out[f] = checkbox(p[f]);
  });
  return out;
}

async function getChecklistToday(env) {
  const row = await findChecklistPageToday(env);
  if (!row) {
    const out = { date: todayISO(), water: 0, exercises: '' };
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

const COACH_SYSTEM_PROMPT = `Egy felelős, részletes wellness coach vagy — NEM orvos —, aki Peter Attia (Outlive), Andrew Huberman és Rhonda Patrick szemléletében, hosszú távú egészség- (healthspan-) és teljesítményszemlélettel elemzi a felhasználó mérési és labor adatait.

Szabályok:
- Ne állíts fel diagnózist, és ne adj konkrét gyógyszerelési/kezelési utasítást — ami ebbe a kategóriába esik, azt jelöld úgy, hogy "ezt érdemes megbeszélni az orvosoddal".
- Emelj ki 2-4 konkrét, adatra hivatkozó megfigyelést: mi javul (konkrét számokkal, trenddel az idő múlásával), mi tartósan/ismétlődően a referenciatartományon kívül, és mi új figyelmeztető jel a legutóbbi méréshez képest a korábbiakhoz viszonyítva.
- Ahol releváns, magyarázd el röviden a MIÉRT-et élettani/hosszú távú egészségügyi szempontból (pl. miért számít ez a healthspan szempontjából), Attia/Huberman/Patrick szemléletében, konkrét mechanizmusra hivatkozva.
- Legyél tömör: 3-5 rövid bekezdés, természetes folyó szöveg, ne listázz nyers számokat gépiesen egymás után.
- Ha egy fontos adat hiányzik vagy régi dátumú, említsd meg, hogy érdemes lenne frissíteni.
- Magyarul írj.`;

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function callAnthropic(env, systemPrompt, userContent) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-opus-5',
      max_tokens: 4096,
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

async function regenerateCoachNotes(env, vitals, laborHistory, fingerprint) {
  try {
    const userContent = JSON.stringify({
      ma: todayISO(),
      legutobbi_ismert_meresek: vitals,
      labor_teljes_tortenet: laborHistory,
      labor_referenciatartomanyok: LAB_REFERENCE_RANGES
    });
    const notes = await callAnthropic(env, COACH_SYSTEM_PROMPT, userContent);
    await env.COACH_KV.put(COACH_KV_KEY, JSON.stringify({
      notes,
      generatedAt: new Date().toISOString(),
      dataHash: fingerprint
    }));
  } catch (err) {
    // Leave whatever notes/hash are already cached in place — since dataHash
    // is untouched on failure, the next request will naturally retry instead
    // of getting stuck on a bad write.
    console.error('coach notes regeneration failed:', err);
  }
}

async function getCoachNotes(env, ctx) {
  const [vitals, laborHistory] = await Promise.all([getVitalsToday(env), getLaborRecent(env, 100)]);
  const fingerprint = await sha256Hex(JSON.stringify({ vitals, laborHistory }));
  const cached = await env.COACH_KV.get(COACH_KV_KEY, 'json');

  if (cached && cached.dataHash === fingerprint) {
    return { notes: cached.notes, generatedAt: cached.generatedAt, stale: false };
  }

  // Data is new or changed — regenerate in the background and hand back
  // whatever's cached right now so this request never blocks on the API call.
  ctx.waitUntil(regenerateCoachNotes(env, vitals, laborHistory, fingerprint));
  return { notes: cached ? cached.notes : null, generatedAt: cached ? cached.generatedAt : null, stale: true };
}

// ---- Entry point ---------------------------------------------------------

export default {
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
        return json(await getCoachNotes(env, ctx));
      }
      return json({ error: 'not found' }, 404);
    } catch (err) {
      return json({ error: String(err) }, 500);
    }
  }
};
