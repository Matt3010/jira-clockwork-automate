// Lettura da Jira: quali issue contano come "tue attività di oggi" e quante ore
// risultano già registrate. È il filtro che decide cosa finisce nel piano, ma
// non era coperto: uno sbaglio qui attribuisce a te il lavoro di un collega.

import assert from 'node:assert/strict';
import { collectJiraActivity, loggedMinutesForDay } from '../src/lib/jira.js';

const IO = 'account-mio';
const ALTRO = 'account-collega';
const quando = (h, m = 0, giorno = 10) => new Date(2026, 7, giorno, h, m).toISOString();

function fakeClient(risposte) {
  const chiamate = { search: [], comments: [], tail: [], worklogs: [] };
  return {
    chiamate,
    async search(jql, opzioni) {
      chiamate.search.push({ jql, opzioni });
      return risposte.issues || [];
    },
    async getComments(key) {
      chiamate.comments.push(key);
      return risposte.comments?.[key] || [];
    },
    async getChangelogTail(key, total) {
      chiamate.tail.push({ key, total });
      return risposte.tail?.[key] || [];
    },
    async getWorklogs(key, startedAfter) {
      chiamate.worklogs.push({ key, startedAfter });
      return risposte.worklogs?.[key] || [];
    }
  };
}

// ======================================================== attività della giornata
{
  const client = fakeClient({
    issues: [
      {
        id: '1', key: 'ABC-1', fields: { summary: 'Mia' },
        changelog: {
          total: 2,
          histories: [
            { author: { accountId: IO }, created: quando(11), items: [{ field: 'status' }] },
            { author: { accountId: ALTRO }, created: quando(12), items: [{ field: 'assignee' }] }
          ]
        }
      },
      {
        id: '2', key: 'ABC-2', fields: { summary: 'Solo collega' },
        changelog: {
          total: 1,
          histories: [{ author: { accountId: ALTRO }, created: quando(14), items: [{ field: 'status' }] }]
        }
      },
      {
        id: '3', key: 'ABC-3', fields: { summary: 'Mia ma ieri' },
        changelog: {
          total: 1,
          histories: [{ author: { accountId: IO }, created: quando(11, 0, 9), items: [{ field: 'status' }] }]
        }
      }
    ]
  });

  const attivita = await collectJiraActivity(client, {
    isoDate: '2026-08-10', projects: ['ABC'], accountId: IO, scanComments: false
  });

  assert.deepEqual([...attivita.keys()], ['ABC-1'],
    'solo le issue che hai toccato tu, oggi');
  assert.equal(attivita.get('ABC-1').id, '1', 'l id serve al pannello Sviluppo');
  assert.equal(attivita.get('ABC-1').summary, 'Mia');
  assert.equal(attivita.get('ABC-1').events.length, 1, 'la modifica del collega non conta');
  // Il dettaglio del cambiamento viene conservato, non ridotto a un conteggio:
  // al piano basta contare, al registro delle attività serve sapere cosa è
  // cambiato e da cosa a cosa.
  assert.deepEqual(attivita.get('ABC-1').events[0].items, [{ field: 'status', from: '', to: '' }]);
  // `toString` e' anche un metodo che ogni oggetto eredita: senza un controllo
  // di tipo, un item senza quel campo restituisce la funzione al posto del testo.
  for (const chiave of ['from', 'to']) {
    assert.equal(typeof attivita.get('ABC-1').events[0].items[0][chiave], 'string',
      `${chiave} deve essere testo, non quello che l oggetto eredita`);
  }

  assert.match(client.chiamate.search[0].jql, /project in \(ABC\)/, 'la ricerca è ristretta ai progetti');
  assert.match(client.chiamate.search[0].jql, /updated >= "2026-08-10 00:00"/);
  assert.match(client.chiamate.search[0].jql, /updated < "2026-08-11 00:00"/, 'finestra di un giorno esatto');
  assert.equal(client.chiamate.comments.length, 0, 'con scanComments spento i commenti non si leggono');
}

