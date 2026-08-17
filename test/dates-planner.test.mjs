import assert from 'node:assert/strict';
import { isoWeekday, isoWeekLabel, jiraStarted, addMinutes, formatMinutes, jqlDayRange, dayBounds, isSameLocalDay } from '../src/lib/dates.js';
import { distributeMinutes, buildPlan, meetingsForDay, guessMeetingIssue } from '../src/lib/planner.js';
import { DEFAULT_CONFIG } from '../src/lib/storage.js';

// --- date ---
assert.equal(isoWeekday('2026-08-10'), 1);
assert.equal(isoWeekday('2026-08-16'), 7);
assert.equal(isoWeekLabel('2026-08-10'), '2026-W33');
assert.equal(isoWeekLabel('2026-08-16'), '2026-W33');
assert.equal(isoWeekLabel('2026-08-17'), '2026-W34');
assert.match(jiraStarted('2026-08-10', '09:30'), /^2026-08-10T09:30:00\.000[+-]\d{4}$/);
assert.equal(addMinutes('09:30', 45), '10:15');
assert.equal(addMinutes('23:50', 30), '23:59');
assert.equal(formatMinutes(90), '1h 30m');
assert.deepEqual(jqlDayRange('2026-08-31'), { from: '2026-08-31 00:00', to: '2026-09-01 00:00' });
// La ricerca delle attività chiede una settimana, non un giorno: `updated` è
// l'ultima modifica della issue, quindi un ticket ripreso in mano il giorno
// dopo uscirebbe dalla finestra del giorno in cui ci hai lavorato.
assert.deepEqual(jqlDayRange('2026-08-31', 7), { from: '2026-08-31 00:00', to: '2026-09-07 00:00' });
assert.deepEqual(jqlDayRange('2026-12-28', 7), { from: '2026-12-28 00:00', to: '2027-01-04 00:00' },
  'e scavalca il capodanno senza inventare mesi');
assert.equal(dayBounds('2026-08-10').end - dayBounds('2026-08-10').start, 86400000);
assert.ok(isSameLocalDay(new Date(2026, 7, 10, 23, 59).toISOString(), '2026-08-10'));
assert.ok(!isSameLocalDay(new Date(2026, 7, 11, 0, 1).toISOString(), '2026-08-10'));

// --- distribuzione ---
assert.deepEqual(distributeMinutes(435, 3, 15), [150, 150, 135]);
assert.deepEqual(distributeMinutes(60, 5, 15), [15, 15, 15, 15, 0]);
assert.deepEqual(distributeMinutes(480, 0, 15), []);

// --- riunioni per giorno, 30 minuti come nel calendario reale ---
assert.deepEqual(meetingsForDay(DEFAULT_CONFIG.meetings, '2026-08-10').map(m => [m.time, m.minutes]),
  [['09:30', 30], ['10:00', 30]], 'lunedi: giornaliero + standup, mezz ora ciascuno');
assert.deepEqual(meetingsForDay(DEFAULT_CONFIG.meetings, '2026-08-11').map(m => [m.time, m.minutes]),
  [['09:30', 30]], 'martedi: solo standup');
assert.deepEqual(meetingsForDay(DEFAULT_CONFIG.meetings, '2026-08-16'), []);

// --- proposta del ticket cerimonie ---
const recentIssues = [
  { key: 'ABC-2075', summary: '[BE] Implementazione modulo' },
  { key: 'ABC-1969', summary: 'Standup - Team Sprint 8' },
  { key: 'ABC-1996', summary: 'Analisi refactor' }
];
assert.equal(guessMeetingIssue('Standup di progetto', recentIssues).key, 'ABC-1969');
assert.equal(guessMeetingIssue('Giornaliero', recentIssues), null, 'senza riscontri non inventa nulla');
assert.equal(guessMeetingIssue('', recentIssues), null);

// --- il caso dello screenshot: 7h30 gia' registrate su ABC-2075 ---
const jiraActivity = new Map([
  ['ABC-2075', { key: 'ABC-2075', summary: '[BE] Implementazione modulo', events: Array(11).fill({ kind: 'changelog', at: '2026-08-10T11:00:00.000Z' }) }],
  ['ABC-1969', { key: 'ABC-1969', summary: 'Standup - Team Sprint 8', events: Array(2).fill({ kind: 'changelog', at: '2026-08-10T09:40:00.000Z' }) }]
]);

const pieno = buildPlan({
  isoDate: '2026-08-10', config: DEFAULT_CONFIG,
  jiraActivity, gitByIssue: new Map(), recentIssues,
  alreadyLoggedMinutes: 450
});
assert.equal(pieno.dayBudgetMinutes, 480);
assert.equal(pieno.budgetMinutes, 30, '8h - 7h30 gia registrate = 30 minuti da distribuire');
const taskKeys = pieno.rows.filter(r => r.kind === 'task').map(r => r.issueKey);
assert.ok(!taskKeys.includes('ABC-1969'), 'il ticket cerimonie non deve comparire anche come task');
assert.equal(pieno.rows.filter(r => r.kind === 'task' && r.minutes > 0).length, 0,
  'niente ore inventate sopra a una giornata gia piena');
assert.ok(pieno.warnings.some(w => w.key === 'planMeetingsCoverAll'), 'lo dice invece di far finta di niente');

// il ticket cerimonie e' stato proposto sulle due righe riunione
const meetingRows = pieno.rows.filter(r => r.kind === 'meeting');
assert.equal(meetingRows.length, 2);
assert.equal(meetingRows[1].issueKey, 'ABC-1969');
assert.equal(meetingRows[1].guessed, true, 'segnalato come proposta, non come certezza');

// --- giornata a meta': 4h30 gia' registrate ---
const meta = buildPlan({
  isoDate: '2026-08-10', config: DEFAULT_CONFIG,
  jiraActivity, gitByIssue: new Map(), recentIssues,
  alreadyLoggedMinutes: 270
});
assert.equal(meta.budgetMinutes, 210);
const metaTasks = meta.rows.filter(r => r.kind === 'task');
const metaMeetings = meta.rows.filter(r => r.kind === 'meeting');
// Solo le righe inviabili: una riunione senza ticket non riserva tempo.
const somma = [...metaTasks, ...metaMeetings]
  .filter((r) => r.issueKey)
  .reduce((a, r) => a + r.minutes, 0);
assert.equal(somma, 210, 'le righe inviabili coprono esattamente il tempo rimasto');
// Il lavoro riempie gli spazi liberi: la mezz'ora prima della prima riunione
// va usata, non saltata.
assert.equal(metaTasks[0].time, '09:00', 'si parte a inizio giornata, non dopo le riunioni');
// Qui il "Giornaliero" resta senza ticket, quindi non occupa nulla: la finestra
// libera arriva fino allo standup delle 10:00, ed e' un'ora piena.
assert.deepEqual(metaTasks[0].segments[0], { time: '09:00', minutes: 60 });

// --- giornata vuota, nessun worklog pregresso ---
const vuoto = buildPlan({
  isoDate: '2026-08-11', config: DEFAULT_CONFIG,
  jiraActivity: new Map(), gitByIssue: new Map(), recentIssues, alreadyLoggedMinutes: 0
});
assert.equal(vuoto.budgetMinutes, 480);
assert.ok(vuoto.warnings.some(w => w.key === 'planNoTasks'));

console.log('planner + date: tutti i controlli passati.');
