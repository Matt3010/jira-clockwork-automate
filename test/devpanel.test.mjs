import assert from 'node:assert/strict';
import { collectDevPanelCommits } from '../src/lib/jira.js';

const oggi = (h) => new Date(2026, 7, 10, h, 0).toISOString().replace('Z', '+0000');
const ieri = new Date(2026, 7, 9, 14, 0).toISOString().replace('Z', '+0000');

// payload nella forma che restituisce /rest/dev-status/1.0/issue/detail
const payload = (repoName, commits) => ({ detail: [{ repositories: [{ name: repoName, commits }] }] });
const commit = (msg, ts, author) => ({
  id: 'sha-' + msg, displayId: 'sha-' + msg, message: msg, authorTimestamp: ts, author,
  url: 'https://git/' + encodeURIComponent(msg)
});

const IO = { name: 'Nome Cognome', emailAddress: 'nome.cognome@esempio.it' };
const ALTRO = { name: 'Collega Qualsiasi', emailAddress: 'collega@esempio.it' };
const VECCHIO = { name: 'utente', emailAddress: 'vecchia@vecchiodominio.it' };

let calls = [];
const fakeClient = (byIssueId, { wantType = 'bitbucket' } = {}) => ({
  async getDevelopment(issueId, appType) {
    calls.push({ issueId, appType });
    if (appType !== wantType) return { detail: [] };
    return byIssueId[issueId] || { detail: [] };
  }
});

const candidates = [
  { id: '10001', key: 'ABC-2075' },
  { id: '10002', key: 'ABC-1969' },
  { id: '10003', key: 'ABC-1996' }
];
const identities = ['Nome Cognome', 'nome.cognome@esempio.it'];

// --- caso normale ---
calls = [];
const dev = await collectDevPanelCommits(fakeClient({
  '10001': payload('repo-api', [
    commit('ABC-2075 fix tunnel', oggi(11), IO),
    commit('ABC-2075 review del collega', oggi(15), ALTRO),
    commit('ABC-2075 di ieri', ieri, IO)
  ]),
  '10003': payload('repo-web', [commit('ABC-1996 refactor', oggi(16), IO)])
}), { candidates, isoDate: '2026-08-10', identities });

assert.deepEqual([...dev.byIssue.keys()].sort(), ['ABC-1996', 'ABC-2075']);
assert.equal(dev.byIssue.get('ABC-2075').length, 1, 'solo il mio commit di oggi');
assert.equal(dev.byIssue.get('ABC-2075')[0].subject, 'ABC-2075 fix tunnel');
assert.equal(dev.byIssue.get('ABC-2075')[0].repo, 'repo-api');
// L'indirizzo del commit arriva dal pannello: senza, da «1 commit» non si può
// portare nessuno da nessuna parte.
assert.equal(dev.byIssue.get('ABC-2075')[0].url, 'https://git/ABC-2075%20fix%20tunnel');
assert.equal(dev.skippedOther, 1, 'il commit del collega viene contato e segnalato');
assert.equal(dev.appType, 'bitbucket');
assert.equal(dev.checked, 3);
assert.equal(calls.length, 3, 'una chiamata per issue candidata, nessuna in piu');
assert.ok(dev.byIssue.has('ABC-1996'),
  'un commit su un ticket non toccato oggi in Jira viene trovato grazie alle candidate extra');

// --- nome git diverso: riconosciuto solo se dichiarato ---
const soloVecchio = { '10001': payload('r', [commit('ABC-2075 x', oggi(12), VECCHIO)]) };
calls = [];
const senza = await collectDevPanelCommits(fakeClient(soloVecchio), { candidates, isoDate: '2026-08-10', identities });
assert.equal(senza.byIssue.size, 0);
assert.equal(senza.skippedOther, 1, 'lo segnala invece di perderlo in silenzio');

calls = [];
const con = await collectDevPanelCommits(fakeClient(soloVecchio), {
  candidates, isoDate: '2026-08-10', identities: [...identities, 'vecchia@vecchiodominio.it']
});
assert.equal(con.byIssue.size, 1, 'dichiarando l email alternativa il commit viene attribuito');

