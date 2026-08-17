// Il popup, eseguito davvero.
//
// Le altre suite sul popup guardano il sorgente: che le celle abbiano una
// classe, che il foglio di stile la conosca, che un comando esista dall'altra
// parte. Nessuna lo esegue, e quindi nessuna vede quello che si rompe
// eseguendolo — un disegno che solleva a metà e lascia la tabella vuota, una
// spunta agganciata alla riga sbagliata, un invio che parte con i minuti di
// prima.
//
// Qui il piano lo costruisce il planner vero, così le forme non possono
// divergere: quello che il fondo manderebbe è quello che il test manda.

import assert from 'node:assert/strict';
import { apriPagina, testo, tutti } from './pagina.mjs';
import { buildPlan } from '../src/lib/planner.js';
// L'ora la compone lo stesso pezzo che la disegna: scritta a mano nel test
// dipenderebbe dal fuso della macchina che lo esegue.
import { eventTime } from '../src/lib/registro.js';
// Il finto browser sgancia i timer che installa sul globale: per aspettare
// davvero i tentativi distanziati serve un timer che non passi di lì.
import { setTimeout as respira } from 'node:timers/promises';
import { DEFAULT_CONFIG } from '../src/lib/storage.js';

const HOST = 'esempio.atlassian.net';
const config = {
  ...DEFAULT_CONFIG,
  jira: { ...DEFAULT_CONFIG.jira, projects: ['ABC'], baseUrl: `https://${HOST}` }
};

const attivita = new Map([
  ['ABC-1', { key: 'ABC-1', id: '1', summary: 'Titolo uno', events: [{ kind: 'changelog', at: '2026-08-10T11:00:00.000Z' }] }],
  ['ABC-2', { key: 'ABC-2', id: '2', summary: 'Titolo due', events: [{ kind: 'comment', at: '2026-08-10T14:00:00.000Z' }] }]
]);

const piano = buildPlan({
  isoDate: '2026-08-10',
  config,
  jiraActivity: attivita,
  gitByIssue: new Map(),
  recentIssues: [],
  loggedEntries: [],
  alreadyLoggedMinutes: 0
});

const RISPOSTE = {
  siteStatus: { host: HOST, configured: true, tabsOnSite: 1, openHosts: [HOST] },
  analyze: { ...piano, config, site: { host: HOST } },
  submit: { results: [] },
  refreshLogged: { loggedEntries: [], alreadyLoggedMinutes: 0 }
};

/** Le righe del piano, senza quelle di dettaglio dei worklog. */
const righe = (documento) => tutti(documento, '#rows tr').filter((tr) => !tr.classList.contains('worklogs'));
const campo = (tr, selettore) => tr.querySelector(selettore);
const cambia = (nodo, valore) => {
  nodo.value = valore;
  nodo.dispatchEvent(new nodo.ownerDocument.defaultView.Event('change', { bubbles: true }));
};

// --- il piano arriva a schermo -------------------------------------------
{
  const p = await apriPagina('popup', { risposte: RISPOSTE });
  await p.attendi();

  assert.deepEqual(p.chiamate.map((c) => c.type), ['siteStatus', 'analyze'],
    'aprendo il popup si chiede lo stato del sito e il piano di oggi, e basta');

  const r = righe(p.document);
  assert.equal(r.length, 4, 'due riunioni e due task');
  assert.deepEqual(
    r.map((tr) => campo(tr, '.issue-input').value),
    ['', '', 'ABC-1', 'ABC-2'],
    'le chiavi finiscono nei campi, le riunioni senza ticket restano vuote'
  );
  assert.deepEqual(
    r.map((tr) => campo(tr, '.hours').value),
    ['0', '0', '4', '4'],
    'otto ore divise sulle due righe inviabili; una riga senza ticket non prenota niente'
  );
  assert.equal(testo(campo(r[2], '.time')), '09:00–13:00', 'e gli orari sono quelli del piano');

  // Il totale e il pulsante dicono la stessa cosa in due modi: se uno dei due
  // resta indietro, chi guarda non sa piu' cosa sta per partire.
  assert.match(testo(p.document.querySelector('#total')), /8h to distribute out of 8h/);
  assert.match(testo(p.document.querySelector('#total')), /day ends at 18:00/);
  assert.equal(testo(p.document.querySelector('#submit')), 'Send 2 worklogs');

  // L'etichetta di freschezza dice l'ora della lettura, non quanto è vecchia:
  // l'età tornava «ora» a ogni rilettura, e quindi non diceva niente.
  const quando = testo(p.document.querySelector('#sync'));
  assert.match(quando, /^read at \d{2}:\d{2}$/, `l etichetta dice l ora: «${quando}»`);
  assert.match(p.document.querySelector('#sync').title, /^Last read at \d{2}:\d{2}$/);
  p.chiudi();
}

