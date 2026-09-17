// ── STATE ──────────────────────────────────────────────────
let currentDay = null;
let timerInterval = null;
let timerCompletionTimeout = null;
let timerSeconds = 0;
let timerTotal = 0;
let timerEndTime = 0;
let timerLabel = '';
let completionReturnFocus = null;
let exerciseChartState = null;
let settings = { restTime: 90, vibrate: true, autoTimer: true };
const BACKUP_FORMAT = 'Leafy-GymKit-Backup';
const BACKUP_VERSION = 2;
const MAX_BACKUP_BYTES = 2 * 1024 * 1024;
const MAX_PROGRESS_ROWS = 5000;
const MAX_SET_LOGS = 100000;

// ── DB (IndexedDB) ────────────────────────────────────────
const DB_NAME = 'gymkit';
const DB_VERSION = 1;
let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('progress')) {
        d.createObjectStore('progress', { keyPath: 'date' });
      }
      if (!d.objectStoreNames.contains('settings')) {
        d.createObjectStore('settings', { keyPath: 'key' });
      }
    };
    req.onsuccess = e => { db = e.target.result; resolve(db); };
    req.onerror = e => reject(e.target.error);
  });
}

function dbGet(store, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = e => reject(e.target.error);
  });
}

function dbPut(store, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).put(value);
    req.onsuccess = () => resolve();
    req.onerror = e => reject(e.target.error);
  });
}

function dbDelete(store, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).delete(key);
    req.onsuccess = () => resolve();
    req.onerror = e => reject(e.target.error);
  });
}

function dbGetAll(store) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = e => reject(e.target.error);
  });
}

function dbClear(store) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).clear();
    req.onsuccess = () => resolve();
    req.onerror = e => reject(e.target.error);
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('数据库事务失败'));
    tx.onabort = () => reject(tx.error || new Error('数据库事务已取消'));
  });
}

// ── Progress cache (avoid async in hot paths) ─────────────
let progressCache = {};

async function loadAllProgress() {
  const rows = await dbGetAll('progress');
  progressCache = {};
  for (const row of rows) {
    progressCache[row.date] = row.data;
  }
}

function getProgress(date, dayKey) {
  return progressCache[date]?.[dayKey] || {};
}

async function setItemDone(date, dayKey, itemId, done) {
  const prog = ensureDayProgress(date, dayKey);
  prog[itemId] = done;
  if (done && ensureV2(prog).sessionStatus === 'skipped') prog._v2.sessionStatus = 'active';
  await dbPut('progress', { date, data: progressCache[date] });
}

async function setSetDone(date, dayKey, exId, setIdx, done) {
  if (!progressCache[date]) progressCache[date] = {};
  if (!progressCache[date][dayKey]) progressCache[date][dayKey] = {};
  if (!progressCache[date][dayKey][exId]) progressCache[date][dayKey][exId] = [];
  progressCache[date][dayKey][exId][setIdx] = done;
  await dbPut('progress', { date, data: progressCache[date] });
}

function weightKey(exId) { return `${exId}_weight`; }

function ensureDayProgress(date, dayKey) {
  if (!progressCache[date]) progressCache[date] = {};
  if (!progressCache[date][dayKey]) progressCache[date][dayKey] = {};
  return progressCache[date][dayKey];
}

function ensureV2(prog) {
  if (!prog._v2 || typeof prog._v2 !== 'object' || Array.isArray(prog._v2)) prog._v2 = {};
  if (!prog._v2.setLogs || typeof prog._v2.setLogs !== 'object' || Array.isArray(prog._v2.setLogs)) {
    prog._v2.setLogs = {};
  }
  return prog._v2;
}

