// Gli avvisi nel popup: quanti se ne accumulano e quanto restano.
//
// Il popup è alto quattro righe: ogni avviso che resta a schermo è spazio
// tolto al contenuto. Spostando cinque ticket di fila se ne impilavano cinque,
// e insieme dicevano meno dell'ultimo da solo.
//
// È comportamento del DOM e qui non c'è un DOM: si verifica la regola sul
// sorgente.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const popup = readFileSync(join(root, 'src/popup.js'), 'utf8');
const message = popup.slice(popup.indexOf('function message('), popup.indexOf('\nfunction clearMessages'));
assert.ok(message.length > 100, 'non ho trovato la funzione message');

// --- lo stesso avviso non si ripete ---------------------------------------
assert.match(message, /dataset\.text === text/,
  'lo stesso testo due volte non informa il doppio: succede a ogni tentativo fallito');

// --- gli avvisi sulla stessa cosa si sostituiscono ------------------------
assert.match(message, /dataset\.channel === channel/,
  'senza canale gli avvisi ripetuti si accodano invece di prendere il posto del precedente');
assert.match(message, /esistente\.remove\(\)/, 'e il vecchio va tolto, non solo nascosto');

// --- una conferma si toglie di mezzo da sola ------------------------------
assert.match(message, /level === 'ok'/,
  'l auto-rimozione vale per le conferme, non per errori e avvisi');
assert.match(message, /setTimeout\(\(\) => node\.remove\(\)/, 'e avviene davvero');
// Con un'azione dentro, sparire da solo toglierebbe di mano il pulsante
// proprio mentre lo stai per premere.
assert.match(message, /level === 'ok' && !action/,
  'un avviso con un pulsante non deve sparire da sotto le dita');

// --- errori e avvisi restano ----------------------------------------------
for (const livello of ["'err'", "'warn'"]) {
  assert.doesNotMatch(message, new RegExp(`level === ${livello}[^\\n]*remove`),
    `gli avvisi ${livello} non devono togliersi da soli: vanno letti, e a volte agiti`);
}

// --- chi sposta i ticket usa il canale ------------------------------------
{
  const moveTicket = popup.slice(popup.indexOf('async function moveTicket('));
  const corpo = moveTicket.slice(0, moveTicket.indexOf('\n}'));
  const conferme = [...corpo.matchAll(/message\(/g)];
  assert.ok(conferme.length >= 2, 'lo spostamento ha più esiti da raccontare');
  assert.equal(
    [...corpo.matchAll(/channel: canale/g)].length, conferme.length,
    'ogni esito dello spostamento deve passare dallo stesso canale, o si impilano di nuovo'
  );
  assert.match(corpo, /const canale = `ticket:\$\{issue\.key\}`/,
    'il canale è la riga: due ticket diversi possono avere due avvisi insieme');
}

console.log('avvisi: tutti i controlli passati.');