// --- spegnere una riga ridistribuisce sull'altra --------------------------
// E' il conto che il popup rifa' da solo a ogni modifica: le ore tolte non
// spariscono, tornano nel monte e vanno a chi resta.
{
  const p = await apriPagina('popup', { risposte: RISPOSTE });
  await p.attendi();

  const prima = righe(p.document);
  const spunta = campo(prima[2], '.col-check input');
  spunta.checked = false;
  spunta.dispatchEvent(new p.dom.window.Event('change', { bubbles: true }));
  await p.attendi(1);

  const dopo = righe(p.document);
  assert.equal(campo(dopo[2], '.hours').value, '0', 'la riga spenta non tiene ore');
  assert.equal(campo(dopo[3], '.hours').value, '8', 'e le sue vanno all altra, non nel nulla');
  assert.equal(testo(p.document.querySelector('#submit')), 'Send 1 worklog',
    'il pulsante conta le righe che partiranno davvero');
  p.chiudi();
}

// --- la nota è una casella su più righe, e le mostra tutte ---------------
// Con la lista dei commit dentro un campo a riga singola se ne vedrebbe uno
// solo, e gli altri sarebbero lì senza che nessuno lo sappia.
{
  const conCommit = {
    ...piano,
    rows: piano.rows.map((r) => (r.issueKey === 'ABC-1'
      ? { ...r, comment: 'feat: prima cosa\nfix: seconda cosa\nchore: terza cosa' }
      : r))
  };
  const p = await apriPagina('popup', {
    risposte: { ...RISPOSTE, analyze: { ...conCommit, config, site: { host: HOST } } }
  });
  await p.attendi();

  const nota = campo(righe(p.document)[2], '.comment');
  assert.equal(nota.tagName, 'TEXTAREA', 'la nota deve poter contenere più righe');
  assert.equal(nota.value.split('\n').length, 3, 'e contenerle davvero');
  assert.equal(Number(nota.rows), 3, 'con la casella alta quanto serve, senza scorrere per leggerla');

  // Scrivendoci dentro l'altezza segue, e quello che si scrive arriva all invio.
  nota.value = 'una riga sola';
  nota.dispatchEvent(new p.dom.window.Event('input', { bubbles: true }));
  assert.equal(Number(nota.rows), 1, 'e si riabbassa quando la nota si accorcia');

  p.document.querySelector('#submit').click();
  await p.attendi(2);
  assert.equal(p.ultima('submit').rows.find((r) => r.issueKey === 'ABC-1').comment, 'una riga sola');
  p.chiudi();
}

