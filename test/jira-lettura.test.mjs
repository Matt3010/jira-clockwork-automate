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
  // La finestra è larga una settimana, non un giorno: `updated` è l'*ultima*
  // modifica della issue, non «è stata modificata quel giorno». Con un giorno
  // esatto, un ticket ripreso in mano il giorno dopo spariva dal giorno in cui
  // ci avevi lavorato — cioè proprio quando compili ieri stamattina.
  assert.match(client.chiamate.search[0].jql, /updated < "2026-08-17 00:00"/,
    'sette giorni: con la finestra di uno i giorni passati si svuotano da soli');
  // E non oltre: senza limite superiore, su un giorno di mesi fa «toccate da
  // allora» sono migliaia, il tetto scatta sempre e quello che rientra è
  // rumore — una giornata vuota con l avviso che dice che manca qualcosa.
  assert.doesNotMatch(client.chiamate.search[0].jql, /updated >= "2026-08-10 00:00" ORDER/,
    'la rete larga senza fondo riporta rumore e basta');
  // E in ordine crescente: col tetto di 100 il decrescente riempirebbe
  // l elenco con le issue calde di oggi e taglierebbe quelle ferme dal giorno
  // che stai guardando.
  assert.match(client.chiamate.search[0].jql, /ORDER BY updated ASC/);
  assert.equal(client.chiamate.comments.length, 0, 'con scanComments spento i commenti non si leggono');
}

// ======================================================== quello che fanno gli altri sulle tue
// Farsi assegnare un ticket da un collega non lasciava traccia da nessuna
// parte: la modifica porta il suo nome, non il tuo, e veniva scartata. Il
// ticket non compariva né nel registro né fra le righe — e chi lo cercava
// premeva Aggiorna a vuoto.
{
  const client = fakeClient({
    issues: [
      {
        id: '1', key: 'ABC-1',
        fields: { summary: 'Assegnata a me', assignee: { accountId: IO } },
        changelog: {
          total: 1,
          histories: [{
            author: { accountId: ALTRO, displayName: 'Dario Decarlo' },
            created: quando(17),
            items: [{ field: 'assignee', toString: 'Matteo Scanferla' }]
          }]
        }
      },
      {
        id: '2', key: 'ABC-2',
        fields: { summary: 'Aperta da me, in mano ad altri', reporter: { accountId: IO } },
        changelog: {
          total: 1,
          histories: [{
            author: { accountId: ALTRO, displayName: 'Dario Decarlo' },
            created: quando(16),
            items: [{ field: 'status', fromString: 'To Do', toString: 'In Progress' }]
          }]
        }
      },
      {
        id: '3', key: 'ABC-3',
        fields: { summary: 'Di un altro, mossa da un altro' },
        changelog: {
          total: 1,
          histories: [{
            author: { accountId: ALTRO, displayName: 'Dario Decarlo' },
            created: quando(15), items: [{ field: 'status' }]
          }]
        }
      },
      {
        id: '4', key: 'ABC-4',
        fields: { summary: 'Mia, ma solo contabilità', assignee: { accountId: IO } },
        changelog: {
          total: 1,
          histories: [{
            author: { accountId: ALTRO, displayName: 'Dario Decarlo' },
            created: quando(14), items: [{ field: 'timespent', toString: '3600' }]
          }]
        }
      }
    ]
  });

  const attivita = await collectJiraActivity(client, {
    isoDate: '2026-08-10', projects: [], accountId: IO, scanComments: false
  });

  assert.deepEqual([...attivita.keys()].sort(), ['ABC-1', 'ABC-2'],
    'le tue per assegnazione o per richiesta, non mezzo progetto');

  // `foreign` le tiene distinte dalle tue: da qui in poi decidono se la riga
  // parte accesa e se il registro ci mette sopra un nome.
  const assegnata = attivita.get('ABC-1').events[0];
  assert.equal(assegnata.kind, 'foreign', 'non è lavoro tuo e non deve sembrarlo');
  assert.equal(assegnata.by, 'Dario Decarlo', 'con il nome di chi l ha fatto');
  assert.deepEqual(assegnata.items, [{ field: 'assignee', from: '', to: 'Matteo Scanferla' }]);
  assert.equal(attivita.get('ABC-2').events[0].kind, 'foreign');

  // La contabilità resta esclusa anche quando la muove un altro: quelle righe
  // le genera la registrazione delle ore, non una persona.
  assert.ok(!attivita.has('ABC-4'), 'timespent mosso da altri non è una cosa che ti riguarda');

  for (const campo of ['assignee', 'reporter']) {
    assert.ok(client.chiamate.search[0].opzioni.fields.includes(campo),
      `senza ${campo} non si può sapere se la issue è tua`);
  }
}

