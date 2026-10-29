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
  addManualRow, applyCopy, applyLogged, confirmedGuesses, copyEntries, deleteMessage, deleteWorklogs, loadPlan,
  loggedFor, newDayState, notePending, previousWorkday, rememberMeetings, setRowIssue, setRowMinutes,
  seriesClass, submitMessages, submitRows, summary, timelineBlocks, timelineExtent, toggleAll, toggleRow
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

// --- eliminare: solo i tuoi, solo quel giorno, solo quelli scelti ------------
{
  const ME = 'acc-me';
  const worklogs = [
    { id: '1', author: { accountId: ME }, started: '2026-10-28T09:00:00.000+0100', timeSpentSeconds: 1800 },
    { id: '2', author: { accountId: ME }, started: '2026-10-28T10:00:00.000+0100', timeSpentSeconds: 10800 },
    { id: '3', author: { accountId: 'altro' }, started: '2026-10-28T10:00:00.000+0100', timeSpentSeconds: 3600 },
    { id: '4', author: { accountId: ME }, started: '2026-10-29T09:00:00.000+0100', timeSpentSeconds: 3600 }
  ];
  const cancellati = [];
  const jira = {
    async getWorklogs() { return worklogs; },
    async deleteWorklog(key, id) {
      if (id === '2' && cancellati.includes('fail')) throw new Error('Jira 403');
      cancellati.push(id);
    }
  };
  const tutti = ['1', '2', '3', '4'];
  const out = await deleteWorklogs(jira, { isoDate: '2026-10-28', issueKey: 'ABC-1', worklogIds: tutti, accountId: ME });
  assert.deepEqual(cancellati, ['1', '2'], 'mai quello di un collega, mai un altro giorno');
  assert.deepEqual(out, { deleted: 2, minutes: 210, total: 2, error: null });
  assert.equal(deleteMessage('ABC-1', out).level, 'ok');

  // Senza id non si cancella niente.
  cancellati.length = 0;
  assert.equal((await deleteWorklogs(jira, { isoDate: '2026-10-28', issueKey: 'ABC-1', worklogIds: [], accountId: ME })).deleted, 0);
  assert.deepEqual(cancellati, []);

  // A meta' strada: si dice quanto e' gia' andato.
  cancellati.length = 0;
  cancellati.push('fail');
  const meta = await deleteWorklogs(jira, { isoDate: '2026-10-28', issueKey: 'ABC-1', worklogIds: ['1', '2'], accountId: ME });
  assert.equal(meta.deleted, 1);
  assert.equal(meta.error, 'Jira 403');
  assert.equal(deleteMessage('ABC-1', meta).level, 'err');
}

// --- l'elenco dei worklog di una riga ---------------------------------------
{
  const state = newDayState('2026-10-28');
  state.loggedEntries = [
    { id: '9', key: 'ABC-1', startMinutes: 840, minutes: 60 },
    { id: '8', key: 'ABC-1', startMinutes: 540, minutes: 30 },
    { key: 'ABC-1', startMinutes: 600, minutes: 30 },
    { id: '7', key: 'ABC-2', startMinutes: 600, minutes: 30 }
  ];
  assert.deepEqual(loggedFor(state, 'ABC-1').map((e) => e.id), ['8', '9'], 'in ordine, e solo quelli con id');
}

// --- copiare un giorno --------------------------------------------------------
{
  assert.equal(previousWorkday('2026-10-26'), '2026-10-23', 'di lunedi si copia il venerdi');
  assert.equal(previousWorkday('2026-10-28'), '2026-10-27');

  const entries = copyEntries({ entries: [
    { key: 'ABC-1', summary: 'Uno', minutes: 30, comment: '' },
    { key: 'ABC-1', summary: 'Uno', minutes: 180, comment: 'fatto x' },
    { key: 'ABC-3', summary: 'Tre', minutes: 60, comment: '' }
  ] });
  assert.deepEqual(entries.map((e) => [e.key, e.minutes, e.comment]), [['ABC-1', 210, 'fatto x'], ['ABC-3', 60, '']]);

  const state = giorno({ registrate: { 'ABC-3': 60 } });
  state.rows.push({ id: 'task:ABC-3', kind: 'task', issueKey: 'ABC-3', summary: 'Tre', existingMinutes: 60, enabled: false, sources: [] });
  const msg = applyCopy(state, entries, '2026-10-27');
  assert.equal(msg.level, 'ok');
  const uno = state.rows.find((r) => r.issueKey === 'ABC-1');
  assert.equal(uno.minutes, 210, 'le ore copiate restano quelle');
  assert.equal(uno.locked, true);
  assert.equal(uno.comment, 'fatto x');
  assert.equal(state.rows.find((r) => r.issueKey === 'ABC-3').enabled, false, 'gia registrata oggi: resta spenta');
  assert.equal(applyCopy(state, [], '2026-10-20').level, 'info');
}

