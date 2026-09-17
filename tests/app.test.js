const test = require('node:test');
const assert = require('node:assert/strict');

global.DAY_KEYS = ['mon'];
global.DAY_WEEKDAY = { mon: 1 };
global.PLAN = {
  mon: {
    sections: [
      { type: 'warmup', label: '热身', items: ['走路'] },
      { type: 'exercises', exercises: [{ id: 'm1', sets: 2, countUnit: '次' }] },
      { type: 'cardio', label: '有氧' }
    ]
  },
  fri: {
    sections: [{
      type: 'exercises',
      exercises: [
        { id: 'f4', sets: 3, countUnit: '步' },
        { id: 'f5', sets: 3, countUnit: '秒' }
      ]
    }]
  }
};

const app = require('../js/app.js');

test('legacy exercise weight remains readable only when no V2 set-log array exists', () => {
  assert.deepEqual(app.readSetLogs({ m1_weight: 22.5 }, 'm1', 2), [
    { weight: 22.5, actualCount: null },
    { weight: 22.5, actualCount: null }
  ]);
  assert.deepEqual(app.readSetLogs({
    m1_weight: 20,
    _v2: { setLogs: { m1: [{ weight: 22.5, actualCount: 10 }] } }
  }, 'm1', 2), [
    { weight: 22.5, actualCount: 10 },
    null
  ]);
});

test('persisted first-set weight replaces eligible history without persisting compatibility data', () => {
  const current = {
    m1_weight: 30,
    _v2: { setLogs: { m1: [{ weight: 30, actualCount: 6 }] } }
  };
  const history = [
    { weight: 25, actualCount: 10 },
    { weight: 22.5, actualCount: 9 },
    { weight: 20, actualCount: 8 }
  ];

  assert.deepEqual(app.readSetLogs(current, 'm1', 3), [
    { weight: 30, actualCount: 6 },
    null,
    null
  ]);
  assert.deepEqual(app.resolveSetDisplayValues(current, 'm1', 3, history), [
    { weight: 30, actualCount: 6 },
    { weight: 30, actualCount: 9 },
    { weight: 30, actualCount: 8 }
  ]);
});

test('a cleared V2 draft is not resurrected by a stale legacy weight mirror', () => {
  const current = {
    m1_weight: 30,
    _v2: { setLogs: { m1: [null] } }
  };

  assert.deepEqual(app.readSetLogs(current, 'm1', 1), [null]);
  assert.deepEqual(app.resolveSetDisplayValues(current, 'm1', 1), [
    { weight: null, actualCount: null }
  ]);
  assert.deepEqual(app.resolveSetDisplayValues(current, 'm1', 1, [
    { weight: 25, actualCount: 10 }
  ]), [
    { weight: 25, actualCount: 10 }
  ]);
  assert.deepEqual(app.resolveSetDisplayValues({
    m1_weight: 30,
    _v2: { setLogs: { m1: [{ weight: null, actualCount: 12 }] } }
  }, 'm1', 1, [{ weight: 25, actualCount: 10 }]), [
    { weight: null, actualCount: 12 }
  ]);
});

test('set completion validation accepts bodyweight and rejects invalid counts', () => {
  assert.deepEqual(app.normalizeSetLog({ weight: 0, actualCount: 12 }), { weight: 0, actualCount: 12 });
  assert.equal(app.normalizeSetLog({ weight: 20, actualCount: 0 }), null);
  assert.equal(app.normalizeSetLog({ weight: -1, actualCount: 10 }), null);
});

test('prior exercise session accepts a partly completed exercise and excludes unfinished set logs', () => {
  const cache = {
    '2026-09-10': {
      mon: {
        m1: [true, false],
        _v2: { setLogs: { m1: [
          { weight: 22.5, actualCount: 10 },
          { weight: 25, actualCount: 8 }
        ] } }
      }
    }
  };
  const sessions = app.priorExerciseSessions('m1', '2026-09-18', 6, cache, global.PLAN);
  assert.equal(sessions.length, 1);
  assert.deepEqual(sessions[0].logs, [{ weight: 22.5, actualCount: 10 }, null]);
});

test('set display values autofill weights only while retaining historical counts', () => {
  const current = {
    _v2: { setLogs: { m1: [{ weight: 25, actualCount: null }] } }
  };
  const previous = [
    { weight: 20, actualCount: 10 },
    { weight: 0, actualCount: 12 },
    null
  ];
  const beforeCurrent = structuredClone(current);
  const beforePrevious = structuredClone(previous);

  assert.deepEqual(app.resolveSetDisplayValues(current, 'm1', 3, previous), [
    { weight: 25, actualCount: null },
    { weight: 25, actualCount: 12 },
    { weight: 25, actualCount: null }
  ]);
  assert.deepEqual(current, beforeCurrent);
  assert.deepEqual(previous, beforePrevious);
});

