// Le issue che hai creato tu. Non stanno nel changelog — creare non è
// modificare — quindi senza questa ricerca "ho aperto un ticket" resterebbe
// fuori dal registro.

import assert from 'node:assert/strict';
import { collectCreatedIssues } from '../src/lib/jira.js';

function fakeClient(risposta) {
  const chiamate = [];
  return {
    chiamate,
    async search(jql, opzioni) {
      chiamate.push({ jql, opzioni });
      if (risposta instanceof Error) throw risposta;
      return risposta;
    }
  };
}

// --- ricerca ben formata ---------------------------------------------------
{
  const client = fakeClient([
    { key: 'ABC-1', fields: { summary: 'Prima', created: '2026-08-11T09:00:00.000+0200' } },
    { key: 'ABC-2', fields: { summary: 'Seconda', created: '2026-08-11T14:00:00.000+0200' } }
  ]);

  const create = await collectCreatedIssues(client, { isoDate: '2026-08-11', projects: ['ABC'] });

  assert.deepEqual(create.map((i) => i.key), ['ABC-1', 'ABC-2']);
  assert.equal(create[0].summary, 'Prima');
  assert.equal(create[0].at, '2026-08-11T09:00:00.000+0200', 'l orario serve a collocarla nel registro');

  const { jql } = client.chiamate[0];
  assert.match(jql, /creator = currentUser\(\)/, 'solo quelle aperte da te');
  assert.match(jql, /created >= "2026-08-11 00:00"/);
  assert.match(jql, /created < "2026-08-12 00:00"/, 'finestra di un giorno esatto');
  assert.match(jql, /project in \(ABC\)/, 'ristretta ai progetti configurati');
  assert.match(jql, /ORDER BY created ASC/, 'in ordine di creazione');
}

// --- senza progetti configurati la ricerca non ha il filtro ---------------
{
  const client = fakeClient([]);
  await collectCreatedIssues(client, { isoDate: '2026-08-11', projects: [] });
  assert.ok(client.chiamate[0].jql.startsWith('creator ='), 'nessun filtro progetto appeso davanti');
}

// --- se `creator` non è interrogabile, il registro perde le creazioni ------
//     ma non si ferma: il resto degli eventi resta valido.
{
  const client = fakeClient(new Error('Field creator not searchable'));
  const create = await collectCreatedIssues(client, { isoDate: '2026-08-11', projects: ['ABC'] });
  assert.deepEqual(create, [], 'elenco vuoto, non un errore che fa saltare tutto');
}

// --- campi mancanti non producono valori sporchi --------------------------
{
  const client = fakeClient([{ key: 'ABC-9', fields: {} }]);
  const [creata] = await collectCreatedIssues(client, { isoDate: '2026-08-11', projects: [] });
  assert.equal(creata.summary, '');
  assert.equal(creata.at, null, 'senza data l evento verrà scartato, non collocato a caso');
}

console.log('issue create: tutti i controlli passati.');