// --- una issue tua mossa da un altro: si vede, ed è spenta ---------------
// Il caso vero: un collega ti assegna un ticket alle 17:00. Prima non compariva
// da nessuna parte — la modifica portava il suo nome, non il tuo. Ora c'è, ma
// spenta: farsela assegnare non è averci lavorato, e le ore della giornata non
// devono finirci sopra da sole.
{
  const assegnata = new Map([
    ...attivita,
    ['ABC-9', {
      key: 'ABC-9', id: '9', summary: 'Assegnata da un collega',
      events: [{
        kind: 'foreign', at: '2026-08-10T17:00:00.000Z', by: 'Dario Decarlo',
        // `assignsYou` lo decide chi legge da Jira, che vede l'accountId del
        // nuovo assegnatario: qui è il fatto, non il campo cambiato.
        assignsYou: true,
        items: [{ field: 'assignee', from: '', to: 'Matteo Scanferla' }]
      }]
    }]
  ]);
  const conAssegnata = buildPlan({
    isoDate: '2026-08-10',
    config,
    jiraActivity: assegnata,
    gitByIssue: new Map(),
    recentIssues: [],
    loggedEntries: [],
    alreadyLoggedMinutes: 0
  });

  const p = await apriPagina('popup', {
    risposte: { ...RISPOSTE, analyze: { ...conAssegnata, config, site: { host: HOST } } }
  });
  await p.attendi();

  const riga = righe(p.document).find((tr) => campo(tr, '.issue-input')?.value === 'ABC-9');
  assert.ok(riga, 'la riga deve esserci: il ticket è tuo');
  assert.equal(campo(riga, 'input[type="checkbox"]').checked, false, 'e deve partire spenta');
  assert.equal(campo(riga, '.hours').value, '0', 'senza portarsi via minuti');
  // Senza una frase, una riga spenta e senza attività sembra comparsa dal
  // nulla. La dice la riga dei colleghi, che li elenca tutti: una frase sola
  // nominava solo il primo, e con due persone la seconda spariva.
  // Con l'ora accanto: assegnata alle 9 o alle 17 sono due cose diverse.
  const quandoAssegnata = eventTime(Date.parse('2026-08-10T17:00:00.000Z'));
  assert.equal(testo(campo(riga, '.altri')), `Dario Decarlo: assigned it to you at ${quandoAssegnata}`);
  assert.equal(campo(riga, '.detail'), null,
    'e non ce n è una seconda a dire la stessa cosa: aprirebbe un vuoto nella card');

  // Le ore restano tutte sulle righe su cui hai lavorato davvero.
  const conTicket = righe(p.document)
    .filter((tr) => campo(tr, '.issue-input').value && campo(tr, 'input[type="checkbox"]').checked)
    .map((tr) => campo(tr, '.issue-input').value);
  assert.deepEqual(conTicket, ['ABC-1', 'ABC-2'], 'le altre due restano accese');

  p.document.querySelector('#submit').click();
  await p.attendi(2);
  const inviata = p.ultima('submit').rows.find((r) => r.issueKey === 'ABC-9');
  assert.equal(inviata.minutes, 0, 'e non si registra niente su un ticket che ti hanno solo assegnato');

  // Ma il caso normale è che la task te la faccia il PM e poi ci lavori: da
  // spenta a registrabile deve essere un click, con le ore che si spostano da
  // sole. Se costasse di più, tanto varrebbe non mostrarla.
  const spunta = campo(riga, '.col-check input');
  spunta.checked = true;
  spunta.dispatchEvent(new p.dom.window.Event('change', { bubbles: true }));
  await p.attendi(1);

  const acceso = righe(p.document).find((tr) => campo(tr, '.issue-input').value === 'ABC-9');
  assert.ok(Number(campo(acceso, '.hours').value) > 0, 'accesa, prende la sua parte di giornata');
  assert.equal(
    righe(p.document).reduce((somma, tr) => somma + Number(campo(tr, '.hours').value), 0), 8,
    'e le otto ore restano otto: le sue arrivano dalle altre, non dal nulla'
  );
  p.chiudi();
}

