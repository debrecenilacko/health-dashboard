// Frontend logic — talks to the Cloudflare Worker (see ../worker) which in
// turn talks to Notion. Nothing here holds the real Notion secret; it only
// holds the API base URL and the lightweight APP_TOKEN you chose yourself.

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

  root.querySelectorAll('.hd-tap-card').forEach((card) => {
    card.addEventListener('click', () => toggleVitalsCard(card.dataset.vfield, card));
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
  // "never logged" and "logged but unchecked" aren't the same signal).
  function renderConsistency(history) {
    const wrap = document.getElementById('hd-consistency-list');
    wrap.innerHTML = '';
    if (!history || !history.length) {
      wrap.innerHTML = '<p style="font-size:13px; opacity:.55;">Nincs elég adat.</p>';
      return;
    }
    const total = history.length;
    const rows = Object.keys(MED_LABELS).map((field) => {
      const count = history.filter((h) => h[field]).length;
      return { label: DISPLAY_NAME[field] || field, count, pct: Math.round((count / total) * 100) };
    }).sort((a, b) => a.pct - b.pct);

    rows.forEach((r) => {
      const row = document.createElement('div');
      row.className = 'hd-consist-row';
      row.innerHTML =
        '<div class="hd-consist-top"><span>' + r.label + '</span><span class="hd-consist-count">' + r.count + '/' + total + '</span></div>' +
        '<div class="hd-consist-bar"><div class="hd-consist-fill" style="width:' + r.pct + '%;"></div></div>';
      wrap.appendChild(row);
    });
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
      card.innerHTML =
        '<div class="hd-meal-type">' + (m.type || '') + '</div>' +
        '<div class="hd-meal-desc">' + (m.desc || '') + '</div>' +
        '<div class="hd-meal-macros">' + (m.calories || 0) + ' kcal · ' + (m.protein || 0) + 'g fehérje · ' + (m.carbs || 0) + 'g szénhidrát · ' + (m.fat || 0) + 'g zsír</div>';
      wrap.appendChild(card);
    });
    const totals = meals.reduce(
      (acc, m) => ({
        cal: acc.cal + (m.calories || 0), protein: acc.protein + (m.protein || 0),
        carbs: acc.carbs + (m.carbs || 0), fat: acc.fat + (m.fat || 0)
      }),
      { cal: 0, protein: 0, carbs: 0, fat: 0 }
    );
    document.getElementById('hd-nutri-cal').textContent = totals.cal;
    document.getElementById('hd-nutri-protein').textContent = totals.protein;
    document.getElementById('hd-nutri-carbs').textContent = totals.carbs;
    document.getElementById('hd-nutri-fat').textContent = totals.fat;
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
  let vitalsHistory = [];
  const vitalsChartInstances = {};

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
    const chartWrap = document.getElementById(SLEEP_FIELDS.indexOf(field) !== -1 ? 'hd-sleep-chart' : 'hd-vitals-chart');
    const grid = cardEl.parentElement;
    const prevKey = chartWrap.dataset.activeKey;
    const wasOpen = chartWrap.style.display !== 'none';

    if (wasOpen && prevKey && prevKey !== field) {
      toggleTrendChart(chartWrap, vitalsChartInstances, prevKey, [], []);
    }
    const closingSameField = wasOpen && prevKey === field;

    const meta = VITALS_CHART_META[field] || {};
    const refLines = meta.target != null ? [{ label: meta.targetLabel || 'cél', value: meta.target, color: '#C9A227' }] : [];
    toggleTrendChart(chartWrap, vitalsChartInstances, field, buildVitalsSeries(field), refLines);

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
    { label: 'Egyéb', fields: ['TSH', 'PSA', 'Vas (Fe)'] }
  ];
  const LAB_META = {
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
  function renderCoachNotes(data) {
    const wrap = document.getElementById('hd-coach-notes');
    wrap.innerHTML = '';
    if (!data || !data.notes) {
      if (data && data.stale) {
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
    textWrap.className = 'hd-coach-text';
    data.notes.split('\n').map((s) => s.trim()).filter(Boolean).forEach((line) => {
      const p = document.createElement('p');
      p.textContent = line;
      textWrap.appendChild(p);
    });
    card.appendChild(textWrap);
    const meta = document.createElement('p');
    meta.className = 'hd-coach-meta';
    meta.textContent = (data.generatedAt ? 'Frissítve: ' + data.generatedAt.slice(0, 16).replace('T', ' ') : '') + (data.stale ? ' · új adat alapján frissítés folyamatban' : '');
    card.appendChild(meta);
    wrap.appendChild(card);
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
  function toggleTrendChart(chartWrap, chartInstances, key, series, refLines) {
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
    const labels = series[0].points.map((p) => p.date);
    const palette = ['#1B3A4B', '#C9A227'];
    const datasets = series.map((s, i) => ({
      label: s.label, data: s.points.map((p) => p.value),
      borderColor: palette[i % palette.length], backgroundColor: palette[i % palette.length],
      tension: 0.15, pointRadius: 3, borderWidth: 2
    }));
    (refLines || []).forEach((line) => {
      datasets.push({ label: line.label, data: labels.map(() => line.value), borderColor: line.color, borderDash: [4, 4], pointRadius: 0, borderWidth: 1 });
    });
    chartInstances[key] = new Chart(chartWrap.querySelector('canvas'), {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: series.length > 1 } },
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

  // General movement guideline (~150 min/week moderate activity is the
  // common WHO/Attia-cited baseline) — shown as context, not a personalized
  // prescription.
  const WEEKLY_MOVEMENT_TARGET_MIN = 150;
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
  function renderWater(waterCount, onChange) {
    const row = document.getElementById('hd-water-row');
    const summary = document.getElementById('hd-water-summary');
    let filled = waterCount || 0;

    function redraw() {
      row.innerHTML = '';
      for (let i = 1; i <= WATER_GLASSES; i++) {
        const g = document.createElement('div');
        g.className = 'hd-glass' + (i <= filled ? ' filled' : '');
        g.textContent = i;
        g.addEventListener('click', async () => {
          filled = filled === i ? i - 1 : i;
          await onChange(filled);
          redraw();
        });
        row.appendChild(g);
      }
      summary.textContent = filled + ' / ' + WATER_GLASSES + ' pohár (' + filled * 250 + ' / ' + WATER_GLASSES * 250 + ' ml)';
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

  async function main() {
    try {
      const [vitals, meals, activities, checklist, labor, coachNotes, surgeryPlan, vitalsRecent, checklistRecent] = await Promise.all([
        api('/api/vitals/today'),
        api('/api/meals/today'),
        api('/api/activity/recent'),
        api('/api/checklist/today'),
        api('/api/labor/recent?limit=100'),
        api('/api/coach-notes'),
        api('/api/surgery-plan'),
        api('/api/vitals/recent?limit=100'),
        api('/api/checklist/recent?days=30')
      ]);

      vitalsHistory = vitalsRecent;
      root.classList.remove('loading');
      renderVitals(vitals);
      renderSleepDebt(vitalsHistory);
      renderMeals(meals);
      renderActivityChart(activities);
      renderMovementRollup(activities);
      renderConsistency(checklistRecent);
      renderLabor(labor);
      renderCoachNotes(coachNotes);
      renderSurgeryWarning(surgeryPlan, checklist);

      renderChecklistRow(document.getElementById('hd-nw-list'), ['Nordic walking'], checklist, async (field, val) => {
        await api('/api/checklist/today', { method: 'POST', body: JSON.stringify({ [field]: val }) });
      });

      const medGroups = { morning: [], evening: [], weekly: [], supp: [], routine: [] };
      Object.entries(MED_LABELS).forEach(([field, group]) => medGroups[group].push(field));
      const toggleMed = async (field, val) => {
        await api('/api/checklist/today', { method: 'POST', body: JSON.stringify({ [field]: val }) });
      };
      renderChecklistRow(document.getElementById('hd-med-morning'), medGroups.morning, checklist, toggleMed);
      renderChecklistRow(document.getElementById('hd-med-evening'), medGroups.evening, checklist, toggleMed);
      renderChecklistRow(document.getElementById('hd-med-weekly'), medGroups.weekly, checklist, toggleMed);
      renderChecklistRow(document.getElementById('hd-med-supp'), medGroups.supp, checklist, toggleMed);
      renderChecklistRow(document.getElementById('hd-med-routine'), medGroups.routine, checklist, toggleMed);

      renderWater(checklist.water, async (n) => {
        await api('/api/checklist/today', { method: 'POST', body: JSON.stringify({ water: n }) });
      });

      renderTextList('hd-ex-list', 'hd-ex-input', 'hd-ex-add', checklist.exercises, async (str) => {
        await api('/api/checklist/today', { method: 'POST', body: JSON.stringify({ exercises: str }) });
      });

      renderTextList('hd-symptom-list', 'hd-symptom-input', 'hd-symptom-add', checklist.symptoms, async (str) => {
        await api('/api/checklist/today', { method: 'POST', body: JSON.stringify({ symptoms: str }) });
      });

      document.getElementById('hd-meal-add').onclick = async () => {
        const type = document.getElementById('hd-meal-type').value;
        const desc = document.getElementById('hd-meal-desc').value.trim();
        const num = (id) => {
          const v = document.getElementById(id).value;
          return v === '' ? undefined : Number(v);
        };
        await api('/api/meals/log', {
          method: 'POST',
          body: JSON.stringify({ type, desc, calories: num('hd-meal-cal'), protein: num('hd-meal-protein'), carbs: num('hd-meal-carbs'), fat: num('hd-meal-fat') })
        });
        ['hd-meal-desc', 'hd-meal-cal', 'hd-meal-protein', 'hd-meal-carbs', 'hd-meal-fat'].forEach((id) => { document.getElementById(id).value = ''; });
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
