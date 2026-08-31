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
  bodyFat: (p) => num(p['Testzsír (%)']),
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

// ---- Nutrition MCP meal -> Notion sync -------------------------------------
// The Nutrition MCP (a separate, self-hosted Supabase-backed service the
// user logs meals into via chat) is not the same system as this dashboard's
// Notion-backed Étkezések table. A Postgres trigger on its `meals` table
// calls this endpoint on every insert/update so those meals show up here
// too, without the two systems needing to be manually kept in sync.
const MEAL_TYPE_HU = { breakfast: 'Reggeli', lunch: 'Ebéd', dinner: 'Vacsora', snack: 'Snack' };

async function handleSyncMeal(request, env) {
  const secret = request.headers.get('X-Sync-Secret');
  if (secret !== env.SYNC_SECRET) return unauthorized();
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }
  const rec = payload.record;
  if (!rec) return json({ error: 'no record' }, 400);
  try {
    await syncMealRecordToNotion(env, rec);
    return json({ ok: true });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
}

// Called by an AFTER DELETE trigger on the Nutrition MCP's `meals` table, so
// a meal deleted there doesn't leave an orphaned row in Notion. Archives
// rather than hard-deletes, matching how Notion's own UI trash works.
async function handleSyncMealDelete(request, env) {
  const secret = request.headers.get('X-Sync-Secret');
  if (secret !== env.SYNC_SECRET) return unauthorized();
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }
  const pageId = payload.notion_page_id;
  if (!pageId) return json({ error: 'no notion_page_id' }, 400);
  try {
    await notion(env, `/pages/${pageId}`, { method: 'PATCH', body: JSON.stringify({ archived: true }) });
    return json({ ok: true });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
}

