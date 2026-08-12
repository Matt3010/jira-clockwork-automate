// Le due aggiunte: il badge con le ore mancanti e la copia da un altro giorno.
// Quello che conta è che copiare non scavalchi le protezioni già in piedi.

import assert from 'node:assert/strict';
import { shortMinutes, toIsoDate, localDateTime } from '../src/lib/dates.js';
import { textFromAdf } from '../src/lib/jira.js';
import { reflow } from '../src/lib/planner.js';
import { DEFAULT_CONFIG } from '../src/lib/storage.js';

// ---------------------------------------------------------------- badge
// Il badge tiene quattro caratteri: il formato dev'essere compatto e leggibile.
assert.equal(shortMinutes(480), '8h');
assert.equal(shortMinutes(450), '7h30');
assert.equal(shortMinutes(60), '1h');
assert.equal(shortMinutes(45), '45m');
assert.equal(shortMinutes(5), '5m');
assert.equal(shortMinutes(605), '10h05', 'i minuti tengono lo zero, o 10h5 si legge male');
for (const m of [5, 45, 60, 450, 480, 605, 1439]) {
  assert.ok(shortMinutes(m).length <= 5, `"${shortMinutes(m)}" non sta nel badge`);
}

// ---------------------------------------------------------------- note copiate
// La nota di un worklog torna da Jira in Atlassian Document Format.
assert.equal(textFromAdf(null), '');
assert.equal(textFromAdf('già testo'), 'già testo');
assert.equal(
  textFromAdf({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Avanzamento' }] }] }),
  'Avanzamento'
);
assert.equal(
  textFromAdf({
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Prima' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Seconda' }] }
    ]
  }),
  'Prima\nSeconda',
  'i paragrafi tornano come righe: la nota è la lista dei commit, uno per riga'
);

// ---------------------------------------------------------------- giorno da cui copiare
/** Come il popup sceglie il giorno proposto: l'ultimo lavorativo. */
function previousWorkday(isoDate) {
  const date = localDateTime(isoDate);
  do {
    date.setDate(date.getDate() - 1);
  } while (date.getDay() === 0 || date.getDay() === 6);
  return toIsoDate(date);
}

assert.equal(previousWorkday('2026-08-11'), '2026-08-10', 'martedì -> lunedì');
assert.equal(previousWorkday('2026-08-10'), '2026-08-07', 'lunedì -> venerdì, non domenica');
assert.equal(previousWorkday('2026-08-09'), '2026-08-07', 'domenica -> venerdì');
assert.equal(previousWorkday('2026-08-08'), '2026-08-07', 'sabato -> venerdì');

// ---------------------------------------------------------------- copia nel piano
const config = { ...DEFAULT_CONFIG, meetings: [] };
const contesto = { dayBudgetMinutes: 480, alreadyLoggedMinutes: 0, loggedEntries: [] };

/** Come il popup applica le righe copiate. */
function applica(rows, entries) {
  for (const entry of entries) {
    const esistente = rows.find((r) => r.issueKey === entry.key);
    const riga = esistente || {
      kind: 'task', id: `copia:${entry.key}`, issueKey: entry.key, summary: entry.summary,
      existingMinutes: 0, enabled: true, segments: []
    };
    riga.minutes = entry.minutes;
    riga.lockedMinutes = entry.minutes;
    riga.locked = true;
    if (entry.comment) riga.comment = entry.comment;
    if (!riga.existingMinutes) riga.enabled = true;
    if (!esistente) rows.push(riga);
  }
  reflow(rows, config, contesto);
  return rows;
}

// --- le ore copiate restano quelle, non vengono ridistribuite --------------
{
  const rows = [];
  applica(rows, [
    { key: 'ABC-1', summary: 'Uno', minutes: 300, comment: 'Avanzamento' },
    { key: 'ABC-2', summary: 'Due', minutes: 120, comment: '' }
  ]);
  assert.deepEqual(rows.map((r) => r.minutes), [300, 120], 'le ore arrivano come erano');
  assert.equal(rows.reduce((s, r) => s + r.minutes, 0), 420,
    'e il totale resta quello del giorno copiato, anche se non fa 8h');
  assert.equal(rows[0].comment, 'Avanzamento', 'la nota viene con loro');
  assert.ok(rows.every((r) => r.locked), 'bloccate: sono una scelta, non una stima');
}

// --- una issue già nel piano viene aggiornata, non duplicata --------------
{
  const rows = [{
    kind: 'task', id: 'task:ABC-1', issueKey: 'ABC-1', summary: 'Uno',
    existingMinutes: 0, enabled: true, minutes: 480, segments: []
  }];
  applica(rows, [{ key: 'ABC-1', summary: 'Uno', minutes: 120, comment: '' }]);
  assert.equal(rows.length, 1, 'nessuna riga doppia per la stessa issue');
  assert.equal(rows[0].minutes, 120, 'vince il valore copiato');
}

// --- la protezione dai duplicati vale anche per la copia ------------------
{
  const rows = [{
    kind: 'task', id: 'task:ABC-1', issueKey: 'ABC-1', summary: 'Uno',
    existingMinutes: 180, enabled: false, autoDisabled: true, minutes: 0, segments: []
  }];
  applica(rows, [{ key: 'ABC-1', summary: 'Uno', minutes: 300, comment: '' }]);
  assert.equal(rows[0].enabled, false,
    'una issue che oggi ha già ore resta spenta: copiare non deve creare doppioni');
  assert.equal(rows[0].minutes, 0, 'e non mostra ore che non scriverà');
}

console.log('copia + badge: tutti i controlli passati.');
