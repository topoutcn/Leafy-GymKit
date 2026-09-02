// ── STATE ──────────────────────────────────────────────────
let currentDay = null;
let timerInterval = null;
let timerCompletionTimeout = null;
let timerSeconds = 0;
let timerTotal = 0;
let timerEndTime = 0;
let timerLabel = '';
let settings = { restTime: 90, vibrate: true, autoTimer: true };

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
  if (!progressCache[date]) progressCache[date] = {};
  if (!progressCache[date][dayKey]) progressCache[date][dayKey] = {};
  progressCache[date][dayKey][itemId] = done;
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

function readExerciseWeight(prog, exId) {
  const value = prog?.[weightKey(exId)];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function hasRequiredWeight(prog, exId) {
  return readExerciseWeight(prog, exId) !== null;
}

async function setExerciseWeight(date, dayKey, exId, weight) {
  if (!progressCache[date]) progressCache[date] = {};
  if (!progressCache[date][dayKey]) progressCache[date][dayKey] = {};
  progressCache[date][dayKey][weightKey(exId)] = weight;
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

function dateFromLocalKey(dateKey) {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function today() { return localDateKey(); }
function todayWeekday() { return new Date().getDay(); }

function scheduledDayKey(date) {
  return Object.keys(DAY_WEEKDAY).find(key => DAY_WEEKDAY[key] === date.getDay()) || null;
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
  const { done, total } = calcProgress(date, dayKey);
  return total > 0 && done === total;
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
    return `<div class="day-card${isToday ? ' today-highlight' : ''}"
      style="background:${d.bg};color:${d.color}"
      onclick="openDay('${key}')">
      <div class="dc-day">${d.label}</div>
      <div class="dc-name">${d.title}</div>
      <div class="dc-tag">${d.sub}</div>
      <div class="dc-prog">${complete ? '✅ 完成' : done > 0 ? `${pct}%` : '未开始'}</div>
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

  let html = '';
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
        const weight = readExerciseWeight(prog, ex.id);
        const allDone = sets.filter(Boolean).length === ex.sets;
        html += `<div class="ex-card${allDone ? ' completed' : ''}" id="card_${ex.id}">
          <div class="ex-header">
            <div class="ex-name">${ex.name}</div>
            <div class="ex-badge" style="color:${ex.badgeColor};background:${ex.badgeBg}">${ex.badge}</div>
          </div>
          <div class="ex-tip">${ex.tip}</div>
          <div class="ex-meta">${ex.meta}</div>
          <label class="weight-row" for="weight_${ex.id}">
            <span class="weight-label">本次重量</span>
            <span class="weight-control">
              <input class="weight-input" id="weight_${ex.id}" data-weight-ex="${ex.id}"
                type="number" min="0" step="0.5" inputmode="decimal"
                value="${weight === null ? '' : weight}" placeholder="0">
              <span>kg</span>
            </span>
          </label>
          <div class="weight-error" id="weight_error_${ex.id}"></div>
          <div class="ex-sets">`;
        for (let s = 0; s < ex.sets; s++) {
          const done = !!sets[s];
          html += `<div class="set-btn${done ? ' done' : ''}" id="set_${ex.id}_${s}"
            data-set-ex="${ex.id}" data-set-idx="${s}" data-set-rest="${ex.rest}" data-set-label="第${s + 1}组 ${ex.reps}"></div>`;
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
  document.getElementById('completeBanner').classList.remove('show');
  checkComplete();
}

async function toggleWarmup(id, el) {
  const date = today();
  const prog = getProgress(date, currentDay);
  const done = !prog[id];
  await setItemDone(date, currentDay, id, done);
  el.querySelector('.wi-check').className = 'wi-check' + (done ? ' done' : '');
  el.querySelector('.wi-text').className = 'wi-text' + (done ? ' done' : '');
  if (done && settings.vibrate && navigator.vibrate) navigator.vibrate(30);
  updateProgress();
  checkComplete();
}

async function toggleSet(exId, setIdx, restSecs, label) {
  const date = today();
  const prog = getProgress(date, currentDay);
  const sets = prog[exId] || [];
  const done = !sets[setIdx];
  if (done && !sets.some(Boolean) && !hasRequiredWeight(prog, exId)) {
    const input = document.getElementById(`weight_${exId}`);
    const error = document.getElementById(`weight_error_${exId}`);
    if (error) error.textContent = '请先输入本次重量（0 表示自重）';
    if (input) {
      input.classList.add('invalid');
      input.focus();
    }
    return;
  }
  await setSetDone(date, currentDay, exId, setIdx, done);
  const btn = document.getElementById(`set_${exId}_${setIdx}`);
  btn.className = 'set-btn' + (done ? ' done' : '');
  if (done) {
    if (settings.vibrate && navigator.vibrate) navigator.vibrate([40, 20, 40]);
    const updatedSets = getProgress(date, currentDay)[exId] || [];
    const doneCount = updatedSets.filter(Boolean).length;
    const ex = PLAN[currentDay].sections.flatMap(s => s.exercises || []).find(e => e.id === exId);
    if (ex && doneCount === ex.sets) {
      document.getElementById('card_' + exId).classList.add('completed');
    }
    if (settings.autoTimer && restSecs > 0) startTimer(restSecs, label);
  }
  updateProgress();
  checkComplete();
}

async function toggleCardio(cid, el) {
  const date = today();
  const prog = getProgress(date, currentDay);
  const done = !prog[cid];
  await setItemDone(date, currentDay, cid, done);
  const card = el.closest('.cardio-card');
  card.querySelector('.big-check').className = 'big-check' + (done ? ' done' : '');
  if (done && settings.vibrate && navigator.vibrate) navigator.vibrate([40, 30, 40, 30, 80]);
  updateProgress();
  checkComplete();
}

function updateProgress() {
  const { done, total, pct } = calcProgress(today(), currentDay);
  document.getElementById('progFill').style.width = pct + '%';
  document.getElementById('progText').textContent = `${done} / ${total} 项完成（${pct}%）`;
}

function checkComplete() {
  const { done, total } = calcProgress(today(), currentDay);
  const banner = document.getElementById('completeBanner');
  if (done === total && total > 0) {
    const d = PLAN[currentDay];
    document.getElementById('completeSub').textContent = `${d.label} ${d.title}全部完成`;
    banner.classList.add('show');
    if (settings.vibrate && navigator.vibrate) navigator.vibrate([50, 50, 50, 50, 200]);
  } else {
    banner.classList.remove('show');
  }
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

function calculateScheduledStreak(now = new Date(), isComplete = isDayComplete, planForDate = scheduledDayKey) {
  const cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayPlan = planForDate(cursor);
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
    const hasPartial = !hasFull && DAY_KEYS.some(k => p[ds]?.[k] && Object.keys(p[ds][k]).length > 0);
    const wasMissed = ds < today() && !!scheduledDayKey(dateFromLocalKey(ds)) && !hasFull && !hasPartial;
    let cls = 'cal-day';
    if (isToday) cls += ' today';
    if (hasFull) cls += ' done';
    else if (hasPartial) cls += ' partial';
    else if (wasMissed) cls += ' missed';
    const mark = hasFull ? '<span class="cal-mark">✓</span>'
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
          const weight = readExerciseWeight(getProgress(d, k), ex.id);
          return weight === null ? null : `${ex.name} ${weight}kg`;
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
    const warmupItem = e.target.closest('[data-warmup-id]');
    if (warmupItem) {
      toggleWarmup(decodeURIComponent(warmupItem.dataset.warmupId), warmupItem);
      return;
    }
    const setBtn = e.target.closest('[data-set-ex]');
    if (setBtn) {
      toggleSet(setBtn.dataset.setEx, parseInt(setBtn.dataset.setIdx),
        parseInt(setBtn.dataset.setRest), setBtn.dataset.setLabel);
      return;
    }
    const cardioCheck = e.target.closest('[data-cardio-id]');
    if (cardioCheck) {
      toggleCardio(decodeURIComponent(cardioCheck.dataset.cardioId), cardioCheck);
      return;
    }
  });

  document.getElementById('workoutBody').addEventListener('change', async e => {
    const input = e.target.closest('[data-weight-ex]');
    if (!input) return;
    const value = Number(input.value);
    const error = document.getElementById(`weight_error_${input.dataset.weightEx}`);
    if (input.value.trim() === '' || !Number.isFinite(value) || value < 0) {
      input.classList.add('invalid');
      if (error) error.textContent = '请输入 0 或更大的重量';
      return;
    }
    input.classList.remove('invalid');
    if (error) error.textContent = '';
    await setExerciseWeight(today(), currentDay, input.dataset.weightEx, value);
  });

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
    dateFromLocalKey,
    remainingSeconds,
    readExerciseWeight,
    hasRequiredWeight,
    calculateScheduledStreak
  };
}