async function syncMealRecordToNotion(env, rec) {
  const type = MEAL_TYPE_HU[rec.meal_type] || 'Snack';
  const desc = rec.description || '';
  const d = (rec.logged_at ? String(rec.logged_at) : new Date().toISOString()).slice(0, 10);
  const properties = {
    Name: { title: [{ text: { content: `${d} ${type}` } }] },
    'Dátum': { date: { start: d } },
    'Típus': { select: { name: type } },
    'Leírás': { rich_text: [{ text: { content: desc } }] }
  };
  if (typeof rec.calories === 'number') properties['Kalória'] = { number: rec.calories };
  if (rec.protein_g != null) properties['Fehérje (g)'] = { number: Number(rec.protein_g) };
  if (rec.carbs_g != null) properties['Szénhidrát (g)'] = { number: Number(rec.carbs_g) };
  if (rec.fat_g != null) properties['Zsír (g)'] = { number: Number(rec.fat_g) };
  if (rec.fiber_g != null) properties['Rost (g)'] = { number: Number(rec.fiber_g) };
  if (rec.sugar_g != null) properties['Cukor (g)'] = { number: Number(rec.sugar_g) };

  if (rec.notion_page_id) {
    await notion(env, `/pages/${rec.notion_page_id}`, { method: 'PATCH', body: JSON.stringify({ properties }) });
    return;
  }

  const row = await notion(env, '/pages', {
    method: 'POST',
    body: JSON.stringify({ parent: { database_id: env.DB_ETKEZESEK }, properties })
  });

  // Write the Notion page id back onto the Supabase row so a future edit
  // (e.g. a portion-size correction) updates this same Notion page instead
  // of creating a new one. This is itself an UPDATE on `meals`, but the
  // trigger's WHEN condition excludes it, so it does not re-trigger the sync.
  await fetch(`${env.SUPABASE_URL}/rest/v1/meals?id=eq.${rec.id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      apikey: env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
      Prefer: 'return=minimal'
    },
    body: JSON.stringify({ notion_page_id: row.id })
  });
}

// AI macro estimation for the in-app meal form: the user types what they ate
// (and optionally the calorie count if they know it, e.g. from a package),
// and this fills in the rest so they don't have to hunt down a nutrition
// database themselves. Returns plain numbers, never written to Notion
// directly — the frontend shows them in the normal editable form fields
// first, same as a manually-typed value, so the user can correct anything
// before saving.
async function estimateMealMacros(env, desc, knownCalories) {
  const systemPrompt = 'Egy táplálkozási becslő asszisztens vagy. A felhasználó megad egy étel/étkezés leírást magyarul, a te feladatod, hogy megbecsüld a tápérték adatait egy hozzávetőleges, étlap/tápérték-táblázat szintű pontossággal.'
    + (knownCalories ? ' A kalóriaérték már ismert: ' + knownCalories + ' kcal — ezt vedd készpénznek, és a többi értéket ehhez illeszd arányosan.' : '')
    + ' Válaszolj KIZÁRÓLAG egy JSON objektummal, semmi mással — ne írj magyarázatot, ne használj markdown code fence-t. A JSON kulcsai pontosan ezek legyenek: calories, protein, carbs, fat, fiber, sugar (mind szám, gramm — a calories kcal). Ha valamit nem lehet ésszerűen megbecsülni, írj oda 0-t, sose hagyd ki a kulcsot.';
  const raw = await callAnthropic(env, systemPrompt, desc, 512);
  let jsonStr = raw.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();
  const parsed = JSON.parse(jsonStr);
  return {
    calories: Number(parsed.calories) || 0,
    protein: Number(parsed.protein) || 0,
    carbs: Number(parsed.carbs) || 0,
    fat: Number(parsed.fat) || 0,
    fiber: Number(parsed.fiber) || 0,
    sugar: Number(parsed.sugar) || 0
  };
}

async function getActivityRecent(env, days) {
  const start = new Date();
  start.setDate(start.getDate() - Math.min(days || 20, 180));
  const data = await notion(env, `/databases/${env.DB_AKTIVITAS}/query`, {
    method: 'POST',
    body: JSON.stringify({
      filter: { property: 'Dátum', date: { on_or_after: start.toISOString().slice(0, 10) } },
      sorts: [{ property: 'Dátum', direction: 'ascending' }],
      page_size: 100
    })
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

// Merges any duplicate same-day checklist pages back into one: keeps the
// earliest-created page, OR-merges checkboxes, takes the max water count,
// and joins any distinct free-text fields — then archives the rest. Called
// after every create, so whichever racing request finishes last is the one
// that sees and cleans up all of them.
async function dedupeChecklistToday(env) {
  const d = todayISO();
  const data = await notion(env, `/databases/${env.DB_CHECKLIST}/query`, {
    method: 'POST',
    body: JSON.stringify({
      filter: { property: 'Dátum', date: { equals: d } },
      sorts: [{ timestamp: 'created_time', direction: 'ascending' }]
    })
  });
  if (data.results.length <= 1) return data.results[0];

  const [keep, ...extras] = data.results;
  const merged = {};
  CHECKLIST_CHECKBOX_FIELDS.forEach((f) => {
    if (data.results.some((r) => checkbox(r.properties[f]))) merged[f] = { checkbox: true };
  });
  const maxWater = Math.max(...data.results.map((r) => num(r.properties['Víz (pohár, 250ml)']) || 0));
  if (maxWater) merged['Víz (pohár, 250ml)'] = { number: maxWater };
  const exercisesText = [...new Set(data.results.map((r) => text(r.properties['Gyakorlatok'])).filter(Boolean))].join(' / ');
  if (exercisesText) merged['Gyakorlatok'] = { rich_text: [{ text: { content: exercisesText } }] };
  const symptomsText = [...new Set(data.results.map((r) => text(r.properties['Emésztési tünetek'])).filter(Boolean))].join(' / ');
  if (symptomsText) merged['Emésztési tünetek'] = { rich_text: [{ text: { content: symptomsText } }] };

  const patched = await notion(env, `/pages/${keep.id}`, { method: 'PATCH', body: JSON.stringify({ properties: merged }) });
  await Promise.all(extras.map((r) => notion(env, `/pages/${r.id}`, { method: 'PATCH', body: JSON.stringify({ archived: true }) })));
  return patched;
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
    // findChecklistPageToday + create-if-missing isn't atomic: two requests
    // that both miss an as-yet-uncreated page each create their own,
    // leaving a duplicate row for the day (this actually happened on
    // 2026-08-27). Self-heal after every create by checking for same-day
    // siblings and merging them back into one.
    row = await dedupeChecklistToday(env);
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

// The Nutrition MCP (a separate, self-hosted Supabase-backed service the user
// logs meals into via chat) also tracks weight, in its own weight_log table.
// Every vitals/log write that includes a weight — manual or the Renpho auto
// sync — mirrors it there too, so weight logged here is visible from chat/MCP
// as well, not just this dashboard. One row per day, upserted on
// (user_id, idempotency_key), mirroring the same-day merge done for the
// Notion write below. Best-effort: never blocks or breaks the Notion write.
async function writeWeightToSupabase(env, weightKg, d) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY || !env.NUTRITION_USER_ID) {
    console.warn('Supabase env vars missing, skipping nutrition-mcp weight sync');
    return;
  }
  try {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/weight_log?on_conflict=user_id,idempotency_key`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: env.SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
        Prefer: 'resolution=merge-duplicates'
      },
      body: JSON.stringify({
        user_id: env.NUTRITION_USER_ID,
        weight_g: Math.round(weightKg * 1000),
        logged_at: new Date().toISOString(),
        notes: 'Health dashboard sync',
        idempotency_key: `dashboard-${d}`
      })
    });
    if (!res.ok) {
      console.error('Supabase weight_log upsert failed:', res.status, await res.text());
    }
  } catch (err) {
    console.error('Supabase weight_log upsert error:', err);
  }
}