test('first-set weight classification accepts endpoints and distinguishes clear from invalid', () => {
  assert.deepEqual(app.classifyFirstSetWeight('0'), { kind: 'valid', weight: 0 });
  assert.deepEqual(app.classifyFirstSetWeight('10000'), { kind: 'valid', weight: 10000 });
  assert.deepEqual(app.classifyFirstSetWeight(''), { kind: 'empty', weight: null });
  assert.deepEqual(app.classifyFirstSetWeight('-1'), { kind: 'invalid', weight: null });
  assert.deepEqual(app.classifyFirstSetWeight('10001'), { kind: 'invalid', weight: null });
});

test('autofill revisions replace only eligible automatic values and clearing restores fallback', () => {
  const history = {
    value: 22.5,
    source: 'history',
    fallbackValue: 22.5,
    fallbackSource: 'history',
    autoFillEligible: true,
    touched: false,
    completed: false
  };
  const first = app.nextAutofillWeightState(history, '30');
  assert.equal(first.value, 30);
  assert.equal(first.source, 'auto');

  const revised = app.nextAutofillWeightState(first, '32.5');
  assert.equal(revised.value, 32.5);
  assert.equal(revised.source, 'auto');

  const invalid = app.nextAutofillWeightState(revised, '10001');
  assert.equal(invalid.value, 32.5);
  assert.equal(invalid.source, 'auto');

  const cleared = app.nextAutofillWeightState(revised, '');
  assert.equal(cleared.value, 22.5);
  assert.equal(cleared.source, 'history');

  const protectedByCountTouch = app.nextAutofillWeightState({ ...first, touched: true }, '40');
  assert.equal(protectedByCountTouch.value, 30);
  const protectedDraft = app.nextAutofillWeightState({
    ...history,
    source: 'current-v2',
    autoFillEligible: false
  }, '40');
  assert.equal(protectedDraft.value, 22.5);
  const protectedCompleted = app.nextAutofillWeightState({ ...history, completed: true }, '40');
  assert.equal(protectedCompleted.value, 22.5);
});

test('focus alone keeps a later group following while real input locks the group', () => {
  const row = { dataset: {} };
  const input = { closest: selector => selector === '.set-log-row' ? row : null };
  const base = {
    value: 22.5,
    source: 'history',
    fallbackValue: 22.5,
    fallbackSource: 'history',
    autoFillEligible: true,
    completed: false
  };

  assert.equal(app.markSetTouchedForInteraction(input, 'focusin'), false);
  assert.equal(row.dataset.setTouched, undefined);
  const afterFocus = app.nextAutofillWeightState({
    ...base,
    touched: row.dataset.setTouched === 'true'
  }, '30');
  assert.equal(afterFocus.value, 30);
  assert.equal(afterFocus.source, 'auto');

  assert.equal(app.markSetTouchedForInteraction(input, 'input'), true);
  assert.equal(row.dataset.setTouched, 'true');
  const afterWeightOrCountInput = app.nextAutofillWeightState({
    ...afterFocus,
    touched: row.dataset.setTouched === 'true'
  }, '35');
  assert.equal(afterWeightOrCountInput.value, 30);
  assert.equal(afterWeightOrCountInput.source, 'auto');
});

test('render derivation marks source and fallback while protecting V2 drafts and completed groups', () => {
  const rows = app.resolveSetDisplayRows({
    m1: [true, false, false, true],
    _v2: { setLogs: { m1: [
      { weight: 30, actualCount: 6 },
      { weight: 25, actualCount: 8 },
      null,
      null
    ] } }
  }, 'm1', 4, [
    { weight: 20, actualCount: 10 },
    { weight: 20, actualCount: 10 },
    { weight: 17.5, actualCount: 12 },
    { weight: 15, actualCount: 15 }
  ]);

  assert.deepEqual(rows.map(row => ({
    weight: row.weight,
    count: row.actualCount,
    source: row.weightSource,
    fallback: row.fallbackWeight,
    eligible: row.autoFillEligible
  })), [
    { weight: 30, count: 6, source: 'current-v2', fallback: 30, eligible: false },
    { weight: 25, count: 8, source: 'current-v2', fallback: 25, eligible: false },
    { weight: 30, count: 12, source: 'auto', fallback: 17.5, eligible: true },
    { weight: 15, count: 15, source: 'history', fallback: 15, eligible: false }
  ]);
});

