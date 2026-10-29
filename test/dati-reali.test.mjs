// Niente dati reali, ne' nel codice ne' nei test.
//
// Lo userscript gira sul sito della pagina che lo carica: un sottodominio
// Atlassian scritto nel codice vorrebbe dire scrivere ore sul sito sbagliato.
// E gli esempi nei test servono, ma devono essere di fantasia: un repository
// pubblico con dentro nomi di clienti e chiavi di progetto veri e' una fuga di
// dati, non un test.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const js = (dir) => readdirSync(join(root, dir)).filter((f) => f.endsWith('.js')).map((f) => `${dir}/${f}`);

// --- nessun sito cablato nel codice ----------------------------------------
// Si cerca un sottodominio concreto davanti a .atlassian.net: il suffisso da
// solo e il pattern con l'asterisco di @match sono legittimi.
for (const file of [...js('src/lib'), ...js('src/userscript'), 'tools/build-userscript.mjs']) {
  const testo = readFileSync(join(root, file), 'utf8');
  const cablati = [...testo.matchAll(/\b[a-z0-9][a-z0-9-]*\.atlassian\.net/g)].map((m) => m[0]);
  assert.deepEqual(cablati, [], `${file} cabla un sito Atlassian: ${cablati.join(', ')}`);
}

// --- e i test usano solo siti e progetti di fantasia -----------------------
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

// --- e i default non danno per scontato nessun progetto --------------------
const { DEFAULT_CONFIG } = await import('../src/lib/storage.js');
assert.deepEqual(DEFAULT_CONFIG.jira.projects, [], 'nessun progetto di default');

console.log('dati reali: tutti i controlli passati.');