async function postVitalsLog(env, body) {
  const d = todayISO();
  const properties = {};
  if (typeof body.weight === 'number') properties['Súly (kg)'] = { number: body.weight };
  if (typeof body.bodyFat === 'number') properties['Testzsír (%)'] = { number: body.bodyFat };
  if (typeof body.bmi === 'number') properties['BMI'] = { number: body.bmi };
  if (typeof body.waist === 'number') properties['Derékbőség (cm)'] = { number: body.waist };
  if (typeof body.sys === 'number') properties['Sys (Hgmm)'] = { number: body.sys };
  if (typeof body.dia === 'number') properties['Dia (Hgmm)'] = { number: body.dia };
  if (typeof body.pulse === 'number') properties['Pulzus (/perc)'] = { number: body.pulse };

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
    row = await notion(env, '/pages', {
      method: 'POST',
      body: JSON.stringify({
        parent: { database_id: env.DB_MERESEK },
        properties: {
          Name: { title: [{ text: { content: d } }] },
          'Dátum': { date: { start: d } },
          'Forrás': { select: { name: 'Kézi bevitel' } },
          ...properties
        }
      })
    });
  }

  if (typeof body.weight === 'number') {
    await writeWeightToSupabase(env, body.weight, d);
  }

  return { ok: true, id: row.id };
}

// ---- Weekly workout program -------------------------------------------
// The plan template (which exercises on which weekday) is just config, so
// it lives in COACH_KV like surgery-plan/suggested-tests — full-replace on
// save, no history needed. Actual completions go to their own Notion
// database ("Edzésnapló") since exercises are free-text and vary per day,
// one row per (date, exercise) so weight-over-time can be charted per
// exercise later, same free-text-identity idea as Labor markers.

const WORKOUT_PLAN_KV_KEY = 'workout-plan';
const WORKOUT_DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DEFAULT_WORKOUT_PLAN = { monday: [], tuesday: [], wednesday: [], thursday: [], friday: [], saturday: [], sunday: [] };

function todayWorkoutDayKey() {
  return WORKOUT_DAYS[new Date().getUTCDay()];
}

async function getWorkoutPlan(env) {
  const plan = await env.COACH_KV.get(WORKOUT_PLAN_KV_KEY, 'json');
  return plan || DEFAULT_WORKOUT_PLAN;
}

