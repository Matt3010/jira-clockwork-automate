// Userscript, passo 1: il canale dalla pagina e la verifica sui giorni passati.
//
// La verifica e' lo strumento con cui si giudica il resto: se dice "giusto" a
// un ticket che manca, o conta le riunioni due volte, ogni correzione fatta
// guardandola e' una correzione alla cieca. Va tenuta ferma lei per prima.

import assert from 'node:assert/strict';
import { PageChannel } from '../src/userscript/channel.js';
import { daysBefore, planFromDay } from '../src/userscript/analysis.js';
import { compareDay, lastWorkingDays } from '../src/userscript/verify.js';
import { DEFAULT_CONFIG } from '../src/lib/storage.js';

// --- il canale: stessa forma del Channel dell'estensione ------------------
{
  const chiamate = [];
  const canale = new PageChannel({
    base: 'https://esempio.atlassian.net',
    fetchImpl: async (url, init) => {
      chiamate.push({ url, init });
      return { status: 201, text: async () => '{"ok":true}', headers: { get: () => 'application/json' } };
    }
  });
  const r = await canale.request('/rest/api/3/issue/ABC-1/worklog', { method: 'POST', body: { a: 1 } });
  assert.deepEqual(r, { status: 201, text: '{"ok":true}', contentType: 'application/json' });
  assert.equal(chiamate[0].url, 'https://esempio.atlassian.net/rest/api/3/issue/ABC-1/worklog');
  assert.equal(chiamate[0].init.body, '{"a":1}', 'il corpo parte in JSON');
  assert.equal(chiamate[0].init.headers['Content-Type'], 'application/json');
  assert.equal(chiamate[0].init.credentials, 'include', 'usa il login della pagina');
  assert.equal(canale.host, 'esempio.atlassian.net');

  // Una rete che cade non solleva: status 0, come l'estensione.
  const giu = new PageChannel({ base: 'https://x.atlassian.net', fetchImpl: async () => { throw new Error('offline'); } });
  assert.deepEqual(await giu.request('/rest/api/3/myself'), { status: 0, text: 'offline', contentType: '' });
}

// --- i giorni da verificare ----------------------------------------------
{
  // Giovedi' 29 ottobre 2026: si parte dal giorno prima e si saltano i weekend.
  assert.deepEqual(lastWorkingDays(5, '2026-10-29'),
    ['2026-10-28', '2026-10-27', '2026-10-26', '2026-10-23', '2026-10-22']);
  // Di lunedi' il primo giorno e' il venerdi'.
  assert.deepEqual(lastWorkingDays(1, '2026-10-26'), ['2026-10-23']);
  assert.equal(daysBefore('2026-03-02', 2), '2026-02-28', 'attraversa i mesi');
}

// --- il confronto ---------------------------------------------------------
const quando = (h) => new Date(2026, 9, 28, h, 0).toISOString();
const giorno = ({ attivita = {}, git = new Map(), altrui = new Map(), registrate = {} } = {}) => ({
  isoDate: '2026-10-28',
  jiraActivity: new Map(Object.entries(attivita).map(([key, events]) => [key, { key, id: key, summary: `T ${key}`, events }])),
  gitByIssue: git,
  foreignGitByIssue: altrui,
  summaries: {},
  estimates: {},
  recentIssues: [],
  logged: {
    byIssue: registrate,
    total: Object.values(registrate).reduce((s, m) => s + m, 0),
    entries: Object.entries(registrate).map(([key, minutes]) => ({ key, summary: `T ${key}`, startMinutes: 600, minutes })),
    issues: Object.keys(registrate).map((key) => ({ key, summary: `T ${key}` }))
  }
});
const config = { ...DEFAULT_CONFIG, meetings: [], work: { ...DEFAULT_CONFIG.work, breaks: [], dailyHours: 8 } };

