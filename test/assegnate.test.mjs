// Le issue tue che ha mosso qualcun altro.
//
// Un collega ti assegna un ticket alle 17:00: è una cosa che ti riguarda e la
// vuoi vedere, ma non è lavoro tuo. Le due metà di questa frase tirano in
// direzioni opposte — la riga deve esserci, e non deve prendersi le ore della
// giornata — ed è quello che si verifica qui.

import assert from 'node:assert/strict';
import { buildPlan } from '../src/lib/planner.js';
import { logLine } from '../src/lib/registro.js';
import { DEFAULT_CONFIG } from '../src/lib/storage.js';

const config = { ...DEFAULT_CONFIG, dayStart: '09:00', dayEnd: '18:00' };
const quando = (h) => new Date(2026, 7, 10, h, 0).toISOString();

const piano = (jiraActivity, gitByIssue = new Map()) => buildPlan({
  isoDate: '2026-08-10',
  config,
  jiraActivity,
  gitByIssue,
  recentIssues: [],
  loggedEntries: [],
  alreadyLoggedMinutes: 0
});

// --- la riga c'è, ma parte spenta ------------------------------------------
{
  const attivita = new Map([
    ['ABC-1', {
      key: 'ABC-1',
      summary: 'Assegnata a me',
      events: [{
        kind: 'foreign', at: quando(17), by: 'Dario Decarlo', assignsYou: true,
        items: [{ field: 'assignee', from: '', to: 'Matteo Scanferla' }]
      }]
    }]
  ]);

  const riga = piano(attivita).rows.find((r) => r.issueKey === 'ABC-1');
  assert.ok(riga, 'la issue deve comparire: è tua');
  assert.equal(riga.enabled, false,
    'ma farsi assegnare un ticket non è averci lavorato: le ore non ci finiscono da sole');
  assert.equal(riga.weight, 0, 'e a peso zero non si prende mai il resto della divisione');
  assert.deepEqual(riga.sources, ['foreign'],
    'niente marchio "jira": quello vuol dire che ci hai lavorato');
  assert.equal(riga.activity.foreign, 1);
  assert.equal(riga.activity.changes, 0,
    'contarla fra le modifiche direbbe "1 modifica" di una giornata in cui non hai toccato niente');
  // Perché la riga è lì, e per mano di chi: lo dice `others`, persona per
  // persona. Prima c'erano due campi in più che dicevano solo del primo, e
  // con due colleghi il secondo spariva.
  assert.equal(riga.others.length, 1, 'una persona sola ci ha messo mano');
  assert.deepEqual(
    [riga.others[0].name, riga.others[0].assigned, riga.others[0].changes],
    ['Dario Decarlo', true, 1]
  );
  assert.equal(riga.others[0].assignedAt, Date.parse(quando(17)), 'con l ora dell assegnazione');
}

// --- una riga spenta non toglie ore alle altre -----------------------------
// È la metà che conta: se entrasse nella divisione, la giornata verrebbe
// spalmata anche su un ticket che non hai aperto nemmeno una volta.
{
  const attivita = new Map([
    ['ABC-1', {
      key: 'ABC-1', summary: 'Lavorata da me',
      events: [{ kind: 'changelog', at: quando(11), by: '', items: [{ field: 'status', from: 'To Do', to: 'In Progress' }] }]
    }],
    ['ABC-2', {
      key: 'ABC-2', summary: 'Assegnata e basta',
      events: [{ kind: 'foreign', at: quando(17), by: 'Dario Decarlo', assignsYou: true, items: [{ field: 'assignee', from: '', to: 'Matteo Scanferla' }] }]
    }]
  ]);

  const rows = piano(attivita).rows;
  const lavorata = rows.find((r) => r.issueKey === 'ABC-1');
  const assegnata = rows.find((r) => r.issueKey === 'ABC-2');

  assert.equal(assegnata.minutes, 0, 'la riga spenta non porta via minuti');
  assert.ok(lavorata.minutes > 0, 'e quella su cui hai lavorato prende tutto');
  assert.ok(rows.indexOf(lavorata) < rows.indexOf(assegnata),
    'in cima il lavoro vero: a peso zero l assegnata finisce in fondo');
}