// --- su una task tua ha lavorato anche un collega ------------------------
// Sapere che sul tuo ticket ha committato qualcun altro è metà del daily.
// Prima non si vedeva: i suoi commit erano un numero in un avviso in cima,
// staccato dalla task a cui appartengono.
{
  const insieme = new Map([
    ['ABC-1', {
      key: 'ABC-1', id: '1', summary: 'Titolo uno',
      events: [
        { kind: 'changelog', at: '2026-08-10T11:00:00.000Z', by: '', items: [{ field: 'status', from: 'To Do', to: 'In Progress' }] },
        { kind: 'foreign', at: '2026-08-10T12:00:00.000Z', by: 'Dario Decarlo', items: [{ field: 'status', from: 'In Progress', to: 'In Review' }] }
      ]
    }],
    ['ABC-2', { key: 'ABC-2', id: '2', summary: 'Titolo due', events: [{ kind: 'comment', at: '2026-08-10T14:00:00.000Z' }] }]
  ]);
  const conColleghi = buildPlan({
    isoDate: '2026-08-10',
    config,
    jiraActivity: insieme,
    gitByIssue: new Map(),
    foreignGitByIssue: new Map([['ABC-1', [
      { author: 'Dario Decarlo', subject: 'feat: suo', at: '2026-08-10T16:00:00.000Z', url: 'https://bitbucket.org/x/commits/abc123' }
    ]]]),
    recentIssues: [],
    loggedEntries: [],
    alreadyLoggedMinutes: 0
  });

  const p = await apriPagina('popup', {
    risposte: { ...RISPOSTE, analyze: { ...conColleghi, config, site: { host: HOST } } }
  });
  await p.attendi();

  const riga = righe(p.document).find((tr) => campo(tr, '.issue-input').value === 'ABC-1');
  // In coda l'arco in cui ci ha messo mano: «1 modifica, 1 commit» senza
  // orario non si colloca nella giornata, e non si sa se è successo prima o
  // dopo il tuo lavoro.
  const dalle = eventTime(Date.parse('2026-08-10T12:00:00.000Z'));
  const alle = eventTime(Date.parse('2026-08-10T16:00:00.000Z'));
  assert.equal(testo(campo(riga, '.altri')),
    `Dario Decarlo: 1 Jira change, 1 commit (${dalle}–${alle})`);
  // Con un collega sotto, «1 modifica» da solo non direbbe più di chi è: le
  // due righe portano tutte e due un nome davanti.
  assert.equal(testo(campo(riga, '.detail')), 'you: 1 Jira change');

  // Da «1 commit» si deve arrivare al commit, non alla issue e poi cercarlo a
  // mano; le modifiche Jira portano alla issue, che è dove sta la cronologia.
  const [modifiche, commit] = tutti(riga, '.altri a');
  assert.equal(modifiche.textContent, '1 Jira change');
  assert.equal(modifiche.href, `https://${HOST}/browse/ABC-1`);
  assert.equal(commit.textContent, '1 commit');
  assert.equal(commit.href, 'https://bitbucket.org/x/commits/abc123');
  for (const a of [modifiche, commit]) {
    assert.equal(a.target, '_blank', 'il popup si chiude al primo click fuori: la scheda dev essere nuova');
    assert.equal(a.rel, 'noreferrer');
  }
  // Il nome no: non è un posto dove andare, è chi è stato.
  assert.equal(testo(campo(riga, '.altri .chi')), 'Dario Decarlo');
  assert.equal(campo(riga, '.altri .chi').tagName, 'SPAN');

  // Dove colleghi non ce ne sono, il nome davanti sarebbe rumore.
  const sola2 = righe(p.document).find((tr) => campo(tr, '.issue-input').value === 'ABC-2');
  assert.equal(testo(campo(sola2, '.detail')), '1 comment');

  // Resta una riga tua a tutti gli effetti: accesa, con le sue ore.
  assert.equal(campo(riga, 'input[type="checkbox"]').checked, true);
  assert.ok(Number(campo(riga, '.hours').value) > 0);

  // E dove non ci ha messo mano nessun altro, nessuna riga in più a vuoto.
  const sola = righe(p.document).find((tr) => campo(tr, '.issue-input').value === 'ABC-2');
  assert.equal(campo(sola, '.altri'), null, 'niente contenitore vuoto sulle righe senza colleghi');
  p.chiudi();
}

// --- la chiave del ticket è un link, e porta alla issue ------------------
// Il codice che apre Jira sta in un posto solo: se quella funzione smette di
// mettere `target`, il popup si chiude e la issue si apre al posto suo — e
// quello che stavi compilando sparisce.
{
  const gruppi = [{
    status: 'In corso',
    category: 'indeterminate',
    count: 1,
    days: [{
      day: '2026-08-10',
      issues: [{
        key: 'ABC-7', summary: 'Titolo sette', status: 'In corso', category: 'indeterminate',
        updated: '2026-08-10T09:00:00.000Z'
      }]
    }]
  }];
  const p = await apriPagina('popup', {
    risposte: { ...RISPOSTE, openIssues: { groups: gruppi, total: 1 } }
  });
  await p.attendi();

  p.document.getElementById('tab-tickets').click();
  await p.attendi(1);

  // La data del gruppo dice l'ultimo movimento, non l'apertura: nell'elenco
  // dei ticket aperti si cerca cosa si è mosso e cosa è fermo da settimane.
  assert.match(testo(p.document.querySelector('#tickets')), /Last moved/);

  const chiave = p.document.querySelector('#tickets .chiave');
  assert.equal(testo(chiave), 'ABC-7');
  assert.equal(chiave.tagName, 'A', 'la chiave deve essere un link');
  assert.equal(chiave.href, `https://${HOST}/browse/ABC-7`);
  assert.equal(chiave.target, '_blank');
  assert.equal(chiave.rel, 'noreferrer');
}

// --- senza sito configurato non si disegnano link morti ------------------
// Il sito si sa solo dopo `siteStatus`: prima di allora un `<a>` senza `href`
// sembra cliccabile e non porta da nessuna parte.
{
  const p = await apriPagina('popup', {
    risposte: {
      ...RISPOSTE,
      siteStatus: { host: '', configured: false, tabsOnSite: 0, openHosts: [] },
      openIssues: {
        groups: [{
          status: 'In corso',
          category: 'indeterminate',
          count: 1,
          days: [{ day: '2026-08-10', issues: [{ key: 'ABC-7', summary: 'Titolo sette', status: 'In corso', category: 'indeterminate' }] }]
        }],
        total: 1
      }
    }
  });
  await p.attendi();

  p.document.getElementById('tab-tickets').click();
  await p.attendi(1);

  const chiave = p.document.querySelector('#tickets .chiave');
  assert.equal(testo(chiave), 'ABC-7', 'la chiave si legge comunque');
  assert.equal(chiave.tagName, 'SPAN', 'ma non è un link che non porta da nessuna parte');
  p.chiudi();
}