{
  // Due ticket con attivita', registrati 6h e 2h; piu' uno registrato senza
  // nessuna traccia, e uno toccato solo da un collega.
  const day = giorno({
    attivita: {
      'ABC-1': [{ kind: 'changelog', at: quando(10) }],
      'ABC-2': [{ kind: 'comment', at: quando(15) }],
      'ABC-4': [{ kind: 'foreign', at: quando(11), by: 'Collega' }]
    },
    registrate: { 'ABC-1': 360, 'ABC-2': 60, 'ABC-3': 60, 'ABC-4': 0 }
  });
  delete day.logged.byIssue['ABC-4'];

  // Il piano "come se vuoto" non vede i worklog: niente righe spente per
  // duplicato, niente monte ore gia' consumato.
  const plan = planFromDay(day, config, { asIfEmpty: true });
  assert.ok(plan.rows.every((r) => r.enabled), 'nessuna riga spenta dal controllo duplicati');
  assert.equal(plan.rows.reduce((s, r) => s + r.minutes, 0), 480, 'distribuisce la giornata intera');

  const esito = compareDay(day, plan);
  const per = Object.fromEntries(esito.rows.map((r) => [r.key, r]));
  assert.equal(per['ABC-1'].status, 'hours', '6h registrate contro 4h di piano');
  assert.equal(per['ABC-2'].status, 'hours');
  assert.equal(per['ABC-3'].status, 'missing');
  assert.equal(per['ABC-3'].reason, 'noTrace', 'nessuna attivita, nessun commit: non si poteva trovare');
  assert.equal(per['ABC-4'], undefined, 'non registrato e non nel piano: non compare');
  assert.equal(esito.loggedTotal, 480);
  assert.equal(esito.plannedTotal, 480);
  assert.equal(esito.loggedTickets, 3);
  assert.equal(esito.matchedTickets, 2);
  // Sovrapposizione: min(360,240) + min(60,240) = 300.
  assert.equal(esito.overlapMinutes, 300);
  // Prima quello che non torna.
  assert.equal(esito.rows[0].key, 'ABC-3');
}

{
  // Il ticket registrato e' stato toccato solo da un collega: il motivo deve
  // dirlo, perche' e' una scelta del planner e non un buco della ricerca.
  const day = giorno({
    attivita: {
      'ABC-1': [{ kind: 'changelog', at: quando(10) }],
      'ABC-9': [{ kind: 'foreign', at: quando(11), by: 'Collega' }]
    },
    registrate: { 'ABC-1': 240, 'ABC-9': 240 }
  });
  const esito = compareDay(day, planFromDay(day, config, { asIfEmpty: true }));
  const per = Object.fromEntries(esito.rows.map((r) => [r.key, r]));
  assert.equal(per['ABC-9'].status, 'missing');
  assert.equal(per['ABC-9'].reason, 'onlyOthers');
  assert.equal(per['ABC-1'].status, 'hours', 'si prende tutta la giornata, 8h contro 4h');
}

{
  // Il piano trova un ticket che non hai registrato: "in piu'".
  const day = giorno({
    attivita: { 'ABC-1': [{ kind: 'changelog', at: quando(10) }], 'ABC-5': [{ kind: 'changelog', at: quando(16) }] },
    registrate: { 'ABC-1': 480 }
  });
  const esito = compareDay(day, planFromDay(day, config, { asIfEmpty: true }));
  assert.equal(esito.rows.find((r) => r.key === 'ABC-5').status, 'extra');
}

// --- il changelog lungo: il giorno puo' stare a meta' -----------------------
{
  // 250 modifiche, una all'ora a partire dal 20 ottobre; la search ne porta le
  // 40 piu' recenti. Il 21 ottobre sta fra la 24esima e la 48esima: ne' nella
  // search ne' nelle "ultime 50" di prima.
  const { JiraClient, collectJiraActivity } = await import('../src/lib/jira.js');
  const ME = 'acc-me';
  const storia = Array.from({ length: 250 }, (_, i) => ({
    id: String(i),
    created: new Date(2026, 9, 20, i, 30).toISOString(),
    author: { accountId: ME },
    items: [{ field: 'status' }]
  }));
  const pagine = [];
  const canale = {
    request: async (path, init) => {
      if (path.startsWith('/rest/api/3/search/jql')) {
        const issue = {
          key: 'ABC-7', id: '7', fields: { summary: 'Lunga' },
          changelog: { startAt: 0, maxResults: 40, total: storia.length, histories: storia.slice(-40).reverse() }
        };
        return { status: 200, text: JSON.stringify({ issues: [issue] }) };
      }
      const url = new URL(`https://x.atlassian.net${path}`);
      if (url.pathname.endsWith('/comment')) return { status: 200, text: '{"comments":[]}' };
      const startAt = Number(url.searchParams.get('startAt'));
      const max = Number(url.searchParams.get('maxResults'));
      pagine.push(startAt);
      return { status: 200, text: JSON.stringify({ values: storia.slice(startAt, startAt + max), total: storia.length }) };
    }
  };
  const attivita = await collectJiraActivity(new JiraClient(canale), {
    isoDate: '2026-10-21', projects: ['ABC'], accountId: ME, displayName: 'Me', scanComments: false
  });
  assert.equal(attivita.get('ABC-7')?.events.length, 24, 'tutte le 24 modifiche del 21 ottobre');
  // Si risale dalla fine e ci si ferma appena la pagina comincia prima del giorno.
  assert.deepEqual(pagine, [150, 50, 0]);

  // Se la search arriva gia' a prima del giorno, niente chiamate in piu'.
  pagine.length = 0;
  await collectJiraActivity(new JiraClient(canale), {
    isoDate: '2026-10-30', projects: ['ABC'], accountId: ME, displayName: 'Me', scanComments: false
  });
  assert.deepEqual(pagine, [], 'il giorno e dentro le 40 della search');
}

