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

async function ensureConfig() {
  let cfg = getConfig();
  if (!cfg.apiBase) {
    const apiBase = prompt('Add meg a backend URL-t (pl. https://egeszseg-dashboard-api.<neved>.workers.dev):');
    const appToken = prompt('Add meg az APP_TOKEN-t (amit a wrangler secret put APP_TOKEN-nél megadtál):');
    cfg = { apiBase: (apiBase || '').replace(/\/$/, ''), appToken: appToken || '' };
    saveConfig(cfg);
  }
  return cfg;
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
  if (!res.ok) throw new Error('API hiba: ' + res.status);
  return res.json();
}

(function () {
  const todayKey = new Date().toISOString().slice(0, 10);
  document.getElementById('hd-date').textContent = todayKey;

  const root = document.getElementById('hd-root');
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
      const [vitals, meals, activities, checklist] = await Promise.all([
        api('/api/vitals/today'),
        api('/api/meals/today'),
        api('/api/activity/recent'),
        api('/api/checklist/today')
      ]);

      renderVitals(vitals);
      renderMeals(meals);
      renderActivityChart(activities);

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
      document.getElementById('hd-root').insertAdjacentHTML(
        'afterbegin',
        '<div class="hd-banner" style="border-color:#C1666B;">Nem sikerült elérni a backendet: ' + err.message + '. Ellenőrizd a beállított API URL-t / tokent (töröld a böngésző localStorage "hd-config" kulcsát az újrapróbáláshoz).</div>'
      );
    }
  }

  main();
})();
