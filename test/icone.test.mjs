// Le icone si rompono in silenzio.
//
// `icon('nome')` costruisce un SVG con i tracciati che trova in `PATHS` e le
// forme che trova in `SHAPES`. Se il nome non c'è non solleva niente: mette a
// schermo un quadratino vuoto, e un pulsante senza icona si nota solo
// guardandolo — non certo dai test degli altri moduli.
//
// Qui si controllano le due direzioni: che ogni nome chiesto esista, e che
// ogni nome disegnato serva a qualcuno. Un'icona rimasta senza uso è peso
// morto nel pacchetto, e si scopre solo così.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const leggi = (rel) => readFileSync(join(root, rel), 'utf8');

const icons = leggi('src/lib/icons.js');

// I nomi disegnati: le chiavi di PATHS e di SHAPES. Si leggono dal sorgente
// perché il modulo esporta solo `icon`, e per chiamarlo servirebbe un DOM.
function chiaviDi(oggetto) {
  const inizio = icons.indexOf(`const ${oggetto} = {`);
  assert.ok(inizio > -1, `in icons.js non c è più ${oggetto}`);
  const corpo = icons.slice(inizio, icons.indexOf('\n};', inizio));
  return [...corpo.matchAll(/^ {2}([a-zA-Z]+):/gm)].map((m) => m[1]);
}

const disegnate = new Set([...chiaviDi('PATHS'), ...chiaviDi('SHAPES')]);
assert.ok(disegnate.size >= 10, 'la lettura dei nomi dal sorgente ha trovato qualcosa');

// I nomi chiesti. Tre porte: `icon(...)` diretto, `setIcon(elemento, ...)` e
// `setButton(elemento, ...)` nel popup; più i simboli degli avvisi, che sono
// l'unico posto in cui il nome arriva da una tabella invece che dalla chiamata.
const sorgenti = readdirSync(join(root, 'src'))
  .filter((f) => f.endsWith('.js'))
  .map((f) => `src/${f}`);

const chieste = new Map();
for (const file of sorgenti) {
  const testo = leggi(file);
  const trovate = [
    ...testo.matchAll(/\bicon\('([a-zA-Z]+)'/g),
    ...testo.matchAll(/\b(?:setIcon|setButton)\([^,]+, '([a-zA-Z]+)'/g),
    ...testo.matchAll(/glyph: '([a-zA-Z]+)'/g)
  ];
  for (const m of trovate) chieste.set(m[1], file);
}
assert.ok(chieste.size >= 6, 'la scansione delle chiamate ha trovato qualcosa');

// --- ogni nome chiesto deve esistere --------------------------------------
for (const [nome, file] of chieste) {
  assert.ok(disegnate.has(nome), `${file} chiede l icona «${nome}», che icons.js non disegna`);
}

// --- e ogni nome disegnato deve servire -----------------------------------
const inutilizzate = [...disegnate].filter((nome) => !chieste.has(nome));
assert.deepEqual(inutilizzate, [], 'icone disegnate e mai usate');

// --- le forme non stanno in piedi da sole ---------------------------------
// `SHAPES` aggiunge cerchi e rettangoli ai tracciati: un nome che sta solo lì
// dentro disegnerebbe un cerchio nudo, che non è nessuna delle icone volute.
for (const nome of chiaviDi('SHAPES')) {
  assert.ok(chiaviDi('PATHS').includes(nome),
    `«${nome}» ha le forme ma non i tracciati: verrebbe fuori un cerchio vuoto`);
}

console.log('icone: tutti i controlli passati.');