// --- mentre carica, la pagina non collassa verso l'alto ------------------
// L'asse è la cornice della giornata, non un dato: toglierlo a ogni rilettura
// faceva risalire tutto il resto e poi risaltare indietro all'arrivo del
// piano. La legenda invece è dei blocchi, e senza blocchi non spiega niente.
{
  const p = await apriPagina('popup', { risposte: RISPOSTE });
  await p.attendi();
  assert.equal(p.document.getElementById('timeline').hidden, false);
  assert.equal(p.document.getElementById('legend').hidden, false);

  // Una rilettura. Si guarda subito, senza aspettare: `analyze` svuota e
  // ridisegna prima di mettersi in attesa della risposta, ed è quello
  // l'istante in cui la pagina saltava.
  p.document.getElementById('analyze').click();
  assert.equal(righe(p.document).length, 0, 'il piano vecchio sparisce');
  assert.equal(p.document.getElementById('timeline').hidden, false,
    'la cornice resta, o la pagina si accorcia e poi si riallunga');
  assert.equal(p.document.getElementById('legend').hidden, true,
    'la legenda no: senza blocchi non ha niente da spiegare');
  p.chiudi();
}

// --- ogni avviso resta nella vista che lo ha prodotto --------------------
// «Ticket riunione proposto» parla del piano: sotto l'elenco delle pull
// request non vuol dire niente, e il contenitore degli avvisi è uno solo.
{
  const conProposta = {
    ...piano,
    rows: piano.rows.map((r) => (r.kind === 'meeting'
      ? { ...r, issueKey: 'ABC-9', guessed: true, guessReason: 'nome' }
      : r))
  };
  const p = await apriPagina('popup', {
    risposte: {
      ...RISPOSTE,
      analyze: { ...conProposta, config, site: { host: HOST } },
      pullRequests: { items: [], checked: 0 }
    }
  });
  await p.attendi();

  const visibili = () => tutti(p.document, '#messages .msg').filter((m) => !m.hidden);
  assert.equal(visibili().length, 1, 'sulle Ore l avviso del piano si vede');

  p.document.getElementById('tab-pr').click();
  await p.attendi(2);
  assert.equal(visibili().length, 0, 'cambiando vista non lo segue');

  p.document.getElementById('tab-hours').click();
  await p.attendi(1);
  assert.equal(visibili().length, 1, 'e tornando lo ritrovi: non è stato buttato');
  p.chiudi();
}

