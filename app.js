// Frontend logic — talks to the Cloudflare Worker (see ../worker) which in
// turn talks to Notion. Nothing here holds the real Notion secret; it only
// holds the API base URL and the lightweight APP_TOKEN you chose yourself.

// Public by design — sent to the browser as part of the subscribe call, the
// matching private key never leaves the Worker (Cloudflare secret).
const VAPID_PUBLIC_KEY = 'BMz623-2szCzT-nWfTxBAvBHhvMwnEvgbZ4wQUJuy_w_oqXODo71lZ1U6hEjfz8kVOyWL6Ms0myLF-PlfoXX3FI';

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function subscribeToPushNotifications(statusEl) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    statusEl.textContent = 'Ez a böngésző nem támogatja az értesítéseket.';
    return;
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    statusEl.textContent = 'Nincs engedélyezve az értesítés.';
    return;
  }
  try {
    const reg = await navigator.serviceWorker.ready;
    const subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
    });
    await api('/api/push-subscription', { method: 'POST', body: JSON.stringify(subscription.toJSON()) });
    statusEl.textContent = 'Napi emlékeztető bekapcsolva.';
  } catch (err) {
    statusEl.textContent = 'Nem sikerült bekapcsolni: ' + err.message;
  }
}

const CONFIG_KEY = 'hd-config';

function getConfig() {
  const raw = localStorage.getItem(CONFIG_KEY);
  return raw ? JSON.parse(raw) : { apiBase: '', appToken: '' };
}

function saveConfig(cfg) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
}

// Forgives the common typos that turn into a 404: missing scheme, a
// trailing slash, or pasting the URL with "/api" already on the end.
function normalizeApiBase(raw) {
  let v = raw.trim();
  if (!v) return v;
  if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
  v = v.replace(/\/+$/, '');
  v = v.replace(/\/api$/i, '');
  return v;
}

// Shows the backend-settings modal and resolves once the user saves (true)
// or cancels (false). The token field is always left blank on open — it's
// never re-displayed once saved, since there's no way to read it back out
// of a Cloudflare secret either.
function showSettingsModal({ apiBase = '', errorMessage = '', allowCancel = true } = {}) {
  const overlay = document.getElementById('hd-settings-overlay');
  const apiInput = document.getElementById('hd-cfg-apibase');
  const tokenInput = document.getElementById('hd-cfg-token');
  const errorEl = document.getElementById('hd-cfg-error');
  const saveBtn = document.getElementById('hd-cfg-save');
  const cancelBtn = document.getElementById('hd-cfg-cancel');

  apiInput.value = apiBase;
  tokenInput.value = '';
  errorEl.textContent = errorMessage;
  cancelBtn.style.display = allowCancel ? 'inline-block' : 'none';
  overlay.style.display = 'flex';
  tokenInput.focus();

  return new Promise((resolve) => {
    function cleanup() {
      overlay.style.display = 'none';
      saveBtn.removeEventListener('click', onSave);
      cancelBtn.removeEventListener('click', onCancel);
      apiInput.removeEventListener('keydown', onKey);
      tokenInput.removeEventListener('keydown', onKey);
    }
    function onSave() {
      const newApiBase = normalizeApiBase(apiInput.value);
      const newToken = tokenInput.value.trim();
      if (!newApiBase || !newToken) {
        errorEl.textContent = 'Add meg mindkét mezőt.';
        return;
      }
      saveConfig({ apiBase: newApiBase, appToken: newToken });
      cleanup();
      resolve(true);
    }
    function onCancel() {
      cleanup();
      resolve(false);
    }
    function onKey(e) {
      if (e.key === 'Enter') onSave();
    }
    saveBtn.addEventListener('click', onSave);
    cancelBtn.addEventListener('click', onCancel);
    apiInput.addEventListener('keydown', onKey);
    tokenInput.addEventListener('keydown', onKey);
  });
}

// Concurrent api() calls (Promise.all on load) must share one in-flight
// modal instead of each popping their own.
let pendingConfigPromise = null;

async function ensureConfig() {
  const cfg = getConfig();
  if (cfg.apiBase && cfg.appToken) return cfg;
  if (!pendingConfigPromise) {
    pendingConfigPromise = showSettingsModal({ apiBase: cfg.apiBase, allowCancel: false })
      .then(() => {
        pendingConfigPromise = null;
        return getConfig();
      });
  }
  return pendingConfigPromise;
}

// The checklist Worker endpoint finds-or-creates today's Notion page per
// call; two POSTs in flight at once can both miss the not-yet-created page
// and each create their own, leaving a duplicate row for the day. Every
// checkbox/water/text-field toggle fires its own independent request, so
// two rapid taps race easily. Chaining every checklist write through one
// promise queue serializes them — only one is ever in flight.
let checklistWriteQueue = Promise.resolve();
function postChecklistPatch(patch) {
  checklistWriteQueue = checklistWriteQueue.catch(() => {}).then(
    () => api('/api/checklist/today', { method: 'POST', body: JSON.stringify(patch) })
  );
  return checklistWriteQueue;
}