async function saveWorkoutPlan(env, body) {
  const plan = {};
  WORKOUT_DAYS.forEach((day) => {
    const items = Array.isArray(body[day]) ? body[day] : [];
    plan[day] = items
      .filter((it) => it && typeof it.name === 'string' && it.name.trim())
      .map((it) => ({
        id: typeof it.id === 'string' && it.id ? it.id : crypto.randomUUID(),
        name: it.name.trim(),
        sets: typeof it.sets === 'number' ? it.sets : null,
        reps: typeof it.reps === 'number' ? it.reps : null,
        weight: typeof it.weight === 'number' ? it.weight : null
      }));
  });
  await env.COACH_KV.put(WORKOUT_PLAN_KV_KEY, JSON.stringify(plan));
  return plan;
}

async function findWorkoutLogToday(env, exerciseName) {
  const d = todayISO();
  const data = await notion(env, `/databases/${env.DB_EDZESNAPLO}/query`, {
    method: 'POST',
    body: JSON.stringify({
      filter: { and: [{ property: 'Dátum', date: { equals: d } }, { property: 'Gyakorlat', rich_text: { equals: exerciseName } }] }
    })
  });
  return data.results[0] || null;
}

async function postWorkoutLog(env, body) {
  const exercise = typeof body.exercise === 'string' ? body.exercise.trim() : '';
  if (!exercise) throw new Error('exercise required');
  const properties = {
    Name: { title: [{ text: { content: exercise } }] },
    'Dátum': { date: { start: todayISO() } },
    'Gyakorlat': { rich_text: [{ text: { content: exercise } }] }
  };
  if (typeof body.sets === 'number') properties['Sorozatok'] = { number: body.sets };
  if (typeof body.reps === 'number') properties['Ismétlések'] = { number: body.reps };
  if (typeof body.weight === 'number') properties['Súly (kg)'] = { number: body.weight };

  const existing = await findWorkoutLogToday(env, exercise);
  let row;
  if (existing) {
    row = await notion(env, `/pages/${existing.id}`, { method: 'PATCH', body: JSON.stringify({ properties }) });
  } else {
    row = await notion(env, '/pages', {
      method: 'POST',
      body: JSON.stringify({ parent: { database_id: env.DB_EDZESNAPLO }, properties })
    });
  }
  return { ok: true, id: row.id };
}

async function postWorkoutUnlog(env, exercise) {
  const existing = await findWorkoutLogToday(env, exercise);
  if (existing) await notion(env, `/pages/${existing.id}`, { method: 'PATCH', body: JSON.stringify({ archived: true }) });
  return { ok: true };
}

async function getWorkoutToday(env) {
  const plan = await getWorkoutPlan(env);
  const planned = plan[todayWorkoutDayKey()] || [];
  const d = todayISO();
  const data = await notion(env, `/databases/${env.DB_EDZESNAPLO}/query`, {
    method: 'POST',
    body: JSON.stringify({ filter: { property: 'Dátum', date: { equals: d } } })
  });
  const loggedByName = {};
  data.results.forEach((row) => {
    const p = row.properties;
    loggedByName[text(p['Gyakorlat'])] = { sets: num(p['Sorozatok']), reps: num(p['Ismétlések']), weight: num(p['Súly (kg)']) };
  });
  return planned.map((ex) => {
    const logged = loggedByName[ex.name];
    return { ...ex, done: !!logged, loggedSets: logged ? logged.sets : null, loggedReps: logged ? logged.reps : null, loggedWeight: logged ? logged.weight : null };
  });
}

