// Una riga senza ticket non verrà scritta da nessuna parte. Quindi non deve
// né mostrare ore né prendersi una fetta della giornata: le ore sparirebbero
// dal totale senza spiegazione. Vale per le riunioni non ancora agganciate e
// per le righe aggiunte a mano, che nascono vuote.

import assert from 'node:assert/strict';
import { allocate, reflow, reservedByMeetings } from '../src/lib/planner.js';
import { DEFAULT_CONFIG } from '../src/lib/storage.js';

const config = { ...DEFAULT_CONFIG, meetings: [] };
const contesto = { dayBudgetMinutes: 480, alreadyLoggedMinutes: 0, loggedEntries: [] };

const task = (issueKey, over = {}) => ({
  kind: 'task', id: `t-${issueKey || 'vuota'}`, issueKey, enabled: true,
  existingMinutes: 0, minutes: 0, segments: [], ...over
});
const riunione = (issueKey, over = {}) => ({
  kind: 'meeting', id: `m-${issueKey || 'vuota'}`, issueKey, enabled: true,
  existingMinutes: 0, minutes: 30, defaultMinutes: 30, time: '09:30', segments: [], ...over
});

// --- una riga aggiunta a mano nasce vuota ----------------------------------
{
  const rows = [task('ABC-1'), task('')];
  reflow(rows, config, contesto);
  assert.equal(rows[0].minutes, 480, 'tutta la giornata va alla riga con il ticket');
  assert.equal(rows[1].minutes, 0, 'la riga vuota non prende ore');
  assert.deepEqual(rows[1].segments, [], 'e non occupa spazio nella giornata');

  // appena scrivi il ticket, si ridistribuisce
  rows[1].issueKey = 'ABC-2';
  reflow(rows, config, contesto);
  assert.deepEqual(rows.map((r) => r.minutes), [240, 240], 'metà per uno');
  assert.equal(rows.reduce((s, r) => s + r.minutes, 0), 480);
}

// --- riunione non ancora agganciata ----------------------------------------
{
  const rows = [riunione(''), task('ABC-1')];
  reflow(rows, config, contesto);
  assert.equal(rows[0].minutes, 0, 'senza ticket la riunione non mostra la sua durata');
  assert.equal(reservedByMeetings(rows), 0, 'e non riserva tempo');
  assert.equal(rows[1].minutes, 480, 'le 8h restano tutte al lavoro, niente si perde');

  rows[0].issueKey = 'XYZ-9';
  reflow(rows, config, contesto);
  assert.equal(rows[0].minutes, 30, 'agganciata, torna alla durata configurata');
  assert.equal(rows[1].minutes, 450, 'e il lavoro si stringe di conseguenza');
  assert.equal(rows.reduce((s, r) => s + r.minutes, 0), 480);
}

// --- il valore corretto a mano sopravvive al ticket tolto e rimesso --------
{
  const rows = [task('ABC-1', { minutes: 60, lockedMinutes: 60, locked: true }), task('ABC-2')];
  reflow(rows, config, contesto);
  assert.equal(rows[0].minutes, 60);
  assert.equal(rows[1].minutes, 420);

  rows[0].issueKey = '';
  reflow(rows, config, contesto);
  assert.equal(rows[0].minutes, 0, 'senza ticket mostra zero anche se corretta a mano');
  assert.equal(rows[1].minutes, 480, 'e le sue ore tornano in gioco');

  rows[0].issueKey = 'ABC-1';
  reflow(rows, config, contesto);
  assert.equal(rows[0].minutes, 60, 'rimesso il ticket, torna il valore che avevi scritto');
  assert.equal(rows[1].minutes, 420);
}

// --- tutte vuote: nessuna divisione per zero, nessun avviso fuori luogo ----
{
  const rows = [task(''), riunione('')];
  const warnings = [];
  allocate(rows, config, 480, warnings);
  assert.deepEqual(rows.map((r) => r.minutes), [0, 0]);
  assert.deepEqual(warnings, [], 'niente da distribuire non è un problema da segnalare');
}

console.log('righe senza ticket: tutti i controlli passati.');
