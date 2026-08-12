// Il client Jira: come costruisce le richieste e come legge gli errori.
//
// La ricerca passa da `/search/jql` e basta: il ripiego sull'endpoint vecchio
// è stato tolto quando Atlassian l'ha rimosso da Jira Cloud (1° maggio 2025).
// Quello che resta da verificare è che un errore arrivi fino a chi ha chiesto,
// invece di diventare un secondo tentativo destinato a fallire.

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

// ---------------------------------------------------------------- ricerca
{
  const ch = canale((path) => (path.startsWith('/rest/api/3/search/jql')
    ? json({ issues: [{ key: 'ABC-1' }] })
    : json({ errorMessages: ['endpoint sbagliato'] }, 500)));
  const jira = new JiraClient(ch);

  assert.deepEqual(await jira.search('project = ABC', { expand: 'changelog' }), [{ key: 'ABC-1' }]);
  assert.equal(ch.chiamate.length, 1, 'una ricerca, una richiesta');
  assert.equal(ch.chiamate[0].method, 'POST');
  assert.equal(ch.chiamate[0].body.expand, 'changelog', 'su questo endpoint expand è una stringa');
  // I campi vanno chiesti per nome: il nuovo endpoint non ne restituisce
  // nessuno di sua iniziativa, e una ricerca senza `fields` torna monca.
  assert.ok(ch.chiamate[0].body.fields.length, 'i campi vanno sempre dichiarati');

  // Ogni errore deve arrivare intero a chi ha chiesto. Il 400 è quello che
  // conta: è la risposta a una chiave progetto sbagliata nelle opzioni, e
  // finché veniva scambiato per «endpoint assente» chi guardava leggeva il 404
  // del tentativo successivo invece del motivo vero.
  for (const status of [400, 404, 410, 401]) {
    const rotto = canale(() => json({ errorMessages: ['JQL non valida'] }, status));
    const client = new JiraClient(rotto);
    await assert.rejects(client.search('project = SBAGLIATO'), (e) => {
      assert.equal(e.status, status, `un ${status} deve restare un ${status}`);
      assert.match(e.message, /JQL non valida/, 'col messaggio che Jira ha dato');
      return true;
    });
    assert.equal(rotto.chiamate.length, 1, `su un ${status} non si riprova da nessun altra parte`);
  }
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

  // La nota precompilata è la lista dei commit, uno per riga. Un a capo dentro
  // un nodo di testo ADF non è un a capo: Jira lo mostra come uno spazio, e la
  // lista tornerebbe una frase sola. Ogni riga deve diventare un paragrafo.
  await jira.addWorklog('ABC-1', {
    started: 'x',
    timeSpentSeconds: 60,
    comment: 'feat: prima cosa\nfix: seconda cosa\n\nchore: terza cosa'
  });
  const multi = ch.chiamate.at(-1).body.comment;
  assert.equal(multi.content.length, 3, 'una riga, un paragrafo — e le righe vuote non ne fanno uno');
  assert.deepEqual(
    multi.content.map((p) => p.content[0].text),
    ['feat: prima cosa', 'fix: seconda cosa', 'chore: terza cosa']
  );
  assert.ok(multi.content.every((p) => p.type === 'paragraph'));
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
