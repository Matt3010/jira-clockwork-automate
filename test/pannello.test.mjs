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

// --- lo stretto non deve far sparire l'orario ----------------------------
// Le due soglie lavorano in coppia: finché c'è l'anteprima gli orari si
// leggono lì e la colonna può cedere il posto; quando anche l'anteprima non
// ci sta più, la colonna deve tornare. Se una delle due cambia senza l'altra,
// sotto una certa larghezza non si sa più a che ora è nulla.
{
  const css = leggi('src/popup.css');
  const soglie = [...css.matchAll(/@media \(max-width: (\d+)px\) \{([^@]*?)\n\}/gs)]
    .map(([, larghezza, corpo]) => ({ larghezza: Number(larghezza), corpo }));
  assert.ok(soglie.length >= 2, 'servono due soglie, non una');

  const [larga, stretta] = soglie.sort((a, b) => b.larghezza - a.larghezza);
  assert.match(larga.corpo, /\.col-time \{ display: none/,
    'alla prima soglia cede la colonna dell orario, che l anteprima sa già dire');
  assert.match(stretta.corpo, /\.timeline \{ display: none/,
    'alla seconda non ci sta più l anteprima');
  assert.match(stretta.corpo, /\.col-time \{ display: table-cell/,
    'e allora la colonna dell orario deve tornare: senza, l orario sparirebbe del tutto');
}

// --- le celle sanno a quale colonna appartengono -------------------------
// Le regole qui sopra parlano di classi: senza, nasconderebbero l intestazione
// e lascerebbero le celle al loro posto, sfasando tutta la tabella.
{
  const popup = leggi('src/popup.js');
  const html = leggi('src/popup.html');
  for (const colonna of ['col-check', 'col-issue', 'col-what', 'col-hours', 'col-time', 'col-actions']) {
    assert.match(html, new RegExp(`class="${colonna}"`), `manca l intestazione ${colonna}`);
    assert.match(popup, new RegExp(`className = '${colonna}'`), `le celle ${colonna} non sono etichettate`);
  }
}

// --- la scelta è configurabile e il pannello è il valore di partenza ------
assert.equal(DEFAULT_CONFIG.ui.sidePanel, true,
  'per un estensione che si usa mentre si guarda Jira, il pannello è il default sensato');
assert.match(leggi('src/options.js'), /send\('refreshUiMode'\)/,
  'cambiando la scelta va applicata subito, non al prossimo avvio di Chrome');

console.log('pannello laterale: tutti i controlli passati.');
