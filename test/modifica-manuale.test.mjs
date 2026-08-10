// Quando correggi le ore di una riga, tutto il resto deve seguire: le altre
// righe si ridistribuiscono, gli orari si ricalcolano, e l'anteprima con loro.
// Qui si verifica la catena sui dati; il popup si limita a ridisegnare.

import assert from 'node:assert/strict';
import { buildPlan, reflow } from '../src/lib/planner.js';
import { timeToMinutes, addMinutes } from '../src/lib/dates.js';
import { DEFAULT_CONFIG } from '../src/lib/storage.js';

const config = { ...DEFAULT_CONFIG, meetings: [] };
const attivita = new Map([
  ['ABC-1', { key: 'ABC-1', id: '1', summary: 'Uno', events: [{ kind: 'changelog', at: '2026-08-11T11:00:00.000Z' }] }],
  ['ABC-2', { key: 'ABC-2', id: '2', summary: 'Due', events: [{ kind: 'changelog', at: '2026-08-11T11:00:00.000Z' }] }],
  ['ABC-3', { key: 'ABC-3', id: '3', summary: 'Tre', events: [{ kind: 'changelog', at: '2026-08-11T11:00:00.000Z' }] }]
]);

const plan = buildPlan({
  isoDate: '2026-08-11', config,
  jiraActivity: attivita, gitByIssue: new Map(), recentIssues: [],
  loggedEntries: [], loggedByIssue: {}, alreadyLoggedMinutes: 0
});

const contesto = {
  dayBudgetMinutes: plan.dayBudgetMinutes,
  alreadyLoggedMinutes: plan.alreadyLoggedMinutes,
  loggedEntries: plan.loggedEntries
};
const rows = plan.rows.map((r) => ({ ...r, locked: false }));
const task = (key) => rows.find((r) => r.issueKey === key);

// Partenza: 8h divise in tre a scatti di 15 minuti. Non fa 160 tondi: il resto
// della divisione va alle prime righe, e il totale resta esatto.
assert.deepEqual(rows.map((r) => r.minutes), [165, 165, 150]);
assert.equal(rows.reduce((s, r) => s + r.minutes, 0), 480);

/** Come il popup quando scrivi un numero nella colonna ORE. */
function correggi(key, minuti) {
  const row = task(key);
  row.minutes = minuti;
  row.lockedMinutes = minuti;
  row.locked = true;
  reflow(rows, config, contesto);
}

// --- correggo la prima riga a 1h ------------------------------------------
correggi('ABC-1', 60);

assert.equal(task('ABC-1').minutes, 60, 'la riga corretta resta come l hai messa');
assert.deepEqual(
  [task('ABC-2').minutes, task('ABC-3').minutes], [210, 210],
  'le altre si riprendono le ore rimaste: (480-60)/2'
);
assert.equal(rows.reduce((s, r) => s + r.minutes, 0), 480, 'il totale torna sempre 8h');

// --- gli orari seguono, non restano fermi ----------------------------------
assert.equal(task('ABC-1').segments[0].time, '09:00');
assert.deepEqual(task('ABC-1').segments, [{ time: '09:00', minutes: 60 }]);
assert.equal(task('ABC-2').segments[0].time, '10:00', 'la seconda parte dove finisce la prima');

// l ultimo blocco chiude comunque a fine giornata
const ultimo = task('ABC-3').segments.at(-1);
assert.equal(timeToMinutes(ultimo.time) + ultimo.minutes, 18 * 60);

// nessun blocco dentro la pausa, anche dopo la correzione
for (const row of rows) {
  for (const s of row.segments) {
    const da = timeToMinutes(s.time);
    assert.ok(da + s.minutes <= 13 * 60 || da >= 14 * 60,
      `${row.issueKey} ${s.time}–${addMinutes(s.time, s.minutes)} invade la pausa`);
  }
}

// --- una seconda correzione non azzera la prima ----------------------------
correggi('ABC-2', 120);
assert.equal(task('ABC-1').minutes, 60, 'la prima correzione resta');
assert.equal(task('ABC-2').minutes, 120);
assert.equal(task('ABC-3').minutes, 300, 'l unica libera prende tutto il resto');
assert.equal(rows.reduce((s, r) => s + r.minutes, 0), 480);

// --- spegnendo una riga corretta a mano, le sue ore tornano in gioco -------
task('ABC-2').enabled = false;
reflow(rows, config, contesto);
assert.equal(task('ABC-2').minutes, 0,
  'una riga spenta mostra zero anche se corretta a mano: non scrivera nulla');
assert.equal(task('ABC-3').minutes, 420, 'e le sue ore vanno a chi resta');

// ...ma il valore scritto a mano non e perso: riaccendendola torna
task('ABC-2').enabled = true;
reflow(rows, config, contesto);
assert.equal(task('ABC-2').minutes, 120, 'riaccesa, torna il valore che avevi messo');
assert.equal(task('ABC-3').minutes, 300);
assert.equal(rows.reduce((s, r) => s + r.minutes, 0), 480);

console.log('modifica manuale: tutti i controlli passati.');
