// Userscript, scheda Giorno: lo stato del piano e l'invio.
//
// E' la parte che scrive su Jira. Quello che deve valere sempre: si scrive
// solo quello che e' acceso, con ticket e con ore; un blocco spezzato dalla
// pausa diventa piu' worklog; un invio che sfora o duplica chiede conferma; e
// dopo l'invio le righe scritte si spengono da sole, anche se la ricerca
// worklog di Jira e' ancora indietro.

import assert from 'node:assert/strict';
import { buildPlan } from '../src/lib/planner.js';
import { DEFAULT_CONFIG } from '../src/lib/storage.js';
import {
  addManualRow, applyLogged, confirmedGuesses, loadPlan, newDayState, notePending, rememberMeetings,
  setRowIssue, setRowMinutes, submitMessages, submitRows, summary, toggleRow
} from '../src/userscript/day.js';
import { translate } from '../src/userscript/i18n.js';

// --- traduzioni: i segnaposto come li sostituisce Chrome ------------------
{
  const catalogo = {
    due: { message: '$A$ e $B$ ($$)', placeholders: { a: { content: '$1' }, b: { content: '$2' } } },
    nuda: { message: 'niente da sostituire' }
  };
  assert.equal(translate(catalogo, 'due', 'uno', 2), 'uno e 2 ($)');
  assert.equal(translate(catalogo, 'nuda'), 'niente da sostituire');
  assert.equal(translate(catalogo, 'manca'), 'manca', 'una chiave che non c e torna la chiave');
}

const config = {
  ...DEFAULT_CONFIG,
  meetings: [{ id: 'standup', label: 'Standup', days: [1, 2, 3, 4, 5], time: '09:30', minutes: 30 }],
  work: { ...DEFAULT_CONFIG.work, dailyHours: 8, roundingMinutes: 15, split: 'equal', startTime: '09:00',
    breaks: [{ id: 'p', label: 'Pranzo', start: '13:00', end: '14:00' }] },
  weeklyMeetingIssues: {}
};
const quando = (h) => new Date(2026, 9, 28, h, 0).toISOString();

function giorno({ registrate = {}, entries = [] } = {}) {
  const jiraActivity = new Map([
    ['ABC-1', { key: 'ABC-1', id: '1', summary: 'Uno', events: [{ kind: 'changelog', at: quando(10) }] }],
    ['ABC-2', { key: 'ABC-2', id: '2', summary: 'Due', events: [{ kind: 'comment', at: quando(15) }] }]
  ]);
  const recentIssues = [{ key: 'ABC-9', summary: 'Standup Sprint 9' }];
  const total = Object.values(registrate).reduce((s, m) => s + m, 0);
  const plan = buildPlan({
    isoDate: '2026-10-28', config, jiraActivity, gitByIssue: new Map(), recentIssues,
    loggedEntries: entries, loggedByIssue: registrate, alreadyLoggedMinutes: total
  });
  const day = { recentIssues, logged: { issues: [] }, notes: [] };
  const state = newDayState('2026-10-28');
  loadPlan(state, { plan, day, config: structuredClone(config) });
  return state;
}

// --- il piano caricato ------------------------------------------------------
{
  const state = giorno();
  const riunione = state.rows.find((r) => r.kind === 'meeting');
  assert.equal(riunione.issueKey, 'ABC-9', 'la riunione propone il ticket dello standup');
  assert.ok(state.messages.some((m) => m.text.includes('ABC-9')), 'e lo dice');
  assert.ok(state.rows.filter((r) => r.kind === 'task').every((r) => r.comment), 'nota tradotta, non una chiave');

  const s = summary(state);
  assert.equal(s.total, 480, 'otto ore piene');
  assert.equal(s.sendable, 3);
  assert.equal(s.needsConfirm, false);
  assert.equal(s.sendLabel, 'Invia 3 worklog');
}

// --- correzioni a mano --------------------------------------------------------
{
  const state = giorno();
  const [uno, due] = state.rows.filter((r) => r.kind === 'task');
  setRowMinutes(state, uno, 360);
  assert.equal(uno.minutes, 360);
  assert.equal(due.minutes, 90, 'le altre si ridistribuiscono attorno a quella bloccata');

  // Sforare chiede conferma.
  setRowMinutes(state, due, 240);
  const s = summary(state);
  assert.ok(s.overflow > 0);
  assert.equal(s.needsConfirm, true);
  assert.match(s.confirmLabel, /10h/);

  // Spenta, una riga non conta e non si scrive.
  toggleRow(state, due, false);
  assert.equal(summary(state).sendable, 2);
  assert.equal(due.minutes, 0);

  // Una riga aggiunta a mano senza ticket non prende ore.
  const nuova = addManualRow(state);
  assert.equal(nuova.minutes, 0);
}

