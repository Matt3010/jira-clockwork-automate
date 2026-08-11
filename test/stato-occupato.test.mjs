// Mentre l'analisi è in corso il piano non esiste: i comandi che agiscono su
// di esso non devono essere premibili, e il totale non deve mostrare numeri
// riferiti a un piano che non c'è più.
//
// È comportamento del DOM e qui non c'è un DOM: si verifica la regola sul
// sorgente. Il caso che conta è la regressione più probabile — qualcuno
// aggiunge un pulsante e si dimentica di spegnerlo.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const popup = readFileSync(join(root, 'src/popup.js'), 'utf8');

const blocco = (nome) => {
  const inizio = popup.indexOf(`function ${nome}(`);
  assert.ok(inizio > -1, `manca la funzione ${nome}`);
  return popup.slice(inizio, popup.indexOf('\n}', inizio));
};

// --- un solo proprietario dello stato "occupato" --------------------------
const setBusy = blocco('setBusy');
assert.match(setBusy, /state\.busy = on/, 'setBusy tiene il flag');
assert.match(setBusy, /updateTotal\(\)/, 'e rimette in riga totale e pulsante di invio');

// --- ogni comando che tocca il piano dev essere spento durante l analisi ---
// Navigazione, opzioni e i due pulsanti dell invio sono gestiti a parte:
// cambiare giorno mentre carica è legittimo, e l invio lo governa updateTotal.
const A_PARTE = ['date', 'prevDay', 'nextDay', 'openOptions', 'submit', 'cancelSend'];

const conAscoltatore = [...new Set(
  [...popup.matchAll(/\bel\.([a-zA-Z]+)\.addEventListener\(\s*'(click|change)'/g)].map((m) => m[1])
)];
assert.ok(conAscoltatore.length >= 6, 'la scansione ha trovato i comandi del popup');

const scoperti = conAscoltatore.filter((nome) => !A_PARTE.includes(nome) && !setBusy.includes(`el.${nome}.`));
assert.deepEqual(scoperti, [],
  `comandi premibili durante l analisi: ${scoperti.join(', ')} — vanno aggiunti a setBusy`);

// --- il totale non racconta numeri vecchi mentre carica -------------------
const updateTotal = blocco('updateTotal');
const primaUscita = updateTotal.indexOf('return;');
assert.ok(primaUscita > -1, 'updateTotal esce presto quando è occupato');
const parteOccupata = updateTotal.slice(0, primaUscita);
assert.match(parteOccupata, /state\.busy/, 'e la condizione è proprio lo stato occupato');
assert.match(parteOccupata, /emptyAnalysing/, 'al posto dei conti mostra che sta analizzando');
assert.match(parteOccupata, /el\.submit\.disabled = true/, 'e non si può inviare');
assert.match(parteOccupata, /disarmSubmit\(\)/, 'né resta armata una conferma di prima');

// --- l analisi accende e spegne lo stato ----------------------------------
const analyze = popup.slice(popup.indexOf('async function analyze('));
assert.match(analyze.slice(0, analyze.indexOf('try {')), /setBusy\(true\)/,
  'si entra in stato occupato prima di partire');
const finale = analyze.slice(analyze.indexOf('} finally {'));
assert.match(finale, /token === analyzeToken/,
  'e si esce solo se non è già partita un altra analisi: sarebbe lei a decidere');
assert.match(finale, /setBusy\(false\)/, 'sbloccando i comandi');

console.log('stato occupato: tutti i controlli passati.');
