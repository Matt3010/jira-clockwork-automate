// Il client Jira: come costruisce le richieste, come legge gli errori, e il
// ripiego della ricerca sull'endpoint vecchio. Quest'ultimo è logica vera —
// se salta, l'analisi non trova più nessuna issue.

import assert from 'node:assert/strict';
import { JiraClient, JiraError } from '../src/lib/jira.js';

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

// ---------------------------------------------------------------- querystring
{
  const ch = canale(() => json({ ok: true }));
  const jira = new JiraClient(ch);
  await jira.getIssue('ABC-1', ['summary', 'status']);
  assert.equal(ch.chiamate[0].path, '/rest/api/3/issue/ABC-1?fields=summary%2Cstatus');

  await jira.getWorklogs('ABC-1', 1234);
  assert.equal(ch.chiamate[1].path, '/rest/api/3/issue/ABC-1/worklog?startedAfter=1234');

  // le chiavi con caratteri strani vanno codificate, non concatenate
  await jira.getIssue('ABC 1/2');
  assert.match(ch.chiamate[2].path, /issue\/ABC%201%2F2/);
}

// ---------------------------------------------------------------- errori leggibili
{
  const messaggi = new JiraClient(canale(() => json({ errorMessages: ['Issue non trovata'] }, 404)));
  await assert.rejects(messaggi.getIssue('ABC-1'), (e) => {
    assert.ok(e instanceof JiraError);
    assert.equal(e.status, 404);
    assert.match(e.message, /Issue non trovata/);
    return true;
  });

  const campi = new JiraClient(canale(() => json({ errors: { timeSpentSeconds: 'valore non valido' } }, 400)));
  await assert.rejects(campi.addWorklog('ABC-1', { started: 'x', timeSpentSeconds: 0 }),
    (e) => /timeSpentSeconds: valore non valido/.test(e.message));

  const html = new JiraClient(canale(() => ({ status: 500, text: '<html>errore</html>', contentType: 'text/html' })));
  await assert.rejects(html.getIssue('ABC-1'), (e) => /Jira 500/.test(e.message));
}

// ---------------------------------------------------------------- risposta vuota
{
  const ch = canale(() => ({ status: 204, text: '', contentType: '' }));
  const jira = new JiraClient(ch);
  assert.equal(await jira.deleteWorklog('ABC-1', '99'), null, 'un 204 senza corpo non è un errore');
  assert.equal(ch.chiamate[0].method, 'DELETE');
  assert.match(ch.chiamate[0].path, /\/worklog\/99\?notifyUsers=false/, 'cancellare non deve spammare notifiche');
}

// ---------------------------------------------------------------- ricerca e ripiego
{
  // endpoint nuovo disponibile
  const nuovo = canale((path) => (path.startsWith('/rest/api/3/search/jql')
    ? json({ issues: [{ key: 'ABC-1' }] })
    : json({ errorMessages: ['non dovrebbe arrivarci'] }, 500)));
  const jira = new JiraClient(nuovo);
  assert.deepEqual(await jira.search('project = ABC', { expand: 'changelog' }), [{ key: 'ABC-1' }]);
  assert.equal(nuovo.chiamate.length, 1, 'nessun tentativo in più quando il primo funziona');
  assert.equal(nuovo.chiamate[0].method, 'POST');
  assert.equal(nuovo.chiamate[0].body.expand, 'changelog', 'sul nuovo endpoint expand è una stringa');

  // endpoint nuovo assente: si ripiega
  for (const status of [400, 404, 410]) {
    const vecchio = canale((path) => (path.startsWith('/rest/api/3/search/jql')
      ? json({ errorMessages: ['no'] }, status)
      : json({ issues: [{ key: 'ABC-9' }] })));
    const client = new JiraClient(vecchio);
    assert.deepEqual(await client.search('project = ABC', { expand: 'changelog' }), [{ key: 'ABC-9' }],
      `ripiego su ${status}`);
    assert.equal(vecchio.chiamate.length, 2);
    assert.equal(vecchio.chiamate[1].path, '/rest/api/3/search');
    assert.deepEqual(vecchio.chiamate[1].body.expand, ['changelog'],
      'sul vecchio endpoint expand è un elenco');
  }

  // un errore diverso non deve essere scambiato per "endpoint assente"
  const rotto = canale(() => json({ errorMessages: ['JQL non valida'] }, 401));
  await assert.rejects(new JiraClient(rotto).search('roba'), (e) => e.status === 401);
  assert.equal(rotto.chiamate.length, 1, 'su un 401 non si riprova: le credenziali non cambiano');
}

// ---------------------------------------------------------------- scrittura worklog
{
  const ch = canale(() => json({ id: '1' }));
  const jira = new JiraClient(ch);
  await jira.addWorklog('ABC-1', {
    started: '2026-08-10T09:00:00.000+0200',
    timeSpentSeconds: 3600,
    comment: 'Avanzamento'
  });
  const body = ch.chiamate[0].body;
  assert.equal(body.started, '2026-08-10T09:00:00.000+0200');
  assert.equal(body.timeSpentSeconds, 3600);
  assert.equal(body.comment.type, 'doc', 'il commento va in Atlassian Document Format');
  assert.equal(body.comment.content[0].content[0].text, 'Avanzamento');

  await jira.addWorklog('ABC-1', { started: 'x', timeSpentSeconds: 60 });
  assert.equal(ch.chiamate[1].body.comment, undefined, 'senza nota non si manda un documento vuoto');
}

// ---------------------------------------------------------------- pannello Sviluppo
{
  const ch = canale(() => json({ detail: [] }));
  await new JiraClient(ch).getDevelopment('10001', 'bitbucket');
  assert.match(ch.chiamate[0].path, /dev-status\/1\.0\/issue\/detail\?/);
  assert.match(ch.chiamate[0].path, /issueId=10001/);
  assert.match(ch.chiamate[0].path, /applicationType=bitbucket/);
  assert.match(ch.chiamate[0].path, /dataType=repository/);
}

console.log('client Jira: tutti i controlli passati.');