// --- se ci hai lavorato anche tu, resta una riga normale -------------------
// L'assegnazione altrui non deve spegnere una issue su cui hai commit o
// modifiche: lì il ticket è tuo in tutti i sensi.
{
  const attivita = new Map([
    ['ABC-1', {
      key: 'ABC-1', summary: 'Assegnata e poi lavorata',
      events: [
        { kind: 'foreign', at: quando(9), by: 'Dario Decarlo', assignsYou: true, items: [{ field: 'assignee', from: '', to: 'Matteo Scanferla' }] },
        { kind: 'changelog', at: quando(14), by: '', items: [{ field: 'status', from: 'To Do', to: 'In Progress' }] }
      ]
    }]
  ]);

  const riga = piano(attivita).rows.find((r) => r.issueKey === 'ABC-1');
  assert.equal(riga.enabled, true, 'ci hai messo mano: la riga vale come le altre');
  assert.deepEqual(riga.sources, ['jira']);
  assert.equal(riga.activity.changes, 1, 'una modifica tua, non due');
  assert.equal(riga.activity.foreign, 1, 'quella del collega resta contata a parte');
  assert.deepEqual(riga.others.map((chi) => chi.assigned), [true],
    'l assegnazione resta scritta accanto a chi l ha fatta');
}

// --- lo stesso vale con i commit -------------------------------------------
{
  const attivita = new Map([
    ['ABC-1', {
      key: 'ABC-1', summary: 'Assegnata, e ci sono commit',
      events: [{ kind: 'foreign', at: quando(9), by: 'Dario Decarlo', assignsYou: true, items: [{ field: 'assignee', from: '', to: 'Matteo' }] }]
    }]
  ]);
  const commit = new Map([['ABC-1', [{ subject: 'fix: qualcosa', at: quando(15) }]]]);

  const riga = piano(attivita, commit).rows.find((r) => r.issueKey === 'ABC-1');
  assert.equal(riga.enabled, true, 'il codice scritto è la prova che ci hai lavorato');
  assert.deepEqual(riga.sources, ['git']);
}

