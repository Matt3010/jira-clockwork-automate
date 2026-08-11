// Pannello laterale e popup sono la stessa pagina in due contenitori diversi.
//
// La differenza che conta è la larghezza: il popup non ha una finestra sua e
// se la deve dichiarare, il pannello ce l'ha e la decide chi trascina il
// bordo. Sbagliare qui non dà errori — dà una pagina larga 800px dentro un
// pannello da 400, cioè metà interfaccia fuori dallo schermo.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DEFAULT_CONFIG } from '../src/lib/storage.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const leggi = (rel) => readFileSync(join(root, rel), 'utf8');
const manifest = JSON.parse(leggi('manifest.json'));

// --- il manifest ----------------------------------------------------------
assert.ok(manifest.permissions.includes('sidePanel'), 'senza il permesso il pannello non si apre');
assert.ok(manifest.side_panel?.default_path, 'il manifest non dichiara la pagina del pannello');

// Questa è la parte che si sbaglia una volta sola ma in silenzio: se il
// manifest dichiara anche `default_popup`, quello vince sempre e il pannello
// non si apre mai, qualunque cosa dica `setPanelBehavior`.
assert.equal(manifest.action?.default_popup, undefined,
  'con default_popup nel manifest il pannello non si aprirebbe mai');

// E allora il popup deve poter tornare da qualche altra parte, o chi ha
// Chrome vecchio resta senza niente.
assert.match(leggi('src/background.js'), /chrome\.action\.setPopup/,
  'tolto dal manifest, il popup va riattivato a runtime');
assert.match(leggi('src/background.js'), /chrome\.sidePanel\?\.\w+|chrome\.sidePanel &&/,
  'chrome.sidePanel esiste da Chrome 114: va verificato prima di usarlo');

// --- la pagina sa in quale dei due contenitori si trova --------------------
{
  const [file, query] = manifest.side_panel.default_path.split('?');
  assert.ok(query, 'senza un segno nell URL la pagina non può distinguere i due casi');
  assert.doesNotThrow(() => leggi(file), `il manifest punta a ${file}, che non c'è`);

  const chiave = new URLSearchParams(query).keys().next().value;
  const popup = leggi('src/popup.js');
  assert.match(popup, new RegExp(`get\\('${chiave}'\\)`),
    `il popup non legge il parametro «${chiave}» che il manifest gli passa`);
  assert.match(popup, /dataset\.mode = 'panel'/, 'e non lo traduce in un segno per il foglio di stile');
}

