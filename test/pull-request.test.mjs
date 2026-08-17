// Le pull request lette dal pannello Sviluppo.
//
// Stesso pannello dei commit, altro `dataType`: è l'unica strada che non
// chiede una scheda aperta su Bitbucket, perché quei dati Jira se li tiene per
// disegnare il pannello in fondo a ogni ticket. In cambio si legge e basta.
//
// La domanda a cui deve rispondere l'elenco è una: «cosa aspetta me».

import assert from 'node:assert/strict';
import { collectPullRequests } from '../src/lib/jira.js';

const IO = { name: 'Nome Cognome', emailAddress: 'nome.cognome@esempio.it' };
const identities = ['Nome Cognome', 'nome.cognome@esempio.it'];

const pr = (id, over = {}) => ({
  id,
  name: `#${id}: titolo della ${id}`,
  url: `https://git/pr/${id}`,
  status: 'OPEN',
  author: { name: 'Collega Qualsiasi' },
  reviewers: [],
  commentCount: 0,
  lastUpdate: '2026-08-10T15:00:00.000+0200',
  source: { branch: 'feature/ABC-1' },
  destination: { branch: 'main' },
  ...over
});

let calls = [];
const fakeClient = (perIssue, { wantType = 'bitbucket' } = {}) => ({
  async getDevelopment(issueId, appType, dataType) {
    calls.push({ issueId, appType, dataType });
    if (appType !== wantType) return { detail: [] };
    return { detail: [{ pullRequests: perIssue[issueId] || [] }] };
  }
});

const candidates = [{ id: '1', key: 'ABC-1' }, { id: '2', key: 'ABC-2' }];

// --- si chiede il pannello, e si chiede delle PR --------------------------
{
  calls = [];
  const dev = await collectPullRequests(fakeClient({ 1: [pr(42)] }), { candidates, identities });

  assert.deepEqual([...new Set(calls.map((c) => c.dataType))], ['pullrequest'],
    'col dataType dei commit tornerebbero i commit');
  assert.equal(dev.appType, 'bitbucket');
  assert.equal(dev.checked, 2);

  const [uno] = dev.items;
  assert.equal(uno.issueKey, 'ABC-1', 'la PR si porta dietro il ticket da cui è arrivata');
  assert.equal(uno.number, '42');
  assert.equal(uno.title, 'titolo della 42', 'il "#42:" davanti non dice niente a chi guarda');
  assert.equal(uno.url, 'https://git/pr/42', 'senza indirizzo non si può nemmeno aprirla');
  assert.equal(uno.status, 'OPEN');
  assert.equal(uno.source, 'feature/ABC-1');
  assert.equal(uno.destination, 'main');
  assert.equal(uno.at, Date.parse('2026-08-10T15:00:00.000+0200'));
}

// --- IL PUNTO: quali aspettano te ----------------------------------------
{
  calls = [];
  const dev = await collectPullRequests(fakeClient({
    1: [
      pr(1, { reviewers: [{ name: 'Nome Cognome', approved: false }] }),
      pr(2, { reviewers: [{ name: 'Nome Cognome', approved: true }] }),
      pr(3, { reviewers: [{ name: 'Collega Qualsiasi', approved: false }] })
    ],
    2: [pr(4, { author: IO, reviewers: [{ name: 'Collega Qualsiasi', approved: true }] })]
  }), { candidates, identities });

  const per = Object.fromEntries(dev.items.map((p) => [p.number, p]));
  assert.equal(per[1].waitingForYou, true, 'sei revisore e non hai ancora approvato');
  assert.equal(per[2].waitingForYou, false, 'hai già approvato: non aspetta te');
  assert.equal(per[3].waitingForYou, false, 'non sei fra i revisori');
  assert.equal(per[4].waitingForYou, false);

  assert.equal(per[4].mine, true, 'questa l hai aperta tu');
  assert.equal(per[1].mine, false);
  assert.equal(per[4].approvals, 1, 'e ha già un sì: si può unire');
  assert.equal(per[1].approvals, 0);
}

// --- la stessa PR su due ticket resta una riga sola -----------------------
// Una PR che cita due chiavi compare nel pannello di tutte e due: elencarla
// due volte farebbe contare il doppio il lavoro che aspetta.
{
  calls = [];
  const dev = await collectPullRequests(fakeClient({ 1: [pr(7)], 2: [pr(7)] }), { candidates, identities });
  assert.equal(dev.items.length, 1);
  assert.equal(dev.items[0].issueKey, 'ABC-1', 'tiene il ticket da cui è arrivata per prima');
}

// --- istanza che usa ancora il vecchio applicationType --------------------
{
  calls = [];
  const dev = await collectPullRequests(
    fakeClient({ 1: [pr(9)] }, { wantType: 'stash' }),
    { candidates, identities }
  );
  assert.equal(dev.appType, 'stash', 'ricade sul vecchio nome, come per i commit');
  assert.equal(dev.items.length, 1);
}

// --- un pannello che non risponde non ferma gli altri ticket --------------
{
  calls = [];
  const dev = await collectPullRequests({
    async getDevelopment(issueId, appType, dataType) {
      calls.push({ issueId, appType, dataType });
      if (issueId === '1') throw new Error('403 senza permessi');
      return { detail: [{ pullRequests: appType === 'bitbucket' ? [pr(5)] : [] }] };
    }
  }, { candidates, identities });

  assert.equal(dev.items.length, 1, 'un 403 su un ticket non fa sparire le PR degli altri');
}

// --- nessuna PR da nessuna parte -----------------------------------------
{
  calls = [];
  const dev = await collectPullRequests(fakeClient({}), { candidates, identities });
  assert.deepEqual(dev.items, []);
  assert.equal(dev.appType, null, 'e senza risposte non si sa nemmeno quale pannello risponde');
}

console.log('pull request: tutti i controlli passati.');
