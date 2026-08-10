import assert from 'node:assert/strict';
import { buildPlan, guessMeetingIssue, dateVariants } from '../src/lib/planner.js';
import { DEFAULT_CONFIG } from '../src/lib/storage.js';

// Le issue suggerite: lo standup di progetto (nome che combacia) e il
// giornaliero, che sta su un altro progetto e ha la data nel titolo.
const recentIssues = [
  { key: 'ABC-2075', summary: '[BE] Implementazione modulo' },
  { key: 'ABC-1969', summary: 'Standup - Team Sprint 8' },
  { key: 'XYZ-289', summary: 'Weekly Meet 2026-08-10' }
];
const jiraActivity = new Map([
  ['ABC-2075', { key: 'ABC-2075', id: '1', summary: '[BE] Implementazione modulo', events: [{ kind: 'changelog', at: '2026-08-10T11:00:00.000Z' }] }]
]);
const piano = (alreadyLoggedMinutes) => buildPlan({
  isoDate: '2026-08-10', config: DEFAULT_CONFIG,
  jiraActivity, gitByIssue: new Map(), recentIssues, alreadyLoggedMinutes
});
const testi = (p) => p.warnings.map((w) => w.text);

// ---------- livelli dei messaggi ----------
const normale = piano(0);
assert.equal(normale.warnings.length, 0, 'giornata sana: nessun messaggio');

const pieno = piano(480);
assert.equal(pieno.warnings.length, 1, 'un solo messaggio, non due che dicono la stessa cosa');
assert.equal(pieno.warnings[0].level, 'info', 'e informativo: non serve fare niente');
assert.match(pieno.warnings[0].text, /già registrate/);
assert.doesNotMatch(pieno.warnings[0].text, /[Rr]iunioni/,
  'la causa sono le ore gia registrate, non le riunioni');
assert.ok(pieno.rows.every((r) => r.enabled === false), 'nessuna riga attiva');

const stretto = piano(450); // restano 30 minuti, le riunioni ne vogliono 60
const riunioni = stretto.warnings.filter((w) => /riunioni/i.test(w.text));
assert.equal(riunioni.length, 1);
assert.equal(riunioni[0].level, 'info');
assert.match(riunioni[0].text, /1h/);
assert.match(riunioni[0].text, /30m/);
assert.ok(!testi(stretto).some((t) => /già registrate/.test(t)), 'non raddoppia il messaggio');

// Troppe task per il tempo residuo: questo invece richiede un intervento.
const tante = new Map();
for (let i = 1; i <= 40; i++) {
  tante.set(`ABC-90${i}`, { key: `ABC-90${i}`, id: String(i), summary: `Task ${i}`, events: [{ kind: 'changelog', at: '2026-08-10T11:00:00.000Z' }] });
}
const affollato = buildPlan({
  isoDate: '2026-08-10', config: DEFAULT_CONFIG,
  jiraActivity: tante, gitByIssue: new Map(), recentIssues, alreadyLoggedMinutes: 0
});
const troppe = affollato.warnings.find((w) => /Troppe task/.test(w.text));
assert.ok(troppe, 'segnala che non ci sta tutto');
assert.equal(troppe.level, 'action', 'qui devi intervenire tu: livello diverso');

// ---------- proposta del ticket riunione ----------
assert.deepEqual(dateVariants('2026-08-10'),
  ['2026-08-10', '2026/08/10', '10-08-2026', '10/08/2026', '10.08.2026']);

// per nome
assert.equal(guessMeetingIssue('Standup di progetto', recentIssues, { isoDate: '2026-08-10' }).key, 'ABC-1969');
// per data nel titolo, quando il nome non combacia
assert.equal(guessMeetingIssue('Giornaliero', recentIssues, { isoDate: '2026-08-10' }).key, 'XYZ-289');
// il nome batte la data: lo standup non deve farsi rubare il ticket dal giornaliero
assert.equal(guessMeetingIssue('Standup di progetto', recentIssues, { isoDate: '2026-08-10' }).score, 10);
// senza data e senza riscontri non inventa nulla
assert.equal(guessMeetingIssue('Giornaliero', recentIssues, { isoDate: '2026-08-17' }), null);
// un ticket gia' preso da un'altra riunione non viene riproposto
assert.equal(
  guessMeetingIssue('Giornaliero', recentIssues, { isoDate: '2026-08-10', taken: new Set(['XYZ-289']) }),
  null
);

// nel piano completo del lunedi le due riunioni prendono ticket diversi
const meetings = normale.rows.filter((r) => r.kind === 'meeting');
assert.equal(meetings.length, 2);
const chiavi = meetings.map((m) => m.issueKey);
assert.deepEqual(chiavi, ['XYZ-289', 'ABC-1969'], 'giornaliero -> XYZ-289, standup -> ABC-1969');
assert.equal(new Set(chiavi).size, 2, 'mai lo stesso ticket su due riunioni');
assert.ok(meetings.every((m) => m.guessed), 'entrambi segnalati come proposte');

console.log('messaggi + proposta ticket: tutti i controlli passati.');
