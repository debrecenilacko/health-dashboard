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

(function () {
  const todayKey = new Date().toISOString().slice(0, 10);
  document.getElementById('hd-date').textContent = todayKey;

  const root = document.getElementById('hd-root');

  document.getElementById('hd-settings-btn').addEventListener('click', async () => {
    const cfg = getConfig();
    const saved = await showSettingsModal({ apiBase: cfg.apiBase, allowCancel: true });
    if (saved) location.reload();
  });

  root.querySelectorAll('.hd-tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      root.querySelectorAll('.hd-tab-btn').forEach((b) => b.classList.remove('active'));
      root.querySelectorAll('.hd-panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      root.querySelector('.hd-panel[data-panel="' + btn.dataset.tab + '"]').classList.add('active');
    });
  });

  const MED_LABELS = {
    Rosuvastatin: 'morning', Vidonorm: 'morning', Nebilet: 'morning', Rawel: 'morning',
    Merckformin: 'evening', Ozempic: 'weekly',
    'Kreatin-glicin-taurin': 'supp', 'Just Whey': 'supp', 'Omega-3': 'supp', Multivitamin: 'supp'
  };
  const DISPLAY_NAME = { Nebilet: 'Nebilet (½)', Ozempic: 'Ozempic injekció' };

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

  function renderLabor(rows) {
    const wrap = document.getElementById('hd-labor-groups');
    wrap.innerHTML = '';
    const latest = latestPerLabField(rows || []);
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
          return '<div class="hd-lab-row">' +
            '<div class="hd-lab-top"><span class="hd-lab-name">' + f + '</span>' +
            '<span class="hd-lab-val' + (out ? ' out' : '') + '">' + entry.value + (meta.unit ? ' ' + meta.unit : '') + '</span></div>' +
            '<div class="hd-lab-bottom"><span>' + rangeText + '</span><span>' + entry.date + '</span></div>' +
            '</div>';
        }).join('');
      if (!rowsHtml) return;
      any = true;
      wrap.insertAdjacentHTML('beforeend', '<p class="hd-section-title">' + group.label + '</p><div class="hd-card">' + rowsHtml + '</div>');
    });
    if (!any) {
      wrap.innerHTML = '<p style="font-size:13px; opacity:.55;">Nincs laboreredmény.</p>';
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

  function renderExercises(exercisesStr, onSave) {
    const items = (exercisesStr || '').split('\n').filter(Boolean);
    const ul = document.getElementById('hd-ex-list');

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

    document.getElementById('hd-ex-add').onclick = async () => {
      const input = document.getElementById('hd-ex-input');
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
      const [vitals, meals, activities, checklist, labor] = await Promise.all([
        api('/api/vitals/today'),
        api('/api/meals/today'),
        api('/api/activity/recent'),
        api('/api/checklist/today'),
        api('/api/labor/recent?limit=100')
      ]);

      renderVitals(vitals);
      renderMeals(meals);
      renderActivityChart(activities);
      renderLabor(labor);

      renderChecklistRow(document.getElementById('hd-nw-list'), ['Nordic walking'], checklist, async (field, val) => {
        await api('/api/checklist/today', { method: 'POST', body: JSON.stringify({ [field]: val }) });
      });

      const medGroups = { morning: [], evening: [], weekly: [], supp: [] };
      Object.entries(MED_LABELS).forEach(([field, group]) => medGroups[group].push(field));
      const toggleMed = async (field, val) => {
        await api('/api/checklist/today', { method: 'POST', body: JSON.stringify({ [field]: val }) });
      };
      renderChecklistRow(document.getElementById('hd-med-morning'), medGroups.morning, checklist, toggleMed);
      renderChecklistRow(document.getElementById('hd-med-evening'), medGroups.evening, checklist, toggleMed);
      renderChecklistRow(document.getElementById('hd-med-weekly'), medGroups.weekly, checklist, toggleMed);
      renderChecklistRow(document.getElementById('hd-med-supp'), medGroups.supp, checklist, toggleMed);

      renderWater(checklist.water, async (n) => {
        await api('/api/checklist/today', { method: 'POST', body: JSON.stringify({ water: n }) });
      });

      renderExercises(checklist.exercises, async (str) => {
        await api('/api/checklist/today', { method: 'POST', body: JSON.stringify({ exercises: str }) });
      });
    } catch (err) {
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