test('current legacy data remains authoritative and never becomes autofill-eligible', () => {
  const rows = app.resolveSetDisplayRows({ m1_weight: 0 }, 'm1', 2, [
    { weight: 20, actualCount: 10 },
    { weight: 20, actualCount: 8 }
  ]);
  assert.deepEqual(rows.map(row => [row.weight, row.weightSource, row.autoFillEligible]), [
    [0, 'current-legacy', false],
    [0, 'current-legacy', false]
  ]);
});

test('current legacy weight is authoritative without borrowing historical counts', () => {
  assert.deepEqual(app.resolveSetDisplayValues(
    { m1_weight: 22.5 },
    'm1',
    2,
    [{ weight: 20, actualCount: 10 }, { weight: 20, actualCount: 8 }]
  ), [
    { weight: 22.5, actualCount: null },
    { weight: 22.5, actualCount: null }
  ]);
});

test('latest history session stays isolated and unfinished groups remain blank', () => {
  const cache = {
    '2026-09-17': {
      mon: {
        m1: [true, false],
        _v2: { setLogs: { m1: [
          { weight: 30, actualCount: 6 },
          { weight: 30, actualCount: 5 }
        ] } }
      }
    },
    '2026-09-16': {
      mon: {
        m1: [true, true],
        _v2: { setLogs: { m1: [
          { weight: 27.5, actualCount: 8 },
          { weight: 27.5, actualCount: 7 }
        ] } }
      }
    }
  };
  const latest = app.priorExerciseSessions('m1', '2026-09-18', 1, cache, global.PLAN)[0];
  assert.deepEqual(app.resolveSetDisplayValues({}, 'm1', 2, latest.logs), [
    { weight: 30, actualCount: 6 },
    { weight: null, actualCount: null }
  ]);
});

test('legacy history keeps known weight, zero stays visible and no history stays blank', () => {
  const cache = {
    '2026-09-10': { mon: { m1: [true, false], m1_weight: 22.5 } }
  };
  const legacy = app.priorExerciseSessions('m1', '2026-09-18', 1, cache, global.PLAN)[0];
  assert.deepEqual(app.resolveSetDisplayValues({}, 'm1', 2, legacy.logs), [
    { weight: 22.5, actualCount: null },
    { weight: null, actualCount: null }
  ]);
  assert.deepEqual(app.resolveSetDisplayValues({}, 'm1', 1, [{ weight: 0, actualCount: 12 }]), [
    { weight: 0, actualCount: 12 }
  ]);
  assert.deepEqual(app.resolveSetDisplayValues({}, 'm1', 1), [
    { weight: null, actualCount: null }
  ]);
});

test('monthly averages use only completed-set weights and retain full precision', () => {
  const threeSetPlan = structuredClone(global.PLAN);
  threeSetPlan.mon.sections[1].exercises[0].sets = 3;
  const cache = {
    '2026-09-01': { mon: {
      m1: [true, true, true],
      _v2: { setLogs: { m1: [
        { weight: 20, actualCount: 10 },
        { weight: 22.5, actualCount: 8 },
        { weight: 22.5, actualCount: 8 }
      ] } }
    } },
    '2026-09-08': { mon: {
      m1: [true, false, false],
      _v2: { setLogs: { m1: [
        { weight: 0, actualCount: 12 },
        { weight: 99, actualCount: 1 },
        { weight: 100, actualCount: 1 }
      ] } }
    } },
    '2026-09-15': { mon: {
      m1: [false, false, false],
      _v2: { setLogs: { m1: [
        { weight: 50, actualCount: 5 },
        { weight: 50, actualCount: 5 },
        { weight: 50, actualCount: 5 }
      ] } }
    } }
  };

  const points = app.monthlyExerciseAverages('m1', 2026, 8, cache, threeSetPlan);
  assert.deepEqual(points, [
    {
      date: '2026-09-01',
      day: 1,
      average: (20 + 22.5 + 22.5) / 3,
      weights: [20, 22.5, 22.5]
    },
    { date: '2026-09-08', day: 8, average: 0, weights: [0] }
  ]);
  assert.equal(app.formatChartWeight(points[0].average), '21.7');
  assert.equal(app.formatChartWeight(points[1].average), '0');
});