// --- le impostazioni dal modulo -------------------------------------------
{
  const { applySettingsForm, exportSettingsFile } = await import('../src/userscript/settings.js');
  const { importData } = await import('../src/lib/storage.js');
  const prima = { ...DEFAULT_CONFIG, weeklyMeetingIssues: { '2026-W44|Standup': 'ABC-9' } };
  const modulo = {
    projects: ' abc , xyz,, ', scanComments: false, countMerges: true, devCandidates: '-3', authors: 'm.r, ',
    dailyHours: '7.5', roundingMinutes: '', startTime: '08:30', split: 'boh', sendComments: true,
    breaks: [{ id: 'p', label: '', start: '13:00', end: '14:00' }],
    meetings: [
      { id: 'a', label: 'Daily', days: [1, 2], start: '09:30', end: '09:45' },
      { id: 'b', label: 'Sospesa', days: [], start: '10:00', end: '09:00' }
    ]
  };
  const { config: dopo, invalid } = applySettingsForm(prima, modulo);
  assert.deepEqual(invalid, [], 'una riunione senza giorni si scarta, non blocca il salvataggio');
  assert.deepEqual(dopo.jira.projects, ['ABC', 'XYZ']);
  assert.equal(dopo.jira.devCandidates, 0, 'mai sotto zero');
  assert.deepEqual(dopo.identity.extraAuthors, ['m.r']);
  assert.equal(dopo.work.dailyHours, 7.5);
  assert.equal(dopo.work.roundingMinutes, 15, 'vuoto torna al default');
  assert.equal(dopo.work.split, 'equal', 'un valore sconosciuto vale parti uguali');
  assert.deepEqual(dopo.work.breaks, [{ id: 'p', label: 'Pausa', start: '13:00', end: '14:00' }]);
  assert.deepEqual(dopo.meetings, [{ id: 'a', label: 'Daily', days: [1, 2], time: '09:30', minutes: 15 }],
    'da/a diventa orario + durata');
  assert.deepEqual(dopo.weeklyMeetingIssues, prima.weeklyMeetingIssues, 'la memoria delle riunioni resta');

  // La fine prima dell'inizio blocca, e dice dove.
  const rotto = applySettingsForm(prima, { ...modulo, breaks: [{ id: 'p', label: 'Pranzo', start: '14:00', end: '13:00' }] });
  assert.deepEqual(rotto.invalid, ['Pranzo']);

  // Il file esportato si reimporta: e' lo stesso formato dell'estensione.
  const file = exportSettingsFile(dopo);
  assert.match(file.name, /^clockwork-autofill-\d{4}-\d{2}-\d{2}\.json$/);
  const riletto = importData(JSON.parse(file.text));
  assert.deepEqual(riletto.config.meetings, dopo.meetings);
  assert.deepEqual(riletto.meetingMemory, prima.weeklyMeetingIssues);
}

// --- un file che non e' nostro si rifiuta, con un motivo -----------------------
{
  const { importData, ImportError } = await import('../src/lib/storage.js');
  const rifiuto = (dati) => { try { importData(dati); return null; } catch (e) { return e instanceof ImportError ? e.code : 'ALTRO'; } };
  assert.equal(rifiuto({ foo: 1 }), 'NOT_OURS', 'un JSON qualunque non svuota la configurazione');
  assert.equal(rifiuto({ app: 'clockwork-autofill', version: 99, config: {} }), 'TOO_NEW');
  assert.equal(rifiuto({ app: 'clockwork-autofill', version: 1, config: 'rotto' }), 'BROKEN');
  // L'identita' non entra nemmeno se qualcuno ce la mette a mano.
  const letto = importData({ app: 'clockwork-autofill', version: 1, config: { cache: { accountId: 'x' }, work: { dailyHours: 6 } } });
  assert.equal(letto.config.cache, undefined);
  assert.equal(letto.config.work.dailyHours, 6);
}

console.log('userscript verifica: tutti i controlli passati.');
