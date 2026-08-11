// I ticket che hai aperti: come si chiedono a Jira, come si mettono in ordine
// e come si spostano di stato.
//
// È l'unica parte dell'estensione che *scrive* qualcosa che non sia un
// worklog: sbagliare l'id di una transizione muove il ticket sbagliato, e non
// c'è un annulla.

import assert from 'node:assert/strict';
import { JiraClient, collectOpenIssues } from '../src/lib/jira.js';
import {
  groupOpenIssues, openedOn, planStep, statesForType, usefulTransitions
} from '../src/lib/ticket.js';

function fakeClient(issues) {
  const chiamate = [];
  return {
    chiamate,
    async search(jql, opzioni) {
      chiamate.push({ jql, opzioni });
      return issues;
    }
  };
}

function canale(rispondi) {
  const chiamate = [];
  return {
    chiamate,
    async request(path, opzioni = {}) {
      chiamate.push({ path, ...opzioni });
      return rispondi(path, opzioni);
    }
  };
}
const json = (corpo, status = 200) => ({ status, text: JSON.stringify(corpo), contentType: 'application/json' });

const issue = (key, status, category, created, extra = {}) => ({
  key,
  fields: {
    summary: `Titolo di ${key}`,
    status: { name: status, statusCategory: { key: category } },
    created,
    updated: created,
    issuetype: { name: 'Task' },
    ...extra
  }
});

// ======================================================== la ricerca
{
  const client = fakeClient([issue('ABC-1', 'In corso', 'indeterminate', '2026-08-04T09:00:00.000+0200')]);
  const aperti = await collectOpenIssues(client, { projects: ['ABC', 'XYZ'] });

  const { jql, opzioni } = client.chiamate[0];
  assert.match(jql, /assignee = currentUser\(\)/, 'solo i tuoi');
  assert.match(jql, /statusCategory != Done/, 'e solo quelli non chiusi');
  assert.match(jql, /project in \(ABC, XYZ\)/, 'ristretta ai progetti configurati');
  assert.match(jql, /ORDER BY updated DESC/);
  // Senza `status` fra i campi non si potrebbe raggruppare, e senza `created`
  // non si potrebbe dividere per data: sono i due assi della vista.
  for (const campo of ['summary', 'status', 'created']) {
    assert.ok(opzioni.fields.includes(campo), `manca il campo ${campo}`);
  }

  assert.deepEqual(aperti[0], {
    key: 'ABC-1',
    summary: 'Titolo di ABC-1',
    status: 'In corso',
    category: 'indeterminate',
    type: 'Task',
    created: '2026-08-04T09:00:00.000+0200',
    updated: '2026-08-04T09:00:00.000+0200'
  });
}

// --- senza progetti configurati la ricerca non ha il filtro ---------------
{
  const client = fakeClient([]);
  await collectOpenIssues(client, { projects: [] });
  assert.ok(client.chiamate[0].jql.startsWith('assignee ='), 'nessun filtro progetto appeso davanti');
}

// --- campi mancanti non producono valori sporchi --------------------------
{
  const client = fakeClient([{ key: 'ABC-9', fields: {} }]);
  const [aperto] = await collectOpenIssues(client, { projects: [] });
  assert.equal(aperto.summary, '');
  assert.equal(aperto.status, '');
  assert.equal(aperto.created, null);
  // Categoria vuota, non inventata: finirà nel gruppo "non si sa", che è dove
  // sta davvero. Dichiararla "in corso" sarebbe una comodità bugiarda.
  assert.equal(aperto.category, '');
}