// --- le pull request: nessuna richiesta finché non apri la vista ---------
// Costano una chiamata per ticket aperto del progetto: partire da sole a ogni
// analisi vorrebbe dire cinquanta richieste per una vista che magari non
// guardi. E sono sola lettura: unire e rifiutare stanno su Bitbucket.
{
  const PR = [
    {
      id: '1', number: '1', issueKey: 'ABC-1', issueSummary: 'Titolo uno',
      title: 'Aggiusta il tunnel', url: 'https://git/pr/1', status: 'OPEN',
      author: 'Collega Qualsiasi', mine: false, waitingForYou: true,
      approvals: 0, at: Date.parse('2026-08-10T15:00:00.000Z')
    },
    {
      id: '2', number: '2', issueKey: 'ABC-2', issueSummary: 'Titolo due',
      title: 'Mia proposta', url: 'https://git/pr/2', status: 'OPEN',
      author: 'Nome Cognome', mine: true, waitingForYou: false,
      approvals: 2, at: Date.parse('2026-08-10T11:00:00.000Z')
    },
    {
      id: '3', number: '3', issueKey: 'ABC-3', issueSummary: 'Titolo tre',
      title: 'Roba di altri', url: 'https://git/pr/3', status: 'OPEN',
      author: 'Terza Persona', mine: false, waitingForYou: false,
      approvals: 0, at: Date.parse('2026-08-10T09:00:00.000Z')
    },
    {
      id: '4', number: '4', issueKey: 'ABC-4', issueSummary: 'Titolo quattro',
      title: 'Già unita', url: 'https://git/pr/4', status: 'MERGED',
      author: 'Nome Cognome', mine: true, waitingForYou: false,
      approvals: 2, at: Date.parse('2026-08-10T08:00:00.000Z')
    }
  ];
  const p = await apriPagina('popup', {
    risposte: { ...RISPOSTE, pullRequests: { items: PR, checked: 4 } }
  });
  await p.attendi();

  assert.equal(p.chiamate.filter((c) => c.type === 'pullRequests').length, 0,
    'aprendo il popup non si tocca il pannello Sviluppo di mezzo progetto');

  p.document.getElementById('tab-pr').click();
  await p.attendi(2);
  assert.equal(p.chiamate.filter((c) => c.type === 'pullRequests').length, 1,
    'si legge quando apri la vista');

  // Il primo gruppo è la domanda con cui apri questa vista.
  const gruppi = tutti(p.document, '.pr-group-title').map((n) => testo(n));
  assert.deepEqual(gruppi, ['Waiting for you (1)', 'Yours (1)', 'Others (1)'],
    'e le già unite non stanno in nessun gruppo: non aspettano nessuno');

  const prima = p.document.querySelector('.pr-group .pr-row');
  assert.equal(testo(prima.querySelector('.chiave')), 'ABC-1');
  assert.equal(prima.querySelector('.chiave').href, `https://${HOST}/browse/ABC-1`,
    'la chiave porta al ticket');
  assert.equal(testo(prima.querySelector('.pr-title')), 'Aggiusta il tunnel');
  assert.equal(prima.querySelector('.pr-title').href, 'https://git/pr/1',
    'il titolo porta alla PR, che è dove stanno i tasti per unirla');

  // Riaprendo la scheda non si rilegge: la vista costa, e non è cambiata.
  p.document.getElementById('tab-hours').click();
  p.document.getElementById('tab-pr').click();
  await p.attendi(2);
  assert.equal(p.chiamate.filter((c) => c.type === 'pullRequests').length, 1);

  // Ma «Aggiorna» sulla vista PR rilegge quella, non il piano.
  p.document.getElementById('analyze').click();
  await p.attendi(2);
  assert.equal(p.chiamate.filter((c) => c.type === 'pullRequests').length, 2);
  p.chiudi();
}

// --- e quando non ce n'è nessuna, lo dice --------------------------------
{
  const p = await apriPagina('popup', {
    risposte: { ...RISPOSTE, pullRequests: { items: [], checked: 12 } }
  });
  await p.attendi();
  p.document.getElementById('tab-pr').click();
  await p.attendi(2);

  assert.equal(tutti(p.document, '.pr-row').length, 0);
  assert.equal(p.document.getElementById('pr-empty').hidden, false);
  p.chiudi();
}

// --- il ritorno a oggi ---------------------------------------------------
// Sfogliando indietro di qualche giorno, tornare voleva dire contare i click
// all'indietro o riscrivere la data a mano.
{
  const p = await apriPagina('popup', { risposte: RISPOSTE });
  await p.attendi();

  const oggi = p.document.getElementById('today');
  const campo = p.document.getElementById('date');
  const dataDiOggi = campo.value;
  assert.equal(oggi.hidden, true, 'sul giorno corrente non ha niente da fare');

  p.document.getElementById('prev-day').click();
  p.document.getElementById('prev-day').click();
  await p.attendi(2);
  assert.equal(oggi.hidden, false, 'appena sei altrove, compare');
  assert.notEqual(campo.value, dataDiOggi);

  p.chiamate.length = 0;
  oggi.click();
  await p.attendi(3);

  assert.equal(campo.value, dataDiOggi, 'un click solo, da qualunque distanza');
  assert.equal(oggi.hidden, true, 'e sparisce di nuovo');
  const analisi = p.chiamate.filter((c) => c.type === 'analyze');
  assert.equal(analisi.length, 1, 'il giorno nuovo va analizzato');
  assert.equal(analisi[0].payload.isoDate, dataDiOggi);
  p.chiudi();
}

// --- una riga corretta a mano tiene, le altre si assestano ----------------
{
  const p = await apriPagina('popup', { risposte: RISPOSTE });
  await p.attendi();

  cambia(campo(righe(p.document)[2], '.hours'), '2');
  await p.attendi(1);

  const dopo = righe(p.document);
  assert.equal(campo(dopo[2], '.hours').value, '2', 'il valore scritto a mano resta quello');
  assert.equal(campo(dopo[3], '.hours').value, '6', 'il resto si riassesta intorno');
  assert.ok(campo(dopo[2], '.hours').classList.contains('locked'),
    'e si vede che quel valore e stato deciso a mano, non calcolato');
  p.chiudi();
}