// ======================================================== quando la rete larga tocca il tetto
// Allargata la ricerca, il tetto di 100 si può raggiungere per davvero su un
// giorno vecchio. Raggiunto, la giornata è incompleta: va detto a chi guarda,
// non lasciato indovinare da una riga che manca.
{
  const tante = Array.from({ length: 100 }, (_, i) => ({
    id: String(i), key: `ABC-${i}`, fields: { summary: 'x' },
    changelog: { total: 0, histories: [] }
  }));
  const piena = await collectJiraActivity(fakeClient({ issues: tante }), {
    isoDate: '2026-08-10', projects: [], accountId: IO, scanComments: false
  });
  assert.equal(piena.truncated, true, 'il tetto raggiunto va segnalato');

  const scarsa = await collectJiraActivity(fakeClient({ issues: tante.slice(0, 99) }), {
    isoDate: '2026-08-10', projects: [], accountId: IO, scanComments: false
  });
  assert.equal(scarsa.truncated, false, 'sotto il tetto non c è niente da dire');
}

// ======================================================== e sempre del giorno scelto
// La riga scrive un'ora sola, senza data: regge solo perché tutto quello che
// entra è del giorno che stai guardando. Una modifica di ieri su una issue tua
// scriverebbe «14:00» in mezzo a oggi, e nessuno saprebbe che è di ieri.
{
  const client = fakeClient({
    issues: [{
      id: '1', key: 'ABC-1',
      fields: { summary: 'Mia, mossa ieri da un collega', assignee: { accountId: IO } },
      changelog: {
        total: 2,
        histories: [
          {
            author: { accountId: ALTRO, displayName: 'Dario Decarlo' },
            created: quando(14, 0, 9),
            items: [{ field: 'status', fromString: 'To Do', toString: 'In Progress' }]
          },
          {
            author: { accountId: ALTRO, displayName: 'Dario Decarlo' },
            created: quando(16),
            items: [{ field: 'priority', fromString: 'Low', toString: 'High' }]
          }
        ]
      }
    }]
  });

  const attivita = await collectJiraActivity(client, {
    isoDate: '2026-08-10', projects: [], accountId: IO, scanComments: false
  });

  assert.equal(attivita.get('ABC-1').events.length, 1, 'quella di ieri resta fuori');
  assert.deepEqual(attivita.get('ABC-1').events[0].items.map((i) => i.field), ['priority']);
}