// ======================================================== raggruppamento
{
  const gruppi = groupOpenIssues([
    issue('ABC-3', 'Da fare', 'new', '2026-08-10T09:00:00.000+0200'),
    issue('ABC-1', 'In corso', 'indeterminate', '2026-08-04T09:00:00.000+0200'),
    issue('ABC-2', 'In corso', 'indeterminate', '2026-08-10T15:00:00.000+0200'),
    issue('ABC-4', 'Da fare', 'new', '2026-08-10T18:00:00.000+0200'),
    issue('ABC-5', 'In revisione', 'indeterminate', '2026-07-01T09:00:00.000+0200')
  ].map((i) => ({
    key: i.key,
    summary: i.fields.summary,
    status: i.fields.status.name,
    category: i.fields.status.statusCategory.key,
    created: i.fields.created
  })));

  // Quello che stai già facendo sta sopra a quello che devi cominciare, e a
  // parità di categoria l'ordine è alfabetico — stabile, non casuale.
  assert.deepEqual(gruppi.map((g) => g.status), ['In corso', 'In revisione', 'Da fare']);
  assert.deepEqual(gruppi.map((g) => g.count), [2, 1, 2]);

  const inCorso = gruppi[0];
  assert.deepEqual(inCorso.days.map((g) => g.day), ['2026-08-10', '2026-08-04'],
    'dentro lo stato, il giorno più recente in cima');
  assert.deepEqual(inCorso.days[0].issues.map((i) => i.key), ['ABC-2']);

  const daFare = gruppi[2];
  assert.equal(daFare.days.length, 1, 'due ticket aperti lo stesso giorno stanno sotto una data sola');
  assert.deepEqual(daFare.days[0].issues.map((i) => i.key), ['ABC-3', 'ABC-4'],
    'e a parità di giorno l ordine è quello delle chiavi');
}

// --- date mancanti in fondo, non in cima ----------------------------------
{
  const [gruppo] = groupOpenIssues([
    { key: 'ABC-1', status: 'Da fare', category: 'new', created: null },
    { key: 'ABC-2', status: 'Da fare', category: 'new', created: '2026-01-05T09:00:00.000+0100' }
  ]);
  assert.deepEqual(gruppo.days.map((g) => g.day), ['2026-01-05', ''],
    'un ticket senza data è un dato mancante, non il più vecchio di tutti');
}

// --- il numero dell'ordinamento non deve essere alfabetico ----------------
{
  const [gruppo] = groupOpenIssues(
    ['ABC-10', 'ABC-9', 'ABC-100'].map((key) => ({
      key, status: 'Da fare', category: 'new', created: '2026-08-10T09:00:00.000+0200'
    }))
  );
  assert.deepEqual(gruppo.days[0].issues.map((i) => i.key), ['ABC-9', 'ABC-10', 'ABC-100'],
    'ABC-100 non viene prima di ABC-9');
}

// --- niente in ingresso, niente in uscita ---------------------------------
assert.deepEqual(groupOpenIssues([]), []);
assert.deepEqual(groupOpenIssues(undefined), []);
assert.deepEqual(groupOpenIssues([{ summary: 'senza chiave' }]), [],
  'una issue senza chiave non è cliccabile né spostabile: non si mostra');

// --- la data di apertura ---------------------------------------------------
assert.equal(openedOn({ created: '2026-08-04T23:30:00.000+0200' }), '2026-08-04');
assert.equal(openedOn({ created: 'non una data' }), '');
assert.equal(openedOn({}), '');
assert.equal(openedOn(null), '');

// ======================================================== transizioni
{
  const ch = canale((path, opzioni) => {
    if (opzioni.method === 'POST') return { status: 204, text: '', contentType: '' };
    return json({
      transitions: [
        { id: '11', name: 'Inizia', to: { name: 'In corso', statusCategory: { key: 'indeterminate' } } },
        { id: '21', name: 'Chiudi', to: { name: 'Fatto', statusCategory: { key: 'done' } } }
      ]
    });
  });
  const jira = new JiraClient(ch);

  const transizioni = await jira.getTransitions('ABC-1');
  assert.equal(ch.chiamate[0].path, '/rest/api/3/issue/ABC-1/transitions');
  assert.deepEqual(transizioni[0], { id: '11', name: 'Inizia', to: 'In corso', category: 'indeterminate' });

  await jira.transitionIssue('ABC-1', 11);
  const scrittura = ch.chiamate[1];
  assert.equal(scrittura.method, 'POST');
  assert.equal(scrittura.path, '/rest/api/3/issue/ABC-1/transitions');
  // Jira vuole l'id come stringa: passando un numero la richiesta viene
  // rifiutata, e il ticket resta dov'era senza che nessuno lo dica.
  assert.deepEqual(scrittura.body, { transition: { id: '11' } });

  await jira.getTransitions('ABC 1/2');
  assert.match(ch.chiamate[2].path, /issue\/ABC%201%2F2\/transitions/, 'la chiave va codificata');
}