// --- l'invio manda quello che si legge -----------------------------------
{
  const p = await apriPagina('popup', { risposte: RISPOSTE });
  await p.attendi();

  p.document.querySelector('#submit').click();
  await p.attendi(2);
  const inviato = p.ultima('submit');
  assert.ok(inviato, 'una giornata che torna parte al primo click, senza cerimonie');
  // La data non e' quella del piano di prova: e' quella che si legge nel campo,
  // cioe' il giorno che si sta guardando. Mandare le ore su un altro giorno e'
  // il modo peggiore di sbagliare, perche' su Jira restano.
  assert.equal(inviato.isoDate, p.document.querySelector('#date').value);
  assert.equal(inviato.isoDate, p.ultima('analyze').isoDate, 'lo stesso giorno che era stato analizzato');

  const conTicket = inviato.rows.filter((r) => r.enabled && r.issueKey);
  assert.deepEqual(conTicket.map((r) => r.issueKey), ['ABC-1', 'ABC-2'],
    'partono le righe con un ticket, nell ordine in cui si leggono');
  assert.deepEqual(conTicket.map((r) => r.minutes), [240, 240], 'coi minuti che erano a schermo');
  assert.ok(conTicket.every((r) => r.segments?.length), 'e con gli orari gia spezzati sulle pause');
  // Le riunioni senza ticket viaggiano lo stesso, ma a zero minuti: e' il fondo
  // a scartarle, e mandarle con delle ore addosso sarebbe un invio a caso.
  assert.ok(inviato.rows.filter((r) => !r.issueKey).every((r) => r.minutes === 0),
    'una riga senza ticket non deve portare minuti con se');
  p.chiudi();
}

// --- una giornata che sfora si invia in due passi -------------------------
// Scrivere ore su Jira non si annulla con un tasto: quando il conto non torna,
// il primo click deve solo chiedere conferma — e dire quanto verrebbe fuori.
{
  const p = await apriPagina('popup', { risposte: RISPOSTE });
  await p.attendi();

  cambia(campo(righe(p.document)[2], '.hours'), '10');
  await p.attendi(1);

  const invia = p.document.querySelector('#submit');
  invia.click();
  await p.attendi(1);
  assert.equal(p.chiamate.filter((c) => c.type === 'submit').length, 0, 'il primo click non manda niente');
  assert.match(testo(invia), /Confirm/i, 'chiede conferma');
  assert.match(testo(invia), /10h/, 'e dice dove finirebbe la giornata');
  assert.ok(invia.classList.contains('danger'), 'con il colore che si accompagna alla domanda');
  assert.equal(p.document.querySelector('#cancel-send').hidden, false, 'e la via d uscita accanto');

  invia.click();
  await p.attendi(2);
  assert.ok(p.ultima('submit'), 'il secondo click manda');
  p.chiudi();
}

// --- senza scheda aperta, la scheda se la apre da sé ---------------------
// Era un pulsante «apri e riprova», e l'utente lo premeva sempre: non c'è
// un'altra risposta possibile. In secondo piano, però: in primo ruberebbe il
// fuoco e il popup si chiuderebbe, portandosi via quello che stavi compilando.
{
  const p = await apriPagina('popup', {
    risposte: {
      ...RISPOSTE,
      analyze: { ok: false, error: 'Jira: no tab open.', code: 'NO_TAB', detail: { host: HOST, openHosts: [] } }
    }
  });
  await p.attendi(6);

  assert.equal(p.tabs.at(-1)?.url, `https://${HOST}/`, 'apre il sito configurato');
  assert.equal(p.tabs.at(-1)?.active, false, 'e in secondo piano, o il popup si chiude da solo');
  assert.equal(p.chiamate.filter((c) => c.type === 'analyze').length, 2,
    'e riprova, senza aspettare che glielo dica qualcuno');
  p.chiudi();
}

// --- e anche quando l'errore arriva spoglio ------------------------------
// Il sito lo sa già il popup: se il fondo non ha attaccato il contesto —
// succedeva con l'identità letta dalla cache — il rimedio deve funzionare lo
// stesso, o resta un errore rosso e nient'altro.
{
  const p = await apriPagina('popup', {
    risposte: {
      ...RISPOSTE,
      analyze: { ok: false, error: 'Jira: no tab open.', code: 'NO_TAB' }
    }
  });
  await p.attendi(6);

  assert.equal(p.tabs.at(-1)?.url, `https://${HOST}/`,
    'l host arriva da siteStatus, non dall errore');
  assert.equal(p.tabs.at(-1)?.active, false);
  p.chiudi();
}

