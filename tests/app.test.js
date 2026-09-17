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

test('legacy exercise weight remains readable as per-set V2 fallback', () => {
  assert.deepEqual(app.readSetLogs({ m1_weight: 22.5 }, 'm1', 2), [
    { weight: 22.5, actualCount: null },
    { weight: 22.5, actualCount: null }
  ]);
  assert.deepEqual(app.readSetLogs({
    m1_weight: 20,
    _v2: { setLogs: { m1: [{ weight: 22.5, actualCount: 10 }] } }
  }, 'm1', 2), [
    { weight: 22.5, actualCount: 10 },
    { weight: 20, actualCount: null }
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
  assert.deepEqual(app.exerciseChartCopy({ name: '哑铃弓步走', countUnit: '步' }), {
    title: '哑铃弓步走 · 重量与步数变化',
    empty: '暂无可绘制的已完成组记录'
  });
  assert.equal(
    app.exerciseChartCopy({ name: '平板支撑', countUnit: '秒' }).title,
    '平板支撑 · 重量与秒数变化'
  );
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

test('exercise metrics preserve weight, reps and volume meaning', () => {
  assert.deepEqual(app.exerciseMetrics([
    { weight: 20, actualCount: 10 },
    { weight: 22.5, actualCount: 8 }
  ]), {
    maxWeight: 22.5,
    totalCount: 18,
    totalReps: 18,
    loadVolumeAvailable: true,
    volume: 380
  });
});

test('bodyweight metrics show unit total without misleading zero kg volume', () => {
  const metrics = app.exerciseMetrics([
    { weight: 0, actualCount: 45 },
    { weight: 0, actualCount: 30 }
  ]);
  assert.equal(metrics.totalCount, 75);
  assert.equal(metrics.volume, null);
  assert.equal(metrics.loadVolumeAvailable, false);
  assert.equal(
    app.formatTrainingSummary(metrics, '秒'),
    '总秒数 75秒 · 负重容量不适用（自重或负重未完整记录）'
  );
});

test('legacy completed log contributes max weight without inventing count or volume', () => {
  assert.deepEqual(app.exerciseMetrics([
    { weight: 22.5, actualCount: null }
  ]), {
    maxWeight: 22.5,
    totalCount: 0,
    totalReps: 0,
    loadVolumeAvailable: false,
    volume: null
  });
});

test('one completed log missing count prevents partial load-volume reporting', () => {
  assert.deepEqual(app.exerciseMetrics([
    { weight: 20, actualCount: 10 },
    { weight: 25, actualCount: null }
  ]), {
    maxWeight: 25,
    totalCount: 10,
    totalReps: 10,
    loadVolumeAvailable: false,
    volume: null
  });
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
