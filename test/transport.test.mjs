import assert from 'node:assert/strict';

let tabs = [], injected = [], injectResponder = null, directCalls = [];
globalThis.chrome = {
  // Riproduce il matching dei pattern di Chrome per i due casi che usiamo:
  // host esatto (`*://host/*`) e sottodominio jolly (`*://*.dominio/*`).
  tabs: { query: async ({ url }) => {
    const pattern = url.replace('*://', '').replace('/*', '');
    return tabs.filter((t) => {
      const host = new URL(t.url).host;
      return pattern.startsWith('*.')
        ? host === pattern.slice(2) || host.endsWith(pattern.slice(1))
        : host === pattern;
    });
  } },
  scripting: { executeScript: async ({ target, args }) => {
    const [url, init] = args;
    injected.push({ tabId: target.tabId, url, method: init.method || 'GET' });
    return [{ result: injectResponder(url, init, target.tabId) }];
  } }
};
globalThis.fetch = async (url) => { directCalls.push(url); throw new Error('non deve mai partire'); };

const { Channel, TransportError, hostOf, tabsOnHost, detectAtlassianHosts } =
  await import('../src/lib/transport.js');

// --- estrazione dell host ---------------------------------------------------
assert.equal(hostOf('https://esempio.atlassian.net/jira/your-work'), 'esempio.atlassian.net');
assert.equal(hostOf('https://esempio.atlassian.net'), 'esempio.atlassian.net');
assert.equal(hostOf(''), '', 'una stringa vuota non deve far esplodere niente');
assert.equal(hostOf('non-un-url'), '');
assert.equal(hostOf(undefined), '');
const JSON_OK = { status: 200, text: '{"accountId":"abc"}', contentType: 'application/json' };
const LOGIN_HTML = { status: 200, text: '<html>login</html>', contentType: 'text/html' };
const FORBIDDEN = { status: 403, text: '{}', contentType: 'application/json' };

const jira = () => new Channel({
  label: 'Jira', host: 'esempio.atlassian.net',
  base: 'https://esempio.atlassian.net', probePath: '/rest/api/3/myself'
});
function reset() { tabs = []; injected = []; directCalls = []; injectResponder = () => JSON_OK; }

// 1. scheda giusta e loggata -> canale pronto
reset();
tabs = [{ id: 7, url: 'https://esempio.atlassian.net/jira/your-work' }];
let ch = await jira().resolve();
assert.equal(ch.tabId, 7);
assert.equal(directCalls.length, 0, 'nessuna chiamata fuori dalla scheda: non esiste piu un canale token');

// 2. IL DOMINIO: una scheda su un altro sito Atlassian non vale
reset();
tabs = [{ id: 9, url: 'https://altro.atlassian.net/jira/your-work' }];
await assert.rejects(jira().resolve(), (e) => e instanceof TransportError && e.code === 'NO_TAB');
assert.equal(injected.length, 0, 'non prova nemmeno a iniettare nella scheda sbagliata');

// 3. nessuna scheda -> NO_TAB con messaggio che nomina l host
reset();
await assert.rejects(jira().resolve(), (e) => e.code === 'NO_TAB' && e.message.includes('esempio.atlassian.net'));

// 3-bis. e l errore si porta dietro dove stava andando: senza host chi lo
// riceve ha un codice e una frase, ma non puo' proporre nessun rimedio —
// aprire *cosa*? Il contesto veniva appeso da chi chiamava, un `.catch` alla
// volta, e una strada che non ci passava lasciava l avviso senza pulsante.
tabs = [{ id: 9, url: 'https://altro.atlassian.net/browse/ABC-1' }];
await assert.rejects(jira().resolve(), (e) => {
  assert.equal(e.detail?.host, 'esempio.atlassian.net', 'l errore deve dire quale sito');
  assert.deepEqual(e.detail?.openHosts, ['altro.atlassian.net'],
    'e quali altri sono aperti, per poter dire «forse intendevi questo»');
  return true;
});
tabs = [];

// 4. scheda giusta ma non loggata (redirect HTML) -> SESSION_INVALID
reset();
tabs = [{ id: 3, url: 'https://esempio.atlassian.net/' }];
injectResponder = () => LOGIN_HTML;
await assert.rejects(jira().resolve(), (e) => e.code === 'SESSION_INVALID');

// 5. 403 trattato come sessione non valida, non come risposta buona
reset();
tabs = [{ id: 3, url: 'https://esempio.atlassian.net/' }];
injectResponder = () => FORBIDDEN;
await assert.rejects(jira().resolve(), (e) => e.code === 'SESSION_INVALID');

// 6. piu schede: usa la prima valida, salta quella scaduta
reset();
tabs = [{ id: 1, url: 'https://esempio.atlassian.net/a' }, { id: 2, url: 'https://esempio.atlassian.net/b' }];
injectResponder = (url, init, tabId) => (tabId === 1 ? LOGIN_HTML : JSON_OK);
ch = await jira().resolve();
assert.equal(ch.tabId, 2);

// 7. la scheda si valida una volta sola, non a ogni richiesta
reset();
tabs = [{ id: 5, url: 'https://esempio.atlassian.net/' }];
ch = jira();
await ch.request('/rest/api/3/myself');
await ch.request('/rest/api/3/search/jql', { method: 'POST', body: {} });
assert.equal(injected.filter(i => i.url.endsWith('/rest/api/3/myself')).length, 2, '1 prova + 1 richiesta');
assert.equal(injected.filter(i => i.method === 'POST').length, 1, 'la POST parte una volta sola');

// --- ricerca delle schede ---------------------------------------------------
reset();
tabs = [
  { id: 1, url: 'https://esempio.atlassian.net/jira/your-work' },
  { id: 2, url: 'https://esempio.atlassian.net/browse/ABC-1' },
  { id: 3, url: 'https://altro.atlassian.net/jira' },
  { id: 4, url: 'https://www.google.com' }
];

assert.deepEqual((await tabsOnHost('esempio.atlassian.net')).map(t => t.id), [1, 2]);
assert.deepEqual(await tabsOnHost('nessuno.atlassian.net'), []);
assert.deepEqual(await tabsOnHost(''), [], 'senza host non si interroga il browser');

const trovati = await detectAtlassianHosts();
assert.deepEqual(trovati, [
  { host: 'esempio.atlassian.net', tabCount: 2 },
  { host: 'altro.atlassian.net', tabCount: 1 }
], 'ordinati per numero di schede: il sito su cui stai davvero lavorando per primo');
assert.ok(!trovati.some(h => h.host.includes('google')), 'i siti non Atlassian restano fuori');

// se il browser non risponde, si degrada senza rompere
const query = globalThis.chrome.tabs.query;
globalThis.chrome.tabs.query = async () => { throw new Error('permesso negato'); };
assert.deepEqual(await tabsOnHost('esempio.atlassian.net'), []);
assert.deepEqual(await detectAtlassianHosts(), []);
globalThis.chrome.tabs.query = query;

console.log('transport: tutti i controlli passati.');
