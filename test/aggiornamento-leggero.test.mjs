// Tornando sul popup si rilegge solo quello che può essere cambiato sotto: le
// ore già registrate. Qui si verifica la regola di riaccensione, che è la parte
// delicata — sbagliarla o riaccende righe che avevi spento tu, o lascia spente
// righe le cui ore non esistono più.

import assert from 'node:assert/strict';
import { buildPlan, reflow } from '../src/lib/planner.js';
import { DEFAULT_CONFIG } from '../src/lib/storage.js';

const config = { ...DEFAULT_CONFIG, meetings: [] };
const attivita = new Map([
  ['ABC-1', { key: 'ABC-1', id: '1', summary: 'Uno', events: [{ kind: 'changelog', at: '2026-08-11T11:00:00.000Z' }] }],
  ['ABC-2', { key: 'ABC-2', id: '2', summary: 'Due', events: [{ kind: 'changelog', at: '2026-08-11T11:00:00.000Z' }] }]
]);

const piano = (loggedByIssue, alreadyLoggedMinutes) => buildPlan({
  isoDate: '2026-08-11', config,
  jiraActivity: attivita, gitByIssue: new Map(), recentIssues: [],
  loggedEntries: [], loggedByIssue, alreadyLoggedMinutes
});

/** La stessa regola che applica il popup quando rilegge solo le ore. */
function aggiorna(rows, plan, loggedByIssue, alreadyLoggedMinutes, force = []) {
  const forzate = new Set(force);
  for (const row of rows) {
    row.existingMinutes = loggedByIssue[row.issueKey] || 0;
    if (forzate.has(row.issueKey)) row.userToggled = false;
    if (row.userToggled) continue;
    if (row.existingMinutes && row.enabled) {
      row.enabled = false;
      row.autoDisabled = true;
    } else if (!row.existingMinutes && row.autoDisabled) {
      row.enabled = true;
      row.autoDisabled = false;
    }
  }
  reflow(rows, config, {
    dayBudgetMinutes: plan.dayBudgetMinutes,
    alreadyLoggedMinutes,
    loggedEntries: []
  });
  return rows;
}

// --- una riga con ore già registrate parte spenta e marcata ----------------
{
  const plan = piano({ 'ABC-1': 120 }, 120);
  const rows = plan.rows.map((r) => ({ ...r }));
  const uno = rows.find((r) => r.issueKey === 'ABC-1');
  const due = rows.find((r) => r.issueKey === 'ABC-2');

  assert.equal(uno.enabled, false, 'spenta dal controllo duplicati');
  assert.equal(uno.autoDisabled, true, 'e marcata come spenta in automatico');
  assert.equal(due.enabled, true);
  assert.equal(due.autoDisabled, undefined, 'chi non ha ore non viene marcato');

  // le ore vengono cancellate da Clockwork: la riga torna disponibile
  aggiorna(rows, plan, {}, 0);
  assert.equal(uno.existingMinutes, 0);
  assert.equal(uno.enabled, true, 'sparite le ore, la riga si riaccende');
  assert.equal(uno.autoDisabled, false);
  assert.equal(rows.reduce((s, r) => s + r.minutes, 0), 480, 'e rientra nella divisione');
}

// --- una riga spenta DA TE non si riaccende da sola ------------------------
{
  const plan = piano({}, 0);
  const rows = plan.rows.map((r) => ({ ...r }));
  const uno = rows.find((r) => r.issueKey === 'ABC-1');

  uno.enabled = false;
  uno.userToggled = true;
  reflow(rows, config, { dayBudgetMinutes: 480, alreadyLoggedMinutes: 0, loggedEntries: [] });
  assert.equal(rows.find((r) => r.issueKey === 'ABC-2').minutes, 480, 'tutto all altra');

  aggiorna(rows, plan, {}, 0);
  assert.equal(uno.enabled, false, 'una scelta tua non viene ribaltata da un aggiornamento');
}