async function getWorkoutRecent(env, days) {
  const start = new Date();
  start.setDate(start.getDate() - Math.min(days || 90, 365));
  const data = await notion(env, `/databases/${env.DB_EDZESNAPLO}/query`, {
    method: 'POST',
    body: JSON.stringify({
      filter: { property: 'Dátum', date: { on_or_after: start.toISOString().slice(0, 10) } },
      sorts: [{ property: 'Dátum', direction: 'ascending' }],
      page_size: 100
    })
  });
  return data.results.map((row) => {
    const p = row.properties;
    return { date: date(p['Dátum']), exercise: text(p['Gyakorlat']), sets: num(p['Sorozatok']), reps: num(p['Ismétlések']), weight: num(p['Súly (kg)']) };
  });
}

// ---- Web Push (RFC 8291 message encryption + RFC 8292 VAPID) --------------
// Hand-rolled with only Web Crypto primitives (no npm `web-push` package —
// this project deliberately has no bundler/build step). VAPID_PUBLIC_KEY is
// public by design (sent to the browser too, in app.js) so it's a plain
// constant, not a secret; VAPID_PRIVATE_KEY (a JWK JSON string) is a real
// Cloudflare secret the user sets themselves via `wrangler secret put`.
const VAPID_PUBLIC_KEY = 'BMz623-2szCzT-nWfTxBAvBHhvMwnEvgbZ4wQUJuy_w_oqXODo71lZ1U6hEjfz8kVOyWL6Ms0myLF-PlfoXX3FI';
const PUSH_SUBSCRIPTION_KV_KEY = 'push-subscription';

function b64urlToBytes(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToB64url(bytes) {
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concatBytes(...arrays) {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  arrays.forEach((a) => { out.set(a, offset); offset += a.length; });
  return out;
}

// Combined HKDF-Extract + HKDF-Expand (RFC 5869) via the native Workers
// 'HKDF' algorithm, returning exactly `length` bytes.
async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

async function importVapidPrivateKey(env) {
  const jwk = JSON.parse(env.VAPID_PRIVATE_KEY);
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

async function buildVapidAuthHeader(env, endpoint) {
  const audience = new URL(endpoint).origin;
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = { aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'mailto:deblacko@gmail.com' };
  const enc = (obj) => bytesToB64url(new TextEncoder().encode(JSON.stringify(obj)));
  const unsigned = enc(header) + '.' + enc(payload);
  const key = await importVapidPrivateKey(env);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(unsigned));
  const jwt = unsigned + '.' + bytesToB64url(new Uint8Array(sig));
  return `vapid t=${jwt}, k=${VAPID_PUBLIC_KEY}`;
}

// RFC 8291 §3.4 — two-stage HKDF: first derive IKM from the ECDH shared
// secret combined with the subscription's auth secret, then derive the
// actual AES-128-GCM key/nonce from IKM combined with a fresh random salt.
async function encryptWebPushPayload(subscription, payloadObj) {
  const plaintext = new TextEncoder().encode(JSON.stringify(payloadObj));
  const uaPublicBytes = b64urlToBytes(subscription.keys.p256dh);
  const authSecret = b64urlToBytes(subscription.keys.auth);

  const asKeyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', asKeyPair.publicKey));

  const uaPublicKey = await crypto.subtle.importKey('raw', uaPublicBytes, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaPublicKey }, asKeyPair.privateKey, 256));

  const authInfo = concatBytes(new TextEncoder().encode('WebPush: info\0'), uaPublicBytes, asPublicRaw);
  const ikm = await hkdf(authSecret, ecdhSecret, authInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: nonce\0'), 12);

  const cekKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const recordPlaintext = concatBytes(plaintext, new Uint8Array([2])); // record delimiter, no padding needed
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, cekKey, recordPlaintext));

  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096, false);
  const header = concatBytes(salt, recordSize, new Uint8Array([asPublicRaw.length]), asPublicRaw);
  return concatBytes(header, ciphertext);
}

async function getPushSubscription(env) {
  return env.COACH_KV.get(PUSH_SUBSCRIPTION_KV_KEY, 'json');
}

async function savePushSubscription(env, subscription) {
  if (!subscription || !subscription.endpoint || !subscription.keys) throw new Error('invalid subscription');
  await env.COACH_KV.put(PUSH_SUBSCRIPTION_KV_KEY, JSON.stringify(subscription));
  return { ok: true };
}

