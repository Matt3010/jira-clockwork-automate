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
  // Senza una frase, una riga spenta e senza attività sembra comparsa dal nulla.
  assert.equal(testo(campo(riga, '.detail')), 'assigned to you by Dario Decarlo');

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

// --- senza scheda aperta, l'errore porta il suo rimedio -------------------
// E' il caso piu' frequente e l'unico in cui l'utente puo' fare qualcosa
// subito: il messaggio deve avere il pulsante, e il pulsante deve aprire il
// sito giusto.
{
  const p = await apriPagina('popup', {
    risposte: {
      ...RISPOSTE,
      analyze: { ok: false, error: 'Jira: no tab open.', code: 'NO_TAB', detail: { host: HOST, openHosts: [] } }
    }
  });
  await p.attendi();

  const avviso = p.document.querySelector('#messages .msg');
  assert.ok(avviso, 'un errore deve diventare un avviso, non una tabella vuota e basta');
  const rimedio = avviso.querySelector('button');
  assert.ok(rimedio, 'e l avviso deve portare il rimedio');

  rimedio.click();
  await p.attendi(2);
  assert.equal(p.tabs.at(-1)?.url, `https://${HOST}/`, 'che apre il sito configurato');
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