// --- nel registro la modifica altrui porta il nome di chi l'ha fatta -------
// Il registro finisce incollato nel daily, dove chi legge dà per scontato che
// parli di te: senza il nome, il lavoro di un collega diventa tuo per
// distrazione.
{
  const riga = logLine({
    at: Date.parse(quando(17)), key: 'ABC-1', tipo: 'status',
    from: 'To Do', to: 'In Progress', by: 'Dario Decarlo'
  });
  // Senza `chrome` la traduzione resta la chiave: si verifica che la riga
  // porti il pezzo "da chi", il testo lo verifica la suite delle traduzioni.
  assert.match(riga, /\(logBy\)/, 'senza il nome se lo intesta chi incolla');

  const tua = logLine({
    at: Date.parse(quando(11)), key: 'ABC-2', tipo: 'status', from: 'To Do', to: 'In Progress'
  });
  assert.doesNotMatch(tua, /\(/, 'sulle tue non si aggiunge niente: sono già tue');
}

// --- chi altro ci ha messo mano, riga per riga -----------------------------
// La domanda è «in quali delle mie task ha lavorato qualcun altro», e vale
// anche — soprattutto — dove hai lavorato pure tu: lì prima non si vedeva
// niente, e i commit dei colleghi finivano contati in un avviso in cima,
// staccati dalla task a cui appartengono.
{
  const attivita = new Map([
    ['ABC-1', {
      key: 'ABC-1', summary: 'Nostra',
      events: [
        { kind: 'changelog', at: quando(11), by: '', items: [{ field: 'status', from: 'To Do', to: 'In Progress' }] },
        { kind: 'foreign', at: quando(12), by: 'Dario Decarlo', items: [{ field: 'status', from: 'In Progress', to: 'In Review' }] },
        { kind: 'foreignComment', at: quando(13), by: 'Anna Bianchi', items: 'commento' }
      ]
    }]
  ]);
  const miei = new Map([['ABC-1', [{ subject: 'fix: mio', at: quando(15) }]]]);
  const altrui = new Map([['ABC-1', [
    { author: 'Dario Decarlo', subject: 'feat: suo', at: quando(16), url: 'https://git/uno' },
    { author: 'Dario Decarlo', subject: 'fix: suo', at: quando(17), url: 'https://git/due' }
  ]]]);

  const riga = buildPlan({
    isoDate: '2026-08-10',
    config,
    jiraActivity: attivita,
    gitByIssue: miei,
    foreignGitByIssue: altrui,
    recentIssues: [],
    loggedEntries: [],
    alreadyLoggedMinutes: 0
  }).rows.find((r) => r.issueKey === 'ABC-1');

  assert.equal(riga.enabled, true, 'è lavoro tuo: resta una riga normale');
  assert.deepEqual(riga.others.map((chi) => chi.name), ['Anna Bianchi', 'Dario Decarlo'],
    'in ordine di nome');
  assert.deepEqual(riga.others.map((chi) => [chi.changes, chi.commits]), [[1, 0], [1, 2]],
    'ognuno con quello che ha fatto');
  // Gli indirizzi arrivano fin qui, o da «2 commit» non si va da nessuna
  // parte: il pannello li dà, buttarli via costava un link.
  assert.deepEqual(riga.others[1].commitUrls, ['https://git/uno', 'https://git/due']);
  // E quando: senza un orario «2 commit» non si colloca nella giornata.
  assert.deepEqual(
    [riga.others[1].firstAt, riga.others[1].lastAt],
    [Date.parse(quando(12)), Date.parse(quando(17))],
    'dal primo all ultimo momento in cui ci ha messo mano'
  );
  assert.equal(riga.others[0].firstAt, Date.parse(quando(13)),
    'chi ha fatto una cosa sola ha lo stesso istante da tutte e due le parti');
  assert.equal(riga.others[0].lastAt, riga.others[0].firstAt);

  // I commit dei colleghi non entrano nei tuoi conti: né nel numero di commit
  // della riga, né nella nota precompilata, che è la lista di quello che hai
  // fatto tu.
  assert.equal(riga.activity.commits, 1, 'un commit tuo, non tre');
  assert.equal(riga.comment, 'fix: mio');
}

// --- una riga solo altrui non ripete due volte la stessa cosa --------------
{
  const attivita = new Map([
    ['ABC-1', {
      key: 'ABC-1', summary: 'Assegnata',
      events: [{ kind: 'foreign', at: quando(17), by: 'Dario Decarlo', assignsYou: true, items: [{ field: 'assignee', from: '', to: 'Matteo' }] }]
    }]
  ]);
  const riga = piano(attivita).rows.find((r) => r.issueKey === 'ABC-1');

  assert.equal(riga.others.length, 1);
  assert.equal(riga.others[0].assigned, true);
  assert.equal(riga.others[0].assignedAt, Date.parse(quando(17)),
    'l ora dell assegnazione va tenuta a parte: e il fatto che colloca la riga');
}

// --- e non si riaccende quando il worklog sparisce -------------------------
// Il caso storto: sulla issue assegnata da un altro c'erano già delle ore, poi
// le cancelli da Jira. Il controllo duplicati l'aveva marcata `autoDisabled`,
// e la rilettura riaccende proprio quelle — così la riga tornava su da sola e
// si prendeva le ore di una giornata in cui non l'avevi toccata. I due motivi
// per stare spenta non sono lo stesso motivo: quello del duplicato scade
// quando il worklog sparisce, questo no.
{
  const attivita = new Map([
    ['ABC-1', {
      key: 'ABC-1', summary: 'Assegnata, e con ore sopra',
      events: [{ kind: 'foreign', at: quando(17), by: 'Dario Decarlo', assignsYou: true, items: [{ field: 'assignee', from: '', to: 'Matteo' }] }]
    }]
  ]);

  const riga = buildPlan({
    isoDate: '2026-08-10',
    config,
    jiraActivity: attivita,
    gitByIssue: new Map(),
    recentIssues: [],
    loggedEntries: [],
    loggedByIssue: { 'ABC-1': 60 },
    alreadyLoggedMinutes: 60
  }).rows.find((r) => r.issueKey === 'ABC-1');

  assert.equal(riga.enabled, false);
  assert.equal(riga.notYours, true, 'il motivo vero resta scritto');
  assert.ok(!riga.autoDisabled,
    'e non viene coperto da quello del duplicato, che alla rilettura la riaccenderebbe');

  // La regola della rilettura, applicata qui com'è scritta in popup.js: con le
  // ore sparite da Jira la riga deve restare giù.
  riga.existingMinutes = 0;
  if (!riga.existingMinutes && riga.autoDisabled) riga.enabled = true;
  assert.equal(riga.enabled, false, 'sparito il worklog, resta spenta');
}

// --- il nome deve arrivare fino al registro -------------------------------
// Fra la raccolta e la riga da incollare c'è il fondo, che ricompone gli
// eventi: se lì `by` si perde, tutto il resto funziona e il registro torna a
// intestarti il lavoro di un collega. È una giuntura, e si verifica sul
// sorgente come le altre.
{
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const bg = readFileSync(join(root, 'src/background.js'), 'utf8');
  const inizio = bg.indexOf('async function activity(');
  const corpo = bg.slice(inizio, bg.indexOf('\n}', inizio));

  assert.ok(inizio > -1, 'manca il comando che compone il registro');
  assert.match(corpo, /evento\.by/, 'il nome di chi ha fatto la modifica non arriva al registro');
  assert.match(corpo, /foreignComment/,
    'un commento di un collega sotto una issue tua non comparirebbe nel registro');
}

console.log('assegnate: tutti i controlli passati.');