// --- quella che riporta dove sei già non serve a niente -------------------
{
  const elenco = [
    { id: '11', name: 'Riapri', to: 'In corso' },
    { id: '21', name: 'Chiudi', to: 'Fatto' },
    { name: 'Senza id', to: 'Altro' }
  ];
  assert.deepEqual(usefulTransitions(elenco, 'In corso').map((t) => t.id), ['21'],
    'lo stato in cui sei già non è uno spostamento');
  assert.deepEqual(usefulTransitions(elenco, 'in CORSO').map((t) => t.id), ['21'],
    'e il confronto non deve dipendere dalle maiuscole');

  const senzaId = usefulTransitions([{ name: 'Rotta', to: 'Fatto' }], 'Da fare');
  assert.deepEqual(senzaId, [], 'senza id non si può spostare niente: non si mostra un tasto finto');

  assert.deepEqual(usefulTransitions(undefined, 'Da fare'), []);
  assert.deepEqual(usefulTransitions(elenco, '').map((t) => t.id), ['11', '21'],
    'senza stato di partenza non si scarta nulla');
}

// ======================================================== gli stati del progetto
{
  const ch = canale(() => json([
    { name: 'Bug', statuses: [{ id: '1', name: 'Aperto', statusCategory: { key: 'new' } }] },
    { name: 'Task', statuses: [{ id: '2', name: 'Da fare', statusCategory: { key: 'new' } }] }
  ]));
  const jira = new JiraClient(ch);
  const perTipo = await jira.getProjectStatuses('ABC');
  assert.equal(ch.chiamate[0].path, '/rest/api/3/project/ABC/statuses');
  assert.deepEqual(perTipo[0], {
    type: 'Bug', statuses: [{ id: '1', name: 'Aperto', category: 'new' }]
  });

  // Il workflow dipende dal tipo: offrire a un bug gli stati di una storia
  // porta a un salto che si ferma al primo passo.
  assert.deepEqual(statesForType(perTipo, 'Task').map((s) => s.name), ['Da fare']);
  assert.deepEqual(statesForType(perTipo, 'task').map((s) => s.name), ['Da fare'],
    'il tipo si confronta senza badare alle maiuscole');
  assert.deepEqual(statesForType(perTipo, 'Epic').map((s) => s.name), ['Aperto'],
    'un tipo sconosciuto ripiega sul primo elenco: un ordine approssimato è meglio di nessuno');
  assert.deepEqual(statesForType([], 'Task'), []);
  assert.deepEqual(statesForType(undefined, 'Task'), []);
}

// ======================================================== salti di più stati
// Il workflow di esempio, lineare come quasi tutti:
const ORDINE = ['To Do', 'IN PROGRESS', 'DEV PR', 'DEV TEST', 'STAGE PR', 'Stage test', 'Done']
  .map((name) => ({ name, category: name === 'Done' ? 'done' : 'indeterminate' }));

const tr = (id, to) => ({ id, name: to, to, category: 'indeterminate' });

// --- se ci si arriva in un colpo, si va e basta ---------------------------
{
  const passo = planStep({
    from: 'To Do', to: 'IN PROGRESS', order: ORDINE,
    transitions: [tr('11', 'IN PROGRESS'), tr('21', 'DEV PR')]
  });
  assert.equal(passo.to, 'IN PROGRESS');
}