// --- il ticket della riunione -------------------------------------------------
{
  const state = giorno();
  const riunione = state.rows.find((r) => r.kind === 'meeting');
  const { remember, clash } = setRowIssue(state, riunione, ' abc-1 ');
  assert.equal(riunione.issueKey, 'ABC-1');
  assert.deepEqual(remember, [riunione.memoryKey, 'ABC-1'], 'diventa la scelta della settimana');
  assert.equal(clash, true, 'ABC-1 era anche fra le task');
  assert.ok(!state.rows.some((r) => r.kind === 'task' && r.issueKey === 'ABC-1'), 'e quella riga sparisce');

  const memoria = { weeklyMeetingIssues: {} };
  assert.equal(rememberMeetings(memoria, [remember]), true);
  assert.equal(rememberMeetings(memoria, [remember]), false, 'la stessa scelta non riscrive niente');
}

// --- proposta confermata dalle ore gia' registrate -----------------------------
{
  const state = giorno({ registrate: { 'ABC-9': 30 }, entries: [{ key: 'ABC-9', startMinutes: 570, minutes: 30 }] });
  const riunione = state.rows.find((r) => r.kind === 'meeting');
  assert.equal(riunione.issueKey, 'ABC-9');
  const coppie = confirmedGuesses(state);
  assert.deepEqual(coppie, [[riunione.memoryKey, 'ABC-9']]);
  assert.equal(riunione.guessed, false);
}

// --- l'invio ----------------------------------------------------------------
{
  const state = giorno();
  const scritti = [];
  const jira = {
    async addWorklog(key, body) {
      if (key === 'ABC-1' && scritti.some((w) => w.key === 'ABC-1')) throw new Error('Jira 500');
      scritti.push({ key, ...body });
    }
  };
  const results = await submitRows(jira, { isoDate: '2026-10-28', rows: state.rows, config: state.config });

  // ABC-1 parte alle 9:00, si ferma per la riunione e per il pranzo: tre
  // worklog. Il secondo fallisce, e va detto che il primo e' gia' su Jira.
  const perChiave = (k) => scritti.filter((w) => w.key === k);
  assert.equal(perChiave('ABC-9').length, 1);
  assert.match(perChiave('ABC-9')[0].started, /^2026-10-28T09:30:00\.000[+-]\d{4}$/);
  assert.ok(scritti.every((w) => w.timeSpentSeconds > 0));
  const fallito = results.find((r) => !r.ok);
  assert.ok(fallito, 'il secondo blocco di una riga spezzata puo fallire');
  assert.equal(fallito.written, 1);
  assert.match(fallito.error, /già stati scritti/);

  const messaggi = submitMessages(results);
  assert.equal(messaggi[0].level, 'ok');
  assert.ok(messaggi.some((m) => m.level === 'err'));

  // Dopo l'invio Jira e' indietro: la rilettura non vede ancora niente.
  notePending(state, results);
  applyLogged(state, { total: 0, byIssue: {}, entries: [] }, results.filter((r) => r.ok).map((r) => r.issueKey));
  for (const r of results.filter((x) => x.ok)) {
    const row = state.rows.find((x) => x.issueKey === r.issueKey);
    assert.equal(row.enabled, false, `${r.issueKey} scritta: spenta anche se Jira non la riporta ancora`);
    assert.equal(row.existingMinutes, r.minutes);
  }
  assert.ok(state.alreadyLoggedMinutes > 0, 'il monte ore tiene conto di quello appena scritto');

  // Quando Jira la riporta, il minimo si scorda.
  const ok = results.filter((r) => r.ok);
  applyLogged(state, {
    total: ok.reduce((s, r) => s + r.minutes, 0),
    byIssue: Object.fromEntries(ok.map((r) => [r.issueKey, r.minutes])),
    entries: []
  });
  assert.deepEqual(state.pending.perIssue, {});
}

// --- la nota non parte se l'hai spenta ----------------------------------------
{
  const state = giorno();
  const corpi = [];
  await submitRows({ async addWorklog(key, body) { corpi.push(body); } }, {
    isoDate: '2026-10-28', rows: state.rows, config: { ...state.config, work: { ...state.config.work, sendComments: false } }
  });
  assert.ok(corpi.every((b) => b.comment === undefined));
}

console.log('userscript giorno: tutti i controlli passati.');
