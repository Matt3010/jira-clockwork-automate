// Lo stesso codice su due browser.
//
// Il manifest per Firefox non è scritto a mano: si calcola da quello di
// Chrome. È l'unico modo perché un permesso aggiunto oggi ci sia anche di là —
// ma allora il calcolo va controllato, perché sbagliarlo non dà un errore:
// dà un'estensione che si installa e non fa niente.
//
// Le tre cose che cambiano — il fondo, il pannello, l'identità — sono anche le
// tre che, sbagliate, si notano solo installando.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { manifestFirefox, GECKO_ID, GECKO_MIN } from '../tools/manifest-firefox.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const leggi = (rel) => readFileSync(join(root, rel), 'utf8');

const chrome = JSON.parse(leggi('manifest.json'));
const firefox = manifestFirefox(chrome);

// --- il fondo -------------------------------------------------------------
// Chrome vuole un service worker, Firefox una pagina evento. Il file caricato
// deve restare lo stesso, o i due pacchetti eseguirebbero codice diverso.
assert.equal(firefox.background.service_worker, undefined,
  'un service worker Firefox non sa cosa sia: il fondo resterebbe spento');
assert.deepEqual(firefox.background.scripts, [chrome.background.service_worker],
  'il fondo deve essere lo stesso file, dichiarato come script');
assert.equal(firefox.background.type, 'module',
  'il bundle è un modulo ES: senza il tipo gli import non si risolvono');

// --- il pannello laterale -------------------------------------------------
assert.equal(firefox.side_panel, undefined, '`side_panel` è una chiave di Chrome');
assert.ok(!firefox.permissions.includes('sidePanel'),
  'un permesso sconosciuto fa scartare il manifest, e a Firefox non serve');
assert.equal(firefox.sidebar_action.default_panel, chrome.side_panel.default_path,
  'il pannello deve aprire la stessa pagina, parametro compreso');
assert.ok(firefox.sidebar_action.default_icon, 'senza icona il pannello resta senza titolo riconoscibile');
assert.equal(firefox.sidebar_action.open_at_install, false,
  'aprirsi da solo appena installato non è quello che fa su Chrome');

// Il resto dei permessi non si tocca: togliere di troppo si scopre a runtime.
assert.deepEqual(
  firefox.permissions,
  chrome.permissions.filter((p) => p !== 'sidePanel'),
  'oltre a sidePanel non deve sparire niente'
);
assert.deepEqual(firefox.host_permissions, chrome.host_permissions,
  'senza gli host il canale non trova nessuna scheda');

// --- le opzioni -----------------------------------------------------------
// Dal popup ci si arriva con `runtime.openOptionsPage()`, che su Firefox apre
// solo la pagina dichiarata in `options_ui`: con la sola `options_page` il
// pulsante degli ingranaggi non farebbe niente.
assert.equal(firefox.options_page, undefined, '`options_page` da sola su Firefox non basta');
assert.equal(firefox.options_ui.page, chrome.options_page, 'e deve essere la stessa pagina');
assert.equal(firefox.options_ui.open_in_tab, true,
  'in una scheda, come su Chrome: nel riquadro delle estensioni la pagina non ci sta');
assert.match(leggi('src/popup.js'), /openOptionsPage/, 'il popup ci arriva da lì');

// --- l'identità -----------------------------------------------------------
// Senza id l'estensione ne prende uno nuovo a ogni caricamento, e con l'id
// cambia anche l'archivio: la configurazione salvata sparisce.
assert.equal(firefox.browser_specific_settings.gecko.id, GECKO_ID);
assert.match(GECKO_ID, /^[a-z0-9-._]+@[a-z0-9-._]+$/i, 'l id gecko ha la forma di una email');
assert.equal(firefox.browser_specific_settings.gecko.strict_min_version, GECKO_MIN);
assert.ok(Number(GECKO_MIN.split('.')[0]) >= 128,
  '`world` in scripting.executeScript esiste da Firefox 128: sotto, ogni richiesta fallisce');

// --- quello che non cambia ------------------------------------------------
for (const chiave of ['manifest_version', 'name', 'version', 'default_locale', 'description', 'icons', 'action']) {
  assert.deepEqual(firefox[chiave], chrome[chiave], `${chiave} non ha motivo di cambiare fra i due browser`);
}

// --- il codice deve saperci stare, su tutti e due -------------------------
{
  const bg = leggi('src/background.js');
  assert.match(bg, /chrome\.sidebarAction/,
    'il pannello di Firefox ha un altro nome: senza, resta il popup ovunque');
  // Su Firefox il pannello si apre solo dentro un gesto dell'utente: se
  // nessuno ascolta il click, l'icona senza popup non fa proprio niente.
  assert.match(bg, /chrome\.action\.onClicked\.addListener/,
    'tolto il popup, il click va raccolto o l icona diventa muta');
  assert.match(bg, /sidebar\??\.toggle\(\)/, 'e deve aprire il pannello');
}

// --- i comandi di build ---------------------------------------------------
{
  const build = leggi('tools/build.mjs');
  assert.match(build, /firefox: \{ esbuild: 'firefox\d+', manifest: manifestFirefox \}/,
    'Firefox dev essere un bersaglio del build, col suo manifest e la sua versione minima');
  assert.match(build, /chromium: \{ esbuild: 'chrome\d+'/, 'e Chromium pure');

  // Un comando solo, e ricostruisce sempre tutto: rifare un pacchetto e
  // lasciare indietro l'altro è il modo in cui i due si sfasano.
  const pkg = JSON.parse(leggi('package.json'));
  assert.deepEqual(Object.keys(pkg.scripts), ['test', 'build']);
  assert.doesNotMatch(pkg.scripts.build, /chromium|firefox/,
    'il build non deve poter scegliere un browser');
  assert.match(build, /for \(const nome of Object\.keys\(BERSAGLI\)\)/,
    'e li costruisce tutti, senza guardare cosa gli è stato chiesto');
}

console.log('firefox: tutti i controlli passati.');