test('monthly averages support legacy scalar weights and omit completed sets without weight', () => {
  const cache = {
    '2026-02-02': { mon: { m1: [true, false], m1_weight: 22.5 } },
    '2026-02-09': { mon: {
      m1: [true, false],
      _v2: { setLogs: { m1: [{ weight: null, actualCount: 10 }, null] } }
    } },
    '2026-03-02': { mon: { m1: [true, false], m1_weight: 30 } }
  };

  assert.deepEqual(app.monthlyExerciseAverages('m1', 2026, 1, cache, global.PLAN), [
    { date: '2026-02-02', day: 2, average: 22.5, weights: [22.5] }
  ]);
});

test('month navigation crosses years with integer local calendar handling', () => {
  assert.deepEqual(app.shiftYearMonth(2026, 0, -1), { year: 2025, month: 11 });
  assert.deepEqual(app.shiftYearMonth(2025, 11, 1), { year: 2026, month: 0 });
  assert.equal(app.compareYearMonth(2026, 8, 2026, 8), 0);
  assert.ok(app.compareYearMonth(2026, 9, 2026, 8) > 0);
  assert.equal(app.daysInMonth(2024, 1), 29);
  assert.equal(app.daysInMonth(2026, 1), 28);
});

test('monthly chart uses true day positions and remains finite for zero or equal values', () => {
  const points = [
    { date: '2026-09-01', day: 1, average: 0, weights: [0] },
    { date: '2026-09-30', day: 30, average: 0, weights: [0] }
  ];
  const model = app.monthlyChartModel(points, 2026, 8);
  assert.equal(model.points[0].x, model.plot.left);
  assert.equal(model.points[1].x, model.plot.right);
  assert.ok(model.points.every(point => Number.isFinite(point.y)));
  assert.deepEqual(model.xLabels.map(label => label.day), [1, 5, 10, 15, 20, 25, 30]);

  const single = app.monthlyChartModel([
    { date: '2026-02-14', day: 14, average: 20, weights: [20] }
  ], 2026, 1);
  assert.ok(Number.isFinite(single.points[0].y));
  assert.equal(single.xLabels.at(-1).day, 28);
});

test('completion celebration requires an incomplete to complete transition', () => {
  assert.equal(app.didBecomeComplete({ done: 4, total: 5 }, { done: 5, total: 5 }), true);
  assert.equal(app.didBecomeComplete({ done: 5, total: 5 }, { done: 5, total: 5 }), false);
  assert.equal(app.didBecomeComplete({ done: 5, total: 5 }, { done: 4, total: 5 }), false);
  assert.equal(app.didBecomeComplete({ done: 3, total: 5 }, { done: 4, total: 5 }), false);
  assert.equal(app.didBecomeComplete({ done: 0, total: 0 }, { done: 0, total: 0 }), false);
});

test('completion date uses the supplied local calendar key', () => {
  assert.equal(app.formatLocalChineseDate('2026-09-18'), '2026年9月18日');
});

test('weight normalization preserves raw kilograms without equipment conversion', () => {
  assert.deepEqual(app.normalizeSetLog({ weight: '20', actualCount: '10' }), {
    weight: 20,
    actualCount: 10
  });
  assert.deepEqual(app.normalizeSetLog({ weight: '0', actualCount: '12' }), {
    weight: 0,
    actualCount: 12
  });
});

test('legacy weight communicates that actual count is missing', () => {
  assert.equal(
    app.formatSetLog({ weight: 22.5, actualCount: null }, '次'),
    '22.5kg × 次数未记录'
  );
});

test('exercise count units distinguish reps, steps and seconds', () => {
  assert.equal(app.exerciseCountUnit(global.PLAN.mon.sections[1].exercises[0]), '次');
  assert.equal(app.exerciseCountUnit(global.PLAN.fri.sections[0].exercises[0]), '步');
  assert.equal(app.exerciseCountUnit(global.PLAN.fri.sections[0].exercises[1]), '秒');
  assert.equal(app.formatSetLog({ weight: 10, actualCount: 12 }, '步'), '10kg × 12步');
  assert.equal(app.formatSetLog({ weight: 0, actualCount: 45 }, '秒'), '0kg × 45秒');
});

test('user rest setting overrides exercise default', () => {
  assert.equal(app.effectiveRestTime({ restTime: 120 }, 60), 120);
  assert.equal(app.effectiveRestTime({ restTime: 5 }, 60), 60);
});

test('manual skip immediately breaks scheduled streak', () => {
  const now = new Date(2026, 8, 14); // Monday
  const planForDate = date => date.getDay() === 1 ? 'mon' : null;
  const complete = () => true;
  assert.equal(app.calculateScheduledStreak(now, complete, planForDate, () => true), 0);
});

