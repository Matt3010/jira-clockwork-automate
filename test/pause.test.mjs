import assert from 'node:assert/strict';
import { buildPlan, layoutTimes, allocate, breakRanges } from '../src/lib/planner.js';
import { timeToMinutes } from '../src/lib/dates.js';
import { DEFAULT_CONFIG } from '../src/lib/storage.js';

const con = (breaks) => ({ ...DEFAULT_CONFIG, work: { ...DEFAULT_CONFIG.work, breaks } });

// --- normalizzazione delle pause -------------------------------------------
assert.deepEqual(breakRanges(DEFAULT_CONFIG), [{ from: 780, to: 840 }], 'pranzo 13-14 di default');
assert.deepEqual(breakRanges(con([])), []);
assert.deepEqual(
  breakRanges(con([{ start: '15:00', end: '15:15' }, { start: '11:00', end: '11:15' }])),
  [{ from: 660, to: 675 }, { from: 900, to: 915 }],
  'ordinate per orario'
);
assert.deepEqual(
  breakRanges(con([{ start: '13:00', end: '14:00' }, { start: '13:30', end: '15:00' }])),
  [{ from: 780, to: 900 }],
  'le pause sovrapposte vengono fuse'
);
assert.deepEqual(breakRanges(con([{ start: '14:00', end: '13:00' }])), [], 'a rovescio: scartata');
assert.deepEqual(breakRanges(con([{ start: '', end: '14:00' }])), [], 'incompleta: scartata');

// --- spezzatura di un blocco ------------------------------------------------
function righe(minuti, config, start = '09:00') {
  const rows = [{
    kind: 'task', issueKey: 'ABC-1', enabled: true, minutes: minuti, locked: true, segments: []
  }];
  layoutTimes(rows, { ...config, work: { ...config.work, startTime: start } });
  return rows[0];
}

// blocco che non tocca la pausa: un solo segmento
assert.deepEqual(righe(120, DEFAULT_CONFIG).segments, [{ time: '09:00', minutes: 120 }]);

// blocco che ci finisce sopra: spezzato, e la somma resta quella
const spezzato = righe(420, DEFAULT_CONFIG); // 7h dalle 9:00
assert.deepEqual(spezzato.segments, [
  { time: '09:00', minutes: 240 },
  { time: '14:00', minutes: 180 }
], '4h prima di pranzo, 3h dopo');
assert.equal(spezzato.segments.reduce((s, x) => s + x.minutes, 0), 420, 'niente ore perse');
assert.equal(spezzato.time, '09:00', 'il campo time resta il primo segmento');

// blocco che parte dentro la pausa: slitta alla fine
assert.deepEqual(righe(60, DEFAULT_CONFIG, '13:30').segments, [{ time: '14:00', minutes: 60 }]);

// due pause: il blocco viene spezzato in tre
const treTronconi = righe(300, con([
  { start: '11:00', end: '11:15' },
  { start: '13:00', end: '14:00' }
]));
assert.deepEqual(treTronconi.segments, [
  { time: '09:00', minutes: 120 },
  { time: '11:15', minutes: 105 },
  { time: '14:00', minutes: 75 }
]);
assert.equal(treTronconi.segments.reduce((s, x) => s + x.minutes, 0), 300);

// --- la pausa non consuma monte ore ----------------------------------------
const jiraActivity = new Map([['ABC-1', { key: 'ABC-1', id: '1', summary: 'Task', events: [{ kind: 'changelog', at: '2026-08-11T11:00:00.000Z' }] }]]);
const config = { ...DEFAULT_CONFIG, meetings: [], work: { ...DEFAULT_CONFIG.work, startTime: '09:00' } };
const plan = buildPlan({
  isoDate: '2026-08-11', config,
  jiraActivity, gitByIssue: new Map(), recentIssues: [],
  loggedEntries: [], loggedByIssue: {}, alreadyLoggedMinutes: 0
});
const task = plan.rows.find((r) => r.kind === 'task');
assert.equal(task.minutes, 480, 'la pausa non toglie niente al monte ore');
assert.deepEqual(task.segments, [
  { time: '09:00', minutes: 240 },
  { time: '14:00', minutes: 240 }
], 'ma la giornata si allunga fino alle 18:00');
assert.equal(task.segments.reduce((s, x) => s + x.minutes, 0), 480);

// nessun segmento cade dentro la pausa
const pausa = breakRanges(config)[0];
for (const s of task.segments) {
  const da = timeToMinutes(s.time);
  assert.ok(da + s.minutes <= pausa.from || da >= pausa.to,
    `il segmento ${s.time} invade la pausa`);
}

// --- riga spenta: nessun segmento -------------------------------------------
const spente = plan.rows.map((r) => ({ ...r, enabled: false }));
allocate(spente, config, 0);
layoutTimes(spente, config);
assert.ok(spente.every((r) => !r.segments.length), 'una riga spenta non produce worklog');
assert.ok(spente.every((r) => r.minutes === 0),
  'e mostra zero ore, riunioni comprese: niente numeri su righe che non scrivono');

console.log('pause: tutti i controlli passati.');