function readExerciseWeight(prog, exId) {
  const value = prog?.[weightKey(exId)];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function hasRequiredWeight(prog, exId) {
  return readExerciseWeight(prog, exId) !== null;
}

async function setExerciseWeight(date, dayKey, exId, weight) {
  const prog = ensureDayProgress(date, dayKey);
  prog[weightKey(exId)] = weight;
  await dbPut('progress', { date, data: progressCache[date] });
}

function normalizeSetLog(log, requireComplete = true) {
  if (!log || typeof log !== 'object' || Array.isArray(log)) return null;
  const hasWeight = log.weight !== null && log.weight !== undefined && log.weight !== '';
  const hasCount = log.actualCount !== null && log.actualCount !== undefined && log.actualCount !== '';
  const weight = hasWeight ? Number(log.weight) : null;
  const actualCount = hasCount ? Number(log.actualCount) : null;
  if (hasWeight && (!Number.isFinite(weight) || weight < 0 || weight > 10000)) return null;
  if (hasCount && (!Number.isInteger(actualCount) || actualCount < 1 || actualCount > 9999)) return null;
  if (requireComplete && (!hasWeight || !hasCount)) return null;
  if (!hasWeight && !hasCount) return null;
  return { weight, actualCount };
}

function readSetLogs(prog, exId, setCount = 0) {
  const raw = prog?._v2?.setLogs?.[exId];
  const legacyWeight = readExerciseWeight(prog, exId);
  const length = Math.max(setCount, Array.isArray(raw) ? raw.length : 0);
  return Array.from({ length }, (_, index) => {
    const normalized = normalizeSetLog(raw?.[index], false);
    if (Array.isArray(raw)) return normalized
      ? { weight: normalized.weight, actualCount: normalized.actualCount }
      : null;
    return legacyWeight === null ? null : { weight: legacyWeight, actualCount: null };
  });
}

function classifyFirstSetWeight(rawValue) {
  const raw = String(rawValue ?? '').trim();
  if (raw === '') return { kind: 'empty', weight: null };
  const weight = Number(raw);
  return Number.isFinite(weight) && weight >= 0 && weight <= 10000
    ? { kind: 'valid', weight }
    : { kind: 'invalid', weight: null };
}

function nextAutofillWeightState(state, firstWeightRaw) {
  if (!state.autoFillEligible || state.touched || state.completed) return { ...state };
  const first = classifyFirstSetWeight(firstWeightRaw);
  if (first.kind === 'invalid') return { ...state };
  if (first.kind === 'empty') {
    return state.source === 'auto'
      ? { ...state, value: state.fallbackValue, source: state.fallbackSource }
      : { ...state };
  }
  if (!['auto', 'history', 'blank'].includes(state.source)) return { ...state };
  return { ...state, value: first.weight, source: 'auto' };
}

function resolveSetDisplayRows(prog, exId, setCount, previousLogs = []) {
  const raw = prog?._v2?.setLogs?.[exId];
  const legacyWeight = readExerciseWeight(prog, exId);
  const hasV2Logs = Array.isArray(raw);
  const completed = Array.isArray(prog?.[exId]) ? prog[exId] : [];
  const rows = Array.from({ length: setCount }, (_, index) => {
    const current = normalizeSetLog(raw?.[index], false);
    if (current) return {
      weight: current.weight,
      actualCount: current.actualCount,
      weightSource: 'current-v2',
      fallbackWeight: current.weight,
      fallbackSource: 'current-v2',
      autoFillEligible: false,
      completed: !!completed[index]
    };
    if (!hasV2Logs && legacyWeight !== null) {
      return {
        weight: legacyWeight,
        actualCount: null,
        weightSource: 'current-legacy',
        fallbackWeight: legacyWeight,
        fallbackSource: 'current-legacy',
        autoFillEligible: false,
        completed: !!completed[index]
      };
    }
    const previous = normalizeSetLog(previousLogs[index], false);
    const weightSource = previous?.weight !== null && previous?.weight !== undefined
      ? 'history' : 'blank';
    const weight = previous?.weight ?? null;
    return {
      weight,
      actualCount: previous?.actualCount ?? null,
      weightSource,
      fallbackWeight: weight,
      fallbackSource: weightSource,
      autoFillEligible: index > 0 && !completed[index],
      completed: !!completed[index]
    };
  });
  const firstCurrent = normalizeSetLog(raw?.[0], false);
  const firstWeight = firstCurrent?.weight;
  if (!Number.isFinite(firstWeight) || firstWeight < 0 || firstWeight > 10000) return rows;
  return rows.map((row, index) => {
    if (index === 0) return row;
    const next = nextAutofillWeightState({
      value: row.weight,
      source: row.weightSource,
      fallbackValue: row.fallbackWeight,
      fallbackSource: row.fallbackSource,
      autoFillEligible: row.autoFillEligible,
      touched: false,
      completed: row.completed
    }, String(firstWeight));
    return { ...row, weight: next.value, weightSource: next.source };
  });
}

function resolveSetDisplayValues(prog, exId, setCount, previousLogs = []) {
  return resolveSetDisplayRows(prog, exId, setCount, previousLogs).map(row => ({
    weight: row.weight,
    actualCount: row.actualCount
  }));
}

async function setSetLogAndDone(date, dayKey, exId, setIdx, log, done) {
  const normalized = normalizeSetLog(log, done);
  if (done && !normalized) throw new Error('重量或实际次数无效');
  const prog = ensureDayProgress(date, dayKey);
  if (!Array.isArray(prog[exId])) prog[exId] = [];
  prog[exId][setIdx] = done;
  const v2 = ensureV2(prog);
  if (!Array.isArray(v2.setLogs[exId])) v2.setLogs[exId] = [];
  if (normalized) {
    v2.setLogs[exId][setIdx] = normalized;
    prog[weightKey(exId)] = normalized.weight;
  }
  if (v2.sessionStatus === 'skipped') v2.sessionStatus = 'active';
  await dbPut('progress', { date, data: progressCache[date] });
}

async function setSetLogDraft(date, dayKey, exId, setIdx, log) {
  const normalized = normalizeSetLog(log, false);
  if (!normalized) return false;
  const prog = ensureDayProgress(date, dayKey);
  const v2 = ensureV2(prog);
  if (!Array.isArray(v2.setLogs[exId])) v2.setLogs[exId] = [];
  v2.setLogs[exId][setIdx] = normalized;
  if (normalized.weight !== null) prog[weightKey(exId)] = normalized.weight;
  await dbPut('progress', { date, data: progressCache[date] });
  return true;
}

function sessionStatus(prog, complete = false) {
  const explicit = prog?._v2?.sessionStatus;
  if (explicit === 'skipped') return 'skipped';
  if (complete || explicit === 'completed') return 'completed';
  return explicit === 'active' ? 'active' : null;
}

async function setSessionStatus(date, dayKey, status) {
  const prog = ensureDayProgress(date, dayKey);
  ensureV2(prog).sessionStatus = status;
  await dbPut('progress', { date, data: progressCache[date] });
}

// ── Settings persistence ──────────────────────────────────
async function loadSettings() {
  const row = await dbGet('settings', 'user_settings');
  if (row) settings = { ...settings, ...row.value };
}

async function saveSettings() {
  await dbPut('settings', { key: 'user_settings', value: settings });
}

// ── Helpers ───────────────────────────────────────────────
function localDateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function formatLocalChineseDate(dateKey = localDateKey()) {
  const [year, month, day] = dateKey.split('-').map(Number);
  return `${year}年${month}月${day}日`;
}

function dateFromLocalKey(dateKey) {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function today() { return localDateKey(); }
function todayWeekday() { return new Date().getDay(); }

function scheduledDayKey(date) {
  return Object.keys(DAY_WEEKDAY).find(key => DAY_WEEKDAY[key] === date.getDay()) || null;
}

function effectiveRestTime(userSettings, plannedRest) {
  const override = Number(userSettings?.restTime);
  return Number.isInteger(override) && override >= 30 && override <= 600 ? override : plannedRest;
}

function allExercises(plan = PLAN) {
  return Object.entries(plan).flatMap(([dayKey, day]) =>
    day.sections.flatMap(section => (section.exercises || []).map(ex => ({ ...ex, dayKey })))
  );
}

function findExercise(exId, plan = PLAN) {
  return allExercises(plan).find(ex => ex.id === exId) || null;
}

function exerciseCountUnit(exercise) {
  return ['次', '步', '秒'].includes(exercise?.countUnit) ? exercise.countUnit : '次';
}

function countUnitLabel(unit) {
  return unit === '步' ? '步数' : unit === '秒' ? '秒数' : '次数';
}

function priorExerciseSessions(
  exId,
  beforeDate = today(),
  limit = 6,
  cache = progressCache,
  plan = PLAN
) {
  const ex = findExercise(exId, plan);
  if (!ex) return [];
  return Object.keys(cache).filter(date => date < beforeDate).sort().reverse().flatMap(date => {
    const prog = cache[date]?.[ex.dayKey];
    const completed = prog?.[exId];
    if (!prog || !Array.isArray(completed) || !completed.some(Boolean)) return [];
    const logs = readSetLogs(prog, exId, ex.sets);
    const completedLogs = logs.map((log, index) => completed[index] ? log : null);
    return [{ date, dayKey: ex.dayKey, logs: completedLogs }];
  }).slice(0, limit);
}

function formatSetLog(log, countUnit = '次') {
  if (!log) return '未记录';
  const weightText = log.weight === null ? '重量未记录' : `${log.weight}kg`;
  const countText = log.actualCount === null
    ? `${countUnitLabel(countUnit)}未记录` : `${log.actualCount}${countUnit}`;
  return `${weightText} × ${countText}`;
}

function normalizeYearMonth(year, month) {
  const totalMonths = year * 12 + month;
  const normalizedYear = Math.floor(totalMonths / 12);
  return {
    year: normalizedYear,
    month: totalMonths - normalizedYear * 12
  };
}

function shiftYearMonth(year, month, delta) {
  return normalizeYearMonth(year, month + delta);
}

function compareYearMonth(leftYear, leftMonth, rightYear, rightMonth) {
  return leftYear * 12 + leftMonth - (rightYear * 12 + rightMonth);
}

function daysInMonth(year, month) {
  const normalized = normalizeYearMonth(year, month);
  const lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const leap = normalized.year % 4 === 0
    && (normalized.year % 100 !== 0 || normalized.year % 400 === 0);
  return normalized.month === 1 && leap ? 29 : lengths[normalized.month];
}

function formatChartWeight(value) {
  return Number(value).toFixed(1).replace(/\.0$/, '');
}

function monthlyExerciseAverages(
  exId,
  year,
  month,
  cache = progressCache,
  plan = PLAN
) {
  const normalized = normalizeYearMonth(year, month);
  const ex = findExercise(exId, plan);
  if (!ex) return [];
  const prefix = `${normalized.year}-${String(normalized.month + 1).padStart(2, '0')}-`;
  const monthLength = daysInMonth(normalized.year, normalized.month);
  const points = [];
  for (let day = 1; day <= monthLength; day++) {
    const date = `${prefix}${String(day).padStart(2, '0')}`;
    const prog = cache[date]?.[ex.dayKey];
    const completed = prog?.[exId];
    if (!Array.isArray(completed) || !completed.some(Boolean)) continue;
    const logs = readSetLogs(prog, exId, ex.sets);
    const weights = logs.flatMap((log, index) => completed[index]
      && Number.isFinite(log?.weight) && log.weight >= 0 ? [log.weight] : []);
    if (!weights.length) continue;
    points.push({
      date,
      day,
      average: weights.reduce((sum, weight) => sum + weight, 0) / weights.length,
      weights
    });
  }
  return points;
}

function monthlyChartModel(points, year, month) {
  const width = 640;
  const height = 250;
  const plot = { left: 54, right: 622, top: 18, bottom: 206 };
  const monthLength = daysInMonth(year, month);
  const values = points.map(point => point.average);
  let min = values.length ? Math.min(...values) : 0;
  let max = values.length ? Math.max(...values) : 1;
  if (min === max) {
    if (max === 0) {
      max = 1;
    } else {
      const padding = Math.max(max * 0.1, 1);
      min = Math.max(0, min - padding);
      max += padding;
    }
  } else {
    const padding = Math.max((max - min) * 0.12, 0.5);
    min = Math.max(0, min - padding);
    max += padding;
  }
  const xForDay = day => plot.left
    + (day - 1) / Math.max(1, monthLength - 1) * (plot.right - plot.left);
  const yForValue = value => plot.bottom
    - (value - min) / (max - min) * (plot.bottom - plot.top);
  const plottedPoints = points.map(point => ({
    ...point,
    x: xForDay(point.day),
    y: yForValue(point.average)
  }));
  const labelDays = [...new Set([1, 5, 10, 15, 20, 25, monthLength])]
    .filter(day => day <= monthLength);
  return {
    width,
    height,
    plot,
    points: plottedPoints,
    path: plottedPoints.map((point, index) => `${index ? 'L' : 'M'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' '),
    xLabels: labelDays.map(day => ({ day, x: xForDay(day) })),
    yTicks: [max, (max + min) / 2, min].map(value => ({ value, y: yForValue(value) }))
  };
}

function renderMonthlyAverageChart(points, year, month) {
  const model = monthlyChartModel(points, year, month);
  const grid = model.yTicks.map(tick => `<g>
    <line class="monthly-chart-grid" x1="${model.plot.left}" y1="${tick.y}" x2="${model.plot.right}" y2="${tick.y}"></line>
    <text class="monthly-chart-y-label" x="${model.plot.left - 8}" y="${tick.y + 4}" text-anchor="end">${formatChartWeight(tick.value)}kg</text>
  </g>`).join('');
  const xLabels = model.xLabels.map(label => `<text class="monthly-chart-x-label" x="${label.x}" y="${model.plot.bottom + 24}" text-anchor="middle">${label.day}</text>`).join('');
  const line = model.points.length > 1
    ? `<path class="monthly-chart-line" d="${model.path}"></path>` : '';
  const dots = model.points.map(point => `<circle class="monthly-chart-point" cx="${point.x}" cy="${point.y}" r="5">
    <title>${point.date} 平均 ${formatChartWeight(point.average)}kg</title>
  </circle>`).join('');
  return `<svg class="monthly-load-chart" viewBox="0 0 ${model.width} ${model.height}" role="img" aria-label="${year}年${month + 1}月每日已完成组平均重量折线图">
    ${grid}
    <line class="monthly-chart-axis" x1="${model.plot.left}" y1="${model.plot.bottom}" x2="${model.plot.right}" y2="${model.plot.bottom}"></line>
    ${xLabels}${line}${dots}
  </svg>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[char]));
}

// ── PROGRESS CALCULATION ──────────────────────────────────
function calcProgress(date, dayKey) {
  const plan = PLAN[dayKey];
  const prog = getProgress(date, dayKey);
  let total = 0, done = 0;
  for (const sec of plan.sections) {
    if (sec.type === 'warmup') {
      sec.items.forEach((_, i) => { total++; if (prog[`wu_${sec.label}_${i}`]) done++; });
    } else if (sec.type === 'exercises') {
      sec.exercises.forEach(ex => {
        for (let s = 0; s < ex.sets; s++) { total++; if (prog[ex.id]?.[s]) done++; }
      });
    } else if (sec.type === 'cardio') {
      total++; if (prog[`cardio_${sec.label}`]) done++;
    }
  }
  return { total, done, pct: total ? Math.round(done / total * 100) : 0 };
}

function isDayComplete(date, dayKey) {
  const prog = getProgress(date, dayKey);
  if (sessionStatus(prog) === 'skipped') return false;
  const { done, total } = calcProgress(date, dayKey);
  return total > 0 && done === total;
}

function isDayCompleteWithCache(date, dayKey, cache) {
  const original = progressCache;
  progressCache = cache;
  try { return isDayComplete(date, dayKey); }
  finally { progressCache = original; }
}

function isDaySkipped(date, dayKey) {
  return sessionStatus(getProgress(date, dayKey)) === 'skipped';
}

function didBecomeComplete(before, after) {
  return before.total > 0
    && before.done < before.total
    && after.total > 0
    && after.done === after.total;
}

// ── PAGE NAVIGATION ────────────────────────────────────────
function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('on'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('on'));
  document.getElementById('page-' + name).classList.add('on');
  const navEl = document.getElementById('nav-' + name);
  if (navEl) navEl.classList.add('on');
  if (name === 'home') renderHome();
  if (name === 'history') renderHistory();
  if (name === 'settings') renderSettings();
}

// ── HOME ───────────────────────────────────────────────────
function renderHome() {
  const wd = todayWeekday();
  const todayDate = today();
  let sub = '选择今天的训练';
  const todayKey = Object.keys(DAY_WEEKDAY).find(k => DAY_WEEKDAY[k] === wd);
  if (todayKey) sub = `今天是${PLAN[todayKey].label}，${PLAN[todayKey].title}`;
  else if (wd === 3 || wd === 6 || wd === 0) sub = '今天是休息日，好好恢复';
  document.getElementById('homeSubtitle').textContent = sub;

  const grid = document.getElementById('dayGrid');
  grid.innerHTML = DAY_KEYS.map(key => {
    const d = PLAN[key];
    const { done, total, pct } = calcProgress(todayDate, key);
    const isToday = DAY_WEEKDAY[key] === wd;
    const complete = done === total && total > 0;
    const skipped = isDaySkipped(todayDate, key);
    return `<div class="day-card${isToday ? ' today-highlight' : ''}"
      style="background:${d.bg};color:${d.color}"
      onclick="openDay('${key}')">
      <div class="dc-day">${d.label}</div>
      <div class="dc-name">${d.title}</div>
      <div class="dc-tag">${d.sub}</div>
      <div class="dc-prog">${skipped ? '⏭ 已跳过' : complete ? '✅ 完成' : done > 0 ? `${pct}%` : '未开始'}</div>
    </div>`;
  }).join('');
}

// ── WORKOUT ────────────────────────────────────────────────
function openDay(key) {
  currentDay = key;
  showPage('workout');
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('on'));
  document.getElementById('nav-home').classList.add('on');
  renderWorkout();
}