// ======================================================== changelog troncato
{
  const client = fakeClient({
    issues: [{
      id: '1', key: 'ABC-1', fields: { summary: 'Storia lunga' },
      // La ricerca restituisce solo una parte della storia: il resto va richiesto.
      changelog: { total: 120, histories: [{ author: { accountId: ALTRO }, created: quando(8), items: [] }] }
    }],
    tail: {
      'ABC-1': [{ author: { accountId: IO }, created: quando(16), items: [{ field: 'status' }] }]
    }
  });

  const attivita = await collectJiraActivity(client, {
    isoDate: '2026-08-10', projects: [], accountId: IO, scanComments: false
  });

  assert.deepEqual(client.chiamate.tail, [{ key: 'ABC-1', total: 120 }],
    'con la storia troncata si chiede la coda');
  assert.ok(attivita.has('ABC-1'), 'e la modifica che stava nella coda viene trovata');
  assert.equal(client.chiamate.search[0].jql.startsWith('updated'), true,
    'senza progetti configurati la ricerca non ha il filtro');
}

// ======================================================== commenti
{
  const client = fakeClient({
    issues: [{ id: '1', key: 'ABC-1', fields: { summary: 'Con commenti' }, changelog: { total: 0, histories: [] } }],
    comments: {
      'ABC-1': [
        { author: { accountId: IO }, created: quando(15) },
        { author: { accountId: ALTRO }, created: quando(15, 30) },
        { author: { accountId: IO }, created: quando(15, 0, 9) }
      ]
    }
  });

  const attivita = await collectJiraActivity(client, {
    isoDate: '2026-08-10', projects: [], accountId: IO, scanComments: true
  });

  assert.equal(attivita.get('ABC-1').events.length, 1, 'solo il tuo commento di oggi');
  assert.equal(attivita.get('ABC-1').events[0].kind, 'comment');
}

// ======================================================== ore già registrate
{
  const client = fakeClient({
    issues: [
      { key: 'ABC-1', fields: { summary: 'Lavoro' } },
      { key: 'XYZ-9', fields: { summary: 'Riunione' } }
    ],
    worklogs: {
      'ABC-1': [
        { id: '101', author: { accountId: IO }, started: quando(10, 30), timeSpentSeconds: 150 * 60 },
        { id: '102', author: { accountId: ALTRO }, started: quando(11), timeSpentSeconds: 60 * 60 },
        { id: '103', author: { accountId: IO }, started: quando(14, 0, 9), timeSpentSeconds: 60 * 60 }
      ],
      'XYZ-9': [
        { id: '201', author: { accountId: IO }, started: quando(9, 30), timeSpentSeconds: 30 * 60 }
      ]
    }
  });

  const logged = await loggedMinutesForDay(client, { isoDate: '2026-08-10', accountId: IO });

  assert.equal(logged.reliable, true);
  assert.equal(logged.total, 180, '2h30 + 30m: il collega e il giorno prima non contano');
  assert.deepEqual(logged.byIssue, { 'ABC-1': 150, 'XYZ-9': 30 });

  assert.equal(logged.entries.length, 2, 'un elemento per worklog, non per issue');
  const riunione = logged.entries.find((e) => e.key === 'XYZ-9');
  assert.equal(riunione.id, '201', 'l id serve a cancellarne uno solo');
  assert.equal(riunione.startMinutes, 9 * 60 + 30, 'ora di inizio in minuti locali');
  assert.equal(riunione.minutes, 30);
  assert.equal(riunione.summary, 'Riunione');

  assert.match(client.chiamate.search[0].jql, /worklogAuthor = currentUser\(\)/);
  assert.match(client.chiamate.search[0].jql, /worklogDate = "2026-08-10"/);
  assert.ok(client.chiamate.worklogs.every((c) => typeof c.startedAfter === 'number'),
    'i worklog si chiedono a partire dall inizio giornata');
}

// ======================================================== ricerca non disponibile
{
  const client = {
    async search() { throw new Error('JQL non supportata'); },
    async getWorklogs() { return []; }
  };
  const logged = await loggedMinutesForDay(client, { isoDate: '2026-08-10', accountId: IO });
  assert.deepEqual(logged, { total: 0, byIssue: {}, issues: [], entries: [], reliable: false },
    'si prosegue senza scalare nulla, ma segnalando che il dato non è attendibile');
}

// ======================================================== issue senza permessi
{
  const client = fakeClient({ issues: [{ key: 'ABC-1', fields: { summary: 'x' } }] });
  client.getWorklogs = async () => { throw new Error('403'); };
  const logged = await loggedMinutesForDay(client, { isoDate: '2026-08-10', accountId: IO });
  assert.equal(logged.total, 0, 'una issue illeggibile non fa saltare il conto');
  assert.equal(logged.reliable, true);
}

console.log('lettura Jira: tutti i controlli passati.');