async function api(path, options = {}) {
  const cfg = await ensureConfig();
  const res = await fetch(cfg.apiBase + path, {
    ...options,
    headers: {
      Authorization: `Bearer ${cfg.appToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  if (res.status === 401) {
    const err = new Error('API hiba: 401');
    err.isAuthError = true;
    throw err;
  }
  if (!res.ok) throw new Error('API hiba: ' + res.status);
  return res.json();
}

// Same modal pattern as showSettingsModal, for the bariatric-surgery dates.
function showSurgeryModal(plan) {
  const overlay = document.getElementById('hd-surgery-overlay');
  const consultInput = document.getElementById('hd-surgery-consult');
  const opInput = document.getElementById('hd-surgery-op');
  const errorEl = document.getElementById('hd-surgery-error');
  const saveBtn = document.getElementById('hd-surgery-save');
  const cancelBtn = document.getElementById('hd-surgery-cancel');

  consultInput.value = (plan && plan.consultationDate) || '';
  opInput.value = (plan && plan.estimatedSurgeryDate) || '';
  errorEl.textContent = '';
  overlay.style.display = 'flex';

  return new Promise((resolve) => {
    function cleanup() {
      overlay.style.display = 'none';
      saveBtn.removeEventListener('click', onSave);
      cancelBtn.removeEventListener('click', onCancel);
    }
    async function onSave() {
      if (!consultInput.value) {
        errorEl.textContent = 'A konzultáció dátuma kötelező.';
        return;
      }
      try {
        const saved = await api('/api/surgery-plan', {
          method: 'POST',
          body: JSON.stringify({ consultationDate: consultInput.value, estimatedSurgeryDate: opInput.value || null })
        });
        cleanup();
        resolve(saved);
      } catch (err) {
        errorEl.textContent = 'Nem sikerült menteni: ' + err.message;
      }
    }
    function onCancel() {
      cleanup();
      resolve(null);
    }
    saveBtn.addEventListener('click', onSave);
    cancelBtn.addEventListener('click', onCancel);
  });
}

// Terse week-over-week diff, computed entirely from history already fetched
// for other cards (vitalsHistory / checklistHistoryState / mealsHistoryState)
// — no dedicated endpoint. Dates are compared as strings (all sources use
// ISO 'YYYY-MM-DD' date keys) rather than assumed array order, since
// checklistHistoryState comes back newest-first while the others are
// oldest-first.
function avgField(arr, field) {
  const vals = arr.filter((h) => h[field] != null).map((h) => h[field]);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}
function lastByDate(arr, field) {
  const rows = arr.filter((h) => h[field] != null).slice().sort((a, b) => a.date.localeCompare(b.date));
  return rows.length ? rows[rows.length - 1][field] : null;
}
// Consecutive days (ending today or yesterday — "yesterday" so the streak
// doesn't visibly drop to 0 first thing in the morning before today's row
// exists yet) that have *any* checklist row at all. Mirrors the existing
// "no row = never logged" denominator logic already used by the consistency
// view, just walked backward day by day instead of averaged.
function computeLoggingStreak(checklistHistoryState) {
  const dates = new Set((checklistHistoryState || []).map((h) => h.date));
  const dayKey = (n) => { const x = new Date(); x.setDate(x.getDate() - n); return x.toISOString().slice(0, 10); };
  if (!dates.has(dayKey(0)) && !dates.has(dayKey(1))) return 0;
  let offset = dates.has(dayKey(0)) ? 0 : 1;
  let streak = 0;
  while (dates.has(dayKey(offset))) { streak++; offset++; }
  return streak;
}

function renderWeeklyDigest(vitalsHistory, checklistHistoryState, mealsHistoryState) {
  const el = document.getElementById('hd-weekly-digest');
  if (!el) return;
  const dayKey = (n) => { const x = new Date(); x.setDate(x.getDate() - n); return x.toISOString().slice(0, 10); };
  const thisWeekStart = dayKey(7), todayK = dayKey(0), prevWeekStart = dayKey(14);
  const thisWeek = (arr) => arr.filter((h) => h.date >= thisWeekStart && h.date <= todayK);
  const prevWeek = (arr) => arr.filter((h) => h.date >= prevWeekStart && h.date < thisWeekStart);

  const lines = [];

  const streak = computeLoggingStreak(checklistHistoryState);
  if (streak >= 2) {
    lines.push('🔥 ' + streak + ' napja folyamatosan logolsz — szép munka.');
  }

  const wNow = lastByDate(thisWeek(vitalsHistory), 'weight');
  const wPrev = lastByDate(prevWeek(vitalsHistory), 'weight');
  if (wNow != null && wPrev != null) {
    const delta = wNow - wPrev;
    lines.push('Súly: ' + wNow.toFixed(1) + ' kg (' + (delta >= 0 ? '+' : '') + delta.toFixed(1) + ' kg az előző héthez képest)');
  }

  const stepsNow = avgField(thisWeek(vitalsHistory), 'steps');
  const stepsPrev = avgField(prevWeek(vitalsHistory), 'steps');
  if (stepsNow != null && stepsPrev != null) {
    const delta = Math.round(stepsNow - stepsPrev);
    lines.push('Lépés: napi ' + Math.round(stepsNow) + ' (előző hét: ' + Math.round(stepsPrev) + ', ' + (delta >= 0 ? '+' : '') + delta + ')');
  }

  const waterNow = avgField(thisWeek(checklistHistoryState), 'water');
  const waterPrev = avgField(prevWeek(checklistHistoryState), 'water');
  if (waterNow != null && waterPrev != null) {
    lines.push('Víz: napi ' + waterNow.toFixed(1) + ' pohár (előző hét: ' + waterPrev.toFixed(1) + ')');
  }

  const proteinNow = avgField(thisWeek(mealsHistoryState), 'protein');
  const proteinPrev = avgField(prevWeek(mealsHistoryState), 'protein');
  if (proteinNow != null && proteinPrev != null) {
    lines.push('Fehérje: napi ' + Math.round(proteinNow) + 'g (előző hét: ' + Math.round(proteinPrev) + 'g)');
  }

  const sleepNow = avgField(thisWeek(vitalsHistory), 'sleepHours');
  const sleepPrev = avgField(prevWeek(vitalsHistory), 'sleepHours');
  if (sleepNow != null && sleepPrev != null) {
    lines.push('Alvás: napi ' + sleepNow.toFixed(1) + ' óra (előző hét: ' + sleepPrev.toFixed(1) + ' óra)');
  }

  el.innerHTML = '';
  if (!lines.length) return;
  const wrap = document.createElement('div');
  wrap.className = 'hd-card';
  wrap.style.marginBottom = '14px';
  const title = document.createElement('p');
  title.className = 'hd-section-title';
  title.style.marginTop = '0';
  title.textContent = 'Mi változott a héten';
  wrap.appendChild(title);
  lines.forEach((line) => {
    const p = document.createElement('p');
    p.style.margin = '4px 0';
    p.style.fontSize = '13px';
    p.textContent = line;
    wrap.appendChild(p);
  });
  el.appendChild(wrap);
}

function downloadBlob(filename, mime, content) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function gatherExportData() {
  const [vitals, labor, meals, checklist, activity, surgeryPlan, suggestedTests] = await Promise.all([
    api('/api/vitals/recent?limit=100'),
    api('/api/labor/recent?limit=100'),
    api('/api/meals/recent?days=100'),
    api('/api/checklist/recent?days=100'),
    api('/api/activity/recent'),
    api('/api/surgery-plan'),
    api('/api/suggested-tests')
  ]);
  return { vitals, labor, meals, checklist, activity, surgeryPlan, suggestedTests };
}

// Long/tidy format (domain,date,field,value) so wildly different per-domain
// schemas (vitals vs. labor vs. meals vs. checklist) can share one CSV
// without every row needing every column.
function exportDataToCsv(data) {
  const rows = [['domain', 'date', 'field', 'value']];
  ['vitals', 'labor', 'meals', 'checklist', 'activity'].forEach((domain) => {
    (data[domain] || []).forEach((entry) => {
      Object.keys(entry).forEach((field) => {
        if (field === 'date') return;
        const value = entry[field];
        if (value === null || value === undefined || value === '') return;
        rows.push([domain, entry.date || '', field, String(value)]);
      });
    });
  });
  return rows.map((r) => r.map((cell) => '"' + String(cell).replace(/"/g, '""') + '"').join(',')).join('\n');
}

function showExportModal() {
  const overlay = document.getElementById('hd-export-overlay');
  const errorEl = document.getElementById('hd-export-error');
  const jsonBtn = document.getElementById('hd-export-json');
  const csvBtn = document.getElementById('hd-export-csv');
  const cancelBtn = document.getElementById('hd-export-cancel');
  errorEl.textContent = '';
  overlay.style.display = 'flex';

  function cleanup() {
    overlay.style.display = 'none';
    jsonBtn.removeEventListener('click', onJson);
    csvBtn.removeEventListener('click', onCsv);
    cancelBtn.removeEventListener('click', onCancel);
  }
  const exportDate = new Date().toISOString().slice(0, 10);
  async function onJson() {
    try {
      const data = await gatherExportData();
      downloadBlob('egeszseg-export-' + exportDate + '.json', 'application/json', JSON.stringify(data, null, 2));
      cleanup();
    } catch (err) {
      errorEl.textContent = 'Nem sikerült exportálni: ' + err.message;
    }
  }
  async function onCsv() {
    try {
      const data = await gatherExportData();
      downloadBlob('egeszseg-export-' + exportDate + '.csv', 'text/csv', exportDataToCsv(data));
      cleanup();
    } catch (err) {
      errorEl.textContent = 'Nem sikerült exportálni: ' + err.message;
    }
  }
  function onCancel() {
    cleanup();
  }
  jsonBtn.addEventListener('click', onJson);
  csvBtn.addEventListener('click', onCsv);
  cancelBtn.addEventListener('click', onCancel);
}

(function () {
  const todayKey = new Date().toISOString().slice(0, 10);
  document.getElementById('hd-date').textContent = todayKey;

  const root = document.getElementById('hd-root');

  document.getElementById('hd-settings-btn').addEventListener('click', async () => {
    const cfg = getConfig();
    const saved = await showSettingsModal({ apiBase: cfg.apiBase, allowCancel: true });
    if (saved) location.reload();
  });

  document.getElementById('hd-surgery-btn').addEventListener('click', async () => {
    const plan = await api('/api/surgery-plan');
    const saved = await showSurgeryModal(plan);
    if (saved) location.reload();
  });

  document.getElementById('hd-export-btn').addEventListener('click', () => showExportModal());

  document.getElementById('hd-push-subscribe-btn').addEventListener('click', async () => {
    const statusEl = document.getElementById('hd-push-status');
    statusEl.textContent = 'Bekapcsolás…';
    await subscribeToPushNotifications(statusEl);
  });

  document.getElementById('hd-workout-plan-toggle').addEventListener('click', (e) => {
    const editor = document.getElementById('hd-workout-plan-editor');
    const isOpen = editor.style.display !== 'none';
    editor.style.display = isOpen ? 'none' : 'block';
    e.target.textContent = 'Heti program szerkesztése ' + (isOpen ? '▾' : '▴');
  });

  document.getElementById('hd-manual-vitals-toggle').addEventListener('click', (e) => {
    const form = document.getElementById('hd-manual-vitals-form');
    const isOpen = form.style.display !== 'none';
    form.style.display = isOpen ? 'none' : 'block';
    e.target.textContent = 'Kézi mérés hozzáadása (derékbőség, vérnyomás, pulzus) ' + (isOpen ? '▾' : '▴');
  });

  document.getElementById('hd-manual-vitals-save').addEventListener('click', async () => {
    const errorEl = document.getElementById('hd-manual-vitals-error');
    errorEl.textContent = '';
    const body = {};
    ['waist', 'sys', 'dia', 'pulse'].forEach((field) => {
      const raw = document.getElementById('hd-mv-' + field).value;
      if (raw !== '') body[field] = parseFloat(raw);
    });
    if (!Object.keys(body).length) {
      errorEl.textContent = 'Legalább egy mezőt tölts ki.';
      return;
    }
    try {
      await api('/api/vitals/log', { method: 'POST', body: JSON.stringify(body) });
      location.reload();
    } catch (err) {
      errorEl.textContent = 'Nem sikerült menteni: ' + err.message;
    }
  });

  // Top tabs (desktop) and the bottom nav (mobile, CSS-toggled) both use
  // .hd-tab-btn with the same data-tab values — keep both sets in sync by
  // active-class rather than just the one element clicked, so a resize
  // between the two layouts never leaves a stale highlight.
  root.querySelectorAll('.hd-tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      root.querySelectorAll('.hd-tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === btn.dataset.tab));
      root.querySelectorAll('.hd-panel').forEach((p) => p.classList.remove('active'));
      root.querySelector('.hd-panel[data-panel="' + btn.dataset.tab + '"]').classList.add('active');
    });
  });

  // Only cards with a data-vfield are vitals fields — the water/nutrition
  // trend cards reuse the same .hd-tap-card styling (cursor, active border)
  // but have their own dedicated handlers below, wired directly by id.
  root.querySelectorAll('.hd-tap-card[data-vfield]').forEach((card) => {
    card.addEventListener('click', () => toggleVitalsCard(card.dataset.vfield, card));
  });

  document.getElementById('hd-water-trend-card').addEventListener('click', () => {
    const chartWrap = document.getElementById('hd-water-chart');
    const points = checklistHistoryState.filter((h) => h.water != null).map((h) => ({ date: h.date, value: h.water }));
    toggleTrendChart(chartWrap, waterChartInstances, 'water', [{ label: 'Víz', points }], [{ label: 'cél (11)', value: 11, color: '#C9A227' }]);
  });

  document.getElementById('hd-nutri-trend-card').addEventListener('click', () => {
    const chartWrap = document.getElementById('hd-nutri-chart');
    const points = mealsHistoryState.map((d) => ({ date: d.date, value: d.protein }));
    toggleTrendChart(chartWrap, nutriChartInstances, 'protein', [{ label: 'Fehérje', points }], [{ label: 'cél (80g)', value: 80, color: '#C9A227' }]);
  });

  const MED_LABELS = {
    Rosuvastatin: 'morning', Vidonorm: 'morning', Nebilet: 'morning', Rawel: 'morning',
    Merckformin: 'evening', Ozempic: 'weekly',
    'Kreatin-glicin-taurin': 'supp', 'Just Whey': 'supp', 'Omega-3': 'supp', Multivitamin: 'supp',
    'Kurkuma-kivonat': 'supp', NAC: 'supp', TUDCA: 'supp',
    'Esti 3 órás étkezési határ': 'routine', 'Exercise snack': 'routine'
  };
  const DISPLAY_NAME = { Nebilet: 'Nebilet (½)', Ozempic: 'Ozempic injekció', 'Esti 3 órás étkezési határ': 'Esti 3 órás étkezési határ (nincs evés lefekvés előtt)' };
  // Bariatric-surgery-prep supplements that must stop 1-2 weeks before the
  // operation (per their own Notion property descriptions) — surfaced by the
  // surgery-plan warning banner, kept in sync with the Worker's identical list.
  const PRE_OP_STOP_SUPPLEMENTS = ['Kurkuma-kivonat', 'NAC', 'TUDCA'];

  function renderChecklistRow(ulEl, fieldNames, checklistState, onToggle) {
    ulEl.innerHTML = '';
    fieldNames.forEach((field) => {
      const li = document.createElement('li');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!checklistState[field];
      const id = 'cb-' + Math.random().toString(36).slice(2);
      cb.id = id;
      const label = document.createElement('label');
      label.htmlFor = id;
      label.textContent = DISPLAY_NAME[field] || field;
      if (cb.checked) label.classList.add('done');
      cb.addEventListener('change', async () => {
        label.classList.toggle('done', cb.checked);
        await onToggle(field, cb.checked);
      });
      li.appendChild(cb);
      li.appendChild(label);
      ulEl.appendChild(li);
    });
  }

  // Adherence over the last N days per checklist field, sorted worst-first
  // so the things most worth attention surface at the top. `history` is
  // /api/checklist/recent's array (one entry per day that has a Notion row —
  // days with no row at all just don't count toward the denominator, since
  // "never logged" and "logged but unchecked" aren't the same signal). Each
  // row now taps open a boolean (0/1) trend chart, same interaction as Labor.
  let checklistHistoryState = [];
  const consistencyChartInstances = {};
  const CONSISTENCY_SYNTHETIC_FIELD = 'Gyakorlatok';

  function consistencyFieldValue(h, field) {
    return field === CONSISTENCY_SYNTHETIC_FIELD ? !!(h.exercises && h.exercises.trim()) : !!h[field];
  }

  function renderConsistency(history) {
    checklistHistoryState = history || [];
    const wrap = document.getElementById('hd-consistency-list');
    wrap.innerHTML = '';
    Object.keys(consistencyChartInstances).forEach((k) => { consistencyChartInstances[k].destroy(); delete consistencyChartInstances[k]; });
    if (!checklistHistoryState.length) {
      wrap.innerHTML = '<p style="font-size:13px; opacity:.55;">Nincs elég adat.</p>';
      return;
    }
    const total = checklistHistoryState.length;
    const fields = Object.keys(MED_LABELS).concat([CONSISTENCY_SYNTHETIC_FIELD]);
    const rows = fields.map((field) => {
      const count = checklistHistoryState.filter((h) => consistencyFieldValue(h, field)).length;
      const label = field === CONSISTENCY_SYNTHETIC_FIELD ? 'Gyakorlatok naplózva' : (DISPLAY_NAME[field] || field);
      return { field, label, count, pct: Math.round((count / total) * 100) };
    }).sort((a, b) => a.pct - b.pct);

    rows.forEach((r) => {
      const item = document.createElement('div');
      const row = document.createElement('div');
      row.className = 'hd-consist-row';
      row.innerHTML =
        '<div class="hd-consist-top"><span>' + r.label + '</span><span class="hd-consist-count">' + r.count + '/' + total + '</span></div>' +
        '<div class="hd-consist-bar"><div class="hd-consist-fill" style="width:' + r.pct + '%;"></div></div>';
      const chartWrap = document.createElement('div');
      chartWrap.className = 'hd-consist-chart-wrap';
      chartWrap.style.display = 'none';
      row.addEventListener('click', () => toggleConsistencyChart(r.field, item));
      item.appendChild(row);
      item.appendChild(chartWrap);
      wrap.appendChild(item);
    });
  }

  function toggleConsistencyChart(field, itemEl) {
    const chartWrap = itemEl.querySelector('.hd-consist-chart-wrap');
    const points = checklistHistoryState.map((h) => ({ date: h.date, value: consistencyFieldValue(h, field) ? 1 : 0 }));
    toggleTrendChart(chartWrap, consistencyChartInstances, field, [{ label: field, points }], []);
  }

  function renderNordicWalkingConsistency(history) {
    const el = document.getElementById('hd-nw-consistency');
    if (!history || !history.length) { el.textContent = ''; return; }
    const count = history.filter((h) => h['Nordic walking']).length;
    el.textContent = 'Konzisztencia (' + history.length + ' nap): ' + count + '/' + history.length + ' nap';
  }

  function renderWaterAverage(history) {
    const el = document.getElementById('hd-water-avg');
    const withWater = (history || []).filter((h) => h.water != null);
    if (!withWater.length) { el.textContent = '—'; return; }
    el.textContent = Math.round((withWater.reduce((sum, h) => sum + h.water, 0) / withWater.length) * 10) / 10;
  }

  function renderNutritionTrendStat(mealsRecent) {
    mealsHistoryState = mealsRecent || [];
    const el = document.getElementById('hd-nutri-protein-avg');
    if (!mealsHistoryState.length) { el.textContent = '—'; return; }
    el.textContent = Math.round(mealsHistoryState.reduce((sum, d) => sum + (d.protein || 0), 0) / mealsHistoryState.length);
  }

  function renderMeals(meals) {
    const wrap = document.getElementById('hd-meals-list');
    wrap.innerHTML = '';
    if (!meals || meals.length === 0) {
      wrap.innerHTML = '<p style="font-size:13px; opacity:.55;">Ma még nincs naplózott étkezés.</p>';
      return;
    }
    meals.forEach((m) => {
      const card = document.createElement('div');
      card.className = 'hd-meal-card';
      const type = document.createElement('div');
      type.className = 'hd-meal-type';
      type.textContent = m.type || '';
      const desc = document.createElement('div');
      desc.className = 'hd-meal-desc';
      desc.textContent = m.desc || '';
      const macros = document.createElement('div');
      macros.className = 'hd-meal-macros';
      macros.textContent = (m.calories || 0) + ' kcal · ' + (m.protein || 0) + 'g fehérje · ' + (m.carbs || 0) + 'g szénhidrát · ' + (m.fat || 0) + 'g zsír' +
        (m.fiber != null ? ' · ' + m.fiber + 'g rost' : '') + (m.sugar != null ? ' · ' + m.sugar + 'g cukor' : '');
      card.appendChild(type);
      card.appendChild(desc);
      card.appendChild(macros);
      wrap.appendChild(card);
    });
    const totals = meals.reduce(
      (acc, m) => ({
        cal: acc.cal + (m.calories || 0), protein: acc.protein + (m.protein || 0),
        carbs: acc.carbs + (m.carbs || 0), fat: acc.fat + (m.fat || 0),
        fiber: acc.fiber + (m.fiber || 0), sugar: acc.sugar + (m.sugar || 0)
      }),
      { cal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0 }
    );
    document.getElementById('hd-nutri-cal').textContent = totals.cal;
    document.getElementById('hd-nutri-protein').textContent = totals.protein;
    document.getElementById('hd-nutri-carbs').textContent = totals.carbs;
    document.getElementById('hd-nutri-fat').textContent = totals.fat;
    document.getElementById('hd-nutri-fiber').textContent = totals.fiber;
    document.getElementById('hd-nutri-sugar').textContent = totals.sugar;
    renderProteinGoal(totals.protein);
  }

  // General bariatric pre-/post-op protein guideline (60-100g/day is the
  // commonly cited range) — an approximate target to work toward, not a
  // personalized prescription; the label says so explicitly.
  const PROTEIN_GOAL_G = 80;
  function renderProteinGoal(proteinG) {
    const fill = document.getElementById('hd-protein-fill');
    const label = document.getElementById('hd-protein-label');
    const pct = Math.min(100, Math.round((proteinG / PROTEIN_GOAL_G) * 100));
    fill.style.width = pct + '%';
    fill.classList.toggle('over', proteinG >= PROTEIN_GOAL_G);
    label.textContent = proteinG + 'g / ' + PROTEIN_GOAL_G + 'g fehérje cél (általános irányszám, egyeztesd a dietetikusoddal)';
  }

  function renderVitals(vitals) {
    if (!vitals) return;
    document.getElementById('hd-vital-weight').textContent = vitals.weight ?? '—';
    document.getElementById('hd-vital-waist').textContent = vitals.waist ?? '—';
    document.getElementById('hd-vital-bp').textContent = (vitals.sys ?? '—') + '/' + (vitals.dia ?? '—');
    document.getElementById('hd-vital-pulse').textContent = vitals.pulse ?? '—';
    document.getElementById('hd-vital-sleep-hours').textContent = vitals.sleepHours ?? '—';
    document.getElementById('hd-vital-sleep-deep').textContent = vitals.sleepDeepMin ?? '—';
    document.getElementById('hd-vital-sleep-rem').textContent = vitals.sleepRemMin ?? '—';
    document.getElementById('hd-vital-sleep-pulse').textContent = vitals.sleepRestingPulse ?? '—';
    document.getElementById('hd-vital-steps').textContent = vitals.steps ?? '—';
  }

  const SLEEP_GOAL_HOURS = 8;
  function renderSleepDebt(history) {
    const el = document.getElementById('hd-sleep-debt');
    const recent = (history || []).filter((r) => r.sleepHours != null).slice(-7);
    if (!recent.length) { el.textContent = ''; return; }
    const avg = recent.reduce((sum, r) => sum + r.sleepHours, 0) / recent.length;
    const diff = (avg - SLEEP_GOAL_HOURS) * recent.length;
    const avgStr = Math.round(avg * 10) / 10;
    if (diff < -0.5) {
      el.textContent = 'Alvásadósság (' + recent.length + ' mérés, átlag ' + avgStr + ' óra/éjszaka): kb. ' + Math.round(Math.abs(diff) * 10) / 10 + ' óra hiány a ' + SLEEP_GOAL_HOURS + ' órás célhoz képest.';
    } else {
      el.textContent = 'Átlag ' + avgStr + ' óra/éjszaka az utóbbi ' + recent.length + ' mérésen — a ' + SLEEP_GOAL_HOURS + ' órás cél körül vagy felette.';
    }
  }

  // Vitals/sleep cards share one chart area per grid (hd-vitals-chart /
  // hd-sleep-chart) instead of one-per-card like Labor, since these are laid
  // out as a compact stat grid rather than a list. Only sleepHours gets a
  // reference line (a general ~8h target) — weight/waist/BP/pulse deliberately
  // don't get invented target numbers; those should come from an actual
  // doctor/program, not a guess baked into the app.
  const VITALS_CHART_META = { sleepHours: { target: 8, targetLabel: 'cél (8 óra)' } };
  const SLEEP_FIELDS = ['sleepHours', 'sleepDeepMin', 'sleepRemMin', 'sleepRestingPulse'];
  // Fields whose tap-to-expand chart lives outside the two default vitals/
  // sleep chart areas (e.g. steps sits on the Mozgás tab, not Mérések).
  const VITALS_CHART_WRAP_OVERRIDE = { steps: 'hd-steps-chart' };
  let vitalsHistory = [];
  let surgeryPlanState = null;
  const vitalsChartInstances = {};
  const waterChartInstances = {};
  const nutriChartInstances = {};
  let mealsHistoryState = [];

  function buildVitalsSeries(field) {
    if (field === 'bp') {
      const dates = [];
      const bySys = {};
      const byDia = {};
      vitalsHistory.forEach((row) => {
        if (row.sys != null || row.dia != null) {
          if (dates.indexOf(row.date) === -1) dates.push(row.date);
          if (row.sys != null) bySys[row.date] = row.sys;
          if (row.dia != null) byDia[row.date] = row.dia;
        }
      });
      return [
        { label: 'Sys', points: dates.map((d) => ({ date: d, value: bySys[d] ?? null })) },
        { label: 'Dia', points: dates.map((d) => ({ date: d, value: byDia[d] ?? null })) }
      ];
    }
    const points = vitalsHistory.filter((row) => row[field] != null).map((row) => ({ date: row.date, value: row[field] }));
    return [{ label: field, points }];
  }

  function toggleVitalsCard(field, cardEl) {
    const wrapId = VITALS_CHART_WRAP_OVERRIDE[field] || (SLEEP_FIELDS.indexOf(field) !== -1 ? 'hd-sleep-chart' : 'hd-vitals-chart');
    const chartWrap = document.getElementById(wrapId);
    const grid = cardEl.parentElement;
    const prevKey = chartWrap.dataset.activeKey;
    const wasOpen = chartWrap.style.display !== 'none';

    if (wasOpen && prevKey && prevKey !== field) {
      toggleTrendChart(chartWrap, vitalsChartInstances, prevKey, [], []);
    }
    const closingSameField = wasOpen && prevKey === field;

    const meta = VITALS_CHART_META[field] || {};
    const refLines = meta.target != null ? [{ label: meta.targetLabel || 'cél', value: meta.target, color: '#C9A227' }] : [];
    const markers = [];
    if (field === 'weight' && surgeryPlanState) {
      if (surgeryPlanState.consultationDate) markers.push({ date: surgeryPlanState.consultationDate, label: 'Konzultáció', color: '#7A9E8E' });
      if (surgeryPlanState.estimatedSurgeryDate) markers.push({ date: surgeryPlanState.estimatedSurgeryDate, label: 'Műtét (becsült)', color: '#C1666B' });
    }
    toggleTrendChart(chartWrap, vitalsChartInstances, field, buildVitalsSeries(field), refLines, markers);

    chartWrap.dataset.activeKey = closingSameField ? '' : field;
    grid.querySelectorAll('.hd-tap-card').forEach((c) => c.classList.toggle('active', !closingSameField && c.dataset.vfield === field));
  }

  // Reference ranges as configured on each property in the Notion "Labor" database
  // (baked in here since a Notion database *query* only returns property values, not
  // the column's configured description/reference-range text). LDH is intentionally
  // left unflagged — its own Notion description notes two conflicting reference
  // ranges depending on which lab produced the result.
  const LAB_GROUPS = [
    { label: 'Vérkép', fields: ['WBC', 'RBC', 'Hemoglobin', 'Hematokrit', 'MCV', 'MCH', 'MCHC', 'RDW', 'MPV', 'Trombocitaszám', 'Neutrofil %', 'Limfocita %', 'Monocita %', 'Eozinofil %', 'Bazofil %', 'We (süllyedés)'] },
    { label: 'Vesefunkció', fields: ['Kreatinin', 'eGFR', 'Karbamid', 'Húgysav', 'Nátrium', 'Kálium', 'Kalcium', 'Magnézium', 'Foszfát'] },
    { label: 'Májfunkció', fields: ['GOT (AST)', 'GPT (ALT)', 'GGT', 'Alkalikus foszfatáz', 'Összbilirubin', 'Összfehérje', 'Albumin', 'LDH'] },
    { label: 'Lipidek', fields: ['Koleszterin', 'HDL koleszterin', 'LDL koleszterin', 'Trigliceridek'] },
    { label: 'Anyagcsere', fields: ['Glükóz', 'HbA1c IFCC', 'HbA1c NGSP'] },
    { label: 'Gyulladás / enzimek', fields: ['CRP', 'Amiláz', 'Lipáz', 'CK'] },
    { label: 'Mikrotápanyagok', fields: ['B12 (kobalamin)', 'Folsav', 'D-vitamin (25-OH)', 'Ferritin', 'Vas (Fe)'] },
    { label: 'Egyéb', fields: ['TSH', 'PSA'] }
  ];
  const LAB_META = {
    'B12 (kobalamin)': { unit: 'pmol/L', min: 150, max: 670 },
    'D-vitamin (25-OH)': { unit: 'nmol/L', min: 50, max: 125 },
    'Ferritin': { unit: 'ug/L', min: 30, max: 400 },
    'Folsav': { unit: 'nmol/L', min: 7, max: 45 },
    'Albumin': { unit: 'g/L', min: 35.0, max: 52.0 },
    'Alkalikus foszfatáz': { unit: 'U/L', min: 40, max: 129 },
    'Amiláz': { unit: 'U/L', min: 28, max: 100 },
    'Bazofil %': { unit: '%', min: 0.0, max: 1.0 },
    'CK': { unit: 'U/L', max: 172 },
    'CRP': { unit: 'mg/L', max: 5.0 },
    'Eozinofil %': { unit: '%', min: 1.0, max: 4.0 },
    'Foszfát': { unit: 'mmol/L', min: 0.81, max: 1.45 },
    'GGT': { unit: 'U/L', max: 60 },
    'GOT (AST)': { unit: 'U/L', max: 50 },
    'GPT (ALT)': { unit: 'U/L', max: 50 },
    'Glükóz': { unit: 'mmol/L', min: 3.7, max: 6.0, note: 'éhgyomri' },
    'HDL koleszterin': { unit: 'mmol/L', min: 1.04 },
    'HbA1c IFCC': { unit: 'mmol/mol', min: 20.0, max: 39.0 },
    'HbA1c NGSP': { unit: '%', min: 4.0, max: 5.6 },
    'Hematokrit': { unit: 'L/L', min: 0.40, max: 0.52 },
    'Hemoglobin': { unit: 'g/L', min: 135, max: 175 },
    'Húgysav': { unit: 'umol/L', min: 202, max: 428 },
    'Kalcium': { unit: 'mmol/L', min: 2.15, max: 2.65 },
    'Karbamid': { unit: 'mmol/L', min: 2.1, max: 7.2 },
    'Koleszterin': { unit: 'mmol/L', max: 5.2 },
    'Kreatinin': { unit: 'umol/L', min: 62, max: 106 },
    'Kálium': { unit: 'mmol/L', min: 3.5, max: 5.1 },
    'LDH': { unit: 'U/L', note: 'referencia labortól függ' },
    'LDL koleszterin': { unit: 'mmol/L', max: 3.34 },
    'Limfocita %': { unit: '%', min: 25.0, max: 40.0 },
    'Lipáz': { unit: 'U/L', max: 67 },
    'MCH': { unit: 'pg', min: 28, max: 33 },
    'MCHC': { unit: 'g/L', min: 310, max: 365 },
    'MCV': { unit: 'fL', min: 80, max: 96 },
    'MPV': { unit: 'fL', min: 7.2, max: 13.0 },
    'Magnézium': { unit: 'mmol/L', min: 0.73, max: 1.06 },
    'Monocita %': { unit: '%', min: 2.0, max: 8.0 },
    'Neutrofil %': { unit: '%', min: 50.0, max: 70.0 },
    'Nátrium': { unit: 'mmol/L', min: 136, max: 146 },
    'PSA': { unit: 'ug/L', max: 4.0 },
    'RBC': { unit: 'T/L', min: 4.5, max: 5.9 },
    'RDW': { unit: '%', min: 11.6, max: 15.6 },
    'TSH': { unit: 'mIU/L', min: 0.550, max: 4.780 },
    'Trigliceridek': { unit: 'mmol/L', max: 1.71 },
    'Trombocitaszám': { unit: 'G/L', min: 150, max: 450 },
    'Vas (Fe)': { unit: 'umol/L', min: 12.5, max: 32.2 },
    'WBC': { unit: 'G/L', min: 4.4, max: 11.3 },
    'We (süllyedés)': { unit: 'mm/h', min: 2, max: 10 },
    'eGFR': { unit: 'mL/min/1.73m2', min: 90 },
    'Összbilirubin': { unit: 'umol/L', min: 5.0, max: 21.0 },
    'Összfehérje': { unit: 'g/L', min: 66.0, max: 87.0 }
  };

  // /api/labor/recent returns one entry per lab visit (ascending), each carrying only
  // the markers that particular panel actually tested. Take the most recent non-null
  // reading per marker, remembering which date it came from.
  function latestPerLabField(rows) {
    const latest = {};
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      Object.keys(row).forEach((key) => {
        if (key === 'date' || key === 'source') return;
        if (!(key in latest) && row[key] != null) {
          latest[key] = { value: row[key], date: row.date };
        }
      });
    }
    return latest;
  }

  // Shows a prominent warning once the estimated surgery date is within 14
  // days and at least one of the required-stop supplements is still checked
  // on in today's checklist — i.e. only when there's actually something left
  // to act on, not just because a date is near.
  function renderSurgeryWarning(plan, checklist) {
    const wrap = document.getElementById('hd-surgery-warning');
    wrap.innerHTML = '';
    if (!plan || !plan.estimatedSurgeryDate) return;
    const daysUntil = Math.ceil((new Date(plan.estimatedSurgeryDate + 'T00:00:00') - new Date(todayKey + 'T00:00:00')) / 86400000);
    if (daysUntil < 0 || daysUntil > 14) return;
    const stillOn = PRE_OP_STOP_SUPPLEMENTS.filter((f) => checklist && checklist[f]);
    if (!stillOn.length) return;
    const div = document.createElement('div');
    div.className = 'hd-banner';
    div.style.borderColor = '#C1666B';
    const p = document.createElement('p');
    p.style.margin = '0';
    p.textContent = (daysUntil === 0 ? 'A becsült műtéti dátum ma van.' : 'A becsült műtéti dátumig ' + daysUntil + ' nap van hátra.') +
      ' Le kell állítani: ' + stillOn.join(', ') + ' (vérzésrizikó miatt, egyeztetve a sebészeti csapattal).';
    div.appendChild(p);
    wrap.appendChild(div);
  }

  // Renders each non-empty line as its own <p> via textContent (never innerHTML)
  // since this text comes from the Anthropic API, not our own fixed templates.
  function renderCoachSection(containerId, text, generatedAt, stale) {
    const wrap = document.getElementById(containerId);
    if (!wrap) return;
    wrap.innerHTML = '';
    if (!text) {
      if (stale) {
        wrap.innerHTML = '<div class="hd-coach-card"><p class="hd-coach-title">Coach jegyzetek</p><p style="font-size:13px; opacity:.6;">Az első elemzés készül — nézz vissza néhány perc múlva.</p></div>';
      }
      return;
    }
    const card = document.createElement('div');
    card.className = 'hd-coach-card';
    const title = document.createElement('p');
    title.className = 'hd-coach-title';
    title.textContent = 'Coach jegyzetek';
    card.appendChild(title);
    const textWrap = document.createElement('div');
    textWrap.className = 'hd-coach-text collapsed';
    text.split('\n').map((s) => s.trim()).filter(Boolean).forEach((line) => {
      const p = document.createElement('p');
      p.textContent = line;
      textWrap.appendChild(p);
    });
    card.appendChild(textWrap);
    const toggle = document.createElement('button');
    toggle.className = 'hd-coach-toggle';
    toggle.textContent = 'Mutasd a teljeset ▾';
    toggle.addEventListener('click', () => {
      const isCollapsed = textWrap.classList.toggle('collapsed');
      toggle.textContent = isCollapsed ? 'Mutasd a teljeset ▾' : 'Összecsukás ▴';
    });
    card.appendChild(toggle);
    const meta = document.createElement('p');
    meta.className = 'hd-coach-meta';
    meta.textContent = (generatedAt ? 'Frissítve: ' + generatedAt.slice(0, 16).replace('T', ' ') : '') + (stale ? ' · új adat alapján frissítés folyamatban' : '');
    card.appendChild(meta);
    wrap.appendChild(card);
  }

  const COACH_SECTION_TARGETS = { vitals: 'hd-coach-vitals', activity: 'hd-coach-activity', nutrition: 'hd-coach-nutrition', meds: 'hd-coach-meds', labor: 'hd-coach-notes' };
  function renderAllCoachSections(data) {
    const sections = (data && data.sections) || {};
    Object.keys(COACH_SECTION_TARGETS).forEach((key) => {
      renderCoachSection(COACH_SECTION_TARGETS[key], sections[key], data && data.generatedAt, data && data.stale);
    });
  }

  // Full ascending history, kept around so a tapped row can chart every reading
  // it ever had (not just the latest), and the Chart.js instances currently
  // shown, so a second tap can destroy the old canvas before removing it.
  let laborHistory = [];
  const laborChartInstances = {};

  function renderLabor(rows) {
    laborHistory = rows || [];
    const wrap = document.getElementById('hd-labor-groups');
    wrap.innerHTML = '';
    Object.keys(laborChartInstances).forEach((k) => delete laborChartInstances[k]);
    const latest = latestPerLabField(laborHistory);
    let any = false;
    LAB_GROUPS.forEach((group) => {
      const rowsHtml = group.fields
        .filter((f) => latest[f])
        .map((f) => {
          const meta = LAB_META[f] || {};
          const entry = latest[f];
          const out = (meta.min != null && entry.value < meta.min) || (meta.max != null && entry.value > meta.max);
          const rangeText = meta.min != null && meta.max != null ? meta.min + '–' + meta.max + (meta.unit ? ' ' + meta.unit : '')
            : meta.max != null ? '<' + meta.max + (meta.unit ? ' ' + meta.unit : '')
            : meta.min != null ? '>' + meta.min + (meta.unit ? ' ' + meta.unit : '')
            : (meta.note || '');
          return '<div class="hd-lab-item">' +
            '<div class="hd-lab-row" data-field="' + f + '">' +
            '<div class="hd-lab-top"><span class="hd-lab-name">' + f + '</span>' +
            '<span class="hd-lab-val' + (out ? ' out' : '') + '">' + entry.value + (meta.unit ? ' ' + meta.unit : '') + '</span></div>' +
            '<div class="hd-lab-bottom"><span>' + rangeText + '</span><span>' + entry.date + '</span></div>' +
            '</div>' +
            '<div class="hd-lab-chart-wrap" style="display:none;"></div>' +
            '</div>';
        }).join('');
      if (!rowsHtml) return;
      any = true;
      wrap.insertAdjacentHTML('beforeend', '<p class="hd-section-title">' + group.label + '</p><div class="hd-card">' + rowsHtml + '</div>');
    });
    if (!any) {
      wrap.innerHTML = '<p style="font-size:13px; opacity:.55;">Nincs laboreredmény.</p>';
      return;
    }
    wrap.querySelectorAll('.hd-lab-row').forEach((rowEl) => {
      rowEl.addEventListener('click', () => toggleLaborChart(rowEl.dataset.field, rowEl.closest('.hd-lab-item')));
    });
  }

  // Generic tap-to-expand trend chart, shared by Labor markers and vitals/sleep
  // cards. `series` is [{ label, points: [{date, value}] }] (usually one, two
  // for the BP sys/dia overlay); `refLines` is [{ label, value, color }]
  // constant dashed lines (reference ranges for labs, a sleep-hours target,
  // etc). `chartInstances` is the caller's own {key: ChartInstance} map so
  // Labor and vitals charts don't collide, and a second tap on the same key
  // destroys the previous canvas before removing it.
  // `markers` (optional) is [{date, label, color}] — vertical event lines via
  // chartjs-plugin-annotation (surgery consultation/op dates, etc). A category
  // x-axis can only anchor an annotation at an existing label, so a marker's
  // date is unioned into the label set even when nothing was measured that
  // day (spanGaps on each series keeps the line looking normal across it).
  function toggleTrendChart(chartWrap, chartInstances, key, series, refLines, markers) {
    const isOpen = chartWrap.style.display !== 'none';
    if (chartInstances[key]) {
      chartInstances[key].destroy();
      delete chartInstances[key];
    }
    if (isOpen) {
      chartWrap.style.display = 'none';
      chartWrap.innerHTML = '';
      return;
    }
    if (!series.length || !series[0].points.length) {
      chartWrap.style.display = 'block';
      chartWrap.innerHTML = '<p style="font-size:13px; opacity:.55; margin:8px 4px;">Nincs elég adat a trendhez.</p>';
      return;
    }
    chartWrap.style.display = 'block';
    chartWrap.innerHTML = '<div style="position:relative; width:100%; height:160px;"><canvas></canvas></div>';

    const labelSet = new Set();
    series.forEach((s) => s.points.forEach((p) => labelSet.add(p.date)));
    (markers || []).forEach((m) => labelSet.add(m.date));
    const labels = [...labelSet].sort();

    const palette = ['#1B3A4B', '#C9A227'];
    const datasets = series.map((s, i) => {
      const byDate = {};
      s.points.forEach((p) => { byDate[p.date] = p.value; });
      return {
        label: s.label, data: labels.map((d) => (d in byDate ? byDate[d] : null)),
        borderColor: palette[i % palette.length], backgroundColor: palette[i % palette.length],
        tension: 0.15, pointRadius: 3, borderWidth: 2, spanGaps: true
      };
    });
    (refLines || []).forEach((line) => {
      datasets.push({ label: line.label, data: labels.map(() => line.value), borderColor: line.color, borderDash: [4, 4], pointRadius: 0, borderWidth: 1 });
    });

    const annotations = {};
    (markers || []).forEach((m, i) => {
      annotations['marker' + i] = {
        type: 'line', xMin: m.date, xMax: m.date, borderColor: m.color || '#C1666B', borderWidth: 2, borderDash: [3, 3],
        label: { display: true, content: m.label, position: 'start', font: { size: 9 }, backgroundColor: m.color || '#C1666B', color: '#fff', padding: 3 }
      };
    });

    chartInstances[key] = new Chart(chartWrap.querySelector('canvas'), {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: series.length > 1 }, annotation: { annotations } },
        scales: {
          y: { grid: { color: '#e1e0d9' } },
          x: { grid: { display: false }, ticks: { autoSkip: true, maxRotation: 45, font: { size: 9 } } }
        }
      }
    });
  }

  function toggleLaborChart(field, itemEl) {
    const chartWrap = itemEl.querySelector('.hd-lab-chart-wrap');
    const points = laborHistory.filter((row) => row[field] != null).map((row) => ({ date: row.date, value: row[field] }));
    const meta = LAB_META[field] || {};
    const refLines = [];
    if (meta.min != null) refLines.push({ label: 'min', value: meta.min, color: '#7A9E8E' });
    if (meta.max != null) refLines.push({ label: 'max', value: meta.max, color: '#C1666B' });
    toggleTrendChart(chartWrap, laborChartInstances, field, [{ label: field, points }], refLines);
  }

  // General movement guidelines (~150 min/week moderate activity, ~70,000
  // steps/week i.e. ~10k/day, are common WHO/Attia-cited baselines) — shown
  // as context, not a personalized prescription.
  const WEEKLY_MOVEMENT_TARGET_MIN = 150;
  const WEEKLY_STEPS_TARGET = 70000;
  function renderMovementRollup(activities) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    const cutoffKey = cutoff.toISOString().slice(0, 10);
    const recent = (activities || []).filter((a) => a.date >= cutoffKey);
    const minutes = recent.reduce((sum, a) => sum + (a.minutes || 0), 0);
    const km = recent.reduce((sum, a) => sum + (a.km || 0), 0);
    document.getElementById('hd-move-minutes').textContent = minutes;
    document.getElementById('hd-move-km').textContent = Math.round(km * 10) / 10;
    const note = document.getElementById('hd-move-note');
    if (minutes >= WEEKLY_MOVEMENT_TARGET_MIN) {
      note.textContent = 'A ~' + WEEKLY_MOVEMENT_TARGET_MIN + ' perces heti irányszám (WHO/Attia-féle általános ajánlás) teljesítve.';
    } else {
      note.textContent = 'Általános irányszám ~' + WEEKLY_MOVEMENT_TARGET_MIN + ' perc/hét — még ' + (WEEKLY_MOVEMENT_TARGET_MIN - minutes) + ' perc hiányzik.';
    }

    const recentSteps = vitalsHistory.filter((r) => r.date >= cutoffKey && r.steps != null);
    const steps = recentSteps.reduce((sum, r) => sum + r.steps, 0);
    document.getElementById('hd-move-steps').textContent = recentSteps.length ? steps : '—';
    const stepsNote = document.getElementById('hd-move-steps-note');
    if (!recentSteps.length) {
      stepsNote.textContent = '';
    } else if (steps >= WEEKLY_STEPS_TARGET) {
      stepsNote.textContent = 'A ~' + WEEKLY_STEPS_TARGET.toLocaleString('hu-HU') + ' lépéses heti irányszám (kb. napi 10 000) teljesítve.';
    } else {
      stepsNote.textContent = 'Általános irányszám ~' + WEEKLY_STEPS_TARGET.toLocaleString('hu-HU') + ' lépés/hét — még ' + (WEEKLY_STEPS_TARGET - steps).toLocaleString('hu-HU') + ' lépés hiányzik.';
    }
  }

  function renderActivityChart(activities) {
    const labels = activities.map((a) => a.date);
    const km = activities.map((a) => a.km);
    new Chart(document.getElementById('activityChart'), {
      type: 'bar',
      data: { labels, datasets: [{ label: 'Táv (km)', data: km, backgroundColor: '#2a78d6', borderRadius: 4, maxBarThickness: 20 }] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { grid: { color: '#e1e0d9' }, title: { display: true, text: 'km' } },
          x: { grid: { display: false }, ticks: { autoSkip: false, maxRotation: 45, font: { size: 10 } } }
        }
      }
    });
  }

  const WATER_GLASSES = 11;
  // One tap == one glass, rather than tapping a specific numbered glass in a
  // row — friction reduction the user asked for directly (2026-08-28): the
  // old row required picking the right number each time, this just counts up.
  function renderWater(waterCount, onChange) {
    const row = document.getElementById('hd-water-row');
    const summary = document.getElementById('hd-water-summary');
    let filled = waterCount || 0;

    function redraw() {
      row.innerHTML = '';
      const addBtn = document.createElement('button');
      addBtn.className = 'hd-btn hd-water-add';
      addBtn.textContent = '+1 pohár 💧';
      addBtn.addEventListener('click', async () => {
        filled += 1;
        await onChange(filled);
        redraw();
      });
      row.appendChild(addBtn);
      if (filled > 0) {
        const undoBtn = document.createElement('button');
        undoBtn.className = 'hd-btn ghost';
        undoBtn.textContent = '−1 (elírás javítása)';
        undoBtn.addEventListener('click', async () => {
          filled -= 1;
          await onChange(filled);
          redraw();
        });
        row.appendChild(undoBtn);
      }
      const dots = document.createElement('div');
      dots.className = 'hd-glass-dots';
      for (let i = 1; i <= WATER_GLASSES; i++) {
        const dot = document.createElement('div');
        dot.className = 'hd-glass-dot' + (i <= filled ? ' filled' : '');
        dots.appendChild(dot);
      }
      row.appendChild(dots);
      summary.textContent = filled + ' / ' + WATER_GLASSES + ' pohár (' + filled * 250 + ' / ' + WATER_GLASSES * 250 + ' ml)';
    }
    redraw();
  }

  // ---- Weekly workout program -------------------------------------------
  const WORKOUT_DAY_ORDER = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  const WORKOUT_DAY_LABELS = { monday: 'Hétfő', tuesday: 'Kedd', wednesday: 'Szerda', thursday: 'Csütörtök', friday: 'Péntek', saturday: 'Szombat', sunday: 'Vasárnap' };
  let workoutRecentHistory = [];
  const workoutChartInstances = {};

  function toggleWorkoutChart(exerciseName) {
    const chartWrap = document.getElementById('hd-workout-chart');
    const prevKey = chartWrap.dataset.activeKey;
    const wasOpen = chartWrap.style.display !== 'none';
    if (wasOpen && prevKey && prevKey !== exerciseName) {
      toggleTrendChart(chartWrap, workoutChartInstances, prevKey, [], []);
    }
    const closingSame = wasOpen && prevKey === exerciseName;
    const points = workoutRecentHistory.filter((r) => r.exercise === exerciseName && r.weight != null).map((r) => ({ date: r.date, value: r.weight }));
    toggleTrendChart(chartWrap, workoutChartInstances, exerciseName, [{ label: 'Súly (kg)', points }], []);
    chartWrap.dataset.activeKey = closingSame ? '' : exerciseName;
    document.querySelectorAll('#hd-workout-today-list li').forEach((li) => li.classList.toggle('active', !closingSame && li.dataset.exercise === exerciseName));
  }

  function renderWorkoutToday(items) {
    const ul = document.getElementById('hd-workout-today-list');
    const emptyEl = document.getElementById('hd-workout-today-empty');
    ul.innerHTML = '';
    if (!items || !items.length) {
      emptyEl.textContent = 'Ma nincs edzés betervezve — állítsd be a heti programot lentebb.';
      return;
    }
    emptyEl.textContent = '';
    items.forEach((ex) => {
      const li = document.createElement('li');
      li.dataset.exercise = ex.name;

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!ex.done;

      const label = document.createElement('label');
      label.style.cursor = 'pointer';
      label.textContent = ex.name;
      if (ex.done) label.classList.add('done');
      label.addEventListener('click', (e) => { e.preventDefault(); toggleWorkoutChart(ex.name); });

      const setsInput = document.createElement('input');
      setsInput.type = 'number'; setsInput.placeholder = 'szett'; setsInput.className = 'hd-workout-mini-input';
      setsInput.value = ex.done ? (ex.loggedSets ?? '') : (ex.sets ?? '');
      const repsInput = document.createElement('input');
      repsInput.type = 'number'; repsInput.placeholder = 'ism.'; repsInput.className = 'hd-workout-mini-input';
      repsInput.value = ex.done ? (ex.loggedReps ?? '') : (ex.reps ?? '');
      const weightInput = document.createElement('input');
      weightInput.type = 'number'; weightInput.step = '0.5'; weightInput.placeholder = 'kg'; weightInput.className = 'hd-workout-mini-input';
      weightInput.value = ex.done ? (ex.loggedWeight ?? '') : (ex.weight ?? '');

      cb.addEventListener('change', async () => {
        cb.disabled = true;
        try {
          if (cb.checked) {
            await api('/api/workout/log', {
              method: 'POST',
              body: JSON.stringify({
                exercise: ex.name,
                sets: setsInput.value === '' ? undefined : Number(setsInput.value),
                reps: repsInput.value === '' ? undefined : Number(repsInput.value),
                weight: weightInput.value === '' ? undefined : Number(weightInput.value)
              })
            });
            label.classList.add('done');
          } else {
            await api('/api/workout/unlog', { method: 'POST', body: JSON.stringify({ exercise: ex.name }) });
            label.classList.remove('done');
          }
        } finally {
          cb.disabled = false;
        }
      });

      li.appendChild(cb);
      li.appendChild(label);
      li.appendChild(setsInput);
      li.appendChild(repsInput);
      li.appendChild(weightInput);
      ul.appendChild(li);
    });
  }

  function renderWorkoutPlanEditor(plan) {
    const wrap = document.getElementById('hd-workout-plan-editor');
    const state = {};
    WORKOUT_DAY_ORDER.forEach((day) => { state[day] = (plan[day] || []).map((ex) => ({ ...ex })); });

    function redraw() {
      wrap.innerHTML = '';
      WORKOUT_DAY_ORDER.forEach((day) => {
        const dayCard = document.createElement('div');
        dayCard.className = 'hd-card';
        dayCard.style.marginBottom = '10px';
        const title = document.createElement('p');
        title.className = 'hd-stat-label';
        title.textContent = WORKOUT_DAY_LABELS[day];
        dayCard.appendChild(title);

        state[day].forEach((ex, idx) => {
          const row = document.createElement('div');
          row.className = 'hd-workout-plan-row';

          const nameInput = document.createElement('input');
          nameInput.type = 'text'; nameInput.placeholder = 'gyakorlat neve'; nameInput.value = ex.name || '';
          nameInput.addEventListener('input', () => { ex.name = nameInput.value; });

          const setsInput = document.createElement('input');
          setsInput.type = 'number'; setsInput.placeholder = 'szett'; setsInput.value = ex.sets ?? '';
          setsInput.addEventListener('input', () => { ex.sets = setsInput.value === '' ? null : Number(setsInput.value); });

          const repsInput = document.createElement('input');
          repsInput.type = 'number'; repsInput.placeholder = 'ism.'; repsInput.value = ex.reps ?? '';
          repsInput.addEventListener('input', () => { ex.reps = repsInput.value === '' ? null : Number(repsInput.value); });

          const weightInput = document.createElement('input');
          weightInput.type = 'number'; weightInput.step = '0.5'; weightInput.placeholder = 'kg (ha van)'; weightInput.value = ex.weight ?? '';
          weightInput.addEventListener('input', () => { ex.weight = weightInput.value === '' ? null : Number(weightInput.value); });

          const rm = document.createElement('button');
          rm.className = 'hd-btn ghost';
          rm.textContent = '×';
          rm.type = 'button';
          rm.addEventListener('click', () => { state[day].splice(idx, 1); redraw(); });

          row.appendChild(nameInput);
          row.appendChild(setsInput);
          row.appendChild(repsInput);
          row.appendChild(weightInput);
          row.appendChild(rm);
          dayCard.appendChild(row);
        });

        const addBtn = document.createElement('button');
        addBtn.className = 'hd-btn ghost';
        addBtn.type = 'button';
        addBtn.textContent = '+ gyakorlat';
        addBtn.style.marginTop = '4px';
        addBtn.addEventListener('click', () => { state[day].push({ name: '', sets: null, reps: null, weight: null }); redraw(); });
        dayCard.appendChild(addBtn);

        wrap.appendChild(dayCard);
      });

      const saveBtn = document.createElement('button');
      saveBtn.className = 'hd-btn';
      saveBtn.type = 'button';
      saveBtn.textContent = 'Program mentése';
      const statusEl = document.createElement('p');
      statusEl.style.fontSize = '12px';
      statusEl.style.opacity = '.6';
      statusEl.style.margin = '6px 0 14px';
      saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        statusEl.textContent = 'Mentés…';
        try {
          await api('/api/workout-plan', { method: 'POST', body: JSON.stringify(state) });
          location.reload();
        } catch (err) {
          statusEl.textContent = 'Nem sikerült menteni: ' + err.message;
          saveBtn.disabled = false;
        }
      });
      wrap.appendChild(saveBtn);
      wrap.appendChild(statusEl);
    }
    redraw();
  }

  // Shared by the exercises list and the digestive-symptoms log — both are
  // "newline-joined free-text items, one Notion rich_text field" lists.
  function renderTextList(listId, inputId, addBtnId, str, onSave) {
    const items = (str || '').split('\n').filter(Boolean);
    const ul = document.getElementById(listId);

    function redraw() {
      ul.innerHTML = '';
      items.forEach((item, idx) => {
        const li = document.createElement('li');
        li.textContent = item;
        const rm = document.createElement('button');
        rm.className = 'hd-btn ghost';
        rm.textContent = 'törlés';
        rm.style.marginLeft = 'auto';
        rm.addEventListener('click', async () => {
          items.splice(idx, 1);
          await onSave(items.join('\n'));
          redraw();
        });
        li.appendChild(rm);
        ul.appendChild(li);
      });
    }
    redraw();

    document.getElementById(addBtnId).onclick = async () => {
      const input = document.getElementById(inputId);
      const val = input.value.trim();
      if (!val) return;
      items.push(val);
      await onSave(items.join('\n'));
      input.value = '';
      redraw();
    };
  }

  function renderSuggestedTests(items) {
    const ul = document.getElementById('hd-suggested-tests-list');
    const list = items.slice();

    async function save() {
      await api('/api/suggested-tests', { method: 'POST', body: JSON.stringify({ items: list }) });
    }

    function redraw() {
      ul.innerHTML = '';
      list.forEach((item, idx) => {
        const li = document.createElement('li');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = !!item.done;
        checkbox.id = 'hd-suggested-test-' + item.id;
        checkbox.addEventListener('change', async () => {
          item.done = checkbox.checked;
          label.classList.toggle('done', item.done);
          await save();
        });
        const label = document.createElement('label');
        label.htmlFor = checkbox.id;
        label.textContent = item.text;
        if (item.done) label.classList.add('done');
        const rm = document.createElement('button');
        rm.className = 'hd-btn ghost';
        rm.textContent = 'törlés';
        rm.style.marginLeft = 'auto';
        rm.addEventListener('click', async () => {
          list.splice(idx, 1);
          await save();
          redraw();
        });
        li.appendChild(checkbox);
        li.appendChild(label);
        li.appendChild(rm);
        ul.appendChild(li);
      });
    }
    redraw();

    document.getElementById('hd-suggested-test-add').onclick = async () => {
      const input = document.getElementById('hd-suggested-test-input');
      const val = input.value.trim();
      if (!val) return;
      list.push({ id: 'test-' + Date.now(), text: val, done: false });
      await save();
      input.value = '';
      redraw();
    };
  }

  async function main() {
    try {
      const [vitals, meals, activities, checklist, labor, coachNotes, surgeryPlan, vitalsRecent, checklistRecent, mealsRecent, suggestedTests, workoutPlan, workoutToday, workoutRecent] = await Promise.all([
        api('/api/vitals/today'),
        api('/api/meals/today'),
        api('/api/activity/recent'),
        api('/api/checklist/today'),
        api('/api/labor/recent?limit=100'),
        api('/api/coach-notes'),
        api('/api/surgery-plan'),
        api('/api/vitals/recent?limit=100'),
        api('/api/checklist/recent?days=30'),
        api('/api/meals/recent?days=30'),
        api('/api/suggested-tests'),
        api('/api/workout-plan'),
        api('/api/workout/today'),
        api('/api/workout/recent?days=180')
      ]);
      workoutRecentHistory = workoutRecent;

      vitalsHistory = vitalsRecent;
      surgeryPlanState = surgeryPlan;
      root.classList.remove('loading');
      renderVitals(vitals);
      renderSleepDebt(vitalsHistory);
      renderMeals(meals);
      renderNutritionTrendStat(mealsRecent);
      renderActivityChart(activities);
      renderMovementRollup(activities);
      renderConsistency(checklistRecent);
      renderNordicWalkingConsistency(checklistRecent);
      renderWaterAverage(checklistRecent);
      renderLabor(labor);
      renderAllCoachSections(coachNotes);
      renderSurgeryWarning(surgeryPlan, checklist);
      renderSuggestedTests(suggestedTests);
      renderWeeklyDigest(vitalsHistory, checklistRecent, mealsRecent);
      renderWorkoutToday(workoutToday);
      renderWorkoutPlanEditor(workoutPlan);

      renderChecklistRow(document.getElementById('hd-nw-list'), ['Nordic walking'], checklist, async (field, val) => {
        await postChecklistPatch({ [field]: val });
      });

      const medGroups = { morning: [], evening: [], weekly: [], supp: [], routine: [] };
      Object.entries(MED_LABELS).forEach(([field, group]) => medGroups[group].push(field));
      const toggleMed = async (field, val) => {
        await postChecklistPatch({ [field]: val });
      };
      renderChecklistRow(document.getElementById('hd-med-morning'), medGroups.morning, checklist, toggleMed);
      renderChecklistRow(document.getElementById('hd-med-evening'), medGroups.evening, checklist, toggleMed);
      renderChecklistRow(document.getElementById('hd-med-weekly'), medGroups.weekly, checklist, toggleMed);
      renderChecklistRow(document.getElementById('hd-med-supp'), medGroups.supp, checklist, toggleMed);
      renderChecklistRow(document.getElementById('hd-med-routine'), medGroups.routine, checklist, toggleMed);

      renderWater(checklist.water, async (n) => {
        await postChecklistPatch({ water: n });
      });

      renderTextList('hd-ex-list', 'hd-ex-input', 'hd-ex-add', checklist.exercises, async (str) => {
        await postChecklistPatch({ exercises: str });
      });

      renderTextList('hd-symptom-list', 'hd-symptom-input', 'hd-symptom-add', checklist.symptoms, async (str) => {
        await postChecklistPatch({ symptoms: str });
      });

      document.getElementById('hd-meal-estimate').onclick = async () => {
        const btn = document.getElementById('hd-meal-estimate');
        const statusEl = document.getElementById('hd-meal-estimate-status');
        const desc = document.getElementById('hd-meal-desc').value.trim();
        if (!desc) {
          statusEl.textContent = 'Előbb írd be, mit ettél.';
          return;
        }
        const calRaw = document.getElementById('hd-meal-cal').value;
        btn.disabled = true;
        statusEl.textContent = 'Becslés folyamatban…';
        try {
          const est = await api('/api/meals/estimate', {
            method: 'POST',
            body: JSON.stringify({ desc, calories: calRaw === '' ? undefined : Number(calRaw) })
          });
          document.getElementById('hd-meal-cal').value = est.calories;
          document.getElementById('hd-meal-protein').value = est.protein;
          document.getElementById('hd-meal-carbs').value = est.carbs;
          document.getElementById('hd-meal-fat').value = est.fat;
          document.getElementById('hd-meal-fiber').value = est.fiber;
          document.getElementById('hd-meal-sugar').value = est.sugar;
          statusEl.textContent = 'Becsült érték — ellenőrizd, mielőtt mented.';
        } catch (err) {
          statusEl.textContent = 'Nem sikerült megbecsülni: ' + err.message;
        } finally {
          btn.disabled = false;
        }
      };

      document.getElementById('hd-meal-add').onclick = async () => {
        const type = document.getElementById('hd-meal-type').value;
        const desc = document.getElementById('hd-meal-desc').value.trim();
        const num = (id) => {
          const v = document.getElementById(id).value;
          return v === '' ? undefined : Number(v);
        };
        await api('/api/meals/log', {
          method: 'POST',
          body: JSON.stringify({
            type, desc, calories: num('hd-meal-cal'), protein: num('hd-meal-protein'), carbs: num('hd-meal-carbs'), fat: num('hd-meal-fat'),
            fiber: num('hd-meal-fiber'), sugar: num('hd-meal-sugar')
          })
        });
        ['hd-meal-desc', 'hd-meal-cal', 'hd-meal-protein', 'hd-meal-carbs', 'hd-meal-fat', 'hd-meal-fiber', 'hd-meal-sugar'].forEach((id) => { document.getElementById(id).value = ''; });
        document.getElementById('hd-meal-estimate-status').textContent = '';
        renderMeals(await api('/api/meals/today'));
      };
    } catch (err) {
      root.classList.remove('loading');
      if (err.isAuthError) {
        const cfg = getConfig();
        const saved = await showSettingsModal({
          apiBase: cfg.apiBase,
          errorMessage: 'A backend 401-et adott vissza — az APP_TOKEN nem egyezik a Cloudflare Workeren beállítottal. Add meg az érvényes tokent.',
          allowCancel: true
        });
        if (saved) {
          location.reload();
          return;
        }
      }
      document.getElementById('hd-root').insertAdjacentHTML(
        'afterbegin',
        '<div class="hd-banner" style="border-color:#C1666B;">Nem sikerült elérni a backendet: ' + err.message + '. A fogaskerék ikonnal bármikor módosíthatod az API URL-t / tokent.</div>'
      );
    }
  }

  main();
})();