function backToHome() { showPage('home'); }

function renderWorkout() {
  const key = currentDay;
  const d = PLAN[key];
  const date = today();
  const prog = getProgress(date, key);

  const hdr = document.getElementById('workoutHeader');
  hdr.style.background = d.bg;
  hdr.style.color = d.color;
  document.getElementById('workoutTitle').textContent = d.title;
  document.getElementById('workoutSub').textContent = d.label + ' · ' + d.sub;

  updateProgress();

  const skipped = isDaySkipped(date, key);
  const isScheduledToday = scheduledDayKey(dateFromLocalKey(date)) === key;
  let html = isScheduledToday ? `<div class="session-actions">
    <div class="session-state${skipped ? ' skipped' : ''}">${skipped ? '今天已标记为主动跳过' : '如今天无法训练，可主动标记跳过'}</div>
    <button class="session-skip-btn" data-session-skip>${skipped ? '撤销跳过' : '跳过今日训练'}</button>
  </div>` : '';
  html += `<div class="load-guidance"><strong>负重记录：</strong>杠铃填单侧杠铃片合计（不含杆）；哑铃填单只；器械/绳索填面板标示的已选重量（非 kg 先换算）；自重填 0kg。填写第1组重量后，会自动带入未修改的后续组；仍可逐组调整。编辑某组重量或次数后，该组不再跟随。</div>`;
  for (const sec of d.sections) {
    html += `<div class="section-block">
      <div class="section-label">
        <span class="sl-dot" style="background:${sec.dot}"></span>${sec.label}
      </div>`;

    if (sec.type === 'warmup') {
      html += '<div class="warmup-card">';
      sec.items.forEach((item, i) => {
        const id = `wu_${sec.label}_${i}`;
        const done = !!prog[id];
        html += `<div class="warmup-item" data-warmup-id="${encodeURIComponent(id)}">
          <div class="wi-check${done ? ' done' : ''}"></div>
          <div class="wi-text${done ? ' done' : ''}">${item}</div>
        </div>`;
      });
      html += '</div>';
    } else if (sec.type === 'exercises') {
      for (const ex of sec.exercises) {
        const sets = prog[ex.id] || [];
        const previousLogs = priorExerciseSessions(ex.id, date, 1)[0]?.logs || [];
        const logs = resolveSetDisplayRows(prog, ex.id, ex.sets, previousLogs);
        const countUnit = exerciseCountUnit(ex);
        const allDone = sets.filter(Boolean).length === ex.sets;
        html += `<div class="ex-card${allDone ? ' completed' : ''}" id="card_${ex.id}">
          <div class="ex-header">
            <div class="ex-name">${ex.name}</div>
            <div class="ex-header-actions">
              <div class="ex-badge" style="color:${ex.badgeColor};background:${ex.badgeBg}">${ex.badge}</div>
              <button class="history-btn" type="button" title="显示历史数据" data-show-chart="${ex.id}">显示历史数据</button>
            </div>
          </div>
          <div class="ex-tip">${ex.tip}</div>
          <div class="ex-meta">${ex.meta}</div>
          <div class="set-log-head"><span>组</span><span>重量 kg</span><span>实际${countUnitLabel(countUnit)}</span><span>完成</span></div>
          <div class="set-log-list">`;
        for (let s = 0; s < ex.sets; s++) {
          const done = !!sets[s];
          const log = logs[s];
          html += `<div class="set-log-row" id="setrow_${ex.id}_${s}">
            <span class="set-number">${s + 1}</span>
            <input class="set-log-input" id="weight_${ex.id}_${s}" data-set-input="weight"
              data-ex-id="${ex.id}" data-set-idx="${s}" type="number" min="0" max="10000" step="0.5"
              inputmode="decimal" value="${log?.weight ?? ''}"
              data-weight-source="${log.weightSource}" data-weight-fallback="${log.fallbackWeight ?? ''}"
              data-weight-fallback-source="${log.fallbackSource}"
              data-autofill-eligible="${log.autoFillEligible ? 'true' : 'false'}">
            <input class="set-log-input" id="count_${ex.id}_${s}" data-set-input="actualCount"
              data-ex-id="${ex.id}" data-set-idx="${s}" type="number" min="1" max="9999" step="1"
              inputmode="numeric" value="${log?.actualCount ?? ''}" placeholder="${countUnit}">
            <button class="set-btn${done ? ' done' : ''}" id="set_${ex.id}_${s}"
              data-toggle-set data-set-ex="${ex.id}" data-set-idx="${s}"
              data-set-label="第${s + 1}组 ${ex.reps}" aria-label="完成第${s + 1}组"></button>
            <div class="set-log-error" id="set_error_${ex.id}_${s}"></div>
          </div>`;
        }
        html += `</div></div>`;
      }
    } else if (sec.type === 'cardio') {
      const cid = `cardio_${sec.label}`;
      const done = !!prog[cid];
      html += `<div class="cardio-card">
        <div class="cardio-check" data-cardio-id="${encodeURIComponent(cid)}">
          <div>
            <div class="cardio-title">${sec.title}</div>
            <div class="cardio-body">${sec.body.replace(/\n/g, '<br>')}</div>
          </div>
          <div class="big-check${done ? ' done' : ''}"></div>
        </div>
      </div>`;
    }
    html += '</div>';
  }
  document.getElementById('workoutBody').innerHTML = html;
}