// --- la scheda appena aperta non è subito utilizzabile -------------------
// Il documento risulta completo prima che la pagina risponda alle richieste
// iniettate: il secondo tentativo cadeva in quella fessura e mostrava l'errore
// rosso. Da fuori sembrava che l'apertura automatica funzionasse «ogni tanto».
{
  let tentativi = 0;
  const p = await apriPagina('popup', {
    risposte: {
      ...RISPOSTE,
      analyze: () => {
        tentativi += 1;
        // I primi due falliscono: apertura, poi scheda ancora fredda.
        if (tentativi <= 2) {
          return { ok: false, error: 'Jira: no tab open.', code: 'NO_TAB', detail: { host: HOST } };
        }
        return { ...piano, config, site: { host: HOST } };
      }
    }
  });
  await respira(1200);
  await p.attendi(4);

  assert.ok(tentativi >= 3, 'ritenta finché la scheda non risponde');
  assert.equal(p.tabs.filter((t) => t.url === `https://${HOST}/`).length, 1,
    'ma la scheda si apre una volta sola, non una per tentativo');
  assert.equal(righe(p.document).length, 4, 'e alla fine il piano arriva');
  assert.equal([...p.document.querySelectorAll('#messages .msg')].some((m) => m.className.includes('err')),
    false, 'senza mai mostrare l errore rosso');
  p.chiudi();
}

// --- se la scheda non si può aprire, non si resta appesi -----------------
// Chrome rifiuta di aprire schede mentre ne stai trascinando una. L'errore va
// letto dentro il callback: non leggerlo lo lascia in console come «unchecked
// runtime.lastError» e, peggio, lascia l'interfaccia ad aspettare per quindici
// secondi una scheda che non arriverà.
{
  const p = await apriPagina('popup', {
    schedeBloccate: true,
    risposte: {
      // Niente rilettura leggera qui: ripulisce i messaggi e nasconderebbe
      // quello che si sta verificando.
      siteStatus: { host: HOST, configured: true, tabsOnSite: 0, openHosts: [] },
      analyze: { ok: false, error: 'Jira: no tab open.', code: 'NO_TAB', detail: { host: HOST, openHosts: [] } }
    }
  });
  await p.attendi(6);

  assert.equal(p.tabs.length, 0, 'nessuna scheda aperta: Chrome ha detto di no');
  const conRimedio = tutti(p.document, '#messages .msg').filter((m) => m.querySelector('button'));
  assert.equal(conRimedio.length, 1,
    'e il rimedio a mano deve comparire subito, senza aspettare il timer');
  p.chiudi();
}

// --- ma non in eterno: se non risponde, decide l'utente ------------------
// Ritentare in cerchio aprirebbe una scheda per ogni giro, e il problema non
// sarebbe comunque la scheda mancante.
{
  const p = await apriPagina('popup', {
    risposte: {
      ...RISPOSTE,
      analyze: { ok: false, error: 'Jira: no tab open.', code: 'NO_TAB', detail: { host: HOST, openHosts: [] } }
    }
  });
  await respira(2000);
  await p.attendi(4);

  const aperte = p.tabs.filter((t) => t.url === `https://${HOST}/`).length;
  assert.equal(aperte, 1, 'una scheda sola, non una per tentativo');

  const avviso = [...p.document.querySelectorAll('#messages .msg')].at(-1);
  assert.ok(avviso?.querySelector('button'), 'e alla fine il rimedio torna in mano all utente');
  assert.equal(righe(p.document).length, 0, 'il piano resta vuoto: non c e niente da mostrare');
  p.chiudi();
}

// --- la pagina sa in quale contenitore si trova ---------------------------
{
  const pannello = await apriPagina('popup', { risposte: RISPOSTE, query: '?panel=1' });
  await pannello.attendi(1);
  assert.equal(pannello.document.documentElement.dataset.mode, 'panel',
    'nel pannello il foglio di stile deve poter togliere la larghezza fissa del popup');
  pannello.chiudi();

  const popup = await apriPagina('popup', { risposte: RISPOSTE });
  await popup.attendi(1);
  assert.equal(popup.document.documentElement.dataset.mode, undefined, 'nel popup no');
  popup.chiudi();
}

console.log('popup vivo: tutti i controlli passati.');