// --- la firma git intera dentro il campo nome ---
// Il pannello può restituire l'autore come lo scrive git — `Nome <mail>` — in
// un campo solo. Confrontata così com'è non combacia con niente: il commit
// risultava "di un altro autore" pur essendo tuo, e l'avviso mandava a
// dichiarare un nome già dichiarato.
{
  calls = [];
  const firmato = { name: 'Nome Cognome <nome.cognome@esempio.it>', emailAddress: '' };
  const dev = await collectDevPanelCommits(
    fakeClient({ '10001': payload('r', [commit('ABC-2075 firmato', oggi(13), firmato)]) }),
    { candidates, isoDate: '2026-08-10', identities }
  );
  assert.equal(dev.byIssue.size, 1, 'il commit è tuo e va contato');
  assert.equal(dev.skippedOther, 0);

  // Anche dichiarando solo l'email, o solo il nome.
  for (const identita of [['nome.cognome@esempio.it'], ['Nome Cognome']]) {
    const solo = await collectDevPanelCommits(
      fakeClient({ '10001': payload('r', [commit('ABC-2075 firmato', oggi(13), firmato)]) }),
      { candidates, isoDate: '2026-08-10', identities: identita }
    );
    assert.equal(solo.byIssue.size, 1, `riconosciuto anche con ${identita[0]} soltanto`);
  }
}

// --- di chi sono i commit che non ha contato ---
// Un conto non basta: "1 commit di un altro autore" non fa distinguere il
// collega — dove non c'è niente da fare — dal tuo firmato con un altro nome.
{
  calls = [];
  const dev = await collectDevPanelCommits(fakeClient({
    '10001': payload('r', [
      commit('ABC-2075 del collega', oggi(15), ALTRO),
      commit('ABC-2075 mio vecchio nome', oggi(16), VECCHIO)
    ])
  }), { candidates, isoDate: '2026-08-10', identities });

  assert.equal(dev.skippedOther, 2);
  assert.deepEqual(dev.skippedAuthors.sort(), ['Collega Qualsiasi', 'utente'],
    'i nomi servono a chiudere l avviso da soli');

  // Lo stesso autore due volte resta un nome solo.
  const ripetuto = await collectDevPanelCommits(fakeClient({
    '10001': payload('r', [
      commit('ABC-2075 uno', oggi(15), ALTRO),
      commit('ABC-2075 due', oggi(16), ALTRO)
    ])
  }), { candidates, isoDate: '2026-08-10', identities });
  assert.deepEqual(ripetuto.skippedAuthors, ['Collega Qualsiasi']);

  // E nell'avviso ci va il nome, non la firma con l'email appesa.
  const conFirma = await collectDevPanelCommits(fakeClient({
    '10001': payload('r', [commit('ABC-2075 x', oggi(15), { name: 'Collega Qualsiasi <altro@esempio.it>', emailAddress: '' })])
  }), { candidates, isoDate: '2026-08-10', identities });
  assert.deepEqual(conFirma.skippedAuthors, ['Collega Qualsiasi']);

  // E anche i commit dei colleghi si portano dietro il loro indirizzo.
  assert.equal(dev.othersByIssue.get('ABC-2075')[0].url, 'https://git/ABC-2075%20del%20collega');
}

