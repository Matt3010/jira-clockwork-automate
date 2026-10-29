// Le issue tue che ha mosso qualcun altro.
//
// Il piano è l'elenco di cosa registrare: ci va quello su cui hai lavorato tu.
// Un ticket che quel giorno ha toccato solo un collega — tuo perché ne sei
// assegnatario o richiedente — non ci va. Le mosse altrui non spariscono: dove
// hai lavorato pure tu, restano accanto alla riga (`others`), che è metà del
// daily. Prima c'era anche una scheda "attività" che le teneva a parte; adesso
// non c'è più, e con lei se n'è andata la riga spenta "questa non l'hai fatta".

import assert from 'node:assert/strict';
import { buildPlan } from '../src/lib/planner.js';
import { DEFAULT_CONFIG } from '../src/lib/storage.js';

const config = { ...DEFAULT_CONFIG, dayStart: '09:00', dayEnd: '18:00' };
const quando = (h) => new Date(2026, 7, 10, h, 0).toISOString();

const piano = (jiraActivity, extra = {}) => buildPlan({
  isoDate: '2026-08-10',
  config,
  jiraActivity,
  gitByIssue: new Map(),
  recentIssues: [],
  loggedEntries: [],
  alreadyLoggedMinutes: 0,
  ...extra
});

// --- mossa solo da un altro: niente riga -----------------------------------
// Farsi assegnare un ticket alle 17:00 non è averci lavorato: nel piano di cosa
// registrare non ci deve stare.
{
  const attivita = new Map([
    ['ABC-1', {
      key: 'ABC-1', summary: 'Assegnata a me',
      events: [{
        kind: 'foreign', at: quando(17), by: 'Dario Decarlo', assignsYou: true,
        items: [{ field: 'assignee', from: '', to: 'Matteo Scanferla' }]
      }]
    }]
  ]);

  const riga = piano(attivita).rows.find((r) => r.issueKey === 'ABC-1');
  assert.equal(riga, undefined, 'mossa solo da un collega: il ticket non entra nel piano');
}

// --- se ci hai lavorato anche tu, è una riga normale -----------------------
// L'assegnazione altrui non deve spegnere una issue su cui hai modifiche: lì il
// ticket è tuo in tutti i sensi, e chi altro ci ha messo mano si legge accanto.
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

  const riga = piano(attivita, { gitByIssue: commit }).rows.find((r) => r.issueKey === 'ABC-1');
  assert.equal(riga.enabled, true, 'il codice scritto è la prova che ci hai lavorato');
  assert.deepEqual(riga.sources, ['git']);
}

// --- chi altro ci ha messo mano, riga per riga -----------------------------
// La domanda è «in quali delle mie task ha lavorato qualcun altro», e vale
// soprattutto dove hai lavorato pure tu: lì prima i commit dei colleghi
// finivano contati in un avviso in cima, staccati dalla task a cui appartengono.
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

  const riga = piano(attivita, { gitByIssue: miei, foreignGitByIssue: altrui })
    .rows.find((r) => r.issueKey === 'ABC-1');

  assert.equal(riga.enabled, true, 'è lavoro tuo: resta una riga normale');
  assert.deepEqual(riga.others.map((chi) => chi.name), ['Anna Bianchi', 'Dario Decarlo'],
    'in ordine di nome');
  assert.deepEqual(riga.others.map((chi) => [chi.changes, chi.commits]), [[1, 0], [1, 2]],
    'ognuno con quello che ha fatto');
  assert.deepEqual(riga.others[1].commitUrls, ['https://git/uno', 'https://git/due']);
  assert.deepEqual(
    [riga.others[1].firstAt, riga.others[1].lastAt],
    [Date.parse(quando(12)), Date.parse(quando(17))],
    'dal primo all ultimo momento in cui ci ha messo mano'
  );

  // I commit dei colleghi non entrano nei tuoi conti: né nel numero di commit
  // della riga, né nella nota precompilata, che è la lista di quello che hai
  // fatto tu.
  assert.equal(riga.activity.commits, 1, 'un commit tuo, non tre');
  assert.equal(riga.comment, 'fix: mio');
}

// --- assegnata da un altro, ma con ore già sopra: resta, e spenta ----------
// Il caso storto: sulla issue mossa solo da un collega c'erano già delle ore
// (messe a mano da Clockwork). La riga deve esserci — spiega dove sono finite
// le ore — ma spenta, e senza il marchio del duplicato, che alla sparizione
// del worklog la riaccenderebbe su una giornata in cui non l'hai toccata.
{
  const attivita = new Map([
    ['ABC-1', {
      key: 'ABC-1', summary: 'Assegnata, e con ore sopra',
      events: [{ kind: 'foreign', at: quando(17), by: 'Dario Decarlo', assignsYou: true, items: [{ field: 'assignee', from: '', to: 'Matteo' }] }]
    }]
  ]);

  const riga = piano(attivita, { loggedByIssue: { 'ABC-1': 60 }, alreadyLoggedMinutes: 60 })
    .rows.find((r) => r.issueKey === 'ABC-1');

  assert.ok(riga, 'le ore già registrate tengono la riga nel piano');
  assert.equal(riga.enabled, false);
  assert.equal(riga.onlyLogged, true, 'c è solo per le ore già registrate');
  assert.ok(!riga.autoDisabled,
    'e non viene coperto da quello del duplicato, che alla rilettura la riaccenderebbe');

  // La regola della rilettura, applicata qui com'è scritta in popup.js: con le
  // ore sparite da Jira la riga deve restare giù.
  riga.existingMinutes = 0;
  if (!riga.existingMinutes && riga.autoDisabled) riga.enabled = true;
  assert.equal(riga.enabled, false, 'sparito il worklog, resta spenta');
}

console.log('assegnate: tutti i controlli passati.');