async function sendPushNotification(env, title, body) {
  const sub = await getPushSubscription(env);
  if (!sub) return { ok: false, reason: 'no subscription' };
  const encrypted = await encryptWebPushPayload(sub, { title, body });
  const authHeader = await buildVapidAuthHeader(env, sub.endpoint);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'aes128gcm', 'TTL': '86400', 'Authorization': authHeader },
    body: encrypted
  });
  if (!res.ok) return { ok: false, reason: `push send ${res.status}: ${await res.text()}` };
  return { ok: true };
}

// Reads today's plan + today's already-logged exercises, and if there's
// anything planned and not fully done yet, sends a short push summary.
async function sendDailyWorkoutReminder(env) {
  const today = await getWorkoutToday(env);
  if (!today.length) return;
  const remaining = today.filter((ex) => !ex.done);
  if (!remaining.length) return;
  const summary = remaining.map((ex) => `${ex.name} (${ex.sets ?? '?'}×${ex.reps ?? '?'})`).join(', ');
  await sendPushNotification(env, 'Mai edzés', summary);
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
    if (event.cron === '0 6 * * *') {
      await sendDailyWorkoutReminder(env);
      return;
    }
    await checkAndRegenerateCoachNotes(env);
  },

  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });

    const url = new URL(request.url);

    // Supabase trigger on the Nutrition MCP's `meals` table calls this on
    // every insert/update — authenticated with its own SYNC_SECRET, not
    // APP_TOKEN, so it must be handled before the checkAuth gate below.
    if (url.pathname === '/sync/meal' && request.method === 'POST') {
      return handleSyncMeal(request, env);
    }
    if (url.pathname === '/sync/meal/delete' && request.method === 'POST') {
      return handleSyncMealDelete(request, env);
    }

    if (!checkAuth(request, env)) return unauthorized();

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
      if (url.pathname === '/api/meals/estimate' && request.method === 'POST') {
        const body = await request.json();
        if (!body.desc || typeof body.desc !== 'string') return json({ error: 'desc required' }, 400);
        try {
          const estimate = await estimateMealMacros(env, body.desc, typeof body.calories === 'number' ? body.calories : null);
          return json(estimate);
        } catch (err) {
          return json({ error: 'Nem sikerült megbecsülni: ' + String(err) }, 500);
        }
      }
      if (url.pathname === '/api/meals/recent' && request.method === 'GET') {
        const days = Number(url.searchParams.get('days')) || 30;
        return json(await getMealsRecent(env, days));
      }
      if (url.pathname === '/api/activity/recent' && request.method === 'GET') {
        const days = Number(url.searchParams.get('days')) || 20;
        return json(await getActivityRecent(env, days));
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
      if (url.pathname === '/api/workout-plan' && request.method === 'GET') {
        return json(await getWorkoutPlan(env));
      }
      if (url.pathname === '/api/workout-plan' && request.method === 'POST') {
        const body = await request.json();
        return json(await saveWorkoutPlan(env, body));
      }
      if (url.pathname === '/api/workout/today' && request.method === 'GET') {
        return json(await getWorkoutToday(env));
      }
      if (url.pathname === '/api/workout/log' && request.method === 'POST') {
        const body = await request.json();
        return json(await postWorkoutLog(env, body));
      }
      if (url.pathname === '/api/workout/unlog' && request.method === 'POST') {
        const body = await request.json();
        return json(await postWorkoutUnlog(env, body.exercise));
      }
      if (url.pathname === '/api/workout/recent' && request.method === 'GET') {
        return json(await getWorkoutRecent(env, Number(url.searchParams.get('days'))));
      }
      if (url.pathname === '/api/push-subscription' && request.method === 'POST') {
        const body = await request.json();
        return json(await savePushSubscription(env, body));
      }
      return json({ error: 'not found' }, 404);
    } catch (err) {
      return json({ error: String(err) }, 500);
    }
  }
};