async function toggleTodaySkip() {
  const date = today();
  if (!currentDay || scheduledDayKey(dateFromLocalKey(date)) !== currentDay) return;
  const skipped = isDaySkipped(date, currentDay);
  if (!skipped && isDayComplete(date, currentDay)) {
    alert('今天的训练已经完成，不能再标记为跳过。');
    return;
  }
  if (!skipped && !confirm('确定要把今天标记为主动跳过吗？已有的部分记录会保留。')) return;
  await setSessionStatus(date, currentDay, skipped ? 'active' : 'skipped');
  renderWorkout();
  renderHome();
}

function showExerciseChart(exId) {
  const ex = findExercise(exId);
  if (!ex) return;
  const now = new Date();
  exerciseChartState = { exId, year: now.getFullYear(), month: now.getMonth() };
  renderExerciseChart();
  document.getElementById('chartModal').classList.add('on');
}

function renderExerciseChart() {
  if (!exerciseChartState) return;
  const { exId, year, month } = exerciseChartState;
  const ex = findExercise(exId);
  if (!ex) return;
  const points = monthlyExerciseAverages(exId, year, month);
  const now = new Date();
  const atCurrentMonth = compareYearMonth(year, month, now.getFullYear(), now.getMonth()) >= 0;
  const details = points.map(point => `<li>
    <strong>${point.date}</strong>
    <span>日均 ${formatChartWeight(point.average)}kg</span>
    <span>完成组重量 ${point.weights.map(weight => `${formatChartWeight(weight)}kg`).join('、')}</span>
  </li>`).join('');
  const modal = document.getElementById('chartModal');
  document.getElementById('chartModalBody').innerHTML = `
    <div class="chart-modal-title">${escapeHtml(ex.name)} · 月度平均重量</div>
    <div class="month-chart-nav">
      <button type="button" data-chart-month="-1" aria-label="上个月">‹</button>
      <strong>${year}年${month + 1}月</strong>
      <button type="button" data-chart-month="1" aria-label="下个月"${atCurrentMonth ? ' disabled' : ''}>›</button>
    </div>
    ${points.length ? `${renderMonthlyAverageChart(points, year, month)}
      <ul class="monthly-chart-details">${details}</ul>`
      : '<div class="chart-empty">本月暂无已完成的重量记录</div>'}`;
  modal.setAttribute('aria-label', `${ex.name}月度平均重量趋势图`);
}

function changeExerciseChartMonth(delta) {
  if (!exerciseChartState || !Number.isInteger(delta) || Math.abs(delta) !== 1) return;
  const next = shiftYearMonth(exerciseChartState.year, exerciseChartState.month, delta);
  const now = new Date();
  if (compareYearMonth(next.year, next.month, now.getFullYear(), now.getMonth()) > 0) return;
  exerciseChartState = { ...exerciseChartState, ...next };
  renderExerciseChart();
}

function closeExerciseChart() {
  document.getElementById('chartModal').classList.remove('on');
  exerciseChartState = null;
}

async function toggleWarmup(id, el) {
  const date = today();
  const before = calcProgress(date, currentDay);
  const prog = getProgress(date, currentDay);
  const done = !prog[id];
  await setItemDone(date, currentDay, id, done);
  await syncDayStatus(date, currentDay);
  const after = calcProgress(date, currentDay);
  const completedNow = didBecomeComplete(before, after);
  el.querySelector('.wi-check').className = 'wi-check' + (done ? ' done' : '');
  el.querySelector('.wi-text').className = 'wi-text' + (done ? ' done' : '');
  updateProgress();
  if (done && completedNow) showCompletionDialog(date);
  if (done && settings.vibrate && navigator.vibrate) {
    navigator.vibrate(completedNow ? [50, 50, 50, 50, 200] : 30);
  }
}

function readSetInput(exId, setIdx) {
  const weightInput = document.getElementById(`weight_${exId}_${setIdx}`);
  const countInput = document.getElementById(`count_${exId}_${setIdx}`);
  const weightRaw = weightInput?.value.trim() || '';
  const countRaw = countInput?.value.trim() || '';
  const weight = weightRaw === '' ? null : Number(weightRaw);
  const actualCount = countRaw === '' ? null : Number(countRaw);
  const log = normalizeSetLog({ weight, actualCount });
  return { log, weightInput, countInput, weightRaw, countRaw };
}

function markSetTouchedForInteraction(input, eventType) {
  if (eventType !== 'input' && eventType !== 'change') return false;
  const row = input?.closest('.set-log-row');
  if (!row) return false;
  row.dataset.setTouched = 'true';
  return true;
}

