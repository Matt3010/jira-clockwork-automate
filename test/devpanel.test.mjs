import assert from 'node:assert/strict';
import { collectDevPanelCommits } from '../src/lib/jira.js';

const oggi = (h) => new Date(2026, 7, 10, h, 0).toISOString().replace('Z', '+0000');
const ieri = new Date(2026, 7, 9, 14, 0).toISOString().replace('Z', '+0000');

// payload nella forma che restituisce /rest/dev-status/1.0/issue/detail
const payload = (repoName, commits) => ({ detail: [{ repositories: [{ name: repoName, commits }] }] });
const commit = (msg, ts, author) => ({ id: 'sha-' + msg, displayId: 'sha-' + msg, message: msg, authorTimestamp: ts, author });

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

console.log('pannello Sviluppo: tutti i controlli passati.');