// --- altrimenti si avanza il più possibile senza superare il bersaglio ----
{
  // Da "To Do" verso "Stage test": Jira offre solo i primi due passi.
  const passo = planStep({
    from: 'To Do', to: 'Stage test', order: ORDINE,
    transitions: [tr('11', 'IN PROGRESS'), tr('21', 'DEV PR')]
  });
  assert.equal(passo.to, 'DEV PR', 'fra i passi possibili si prende quello che avvicina di più');
}
{
  // Superare il bersaglio significherebbe dover tornare indietro, e ogni
  // passaggio lascia una riga nel changelog del ticket.
  const passo = planStep({
    from: 'To Do', to: 'DEV PR', order: ORDINE,
    transitions: [tr('11', 'IN PROGRESS'), tr('31', 'Done')]
  });
  assert.equal(passo.to, 'IN PROGRESS', 'meglio un passo corto che oltrepassare');
}

// --- si torna anche indietro ----------------------------------------------
{
  const passo = planStep({
    from: 'Stage test', to: 'IN PROGRESS', order: ORDINE,
    transitions: [tr('11', 'DEV TEST'), tr('21', 'Done')]
  });
  assert.equal(passo.to, 'DEV TEST', 'verso il bersaglio, non nella direzione opposta');
}

// --- quando non c'è strada ci si ferma ------------------------------------
{
  assert.equal(
    planStep({
      from: 'To Do', to: 'Stage test', order: ORDINE, transitions: [tr('11', 'Done')]
    }),
    null,
    'l unica transizione supera il bersaglio: fermarsi è meglio che finire altrove'
  );

  assert.equal(planStep({ from: 'To Do', to: 'To Do', order: ORDINE, transitions: [tr('11', 'Done')] }),
    null, 'sei già dove volevi andare');

  assert.equal(
    planStep({
      from: 'Uno stato fuori elenco', to: 'Stage test', order: ORDINE, transitions: [tr('11', 'DEV PR')]
    }),
    null,
    'senza sapere da dove si parte non c è direzione: tirare a indovinare sposterebbe a caso'
  );

  assert.equal(
    planStep({
      from: 'To Do', to: 'Stato che non esiste', order: ORDINE, transitions: [tr('11', 'DEV PR')]
    }),
    null,
    'e nemmeno senza sapere dove si vuole arrivare'
  );

  assert.equal(planStep({ from: 'To Do', to: 'DEV PR', order: ORDINE, transitions: [] }), null);
  assert.equal(planStep({ from: 'To Do', to: 'DEV PR', order: ORDINE, transitions: undefined }), null);
  assert.equal(
    planStep({ from: 'To Do', to: 'DEV PR', order: ORDINE, transitions: [{ to: 'DEV PR' }] }),
    null,
    'una transizione senza id non è applicabile'
  );
}

// --- il percorso completo, un passo alla volta ----------------------------
// È il caso dello screenshot: sei spostamenti a mano per attraversare il
// workflow. Qui si verifica che la catena arrivi davvero in fondo.
{
  const disponibili = {
    'To Do': ['IN PROGRESS'],
    'IN PROGRESS': ['DEV PR', 'To Do'],
    'DEV PR': ['DEV TEST'],
    'DEV TEST': ['STAGE PR'],
    'STAGE PR': ['Stage test']
  };

  let corrente = 'To Do';
  const percorso = [];
  for (let i = 0; i < 8; i += 1) {
    const passo = planStep({
      from: corrente,
      to: 'Stage test',
      order: ORDINE,
      transitions: (disponibili[corrente] || []).map((to, n) => tr(`${n}`, to))
    });
    if (!passo) break;
    corrente = passo.to;
    percorso.push(passo.to);
    if (corrente === 'Stage test') break;
  }

  assert.deepEqual(percorso, ['IN PROGRESS', 'DEV PR', 'DEV TEST', 'STAGE PR', 'Stage test']);
  assert.ok(!percorso.includes('To Do'), 'non deve tornare indietro strada facendo');
}

// --- e uno che si ferma a metà --------------------------------------------
{
  // Da "DEV PR" in avanti il workflow si biforca e Jira non offre niente che
  // avvicini: il ticket resta lì, e chi ha cliccato deve saperlo.
  const passo = planStep({
    from: 'DEV PR', to: 'Stage test', order: ORDINE, transitions: [tr('11', 'To Do')]
  });
  assert.equal(passo, null);
}

console.log('ticket aperti: tutti i controlli passati.');