function applyFirstSetWeightAutofill(exId) {
  const firstInput = document.getElementById(`weight_${exId}_0`);
  if (!firstInput) return;
  const firstWeightRaw = firstInput.validity?.badInput ? 'invalid' : firstInput.value;
  const prog = getProgress(today(), currentDay);
  const completed = Array.isArray(prog[exId]) ? prog[exId] : [];
  document.querySelectorAll(`input[data-set-input="weight"][data-ex-id="${exId}"]`).forEach(input => {
    const setIdx = Number(input.dataset.setIdx);
    if (setIdx === 0) return;
    const row = input.closest('.set-log-row');
    const fallbackRaw = input.dataset.weightFallback ?? '';
    const state = {
      value: input.value === '' ? null : Number(input.value),
      source: input.dataset.weightSource || 'blank',
      fallbackValue: fallbackRaw === '' ? null : Number(fallbackRaw),
      fallbackSource: input.dataset.weightFallbackSource || 'blank',
      autoFillEligible: input.dataset.autofillEligible === 'true',
      touched: row?.dataset.setTouched === 'true',
      completed: !!completed[setIdx]
    };
    const next = nextAutofillWeightState(state, firstWeightRaw);
    if (next.value !== state.value || next.source !== state.source) {
      input.value = next.value ?? '';
      input.dataset.weightSource = next.source;
    }
  });
}

function markSetInputAuthoritative(exId, setIdx) {
  const weightInput = document.getElementById(`weight_${exId}_${setIdx}`);
  if (!weightInput) return;
  weightInput.dataset.weightSource = 'current-v2';
  weightInput.dataset.autofillEligible = 'false';
}

function showSetInputError(exId, setIdx, message, inputs = []) {
  const error = document.getElementById(`set_error_${exId}_${setIdx}`);
  if (error) error.textContent = message;
  inputs.forEach(input => input?.classList.add('invalid'));
  inputs.find(Boolean)?.focus();
}

async function toggleSet(exId, setIdx, label) {
  const date = today();
  const before = calcProgress(date, currentDay);
  const prog = getProgress(date, currentDay);
  const sets = prog[exId] || [];
  const done = !sets[setIdx];
  let log = null;
  if (done) {
    const values = readSetInput(exId, setIdx);
    const countLabel = countUnitLabel(exerciseCountUnit(findExercise(exId)));
    log = values.log;
    values.weightInput?.classList.remove('invalid');
    values.countInput?.classList.remove('invalid');
    if (!log) {
      const emptyWeight = !values.weightInput || values.weightInput.value.trim() === '';
      const emptyCount = !values.countInput || values.countInput.value.trim() === '';
      const message = emptyWeight || emptyCount
        ? `完成前请填写本组重量和实际${countLabel}（自重填 0kg）`
        : `重量需为 0–10000，${countLabel}需为 1–9999 的整数`;
      showSetInputError(exId, setIdx, message, emptyWeight || emptyCount
        ? [emptyWeight ? values.weightInput : null, emptyCount ? values.countInput : null]
        : [values.weightInput, values.countInput]);
      return;
    }
    if (setIdx === 0) applyFirstSetWeightAutofill(exId);
  }
  await setSetLogAndDone(date, currentDay, exId, setIdx, log, done);
  if (done) markSetInputAuthoritative(exId, setIdx);
  await syncDayStatus(date, currentDay);
  const after = calcProgress(date, currentDay);
  const completedNow = didBecomeComplete(before, after);
  const btn = document.getElementById(`set_${exId}_${setIdx}`);
  btn.className = 'set-btn' + (done ? ' done' : '');
  const error = document.getElementById(`set_error_${exId}_${setIdx}`);
  if (error) error.textContent = '';
  if (done) {
    const updatedSets = getProgress(date, currentDay)[exId] || [];
    const doneCount = updatedSets.filter(Boolean).length;
    const ex = PLAN[currentDay].sections.flatMap(s => s.exercises || []).find(e => e.id === exId);
    if (ex && doneCount === ex.sets) {
      document.getElementById('card_' + exId).classList.add('completed');
    }
    if (completedNow) {
      showCompletionDialog(date);
      if (settings.vibrate && navigator.vibrate) navigator.vibrate([50, 50, 50, 50, 200]);
    } else {
      if (settings.vibrate && navigator.vibrate) navigator.vibrate([40, 20, 40]);
      const restSeconds = effectiveRestTime(settings, 0);
      if (settings.autoTimer && restSeconds > 0) startTimer(restSeconds, label);
    }
  }
  updateProgress();
}

async function toggleCardio(cid, el) {
  const date = today();
  const before = calcProgress(date, currentDay);
  const prog = getProgress(date, currentDay);
  const done = !prog[cid];
  await setItemDone(date, currentDay, cid, done);
  await syncDayStatus(date, currentDay);
  const after = calcProgress(date, currentDay);
  const completedNow = didBecomeComplete(before, after);
  const card = el.closest('.cardio-card');
  card.querySelector('.big-check').className = 'big-check' + (done ? ' done' : '');
  updateProgress();
  if (done && completedNow) showCompletionDialog(date);
  if (done && settings.vibrate && navigator.vibrate) {
    navigator.vibrate(completedNow ? [50, 50, 50, 50, 200] : [40, 30, 40, 30, 80]);
  }
}

async function syncDayStatus(date, dayKey) {
  const prog = getProgress(date, dayKey);
  const { done, total } = calcProgress(date, dayKey);
  const current = sessionStatus(prog);
  const next = total > 0 && done === total ? 'completed'
    : current === 'skipped' ? 'skipped' : 'active';
  if (current !== next) await setSessionStatus(date, dayKey, next);
}

function updateProgress() {
  const { done, total, pct } = calcProgress(today(), currentDay);
  document.getElementById('progFill').style.width = pct + '%';
  document.getElementById('progText').textContent = `${done} / ${total} 项完成（${pct}%）`;
}

function showCompletionDialog(dateKey = today()) {
  const dialog = document.getElementById('completionDialog');
  if (!dialog || dialog.open) return;
  completionReturnFocus = document.activeElement;
  const date = document.getElementById('completionDate');
  date.dateTime = dateKey;
  date.textContent = formatLocalChineseDate(dateKey);
  dialog.showModal();
  document.getElementById('completionClose')?.focus();
}

function closeCompletionDialog() {
  const dialog = document.getElementById('completionDialog');
  if (dialog?.open) dialog.close();
}

function restoreCompletionFocus() {
  if (completionReturnFocus?.isConnected) completionReturnFocus.focus();
  completionReturnFocus = null;
}

// ── TIMER ──────────────────────────────────────────────────
function remainingSeconds(endTime, now = Date.now()) {
  return Math.max(0, Math.ceil((endTime - now) / 1000));
}

async function persistActiveTimer() {
  await dbPut('settings', {
    key: 'active_timer',
    value: { endTime: timerEndTime, total: timerTotal, label: timerLabel }
  });
}

async function clearActiveTimer() {
  await dbDelete('settings', 'active_timer');
}

function beginTimerTicks() {
  clearInterval(timerInterval);
  timerInterval = setInterval(reconcileTimer, 250);
}

function clearTimerCompletionCue() {
  clearTimeout(timerCompletionTimeout);
  timerCompletionTimeout = null;
  document.getElementById('timerOverlay').classList.remove('complete');
}

function showTimerCompletionCue() {
  clearTimerCompletionCue();
  const overlay = document.getElementById('timerOverlay');
  overlay.classList.add('on', 'complete');
  document.getElementById('timerCount').textContent = '✓';
  document.getElementById('timerNext').textContent = '休息结束，可以开始下一组';
  document.getElementById('timerRingFill').style.strokeDashoffset = 0;
  timerCompletionTimeout = setTimeout(() => {
    overlay.classList.remove('on', 'complete');
    timerCompletionTimeout = null;
  }, 1800);
}

function startTimer(secs, label) {
  clearTimerCompletionCue();
  timerTotal = secs;
  timerEndTime = Date.now() + secs * 1000;
  timerLabel = label || '';
  document.getElementById('timerNext').textContent = timerLabel ? `下一组：${timerLabel}` : '';
  document.getElementById('timerOverlay').classList.add('on');
  reconcileTimer();
  beginTimerTicks();
  persistActiveTimer().catch(() => {});
}

function reconcileTimer() {
  if (!timerEndTime) return;
  timerSeconds = remainingSeconds(timerEndTime);
  if (timerSeconds <= 0) {
    finishTimer(true);
    return;
  }
  updateTimerDisplay();
}

