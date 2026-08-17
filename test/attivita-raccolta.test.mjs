// Le issue che hai creato tu. Non stanno nel changelog — creare non è
// modificare — quindi senza questa ricerca "ho aperto un ticket" resterebbe
// fuori dal registro.

import assert from 'node:assert/strict';
import { collectCreatedIssues, mergeCreatedIssues } from '../src/lib/jira.js';
import { buildPlan } from '../src/lib/planner.js';
import { DEFAULT_CONFIG } from '../src/lib/storage.js';

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

// ======================================================== e finiscono nel piano
// Non solo nel registro: se hai aperto un ticket quel giorno, scriverlo è
// stato lavoro tuo, e il piano deve saperlo. Senza, una issue creata e non
// più toccata non esiste; una creata e poi committata sembra solo git.
{
  const attivita = new Map([['ABC-1', {
    id: '11', key: 'ABC-1', summary: 'Già lavorata',
    events: [{ kind: 'changelog', at: 1 }]
  }]]);

  mergeCreatedIssues(attivita, [
    { id: '11', key: 'ABC-1', summary: 'Già lavorata', at: '2026-08-11T09:00:00.000+0200' },
    { id: '22', key: 'ABC-2', summary: 'Aperta e basta', at: '2026-08-11T10:00:00.000+0200' }
  ]);

  assert.deepEqual([...attivita.keys()], ['ABC-1', 'ABC-2'],
    'la issue creata e mai più toccata entra nel piano');
  assert.deepEqual(attivita.get('ABC-1').events.map((e) => e.kind), ['changelog', 'created'],
    'e su una già lavorata la creazione si aggiunge, non sostituisce');
  assert.equal(attivita.get('ABC-2').id, '22',
    'l id serve al pannello Sviluppo: senza, la issue non porterebbe i suoi commit');
  assert.equal(typeof attivita.get('ABC-2').events[0].at, 'number', 'l orario è già in millisecondi');
}

// --- una issue arrivata prima dai commit si completa, non si duplica ------
{
  const attivita = new Map([['ABC-9', { id: null, key: 'ABC-9', summary: '', events: [] }]]);
  mergeCreatedIssues(attivita, [{ id: '99', key: 'ABC-9', summary: 'Titolo vero', at: '2026-08-11T09:00:00.000+0200' }]);
  assert.equal(attivita.size, 1, 'nessun doppione');
  assert.equal(attivita.get('ABC-9').id, '99', 'l id mancante viene riempito');
  assert.equal(attivita.get('ABC-9').summary, 'Titolo vero');
}

// --- dati incompleti non entrano ------------------------------------------
{
  const attivita = new Map();
  mergeCreatedIssues(attivita, [
    { key: 'ABC-1', at: null },
    { key: 'ABC-2', at: 'non una data' },
    { at: '2026-08-11T09:00:00.000+0200' }
  ]);
  assert.equal(attivita.size, 0,
    'senza un orario valido l evento non si può collocare, e senza chiave non è una riga');
  assert.doesNotThrow(() => mergeCreatedIssues(new Map(), undefined));
}

// --- nel piano si legge "creata", non "1 modifica" -----------------------
{
  const config = { ...DEFAULT_CONFIG, meetings: [], jira: { ...DEFAULT_CONFIG.jira, projects: ['ABC'] } };
  const attivita = new Map();
  mergeCreatedIssues(attivita, [
    { id: '11', key: 'ABC-1', summary: 'Aperta oggi', at: '2026-08-11T09:00:00.000+0200' }
  ]);

  const plan = buildPlan({
    isoDate: '2026-08-11', config, jiraActivity: attivita,
    gitByIssue: new Map(), recentIssues: [], loggedEntries: [], alreadyLoggedMinutes: 0
  });

  const riga = plan.rows.find((r) => r.issueKey === 'ABC-1');
  assert.ok(riga, 'la issue creata deve avere una riga nel piano');
  assert.deepEqual(riga.sources, ['jira'], 'la fonte è Jira, non git: il ticket lo hai scritto tu');
  // Contarla fra le modifiche direbbe "1 modifica Jira" di un ticket che non
  // esisteva prima, e nasconderebbe che scriverlo è stato lavoro suo.
  assert.equal(riga.activity.created, 1);
  assert.equal(riga.activity.changes, 0, 'creare non è modificare');
  assert.ok(riga.weight > 100, 'e la creazione deve pesare, o la riga finisce in fondo a parità di fonti');
}

// --- e l'analisi le cerca davvero, prima dei commit ----------------------
// La funzione pura non serve a niente se nessuno la chiama. E l'ordine conta:
// una issue aperta oggi è la candidata più probabile per averci committato
// sopra, quindi deve essere in elenco prima che si vada a cercare i commit.
{
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const bg = readFileSync(join(root, 'src/background.js'), 'utf8');
  const analyze = bg.slice(bg.indexOf('async function analyze('), bg.indexOf('\n}', bg.indexOf('async function analyze(')));

  assert.match(analyze, /mergeCreatedIssues\(/, 'l analisi non cerca le issue che hai aperto');
  // La ricerca del giorno è larga e ha un tetto: se lo tocca, la giornata è
  // incompleta e chi guarda deve saperlo — una riga che manca, da sola, non si
  // vede.
  assert.match(analyze, /jiraActivity\.truncated/,
    'il taglio della ricerca non arriva a schermo');
  // Le candidate le sceglie `gatherCommits`, che è dove è finita la sequenza:
  // quello che conta è che l'unione venga prima di quella chiamata.
  assert.ok(
    analyze.indexOf('mergeCreatedIssues(') < analyze.indexOf('gatherCommits('),
    'le issue create vanno unite prima di cercare i commit, o restano fuori dalle candidate'
  );
}

console.log('issue create: tutti i controlli passati.');