function validBackup() {
  return {
    format: 'Leafy-GymKit-Backup',
    version: 2,
    exportedAt: '2026-09-18T00:00:00.000Z',
    progress: [{
      date: '2026-09-14',
      data: {
        mon: {
          'wu_热身_0': true,
          m1: [true, false],
          m1_weight: 20,
          'cardio_有氧': false,
          _v2: {
            sessionStatus: 'active',
            setLogs: { m1: [{ weight: 20, actualCount: 10 }, null] }
          }
        }
      }
    }],
    settings: { restTime: 90, vibrate: true, autoTimer: true }
  };
}

test('backup validation accepts known V2 data and rejects unknown fields', () => {
  const validated = app.validateBackupObject(validBackup(), global.PLAN);
  assert.equal(validated.progress.length, 1);
  const invalid = validBackup();
  invalid.progress[0].data.mon.injected = '<script>';
  assert.throws(() => app.validateBackupObject(invalid, global.PLAN), /未知字段/);
});

test('import replacement uses one multi-store transaction and stores rollback snapshot', async () => {
  const operations = [];
  let tx;
  const database = {
    transaction(names, mode) {
      assert.deepEqual(names, ['progress', 'settings']);
      assert.equal(mode, 'readwrite');
      tx = {
        objectStore(name) {
          return {
            clear: () => operations.push([name, 'clear']),
            put: value => operations.push([name, 'put', value]),
            delete: key => operations.push([name, 'delete', key])
          };
        }
      };
      setImmediate(() => tx.oncomplete());
      return tx;
    }
  };
  const rows = validBackup().progress;
  const settings = validBackup().settings;
  const snapshot = validBackup();
  await app.replaceStoresAtomically(database, rows, settings, snapshot);
  assert.equal(operations[0][1], 'clear');
  assert.ok(operations.some(op => op[0] === 'settings' && op[1] === 'put'
    && op[2].key === 'pre_import_snapshot'));
  assert.ok(operations.some(op => op[0] === 'settings' && op[1] === 'put'
    && op[2].key === 'user_settings'));
});

class FileMock {
  constructor(parts, name, options) {
    this.parts = parts;
    this.name = name;
    this.type = options.type;
  }
}

class BlobMock {
  constructor(parts, options) {
    this.parts = parts;
    this.type = options.type;
  }
}

function fallbackDeps(navigatorRef) {
  let clicks = 0;
  const link = { click: () => { clicks++; }, remove: () => {} };
  return {
    deps: {
      navigatorRef,
      documentRef: {
        createElement: () => link,
        body: { appendChild: () => {} }
      },
      urlRef: { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} },
      FileCtor: FileMock,
      BlobCtor: BlobMock
    },
    getClicks: () => clicks
  };
}

test('backup delivery prefers system share with the JSON File', async () => {
  let shared;
  const navigatorRef = {
    canShare: ({ files }) => files[0] instanceof FileMock,
    share: async payload => { shared = payload; }
  };
  const setup = fallbackDeps(navigatorRef);
  const result = await app.deliverBackupContent('{}', 'backup.json', setup.deps);
  assert.equal(result.method, 'share');
  assert.equal(shared.files[0].name, 'backup.json');
  assert.equal(setup.getClicks(), 0);
});

test('cancelled system share does not claim success or trigger a download', async () => {
  const navigatorRef = {
    canShare: () => true,
    share: async () => { const error = new Error('cancel'); error.name = 'AbortError'; throw error; }
  };
  const setup = fallbackDeps(navigatorRef);
  const result = await app.deliverBackupContent('{}', 'backup.json', setup.deps);
  assert.equal(result.method, 'cancelled');
  assert.equal(setup.getClicks(), 0);
});

test('unsupported system share falls back to anchor download', async () => {
  const setup = fallbackDeps({ canShare: () => false });
  const result = await app.deliverBackupContent('{}', 'backup.json', setup.deps);
  assert.equal(result.method, 'download');
  assert.equal(setup.getClicks(), 1);
});

test('canShare capability error also falls back to anchor download', async () => {
  const setup = fallbackDeps({ canShare: () => { throw new Error('capability error'); } });
  const result = await app.deliverBackupContent('{}', 'backup.json', setup.deps);
  assert.equal(result.method, 'download');
  assert.equal(setup.getClicks(), 1);
});

test('genuine system share error falls back to anchor download', async () => {
  const navigatorRef = {
    canShare: () => true,
    share: async () => { throw new Error('share unavailable'); }
  };
  const setup = fallbackDeps(navigatorRef);
  const result = await app.deliverBackupContent('{}', 'backup.json', setup.deps);
  assert.equal(result.method, 'download');
  assert.equal(setup.getClicks(), 1);
});
