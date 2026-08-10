import assert from 'node:assert/strict';
import { buildPlan } from '../src/lib/planner.js';
import { DEFAULT_CONFIG } from '../src/lib/storage.js';

// Scenario reale: XYZ-289 sta su un progetto diverso da quello configurato, ma su
// di lui hai gia registrato 30m oggi. Arriva in testa ai suggerimenti proprio
// per questo, e deve bastare a farlo proporre come "Giornaliero".
const giaLoggate = [{ key: 'XYZ-289', summary: 'Weekly Meet 2026-08-10' }];
const altreRecenti = [
  { key: 'ABC-2075', summary: '[BE] Implementazione modulo' },
  { key: 'ABC-1969', summary: 'Standup - Team Sprint 8' }
];
const recentIssues = [...giaLoggate, ...altreRecenti];

// XYZ-289 compare anche come attivita Jira del giorno: e' il caso dello screenshot
const jiraActivity = new Map([
  ['ABC-2075', { key: 'ABC-2075', id: '1', summary: '[BE] Implementazione modulo', events: [{ kind: 'changelog', at: '2026-08-10T11:00:00.000Z' }] }],
  ['XYZ-289', { key: 'XYZ-289', id: '2', summary: 'Weekly Meet 2026-08-10', events: [{ kind: 'changelog', at: '2026-08-10T09:35:00.000Z' }] }]
]);

const plan = buildPlan({
  isoDate: '2026-08-10', config: DEFAULT_CONFIG,
  jiraActivity, gitByIssue: new Map(), recentIssues, alreadyLoggedMinutes: 0
});

const meetings = plan.rows.filter((r) => r.kind === 'meeting');
const tasks = plan.rows.filter((r) => r.kind === 'task');

assert.equal(meetings[0].label, 'Giornaliero');
assert.equal(meetings[0].issueKey, 'XYZ-289', 'il giornaliero viene agganciato a XYZ-289 grazie alla data nel titolo');
assert.equal(meetings[1].issueKey, 'ABC-1969', 'lo standup resta sul suo ticket');

// ...e sparisce la riga doppia: XYZ-289 non deve stare anche fra le task
assert.ok(!tasks.some((t) => t.issueKey === 'XYZ-289'),
  'una volta agganciato alla riunione, XYZ-289 non compare piu come task');
assert.deepEqual(tasks.map((t) => t.issueKey), ['ABC-2075']);

// nessun messaggio "riunione senza ticket": entrambe ce l'hanno
assert.ok(meetings.every((m) => m.issueKey), 'nessuna riunione resta senza ticket');

// controprova: senza XYZ-289 fra i suggerimenti, il giornaliero resta vuoto
const senza = buildPlan({
  isoDate: '2026-08-10', config: DEFAULT_CONFIG,
  jiraActivity, gitByIssue: new Map(), recentIssues: altreRecenti, alreadyLoggedMinutes: 0
});
const senzaMeetings = senza.rows.filter((r) => r.kind === 'meeting');
assert.equal(senzaMeetings[0].issueKey, '', 'senza suggerimento utile non inventa un ticket');
assert.ok(senza.rows.some((r) => r.kind === 'task' && r.issueKey === 'XYZ-289'),
  'e allora XYZ-289 resta fra le task: e esattamente il doppione che si vedeva');

console.log('aggancio ticket riunione: tutti i controlli passati.');
