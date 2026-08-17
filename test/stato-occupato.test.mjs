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
assert.match(setBusy, /classList\.toggle\('busy', on\)/,
  'e lo dice anche visivamente: pulsanti spenti non bastano a far capire che carica');

// --- lo stato visivo deve avere uno stile, o la classe non serve a niente --
const css = readFileSync(join(root, 'src/popup.css'), 'utf8');
assert.match(css, /body\.busy/, 'la classe busy ha delle regole');
assert.match(css, /pointer-events: none/, 'e il contenuto sotto non si può toccare');
assert.match(css, /prefers-reduced-motion/,
  'l animazione rispetta chi ha chiesto meno movimento');

// --- ogni comando che tocca il piano dev essere spento durante l analisi ---
// Gestiti a parte, e per motivi diversi: cambiare giorno o vista mentre il
// piano carica è legittimo — le viste sono indipendenti — l invio lo governa
// `updateTotal`, e la copia del registro appartiene a una scheda che non sta
// caricando.
const A_PARTE = [
  // `today` sta con `prevDay`/`nextDay`: è navigazione fra i giorni, e mentre
  // il piano carica cambiare giorno resta legittimo — la richiesta in volo
  // viene invalidata dal suo token.
  'date', 'prevDay', 'nextDay', 'today', 'openOptions',
  'submit', 'cancelSend',
  'tabHours', 'tabLog', 'tabTickets', 'tabPr', 'logCopy'
];

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

// --- il pulsante non si deve deformare quando l etichetta è lunga ---------
// Le conferme sono frasi, non parole: senza un contenitore troncabile il testo
// va a capo e il pulsante si accartoccia.
const setButton = blocco('setButton');
assert.match(setButton, /className = 'label'/, 'l etichetta ha un elemento suo, troncabile');
assert.match(setButton, /button\.title = text/, 'e il testo intero resta nel title');

assert.match(css, /button \.label \{[^}]*text-overflow: ellipsis/,
  'l etichetta si tronca invece di mandare a capo');
assert.match(css, /button \{[^}]*white-space: nowrap/, 'e il pulsante non va su due righe');
assert.match(css, /\.foot-info \{[^}]*min-width: 0/,
  'il totale può restringersi: senza, spinge via i comandi');
assert.match(css, /\.actions \{[^}]*flex: none/, 'e i comandi non cedono spazio al testo');

// --- `hidden` deve davvero nascondere ------------------------------------
// L'attributo vale `display: none` solo finché nessuno dichiara un display
// sull'elemento. Qui lo fanno `button`, `main`, `.bar` e altre: senza la
// guardia, `hidden` non nasconde niente — e non si vede provandolo su un
// elemento qualsiasi, si vede solo su quelli con un display esplicito.
const html = readFileSync(join(root, 'src/popup.html'), 'utf8');
assert.match(css, /\[hidden\][^{]*\{[^}]*display: none !important/,
  'manca la guardia su [hidden]: gli elementi con un display esplicito resterebbero in vista');

for (const foglio of ['src/popup.css', 'src/options.css']) {
  assert.match(readFileSync(join(root, foglio), 'utf8'), /\[hidden\]/,
    `${foglio} usa display espliciti: serve la stessa guardia`);
}

// --- i campi si vestono per esclusione, non per elenco --------------------
// Elencando i tipi (`input[type="text"], input[type="date"]…`) il primo campo
// di un tipo nuovo nasce con lo stile del browser: su tema scuro, bianco. È
// già successo con il campo di ricerca.
for (const foglio of ['src/popup.css', 'src/options.css']) {
  const testo = readFileSync(join(root, foglio), 'utf8');
  assert.match(testo, /input:not\(\[type="checkbox"\]\)/,
    `${foglio} deve vestire i campi per esclusione`);
  // Il selettore per tipo resta legittimo per ritocchi mirati, ma non per
  // dichiarare i colori: quello è il caso che lascia i campi nuovi scoperti.
  // Gli pseudo-elementi restano fuori: `::-webkit-search-cancel-button` è un
  // pezzo interno di quel tipo di campo, non il campo.
  const perTipo = (testo.match(/input\[type="[a-z]+"\][^{]*\{[^}]*\}/g) || [])
    .filter((regola) => !regola.slice(0, regola.indexOf('{')).includes('::'));
  for (const regola of perTipo) {
    assert.doesNotMatch(regola, /(^|[^-])background:|(^|[;\s])color:/,
      `una regola per tipo dichiara i colori dei campi, e i tipi non elencati restano fuori: ${regola.slice(0, 60)}…`);
  }
}

// e gli elementi che si nascondono devono esistere davvero
for (const id of ['log-view', 'timeline', 'legend', 'plan', 'row-tools', 'cancel-send']) {
  assert.ok(new RegExp(`id="${id}"[^>]*hidden`).test(html), `#${id} non nasce nascosto`);
}

console.log('stato occupato: tutti i controlli passati.');