// --- una riga riaccesa DA TE non viene rispenta dal controllo duplicati ----
{
  const plan = piano({ 'ABC-1': 120 }, 120);
  const rows = plan.rows.map((r) => ({ ...r }));
  const uno = rows.find((r) => r.issueKey === 'ABC-1');

  uno.enabled = true;
  uno.userToggled = true;
  uno.autoDisabled = false;

  aggiorna(rows, plan, { 'ABC-1': 120 }, 120);
  assert.equal(uno.enabled, true, 'hai deciso di rimetterle: resta accesa');
  assert.equal(uno.existingMinutes, 120, 'ma il badge continua a dire la verità');
}

// --- ore comparse nel frattempo: la riga si spegne per non duplicare -------
{
  const plan = piano({}, 0);
  const rows = plan.rows.map((r) => ({ ...r }));
  const uno = rows.find((r) => r.issueKey === 'ABC-1');
  assert.equal(uno.enabled, true);

  // qualcuno (o tu, da Clockwork) ha registrato 2h su ABC-1
  aggiorna(rows, plan, { 'ABC-1': 120 }, 120);
  assert.equal(uno.enabled, false, 'si spegne: rimandarle sarebbe un doppione');
  assert.equal(uno.autoDisabled, true);
  assert.equal(rows.find((r) => r.issueKey === 'ABC-2').minutes, 360,
    'e il monte ore residuo scende di conseguenza: 8h - 2h');
}

// --- dopo un invio la riga scritta si spegne, anche se l avevi accesa tu ---
// È il caso che rende il percorso leggero pericoloso se fatto male: la riga che
// hai appena inviato era accesa (e `userToggled`), e restando accesa il click
// successivo su Invia scriverebbe il doppione.
{
  const plan = piano({}, 0);
  const rows = plan.rows.map((r) => ({ ...r }));
  const uno = rows.find((r) => r.issueKey === 'ABC-1');
  uno.userToggled = true; // l avevi acceso tu prima di inviare
  assert.equal(uno.enabled, true);

  // invio: ora su ABC-1 risultano 4h
  aggiorna(rows, plan, { 'ABC-1': 240 }, 240, ['ABC-1']);

  assert.equal(uno.enabled, false, 'la riga appena inviata si spegne: niente doppioni');
  assert.equal(uno.autoDisabled, true);
  assert.equal(uno.existingMinutes, 240, 'e mostra quanto ha appena scritto');
  assert.equal(uno.minutes, 0, 'zero ore da inviare');
  assert.equal(rows.find((r) => r.issueKey === 'ABC-2').minutes, 240,
    'il resto della giornata va a chi manca ancora: 8h - 4h');
}

// --- e la riga resta nel piano, con le ore visibili -------------------------
// Serve a poter disfare l invio: sparendo, il cestino sparirebbe con lei.
{
  const plan = piano({}, 0);
  const rows = plan.rows.map((r) => ({ ...r }));
  aggiorna(rows, plan, { 'ABC-1': 240 }, 240, ['ABC-1']);
  assert.equal(rows.length, 2, 'nessuna riga sparisce dopo l invio');
  assert.ok(rows.find((r) => r.issueKey === 'ABC-1').existingMinutes > 0,
    'e quella scritta si riconosce dalle ore che ha sopra');
}

// --- dopo una cancellazione la riga torna disponibile, anche se l avevi spenta
{
  const plan = piano({ 'ABC-1': 120 }, 120);
  const rows = plan.rows.map((r) => ({ ...r }));
  const uno = rows.find((r) => r.issueKey === 'ABC-1');
  uno.userToggled = true; // l avevi toccata a mano

  aggiorna(rows, plan, {}, 0, ['ABC-1']);
  assert.equal(uno.enabled, true, 'cancellate le ore, la riga torna in gioco');
  assert.equal(uno.existingMinutes, 0);
  assert.equal(rows.reduce((s, r) => s + r.minutes, 0), 480);
}

console.log('aggiornamento leggero: tutti i controlli passati.');