function updateTimerDisplay() {
  const m = Math.floor(timerSeconds / 60);
  const s = timerSeconds % 60;
  document.getElementById('timerCount').textContent =
    m > 0 ? `${m}:${s.toString().padStart(2, '0')}` : timerSeconds;
  const circ = 213.6;
  const offset = circ * (1 - timerSeconds / timerTotal);
  document.getElementById('timerRingFill').style.strokeDashoffset = offset;
}

function finishTimer(notify) {
  clearInterval(timerInterval);
  timerInterval = null;
  timerEndTime = 0;
  timerSeconds = 0;
  clearActiveTimer().catch(() => {});
  if (notify) {
    showTimerCompletionCue();
    if (settings.vibrate && navigator.vibrate) navigator.vibrate([100, 80, 180]);
  } else {
    clearTimerCompletionCue();
    document.getElementById('timerOverlay').classList.remove('on');
  }
}

function skipTimer() { finishTimer(false); }

function addTime() {
  if (!timerEndTime) return;
  timerEndTime += 30000;
  timerTotal += 30;
  reconcileTimer();
  persistActiveTimer().catch(() => {});
}

async function restoreActiveTimer() {
  const row = await dbGet('settings', 'active_timer');
  if (!row?.value?.endTime) return;
  timerEndTime = Number(row.value.endTime);
  timerTotal = Math.max(1, Number(row.value.total) || remainingSeconds(timerEndTime));
  timerLabel = row.value.label || '';
  document.getElementById('timerNext').textContent = timerLabel ? `下一组：${timerLabel}` : '';
  if (remainingSeconds(timerEndTime) <= 0) {
    finishTimer(true);
    return;
  }
  document.getElementById('timerOverlay').classList.add('on');
  reconcileTimer();
  beginTimerTicks();
}

// ── HISTORY ────────────────────────────────────────────────
function completedTrainingDates() {
  return Object.keys(progressCache).filter(date =>
    DAY_KEYS.some(key => isDayComplete(date, key))
  );
}

function calculateScheduledStreak(
  now = new Date(),
  isComplete = isDayComplete,
  planForDate = scheduledDayKey,
  isSkipped = isDaySkipped
) {
  const cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayPlan = planForDate(cursor);
  if (todayPlan && isSkipped(localDateKey(cursor), todayPlan)) return 0;
  if (!todayPlan || !isComplete(localDateKey(cursor), todayPlan)) {
    cursor.setDate(cursor.getDate() - 1);
  }

  let streak = 0;
  for (let checked = 0; checked < 3660; checked++) {
    const expectedPlan = planForDate(cursor);
    if (!expectedPlan) {
      cursor.setDate(cursor.getDate() - 1);
      continue;
    }
    if (!isComplete(localDateKey(cursor), expectedPlan)) break;
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

function renderHistory() {
  const p = progressCache;
  const wrap = document.getElementById('historyWrap');
  const allDates = Object.keys(p).sort().reverse();
  const totalDays = completedTrainingDates().length;
  const streak = calculateScheduledStreak();

  const now = new Date();
  const yr = now.getFullYear(), mo = now.getMonth();
  const firstDay = new Date(yr, mo, 1).getDay();
  const daysInMonth = new Date(yr, mo + 1, 0).getDate();
  const months = ['一月', '二月', '三月', '四月', '五月', '六月',
    '七月', '八月', '九月', '十月', '十一月', '十二月'];

  let calHtml = `<div class="stats-grid">
    <div class="stat-card"><div class="stat-num">${totalDays}</div><div class="stat-lbl">累计训练天数</div></div>
    <div class="stat-card"><div class="stat-num">${streak}</div><div class="stat-lbl">当前连续训练日</div></div>
  </div>
  <div class="cal-month">${yr}年 ${months[mo]}</div>
  <div class="cal-grid">
    <div class="cal-dow">日</div><div class="cal-dow">一</div><div class="cal-dow">二</div>
    <div class="cal-dow">三</div><div class="cal-dow">四</div><div class="cal-dow">五</div>
    <div class="cal-dow">六</div>`;
  for (let i = 0; i < firstDay; i++) calHtml += '<div class="cal-day empty"></div>';
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${yr}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const isToday = ds === today();
    const hasFull = DAY_KEYS.some(k => isDayComplete(ds, k));
    const planKey = scheduledDayKey(dateFromLocalKey(ds));
    const wasSkipped = !!planKey && isDaySkipped(ds, planKey);
    const hasPartial = !hasFull && !wasSkipped && DAY_KEYS.some(k => calcProgress(ds, k).done > 0);
    const wasMissed = ds < today() && !!planKey && !hasFull && !hasPartial && !wasSkipped;
    let cls = 'cal-day';
    if (isToday) cls += ' today';
    if (hasFull) cls += ' done';
    else if (wasSkipped) cls += ' skipped';
    else if (hasPartial) cls += ' partial';
    else if (wasMissed) cls += ' missed';
    const mark = hasFull ? '<span class="cal-mark">✓</span>'
      : wasSkipped ? '<span class="cal-mark">跳</span>'
      : hasPartial ? '<span class="cal-mark">•</span>'
      : wasMissed ? '<span class="cal-mark">✕</span>' : '';
    calHtml += `<div class="${cls}"><span class="cal-date">${d}</span>${mark}</div>`;
  }
  calHtml += '</div>';

  let listHtml = '<div class="history-list">';
  const doneDates = allDates.filter(d => DAY_KEYS.some(k => p[d]?.[k] && isDayComplete(d, k)));
  if (doneDates.length === 0) {
    listHtml += '<div class="empty-state"><div class="empty-icon">🏋️</div><div class="empty-text">还没有完成的训练记录</div></div>';
  } else {
    doneDates.slice(0, 20).forEach(d => {
      const parts = d.split('-');
      const dateLabel = `${parts[1]}月${parts[2]}日`;
      const completedDays = DAY_KEYS.filter(k => isDayComplete(d, k));
      const names = completedDays.map(k => PLAN[k].label + ' ' + PLAN[k].title).join('、');
      const weights = completedDays.flatMap(k =>
        PLAN[k].sections.flatMap(section => section.exercises || []).map(ex => {
          const logs = readSetLogs(getProgress(d, k), ex.id, ex.sets);
          return logs.some(Boolean)
            ? `${ex.name}：${logs.map((log, i) => `${i + 1}组 ${formatSetLog(log, exerciseCountUnit(ex))}`).join('，')}` : null;
        }).filter(Boolean)
      );
      listHtml += `<div class="history-item">
        <div class="hi-top">
          <div class="hi-date">${dateLabel}</div>
          <div class="hi-day">${completedDays.map(k => PLAN[k].label).join(' ')}</div>
        </div>
        <div class="hi-exs">${names}</div>
        ${weights.length ? `<div class="hi-weights">${weights.join('·')}</div>` : ''}
      </div>`;
    });
  }
  listHtml += '</div>';
  wrap.innerHTML = calHtml + listHtml;
}

// ── BACKUP / RESTORE ──────────────────────────────────────
function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(object, allowed) {
  return Object.keys(object).every(key => allowed.includes(key) && key !== '__proto__' && key !== 'constructor');
}

function validDateKey(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = dateFromLocalKey(value);
  return localDateKey(date) === value;
}

function validateDayBackup(dayKey, value, plan = PLAN) {
  if (!isPlainObject(value)) throw new Error(`${dayKey} 训练数据格式无效`);
  const day = plan[dayKey];
  if (!day) throw new Error(`未知训练日：${dayKey}`);
  const exercises = day.sections.flatMap(section => section.exercises || []);
  const exerciseMap = Object.fromEntries(exercises.map(ex => [ex.id, ex]));
  const itemKeys = day.sections.flatMap(section => {
    if (section.type === 'warmup') return section.items.map((_, i) => `wu_${section.label}_${i}`);
    if (section.type === 'cardio') return [`cardio_${section.label}`];
    return [];
  });
  const allowed = new Set(['_v2', ...itemKeys, ...exercises.flatMap(ex => [ex.id, weightKey(ex.id)])]);
  for (const [key, raw] of Object.entries(value)) {
    if (!allowed.has(key)) throw new Error(`${dayKey} 包含未知字段：${key}`);
    if (itemKeys.includes(key)) {
      if (typeof raw !== 'boolean') throw new Error(`${key} 必须为布尔值`);
      continue;
    }
    if (key.endsWith('_weight')) {
      if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 10000) {
        throw new Error(`${key} 重量无效`);
      }
      continue;
    }
    if (exerciseMap[key]) {
      if (!Array.isArray(raw) || raw.length > exerciseMap[key].sets
        || raw.some(item => item !== null && typeof item !== 'boolean')) {
        throw new Error(`${key} 组完成状态无效`);
      }
      continue;
    }
    if (key === '_v2') {
      if (!isPlainObject(raw) || !exactKeys(raw, ['setLogs', 'sessionStatus'])) throw new Error('_v2 格式无效');
      if (raw.sessionStatus !== undefined && !['active', 'completed', 'skipped'].includes(raw.sessionStatus)) {
        throw new Error('训练状态无效');
      }
      if (raw.setLogs !== undefined) {
        if (!isPlainObject(raw.setLogs)) throw new Error('逐组记录格式无效');
        for (const [exId, logs] of Object.entries(raw.setLogs)) {
          const ex = exerciseMap[exId];
          if (!ex || !Array.isArray(logs) || logs.length > ex.sets) throw new Error(`${exId} 逐组记录无效`);
          for (const log of logs) {
            if (log === null) continue;
            if (!isPlainObject(log) || !exactKeys(log, ['weight', 'actualCount']) || !normalizeSetLog(log, false)) {
              throw new Error(`${exId} 包含无效的重量或次数`);
            }
          }
        }
      }
    }
  }
}

