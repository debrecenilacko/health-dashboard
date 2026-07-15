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

async function getVitalsToday(env) {
  const data = await notion(env, `/databases/${env.DB_MERESEK}/query`, {
    method: 'POST',
    body: JSON.stringify({ sorts: [{ property: 'Dátum', direction: 'descending' }], page_size: 1 })
  });
  const row = data.results[0];
  if (!row) return null;
  const p = row.properties;
  return {
    date: date(p['Dátum']),
    weight: num(p['Súly (kg)']),
    waist: num(p['Derékbőség (cm)']),
    sys: num(p['Sys (Hgmm)']),
    dia: num(p['Dia (Hgmm)']),
    pulse: num(p['Pulzus (/perc)']),
    glucose: num(p['Vércukor (mmol/l)'])
  };
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

// ---- Entry point ---------------------------------------------------------

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });
    if (!checkAuth(request, env)) return unauthorized();

    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/vitals/today' && request.method === 'GET') {
        return json(await getVitalsToday(env));
      }
      if (url.pathname === '/api/meals/today' && request.method === 'GET') {
        return json(await getMealsToday(env));
      }
      if (url.pathname === '/api/activity/recent' && request.method === 'GET') {
        return json(await getActivityRecent(env));
      }
      if (url.pathname === '/api/checklist/today' && request.method === 'GET') {
        return json(await getChecklistToday(env));
      }
      if (url.pathname === '/api/checklist/today' && request.method === 'POST') {
        const body = await request.json();
        return json(await postChecklistToday(env, body));
      }
      return json({ error: 'not found' }, 404);
    } catch (err) {
      return json({ error: String(err) }, 500);
    }
  }
};
