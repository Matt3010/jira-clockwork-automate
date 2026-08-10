import assert from 'node:assert/strict';
import { buildPlan, matchMeetingByTime } from '../src/lib/planner.js';
import { DEFAULT_CONFIG } from '../src/lib/storage.js';

// Il lunedi reale: alle 9:30 c'e' XYZ-289, alle 10:00 ABC-1969, piu il lavoro.
const loggedEntries = [
  { key: 'XYZ-289',      summary: 'Weekly Meet 2026-08-10', startMinutes: 9 * 60 + 30, minutes: 30 },
  { key: 'ABC-1969', summary: 'Standup - Team Sprint 8', startMinutes: 10 * 60, minutes: 30 },
  { key: 'ABC-2075', summary: '[BE] Implementazione modulo', startMinutes: 10 * 60 + 30, minutes: 150 },
  { key: 'ABC-2075', summary: '[BE] Implementazione modulo', startMinutes: 14 * 60, minutes: 240 }
];

// --- match diretto sull'orario ---
const g = matchMeetingByTime({ time: '09:30', minutes: 30 }, loggedEntries, {});
assert.equal(g.key, 'XYZ-289');
assert.equal(g.reason, 'orario');

// il ticket gia' assegnato a un'altra riunione non viene ripescato
assert.equal(
  matchMeetingByTime({ time: '09:30', minutes: 30 }, loggedEntries, { taken: new Set(['XYZ-289']) }).key,
  'ABC-1969',
  'senza XYZ-289 ripiega sul worklog piu vicino nella tolleranza'
);

// fuori tolleranza non si inventa niente
assert.equal(matchMeetingByTime({ time: '17:00', minutes: 30 }, loggedEntries, {}), null);

// a parita di scarto vince la durata piu simile
const dueCandidati = [
  { key: 'A', summary: 'a', startMinutes: 9 * 60, minutes: 240 },
  { key: 'B', summary: 'b', startMinutes: 9 * 60, minutes: 30 }
];
assert.equal(matchMeetingByTime({ time: '09:00', minutes: 30 }, dueCandidati, {}).key, 'B');

// --- il piano completo del lunedi ---
// i titoli suggeriti puntano tutti verso ABC-1969: senza l orario, entrambe
// le riunioni finirebbero li sopra (e' esattamente il bug visto a schermo)
const recentIssues = [
  { key: 'ABC-1969', summary: 'Standup - Team Sprint 8' },
  { key: 'ABC-2075', summary: '[BE] Implementazione modulo' }
];
const config = {
  ...DEFAULT_CONFIG,
  meetings: [
    { id: 'settimanale', label: 'Standup settimanale', days: [1], time: '09:30', minutes: 30 },
    { id: 'progetto', label: 'Standup di progetto', days: [1], time: '10:00', minutes: 30 }
  ]
};

const plan = buildPlan({
  isoDate: '2026-08-10', config,
  jiraActivity: new Map(), gitByIssue: new Map(),
  recentIssues, loggedEntries, alreadyLoggedMinutes: 450
});
const meetings = plan.rows.filter((r) => r.kind === 'meeting');
assert.equal(meetings[0].issueKey, 'XYZ-289', 'le 9:30 prendono il ticket segnato alle 9:30');
assert.equal(meetings[0].guessReason, 'orario');
assert.equal(meetings[1].issueKey, 'ABC-1969', 'le 10:00 prendono quello delle 10:00');
assert.equal(new Set(meetings.map((m) => m.issueKey)).size, 2, 'mai lo stesso ticket su due riunioni');

// controprova: senza i worklog, entrambi i nomi tirano verso ABC-1969 e solo
// il divieto di doppione evita il disastro
const senzaOrari = buildPlan({
  isoDate: '2026-08-10', config,
  jiraActivity: new Map(), gitByIssue: new Map(),
  recentIssues, loggedEntries: [], alreadyLoggedMinutes: 0
});
const m2 = senzaOrari.rows.filter((r) => r.kind === 'meeting');
assert.equal(m2[0].issueKey, 'ABC-1969');
assert.equal(m2[0].guessReason, 'nome');
assert.notEqual(m2[1].issueKey, 'ABC-1969', 'la seconda non puo riprendere lo stesso');

console.log('aggancio per orario: tutti i controlli passati.');