function validateBackupObject(raw, plan = PLAN) {
  if (!isPlainObject(raw) || !exactKeys(raw, ['format', 'version', 'exportedAt', 'progress', 'settings'])) {
    throw new Error('不是有效的健身打卡备份');
  }
  if (raw.format !== BACKUP_FORMAT || raw.version !== BACKUP_VERSION) throw new Error('备份版本不受支持');
  if (!Array.isArray(raw.progress) || raw.progress.length > MAX_PROGRESS_ROWS) throw new Error('训练记录数量超出限制');
  if (!isPlainObject(raw.settings) || !exactKeys(raw.settings, ['restTime', 'vibrate', 'autoTimer'])) {
    throw new Error('设置数据格式无效');
  }
  const restTime = raw.settings.restTime;
  if (!Number.isInteger(restTime) || restTime < 30 || restTime > 600
    || typeof raw.settings.vibrate !== 'boolean' || typeof raw.settings.autoTimer !== 'boolean') {
    throw new Error('设置数据数值无效');
  }
  const seenDates = new Set();
  let setLogCount = 0;
  const progress = raw.progress.map(row => {
    if (!isPlainObject(row) || !exactKeys(row, ['date', 'data']) || !validDateKey(row.date) || seenDates.has(row.date)) {
      throw new Error('训练日期无效或重复');
    }
    seenDates.add(row.date);
    if (!isPlainObject(row.data) || !exactKeys(row.data, Object.keys(plan))) throw new Error(`${row.date} 数据格式无效`);
    for (const [dayKey, dayData] of Object.entries(row.data)) {
      validateDayBackup(dayKey, dayData, plan);
      setLogCount += Object.values(dayData?._v2?.setLogs || {}).reduce(
        (sum, logs) => sum + logs.filter(Boolean).length, 0
      );
      if (setLogCount > MAX_SET_LOGS) throw new Error('逐组记录数量超出限制');
    }
    return { date: row.date, data: JSON.parse(JSON.stringify(row.data)) };
  });
  return {
    progress,
    settings: { restTime, vibrate: raw.settings.vibrate, autoTimer: raw.settings.autoTimer }
  };
}

function currentBackupPayload(progressRows, userSettings = settings) {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    progress: progressRows,
    settings: {
      restTime: userSettings.restTime,
      vibrate: !!userSettings.vibrate,
      autoTimer: !!userSettings.autoTimer
    }
  };
}

async function deliverBackupContent(content, filename, deps = {}) {
  const navigatorRef = deps.navigatorRef ?? (typeof navigator !== 'undefined' ? navigator : null);
  const documentRef = deps.documentRef ?? (typeof document !== 'undefined' ? document : null);
  const urlRef = deps.urlRef ?? (typeof URL !== 'undefined' ? URL : null);
  const FileCtor = deps.FileCtor ?? (typeof File !== 'undefined' ? File : null);
  const BlobCtor = deps.BlobCtor ?? (typeof Blob !== 'undefined' ? Blob : null);
  let file = null;
  if (FileCtor) file = new FileCtor([content], filename, { type: 'application/json' });
  let canShareFile = false;
  try {
    canShareFile = !!file && typeof navigatorRef?.canShare === 'function'
      && navigatorRef.canShare({ files: [file] }) && typeof navigatorRef.share === 'function';
  } catch (_) {
    canShareFile = false;
  }

  if (canShareFile) {
    try {
      await navigatorRef.share({
        files: [file],
        title: 'Leafy GymKit 训练备份',
        text: '完整本地训练历史 JSON 备份'
      });
      return { method: 'share' };
    } catch (error) {
      if (error?.name === 'AbortError') return { method: 'cancelled' };
    }
  }

  if (!documentRef || typeof urlRef?.createObjectURL !== 'function' || !BlobCtor) {
    return { method: 'unsupported' };
  }
  try {
    const blob = file || new BlobCtor([content], { type: 'application/json' });
    const url = urlRef.createObjectURL(blob);
    const link = documentRef.createElement('a');
    link.href = url;
    link.download = filename;
    documentRef.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => urlRef.revokeObjectURL?.(url), 1000);
    return { method: 'download' };
  } catch (_) {
    return { method: 'unsupported' };
  }
}

async function exportBackup() {
  // Build synchronously from the write-through cache so iOS keeps the click's
  // transient user activation alive for navigator.share().
  const rows = Object.entries(progressCache).map(([date, data]) => ({
    date,
    data: JSON.parse(JSON.stringify(data))
  }));
  const payload = currentBackupPayload(rows);
  const result = await deliverBackupContent(
    JSON.stringify(payload, null, 2),
    `Leafy-GymKit-${today()}.json`
  );
  if (result.method === 'share') showDataNotice('系统分享已完成。', false);
  else if (result.method === 'download') showDataNotice('备份文件已下载，请保存到“文件”或云盘。', false);
  else if (result.method === 'cancelled') showDataNotice('已取消分享，未导出备份。', true);
  else showDataNotice('当前浏览器无法导出文件，请使用 Safari 后重试。', true);
}

async function hasRunningTimer() {
  if (timerEndTime && remainingSeconds(timerEndTime) > 0) return true;
  const row = await dbGet('settings', 'active_timer');
  return !!row?.value?.endTime && remainingSeconds(Number(row.value.endTime)) > 0;
}

async function applyImportedBackup(validated) {
  const beforeRows = await dbGetAll('progress');
  const beforeSettings = { ...settings };
  const snapshot = currentBackupPayload(beforeRows, beforeSettings);
  validateBackupObject(snapshot);
  await replaceStoresAtomically(
    db,
    validated.progress,
    validated.settings,
    snapshot
  );
}

async function replaceStoresAtomically(database, progressRows, userSettings, snapshot) {
  const tx = database.transaction(['progress', 'settings'], 'readwrite');
  const progressStore = tx.objectStore('progress');
  const settingsStore = tx.objectStore('settings');
  progressStore.clear();
  progressRows.forEach(row => progressStore.put(row));
  if (snapshot) settingsStore.put({ key: 'pre_import_snapshot', value: snapshot });
  else settingsStore.delete('pre_import_snapshot');
  settingsStore.put({ key: 'user_settings', value: userSettings });
  await transactionDone(tx);
}