// ======================================================== assegnata *a te*, non solo riassegnata
// Il campo assegnatario cambia anche quando la issue passa da un collega a un
// altro: leggere solo "il campo è cambiato" faceva scrivere «te l'ha
// assegnata» sotto una task che a te non era arrivata. Nel changelog `to` è
// l'accountId del nuovo assegnatario, ed è quello che decide.
{
  const storia = (chi, versoId, versoNome) => ({
    total: 1,
    histories: [{
      author: { accountId: ALTRO, displayName: chi },
      created: quando(16),
      items: [{ field: 'assignee', to: versoId, toString: versoNome }]
    }]
  });

  const client = fakeClient({
    issues: [
      {
        id: '1', key: 'ABC-1',
        fields: { summary: 'Passata a te', assignee: { accountId: IO } },
        changelog: storia('Dario Decarlo', IO, 'Matteo Scanferla')
      },
      {
        id: '2', key: 'ABC-2',
        fields: { summary: 'Passata a un terzo', reporter: { accountId: IO } },
        changelog: storia('Alessandro Greggio', 'account-terzo', 'Terza Persona')
      },
      {
        id: '3', key: 'ABC-3',
        fields: { summary: 'Istanza senza accountId nel changelog', assignee: { accountId: IO } },
        changelog: storia('Dario Decarlo', '', 'Matteo Scanferla')
      }
    ]
  });

  const attivita = await collectJiraActivity(client, {
    isoDate: '2026-08-10', projects: [], accountId: IO, displayName: 'Matteo Scanferla', scanComments: false
  });

  assert.equal(attivita.get('ABC-1').events[0].assignsYou, true);
  assert.equal(attivita.get('ABC-2').events[0].assignsYou, false,
    'riassegnata fra altri due: la issue ti riguarda, ma non te l ha assegnata nessuno');
  assert.equal(attivita.get('ABC-3').events[0].assignsYou, true,
    'senza accountId resta il nome, o le istanze che non lo mandano perdono il caso');
}

// ======================================================== commenti altrui sulle tue
{
  const client = fakeClient({
    issues: [
      {
        id: '1', key: 'ABC-1',
        fields: { summary: 'Mia', assignee: { accountId: IO } },
        changelog: { total: 0, histories: [] }
      },
      {
        id: '2', key: 'ABC-2',
        fields: { summary: 'Di un altro' },
        changelog: { total: 0, histories: [] }
      }
    ],
    comments: {
      'ABC-1': [{ author: { accountId: ALTRO, displayName: 'Dario Decarlo' }, created: quando(15) }],
      'ABC-2': [{ author: { accountId: ALTRO, displayName: 'Dario Decarlo' }, created: quando(15) }]
    }
  });

  const attivita = await collectJiraActivity(client, {
    isoDate: '2026-08-10', projects: [], accountId: IO, scanComments: true
  });

  assert.deepEqual([...attivita.keys()], ['ABC-1'], 'ti riguarda il commento sotto una issue tua');
  assert.equal(attivita.get('ABC-1').events[0].kind, 'foreignComment');
  assert.equal(attivita.get('ABC-1').events[0].by, 'Dario Decarlo');
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

// ======================================================== contabilità dei worklog
// Registrare ore genera modifiche al changelog (WorklogId, timespent…). Non
// sono attività: le produce anche questa estensione scrivendo i worklog, e
// tenerle è circolare — registri ore, l'analisi dopo le legge come lavoro.
{
  const client = fakeClient({
    issues: [
      {
        id: '1', key: 'ABC-1', fields: { summary: 'Solo contabilità' },
        changelog: {
          total: 1,
          histories: [{
            author: { accountId: IO }, created: quando(10, 9),
            items: [
              { field: 'WorklogId', toString: '102322' },
              { field: 'timespent', toString: '275520' },
              { field: 'timeestimate', toString: '0' }
            ]
          }]
        }
      },
      {
        id: '2', key: 'ABC-2', fields: { summary: 'Lavoro vero' },
        changelog: {
          total: 1,
          histories: [{
            author: { accountId: IO }, created: quando(10, 31),
            items: [
              { field: 'status', fromString: 'To Do', toString: 'In Progress' },
              { field: 'timespent', toString: '3600' }
            ]
          }]
        }
      }
    ]
  });

  const attivita = await collectJiraActivity(client, {
    isoDate: '2026-08-10', projects: [], accountId: IO, scanComments: false
  });

  assert.deepEqual([...attivita.keys()], ['ABC-2'],
    'una issue toccata solo dalla contabilità non è attività: sparisce');
  assert.deepEqual(
    attivita.get('ABC-2').events[0].items.map((i) => i.field), ['status'],
    'e dove c è del lavoro vero, la contabilità viene tolta da sotto'
  );
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