// --- il foglio di stile distingue i due casi ------------------------------
{
  const css = leggi('src/popup.css');
  assert.match(css, /html\[data-mode="panel"\][^{]*\{[^}]*width: auto/,
    'nel pannello la larghezza fissa del popup va tolta, o la pagina esce dal bordo');
  assert.match(css, /html\[data-mode="panel"\][^{]*\{[^}]*max-height: none/,
    'e l altezza massima del popup impedirebbe al pannello di riempire la finestra');
  assert.match(css, /body \{[^}]*width: 800px/,
    'il popup invece la larghezza se la deve ancora dichiarare: non ha una finestra sua');
}

// --- una forma sola per il piano, a qualsiasi larghezza -------------------
// Le righe si leggono come blocchetti sempre, non solo stretto. Due forme
// significavano due layout da tenere in piedi, e la seconda si otteneva
// smontando la prima — con la tabella rimessa a `display: block` e le
// intestazioni nascoste.
{
  const css = leggi('src/popup.css');
  const html = leggi('src/popup.html');

  assert.doesNotMatch(html, /<thead/,
    'le intestazioni di colonna non hanno più colonne da intestare');
  // La spunta generale stava lì dentro, ma è un comando e non un titolo: deve
  // essere sopravvissuta alla rimozione.
  assert.match(html, /id="toggle-all"/, 'la spunta «tutte» è sparita insieme all intestazione');

  const regolaRiga = css.match(/\ntr \{[^}]*\}/)?.[0] || '';
  assert.match(regolaRiga, /display: grid/, 'la riga del piano è una griglia');
  assert.match(regolaRiga, /grid-template-areas:/, 'con le posizioni dichiarate per nome');
  // Senza colonne il confine fra una riga e l'altra non lo dà più
  // l'incolonnamento: serve un contorno, o cinque righe di seguito si
  // leggono come un unico flusso.
  assert.match(regolaRiga, /border:/, 'la riga non ha un contorno che la chiuda');
  assert.match(regolaRiga, /background:/, 'né un fondo che la stacchi dalla pagina');
  assert.match(css, /\ntbody \{[^}]*gap:/, 'e i blocchetti devono essere staccati fra loro');

  // Ogni cella deve avere un posto, o finisce dove capita.
  for (const colonna of ['check', 'issue', 'what', 'hours', 'time', 'actions']) {
    assert.match(css, new RegExp(`\\.col-${colonna} \\{ grid-area: ${colonna}`),
      `la cella ${colonna} non ha un posto nella disposizione`);
  }

  // La riga dei worklog non ha colonne — ha due celle vuote di allineamento e
  // una che prende tutto il resto. Dentro la griglia finirebbero sparse.
  assert.match(css, /tr\.worklogs \{[^}]*display: block/s,
    'la riga dei worklog deve restare fuori dalla griglia delle colonne');
}

// --- stretto non vuol dire che qualcosa sparisce -------------------------
// Resta una sola cosa che cambia con la larghezza: l'anteprima, che si
// corica. E si corica, non si nasconde — nascondere è la scorciatoia che si
// prende senza accorgersene, e chi guarda non sa nemmeno che c'era qualcosa.
{
  const css = leggi('src/popup.css');
  const soglie = [...css.matchAll(/@media \(max-width: (\d+)px\) \{(.*?)\n\}/gs)];
  assert.equal(soglie.length, 1,
    'una soglia sola: con due c è una fascia di larghezze in cui l interfaccia è a metà strada');

  const stretto = soglie[0][2];
  for (const pezzo of ['.timeline', '.col-time', '.col-what', '.col-issue', '.col-hours']) {
    assert.doesNotMatch(stretto, new RegExp(`\\${pezzo}[^{]*\\{[^}]*display: none`),
      `stretto, ${pezzo} viene nascosto invece di essere ricollocato`);
  }
  // Il piano non deve più comparire qui dentro: la sua forma è una sola.
  for (const pezzo of ['table', 'tbody', 'thead', 'td']) {
    assert.doesNotMatch(stretto, new RegExp(`\\n {2}${pezzo}[ ,{]`),
      `la soglia rimette mano al piano: dovrebbe avere una forma sola (${pezzo})`);
  }
}

// --- l'anteprima si corica, e il JS lo scopre dal foglio di stile ---------
// La larghezza a cui succede deve stare scritta in un posto solo. Se il JS
// avesse la sua soglia, cambiarne una lascerebbe l'anteprima disegnata per
// un asse e disposta sull'altro.
{
  const css = leggi('src/popup.css');
  const popup = leggi('src/popup.js');

  assert.match(css, /--asse: verticale/, 'l asse va dichiarato, non dedotto');
  assert.match(css, /--asse: orizzontale/, 'e stretto deve cambiare');
  assert.match(popup, /getPropertyValue\('--asse'\)/,
    'il JS deve leggere l asse dal foglio di stile invece di avere una soglia sua');
  assert.doesNotMatch(popup, /matchMedia\('\(max-width/,
    'una soglia duplicata nel JS si sfasa dal CSS alla prima modifica');

  // Il JS dice dove comincia un blocco e quanto dura; su quale lato diventino
  // top/height o left/width lo decide il CSS.
  // Un'etichetta centrata sul suo istante, agli estremi, cade per metà fuori
  // dall'asse — e la metà che sparisce è quella che si legge per prima.
  assert.match(popup, /bordo-inizio/, 'la prima etichetta del righello deve appoggiarsi al bordo');
  assert.match(popup, /bordo-fine/, 'e così l ultima');
  assert.match(css, /\.tick\.bordo-inizio \{ transform: none/,
    'senza la regola, la classe nel JS non fa niente');
  assert.match(css, /\.tick\.bordo-fine \{ transform: translateX\(-100%\)/);

  assert.match(popup, /setProperty\('--inizio'/, 'la posizione del blocco passa per una variabile');
  assert.match(popup, /setProperty\('--durata'/, 'e anche la durata');
  assert.doesNotMatch(popup, /nodo\.style\.(top|height|left|width) =/,
    'scrivendo direttamente il lato, il JS decide l orientamento al posto del CSS');
}

// --- le celle sanno dove vanno -------------------------------------------
// La griglia colloca per nome: una cella senza etichetta viene posizionata
// dove capita, e la riga si sfascia in silenzio.
{
  const popup = leggi('src/popup.js');
  for (const colonna of ['col-check', 'col-issue', 'col-what', 'col-hours', 'col-time', 'col-actions']) {
    assert.match(popup, new RegExp(`className = '${colonna}'`), `le celle ${colonna} non sono etichettate`);
  }
}

// --- la scelta è configurabile e il pannello è il valore di partenza ------
assert.equal(DEFAULT_CONFIG.ui.sidePanel, true,
  'per un estensione che si usa mentre si guarda Jira, il pannello è il default sensato');
assert.match(leggi('src/options.js'), /send\('refreshUiMode'\)/,
  'cambiando la scelta va applicata subito, non al prossimo avvio di Chrome');

console.log('pannello laterale: tutti i controlli passati.');