async function importBackupFile(file) {
  if (!file) return;
  if (await hasRunningTimer()) throw new Error('请先结束正在运行的休息计时，再导入备份');
  if (file.size > MAX_BACKUP_BYTES) throw new Error('备份文件超过 2MB 限制');
  let raw;
  try { raw = JSON.parse(await file.text()); }
  catch (_) { throw new Error('备份文件不是有效的 JSON'); }
  const validated = validateBackupObject(raw);
  if (!confirm(`将用备份中的 ${validated.progress.length} 天记录替换本机数据。导入后可撤销一次，是否继续？`)) return;
  await applyImportedBackup(validated);
  await loadAllProgress();
  settings = { restTime: 90, vibrate: true, autoTimer: true, ...validated.settings };
  renderHome();
  renderHistory();
  renderSettings();
  showDataNotice('导入完成。若结果不对，可使用“撤销上次导入”。', false);
}

async function undoLastImport() {
  if (await hasRunningTimer()) {
    showDataNotice('请先结束正在运行的休息计时，再撤销导入。', true);
    return;
  }
  const snapshotRow = await dbGet('settings', 'pre_import_snapshot');
  if (!snapshotRow?.value) {
    showDataNotice('没有可撤销的导入记录。', true);
    return;
  }
  let validated;
  try { validated = validateBackupObject(snapshotRow.value); }
  catch (_) {
    showDataNotice('撤销快照已损坏，未更改现有数据。', true);
    return;
  }
  if (!confirm('确定撤销上次导入并恢复导入前的数据吗？')) return;
  await replaceStoresAtomically(db, validated.progress, validated.settings, null);
  await loadAllProgress();
  settings = { restTime: 90, vibrate: true, autoTimer: true, ...validated.settings };
  renderHome();
  renderHistory();
  renderSettings();
  showDataNotice('已恢复到导入前的数据。', false);
}

function showDataNotice(message, isError) {
  const notice = document.getElementById('dataNotice');
  if (!notice) return;
  notice.textContent = message;
  notice.className = `data-notice show${isError ? ' error' : ''}`;
}

// ── SETTINGS ───────────────────────────────────────────────
function renderSettings() {
  [60, 90, 120, 180].forEach(t => {
    const el = document.getElementById('rest' + t);
    if (el) el.textContent = settings.restTime === t ? '✓ 已选' : '';
  });
  document.getElementById('vibrateToggle').className = 'toggle' + (settings.vibrate ? ' on' : '');
  document.getElementById('autoTimerToggle').className = 'toggle' + (settings.autoTimer ? ' on' : '');
  const totalDays = completedTrainingDates().length;
  document.getElementById('totalDaysVal').textContent = totalDays + ' 天';
}

function setRestTime(t) {
  settings.restTime = t;
  saveSettings();
  renderSettings();
}

function toggleVibrate() { settings.vibrate = !settings.vibrate; saveSettings(); renderSettings(); }
function toggleAutoTimer() { settings.autoTimer = !settings.autoTimer; saveSettings(); renderSettings(); }

async function clearData() {
  if (confirm('确定要清除所有训练记录吗？此操作无法撤销。')) {
    await dbClear('progress');
    progressCache = {};
    renderHistory();
    renderSettings();
    renderHome();
  }
}

// ── INIT ───────────────────────────────────────────────────
async function init() {
  await openDB();
  await loadAllProgress();
  await loadSettings();
  renderHome();
  await restoreActiveTimer();

  // Event delegation for workout items
  document.getElementById('workoutBody').addEventListener('click', e => {
    if (e.target.closest('[data-session-skip]')) {
      toggleTodaySkip();
      return;
    }
    const chartButton = e.target.closest('[data-show-chart]');
    if (chartButton) {
      showExerciseChart(chartButton.dataset.showChart);
      return;
    }
    const warmupItem = e.target.closest('[data-warmup-id]');
    if (warmupItem) {
      toggleWarmup(decodeURIComponent(warmupItem.dataset.warmupId), warmupItem);
      return;
    }
    const setBtn = e.target.closest('[data-toggle-set]');
    if (setBtn) {
      toggleSet(setBtn.dataset.setEx, parseInt(setBtn.dataset.setIdx), setBtn.dataset.setLabel);
      return;
    }
    const cardioCheck = e.target.closest('[data-cardio-id]');
    if (cardioCheck) {
      toggleCardio(decodeURIComponent(cardioCheck.dataset.cardioId), cardioCheck);
      return;
    }
  });

  document.getElementById('workoutBody').addEventListener('input', e => {
    const input = e.target.closest('[data-set-input]');
    if (!input) return;
    markSetTouchedForInteraction(input, e.type);
    if (input.dataset.setInput === 'weight' && Number(input.dataset.setIdx) === 0) {
      applyFirstSetWeightAutofill(input.dataset.exId);
    }
  });

  document.getElementById('workoutBody').addEventListener('change', async e => {
    const input = e.target.closest('[data-set-input]');
    if (!input) return;
    markSetTouchedForInteraction(input, e.type);
    const exId = input.dataset.exId;
    const setIdx = Number(input.dataset.setIdx);
    if (input.dataset.setInput === 'weight' && setIdx === 0) {
      applyFirstSetWeightAutofill(exId);
    }
    const values = readSetInput(exId, setIdx);
    const { weightRaw, countRaw } = values;
    const draft = normalizeSetLog({
      weight: weightRaw === '' ? null : Number(weightRaw),
      actualCount: countRaw === '' ? null : Number(countRaw)
    }, false);
    if ((weightRaw || countRaw) && !draft) {
      input.classList.add('invalid');
      const countLabel = countUnitLabel(exerciseCountUnit(findExercise(exId)));
      showSetInputError(exId, setIdx, `重量需为 0–10000，${countLabel}需为 1–9999 的整数`);
      return;
    }
    input.classList.remove('invalid');
    const error = document.getElementById(`set_error_${exId}_${setIdx}`);
    if (error) error.textContent = '';
    if (draft) {
      await setSetLogDraft(today(), currentDay, exId, setIdx, draft);
      markSetInputAuthoritative(exId, setIdx);
    } else {
      const prog = getProgress(today(), currentDay);
      const logs = ensureV2(prog).setLogs[exId];
      if (Array.isArray(logs)) logs[setIdx] = null;
      await dbPut('progress', { date: today(), data: progressCache[today()] });
    }
  });

  document.getElementById('backupFile').addEventListener('change', async e => {
    try { await importBackupFile(e.target.files?.[0]); }
    catch (error) { showDataNotice(error.message || '导入失败，现有数据未更改。', true); }
    finally { e.target.value = ''; }
  });

  document.getElementById('chartModal').addEventListener('click', e => {
    if (e.target.id === 'chartModal') closeExerciseChart();
    const monthButton = e.target.closest('[data-chart-month]');
    if (monthButton && !monthButton.disabled) {
      changeExerciseChartMonth(Number(monthButton.dataset.chartMonth));
    }
  });

  const completionDialog = document.getElementById('completionDialog');
  document.getElementById('completionClose').addEventListener('click', closeCompletionDialog);
  completionDialog.addEventListener('click', e => {
    if (e.target === completionDialog) closeCompletionDialog();
  });
  completionDialog.addEventListener('close', restoreCompletionFocus);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') reconcileTimer();
  });
  window.addEventListener('pageshow', reconcileTimer);

  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

if (typeof document !== 'undefined') init();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    localDateKey,
    formatLocalChineseDate,
    dateFromLocalKey,
    remainingSeconds,
    readExerciseWeight,
    hasRequiredWeight,
    readSetLogs,
    resolveSetDisplayRows,
    resolveSetDisplayValues,
    classifyFirstSetWeight,
    nextAutofillWeightState,
    markSetTouchedForInteraction,
    normalizeSetLog,
    sessionStatus,
    effectiveRestTime,
    exerciseCountUnit,
    countUnitLabel,
    formatSetLog,
    priorExerciseSessions,
    normalizeYearMonth,
    shiftYearMonth,
    compareYearMonth,
    daysInMonth,
    formatChartWeight,
    monthlyExerciseAverages,
    monthlyChartModel,
    didBecomeComplete,
    calculateScheduledStreak,
    validateBackupObject,
    currentBackupPayload,
    replaceStoresAtomically,
    deliverBackupContent
  };
}
