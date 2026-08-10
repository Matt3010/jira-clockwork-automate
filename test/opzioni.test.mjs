// Le opzioni leggono due liste che condividono la stessa classe CSS per la
// griglia. Se una query non e' ristretta al proprio contenitore, legge le righe
// dell'altra e cerca campi che li' non esistono: e' esattamente il
// "Cannot read properties of null (reading 'value')" visto a schermo.
//
// Qui si verifica la regola sul sorgente, senza dover aprire un browser.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const optionsJs = readFileSync(join(root, 'src/options.js'), 'utf8');
const optionsHtml = readFileSync(join(root, 'src/options.html'), 'utf8');

// --- ogni querySelectorAll sulle righe deve essere ancorata a un contenitore ---
const selettori = [...optionsJs.matchAll(/querySelectorAll\('([^']+)'\)/g)].map((m) => m[1]);
const suRighe = selettori.filter((s) => s.includes('.meeting'));
assert.ok(suRighe.length >= 2, 'ci sono almeno le due liste, riunioni e pause');
for (const selettore of suRighe) {
  assert.match(selettore, /^#(meetings|breaks) /,
    `"${selettore}" non e' ancorato al suo contenitore: leggerebbe anche le righe dell'altra lista`);
}

// --- i contenitori esistono davvero nell'HTML ---
for (const id of ['meetings', 'breaks']) {
  assert.ok(optionsHtml.includes(`id="${id}"`), `manca il contenitore #${id} nell'HTML`);
}

// --- ogni $('x') di options.js ha il suo elemento nell'HTML ---
const ids = [...new Set([...optionsJs.matchAll(/\$\('([a-z-]+)'\)/g)].map((m) => m[1]))];
assert.ok(ids.length > 10, 'la scansione degli id ha trovato qualcosa');
for (const id of ids) {
  assert.ok(optionsHtml.includes(`id="${id}"`), `options.js usa $('${id}') ma nell'HTML non c'e'`);
}

// --- le classi dei campi letti esistono in chi costruisce le righe ---
const classi = [...new Set([...optionsJs.matchAll(/querySelector(?:All)?\('\.([bm]-[a-z]+)'\)/g)].map((m) => m[1]))];
for (const classe of classi) {
  assert.ok(optionsJs.includes(`className = '${classe}'`) || optionsJs.includes(`'${classe}'`),
    `la classe .${classe} viene letta ma non assegnata`);
}

// --- niente sito cablato nel codice ---
// Si cerca un sottodominio concreto davanti a .atlassian.net: il suffisso da
// solo e il pattern con l'asterisco dei permessi sono legittimi.
for (const file of ['src/options.js', 'src/options.html', 'src/popup.js', 'src/background.js', 'src/lib/storage.js']) {
  const testo = readFileSync(join(root, file), 'utf8');
  const cablati = [...testo.matchAll(/\b[a-z0-9][a-z0-9-]*\.atlassian\.net/g)].map((m) => m[0]);
  assert.deepEqual(cablati, [], `${file} cabla un sito Atlassian: ${cablati.join(', ')}`);
}

// --- e nemmeno i test devono contenere dati reali -------------------------
// Gli esempi servono, ma devono essere di fantasia: un repository con dentro
// nomi di clienti e chiavi di progetto veri è una fuga di dati, non un test.
const FITTIZI = ['esempio', 'altro', 'sito', 'iltuosito', 'nessuno', 'x'];
const PROGETTI_FITTIZI = ['ABC', 'XYZ', 'DEF'];
for (const file of readdirSync(join(root, 'test'))) {
  const testo = readFileSync(join(root, 'test', file), 'utf8');

  const host = [...new Set([...testo.matchAll(/([a-z0-9-]+)\.atlassian\.net/g)].map((m) => m[1]))];
  const veri = host.filter((h) => !FITTIZI.includes(h));
  assert.deepEqual(veri, [], `test/${file} usa un sito reale: ${veri.join(', ')}`);

  const chiavi = [...new Set([...testo.matchAll(/\b([A-Z]{2,})-\d+\b/g)].map((m) => m[1]))];
  const reali = chiavi.filter((k) => !PROGETTI_FITTIZI.includes(k));
  assert.deepEqual(reali, [], `test/${file} usa una chiave progetto reale: ${reali.join(', ')}`);
}

// --- e i default non danno per scontato nessun sito né progetto ---
const { DEFAULT_CONFIG } = await import('../src/lib/storage.js');
assert.equal(DEFAULT_CONFIG.jira.baseUrl, '', 'nessun sito di default');
assert.deepEqual(DEFAULT_CONFIG.jira.projects, [], 'nessun progetto di default');

// --- normalizzazione del sito: si inserisce solo il prefisso, ma incollare
//     l'URL intero deve funzionare comunque -----------------------------------
const sorgente = optionsJs.slice(optionsJs.indexOf('function normalizeSite'));
const corpo = sorgente.slice(0, sorgente.indexOf('\n}') + 2);
// eslint-disable-next-line no-new-func
const normalizeSite = new Function(`${corpo}; return normalizeSite;`)();

const casi = [
  ['iltuosito', 'iltuosito'],
  ['ILTUOSITO', 'iltuosito'],
  ['  iltuosito  ', 'iltuosito'],
  ['iltuosito.atlassian.net', 'iltuosito'],
  ['https://iltuosito.atlassian.net', 'iltuosito'],
  ['http://iltuosito.atlassian.net/', 'iltuosito'],
  ['https://iltuosito.atlassian.net/jira/your-work', 'iltuosito'],
  ['https://iltuosito.atlassian.net/plugins/servlet/ac/clockwork-cloud', 'iltuosito'],
  ['mio-sito', 'mio-sito'],
  ['', ''],
  ['   ', '']
];
for (const [dentro, atteso] of casi) {
  assert.equal(normalizeSite(dentro), atteso, `normalizeSite(${JSON.stringify(dentro)})`);
}

console.log('opzioni: tutti i controlli passati.');