// --- i commit dei colleghi vanno sulla riga, non in cima -------------------
// Attaccati alla task a cui appartengono rispondono alla domanda vera («in
// quali delle mie task ha lavorato qualcun altro»). L'avviso in cima resta
// solo per quelli che una riga non ce l'hanno: se restasse per tutti, direbbe
// ogni giorno una cosa che si legge due centimetri più sotto.
{
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const bg = readFileSync(join(root, 'src/background.js'), 'utf8');

  // Una sola strada per leggere i commit: il piano e il registro devono
  // chiamare la stessa funzione. Ce n'erano due copie, e alla prima modifica —
  // l'impostazione sui merge — sono andate corrette tutte e due a mano.
  assert.equal((bg.match(/collectDevPanelCommits\(/g) || []).length, 1,
    'la sequenza che legge i commit va scritta in un posto solo');
  assert.equal((bg.match(/await gatherCommits\(/g) || []).length, 2,
    'e sia il piano sia il registro devono passare di lì');

  // Leggere i commit non è più una scelta: era una casella che nessuno aveva
  // motivo di spegnere, e spenta lasciava l'estensione senza la sua fonte
  // principale. Se il pannello non risponde lo si dice, non lo si previene.
  assert.doesNotMatch(bg, /config\.jira\.devPanel/,
    'i commit si leggono sempre: niente interruttore da ricordarsi di accendere');

  // E la scelta sui merge deve arrivarci: l'impostazione senza il filo che la
  // collega è una casella che non fa niente.
  assert.match(bg, /countMerges: config\.jira\.countMerges !== false/,
    'la scelta sui merge non arriva a chi legge i commit');

  assert.match(bg, /foreignGitByIssue/, 'i commit altrui non arrivano al piano');
  assert.ok(
    bg.indexOf('dev.othersByIssue') < bg.indexOf('buildPlan({'),
    'vanno raccolti prima del piano, o le righe nascono senza'
  );

  const punto = bg.indexOf('skipped?.skippedOther');
  const blocco = bg.slice(punto, punto + 800);
  assert.ok(punto > bg.indexOf('buildPlan({'),
    'l avviso si decide dopo il piano: prima non si sa quali commit hanno una riga');
  assert.match(blocco, /plan\.rows\.some/, 'l avviso non esclude i commit che hanno gia una riga');
  assert.match(blocco, /noteOtherAuthorsUnknown/,
    'se il pannello non dà nessun nome, la frase deve reggere lo stesso');
}

// --- i merge si contano solo se lo hai chiesto ----------------------------
// «Merge branch 'release/X' into feature/Y» non è lavoro da registrare, ed è
// anche la riga che si prende la nota precompilata: chi non li vuole li spegne,
// e spariscono da tutti e tre i posti dove i commit contano.
{
  const merge = (msg, ts, extra = {}) => ({ ...commit(msg, ts, IO), ...extra });
  const payloadMisto = {
    '10001': payload('r', [
      merge('feat: lavoro vero', oggi(9)),
      // Il pannello lo dichiara con `merge`...
      merge('unito il ramo', oggi(10), { merge: true }),
      // ...ma non tutte le istanze lo mandano: resta il soggetto di git.
      merge("Merge branch 'release/ABC-1' into feature/ABC-2", oggi(11)),
      merge('Merge pull request #42 from tizio/ramo', oggi(12)),
      merge('Merge remote-tracking branch origin/main', oggi(13))
    ])
  };

  calls = [];
  const con = await collectDevPanelCommits(fakeClient(payloadMisto), {
    candidates, isoDate: '2026-08-10', identities
  });
  assert.equal(con.byIssue.get('ABC-2075').length, 5, 'acceso è quello che faceva prima');

  calls = [];
  const senza = await collectDevPanelCommits(fakeClient(payloadMisto), {
    candidates, isoDate: '2026-08-10', identities, countMerges: false
  });
  assert.deepEqual(senza.byIssue.get('ABC-2075').map((c) => c.subject), ['feat: lavoro vero']);

  // Un merge scartato non è «di un altro autore»: sono due motivi diversi, e
  // confonderli farebbe comparire un avviso che manda a configurare le firme.
  assert.equal(senza.skippedOther, 0);
  assert.deepEqual(senza.skippedAuthors, []);

  // E il pannello risulta comunque risposto: con solo merge dentro, contarli
  // come "niente trovato" farebbe ripiegare sul vecchio applicationType per
  // una issue che invece aveva risposto benissimo.
  const soloMerge = await collectDevPanelCommits(
    fakeClient({ '10001': payload('r', [merge('Merge branch x', oggi(9))]) }),
    { candidates, isoDate: '2026-08-10', identities, countMerges: false }
  );
  assert.equal(soloMerge.appType, 'bitbucket', 'il pannello ha risposto: non si ripiega su stash');
  assert.equal(soloMerge.byIssue.size, 0);

  // Il flag del pannello vince sul soggetto: un commit che si chiama "Merge
  // dei dati anagrafici" non è un merge, e dichiarandolo il pannello lo dice.
  const nonMerge = await collectDevPanelCommits(
    fakeClient({ '10001': payload('r', [merge('Merge dei dati anagrafici', oggi(9), { merge: false })]) }),
    { candidates, isoDate: '2026-08-10', identities, countMerges: false }
  );
  assert.equal(nonMerge.byIssue.size, 1, 'lo decide il pannello quando lo dichiara, non il testo');
}

// --- istanza che usa ancora il vecchio applicationType "stash" ---
calls = [];
const stash = await collectDevPanelCommits(
  fakeClient({ '10001': payload('r', [commit('ABC-2075 y', oggi(10), IO)]) }, { wantType: 'stash' }),
  { candidates, isoDate: '2026-08-10', identities }
);
assert.equal(stash.appType, 'stash', 'ricade sul vecchio applicationType');
assert.equal(stash.byIssue.size, 1);
assert.equal(calls.filter(c => c.appType === 'bitbucket').length, 3, 'prima prova bitbucket su tutte');

// --- accenti e maiuscole non devono far perdere i commit ---
calls = [];
const accenti = await collectDevPanelCommits(
  fakeClient({ '10001': payload('r', [commit('ABC-2075 z', oggi(9), { name: "Nicolò D'Amico", emailAddress: '' })]) }),
  { candidates, isoDate: '2026-08-10', identities: ["nicolo d'amico"] }
);
assert.equal(accenti.byIssue.size, 1, 'Nicolo con accento riconosciuto');

// --- pannello che non risponde su una issue: non fa saltare il resto ---
calls = [];
const parziale = await collectDevPanelCommits({
  async getDevelopment(issueId, appType) {
    if (issueId === '10002') throw new Error('403 senza permessi');
    if (appType !== 'bitbucket') return { detail: [] };
    return issueId === '10003' ? payload('r', [commit('ABC-1996 ok', oggi(14), IO)]) : { detail: [] };
  }
}, { candidates, isoDate: '2026-08-10', identities });
assert.equal(parziale.byIssue.size, 1, 'un 403 su una issue non blocca le altre');

// --- nessun commit da nessuna parte: appType resta null e lo si puo segnalare ---
calls = [];
const vuoto = await collectDevPanelCommits(fakeClient({}), { candidates, isoDate: '2026-08-10', identities });
assert.equal(vuoto.appType, null);
assert.equal(vuoto.byIssue.size, 0);
assert.equal(calls.length, 6, 'provati entrambi gli applicationType prima di arrendersi');

// --- i commit diventano la nota del worklog, tutti, uno per riga ---------
// È la traccia migliore di cosa hai fatto: tenerne tre su sette vorrebbe dire
// scegliere al posto tuo quali pezzi della giornata valgono. E in riga unica,
// separati da un punto, si leggevano come una frase sola.
{
  const { buildPlan } = await import('../src/lib/planner.js');
  const { DEFAULT_CONFIG } = await import('../src/lib/storage.js');

  const soggetti = [
    'feat(requests): [ABC-1] remove unused request classes',
    'fix(api): [ABC-1] timeout piu lungo sulle chiamate lente',
    'chore: [ABC-1] aggiorna le dipendenze',
    'test: [ABC-1] copre il caso senza sessione',
    'feat(requests): [ABC-1] remove unused request classes' // rebase: stesso soggetto
  ];
  const piano = buildPlan({
    isoDate: '2026-08-10',
    config: { ...DEFAULT_CONFIG, jira: { ...DEFAULT_CONFIG.jira, projects: ['ABC'] }, meetings: [] },
    jiraActivity: new Map(),
    gitByIssue: new Map([['ABC-1', soggetti.map((subject, i) => ({ subject, at: oggi(9 + i) }))]]),
    recentIssues: [],
    loggedEntries: [],
    alreadyLoggedMinutes: 0
  });

  const riga = piano.rows.find((r) => r.issueKey === 'ABC-1');
  const righe = riga.comment.split('\n');
  assert.equal(righe.length, 4, 'quattro soggetti diversi, quattro righe: il rifatto non si conta due volte');
  assert.deepEqual(righe, [...new Set(soggetti)], 'nell ordine in cui sono stati fatti');
  assert.doesNotMatch(riga.comment, / · /, 'e non incollati in una frase sola');
}

console.log('pannello Sviluppo: tutti i controlli passati.');