// --- anteprima: gli stessi segmenti che partono con l'invio -----------------
{
  const state = giorno({ registrate: { 'ABC-7': 60 }, entries: [{ key: 'ABC-7', startMinutes: 1020, minutes: 60 }] });
  const blocchi = timelineBlocks(state);
  const inviati = state.rows.filter((r) => r.enabled && r.issueKey).flatMap((r) => r.segments);
  assert.equal(blocchi.filter((b) => b.tipo === 'task' || b.tipo === 'meeting').length, inviati.length,
    'un blocco per ogni worklog che partirebbe');
  assert.ok(blocchi.some((b) => b.tipo === 'pause' && b.from === 780 && b.to === 840), 'la pausa pranzo');
  assert.ok(blocchi.some((b) => b.tipo === 'logged' && b.from === 1020), 'le ore gia registrate');
  assert.ok(blocchi.filter((b) => b.tipo === 'task').every((b) => /^s\d/.test(b.serie)), 'ogni task ha la sua tinta');

  // L'asse copre la giornata configurata, a ore intere: 9:00 + 8h + 1h di pausa.
  assert.deepEqual(timelineExtent(state, []), { da: 540, a: 1080 });
  assert.deepEqual(timelineExtent(state, [{ from: 500, to: 1130 }]), { da: 480, a: 1140 }, 'e si allarga se serve');

  // Il colore segue il ticket, non la posizione.
  const prima = seriesClass(state, 'ABC-2');
  toggleRow(state, state.rows.find((r) => r.issueKey === 'ABC-1'), false);
  assert.equal(seriesClass(state, 'ABC-2'), prima);

  // Seleziona tutto / niente.
  toggleAll(state, false);
  assert.ok(state.rows.every((r) => !r.enabled && r.userToggled));
  assert.equal(timelineBlocks(state).filter((b) => b.tipo === 'task').length, 0);
  toggleAll(state, true);
  assert.ok(state.rows.every((r) => r.enabled));
}

// --- ticket: spostare rilegge lo stato vero e l'elenco ----------------------
{
  const { findShown, moveIssue, newTicketsState, transitionsFor } = await import('../src/userscript/tickets.js');
  const chiamate = [];
  const jira = {
    async getTransitions() {
      return [
        { id: '1', name: 'Resta', to: 'In corso', category: 'indeterminate' },
        { id: '2', name: 'A test', to: 'Dev test', category: 'indeterminate' }
      ];
    },
    async transitionIssue(key, id) { chiamate.push(['move', key, id]); },
    async getIssue() { return { fields: { status: { name: 'Review' } } }; },
    async search(jql) {
      chiamate.push(['search', jql]);
      return [{ key: 'ABC-1', fields: { summary: 'Uno', status: { name: 'Review', statusCategory: { key: 'indeterminate' } },
        updated: '2026-10-29T10:00:00.000+0100' } }];
    }
  };
  const transizioni = await transitionsFor(jira, 'ABC-1', 'In corso');
  assert.deepEqual(transizioni.map((t) => t.id), ['2'], 'quella verso lo stato in cui si e gia non serve');

  const esito = await moveIssue(jira, { jira: { projects: ['ABC'] } }, 'ABC-1', '2');
  assert.deepEqual(chiamate[0], ['move', 'ABC-1', '2']);
  assert.equal(esito.reached, 'Review', 'lo stato si rilegge: un automatismo puo averlo cambiato');
  assert.equal(esito.moved, 'ABC-1');
  assert.equal(esito.total, 1);

  const state = newTicketsState();
  state.groups = esito.groups;
  assert.equal(findShown(state, 'ABC-1').summary, 'Uno');
  state.query = 'x';
  state.results = [{ key: 'ABC-5', summary: 'Cinque' }];
  assert.equal(findShown(state, 'ABC-1'), null, 'con la ricerca attiva conta quello che si vede');
  assert.equal(findShown(state, 'ABC-5').summary, 'Cinque');
}

console.log('userscript giorno: tutti i controlli passati.');
