// Le traduzioni si rompono in silenzio: una chiave usata e mai definita esce
// come chiave nuda, una definita solo in una lingua fa ricadere quella riga in
// inglese senza che nessuno se ne accorga. Qui si controlla tutto insieme.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const leggi = (p) => readFileSync(join(root, p), 'utf8');

const en = JSON.parse(leggi('_locales/en/messages.json'));
const it = JSON.parse(leggi('_locales/it/messages.json'));
const manifest = JSON.parse(leggi('manifest.json'));

const sorgenti = ['src/popup.js', 'src/options.js', 'src/background.js', 'src/lib/planner.js'];
const html = ['src/popup.html', 'src/options.html'];
const codice = sorgenti.map(leggi).join('\n');
const markup = html.map(leggi).join('\n');

// --- il manifest deve dichiarare la lingua di ripiego ----------------------
assert.equal(manifest.default_locale, 'en', 'l inglese è la lingua di ripiego');
assert.match(manifest.description, /^__MSG_(\w+)__$/, 'anche la descrizione è tradotta');
const chiaveDescrizione = /^__MSG_(\w+)__$/.exec(manifest.description)[1];
assert.ok(en[chiaveDescrizione], `manca ${chiaveDescrizione} in inglese`);

// --- le due lingue devono avere le stesse chiavi ---------------------------
const chiaviEn = Object.keys(en).sort();
const chiaviIt = Object.keys(it).sort();
assert.deepEqual(chiaviIt.filter((k) => !en[k]), [], 'chiavi presenti solo in italiano');
assert.deepEqual(chiaviEn.filter((k) => !it[k]), [], 'chiavi presenti solo in inglese');

// --- e gli stessi segnaposto, o le frasi tradotte perdono pezzi ------------
const segnaposto = (voce) => [...voce.message.matchAll(/\$(\w+)\$/g)].map((m) => m[1].toLowerCase()).sort();
for (const chiave of chiaviEn) {
  assert.deepEqual(
    segnaposto(it[chiave]), segnaposto(en[chiave]),
    `i segnaposto di "${chiave}" non combaciano fra le due lingue`
  );
  // Ogni segnaposto usato dev'essere dichiarato, altrimenti Chrome lo lascia grezzo.
  for (const lingua of [en, it]) {
    const dichiarati = Object.keys(lingua[chiave].placeholders || {}).map((p) => p.toLowerCase());
    for (const usato of segnaposto(lingua[chiave])) {
      assert.ok(dichiarati.includes(usato), `"${chiave}": segnaposto $${usato}$ usato ma non dichiarato`);
    }
  }
  assert.ok(en[chiave].message.trim(), `"${chiave}" è vuota in inglese`);
  assert.ok(it[chiave].message.trim(), `"${chiave}" è vuota in italiano`);
}

// --- ogni chiave usata dal codice deve esistere ----------------------------
const usateNelCodice = [...new Set([...codice.matchAll(/\bt\('([a-zA-Z]+)'/g)].map((m) => m[1]))];
assert.ok(usateNelCodice.length > 40, 'la scansione ha trovato le chiamate a t()');
assert.deepEqual(usateNelCodice.filter((k) => !en[k]), [], 'chiavi usate nel codice ma non definite');

// --- e ogni chiave dichiarata nell'HTML pure -------------------------------
const usateNelMarkup = [...new Set(
  [...markup.matchAll(/data-i18n(?:-title|-placeholder)?="([a-zA-Z]+)"/g)].map((m) => m[1])
)];
assert.ok(usateNelMarkup.length > 20, 'la scansione ha trovato gli attributi data-i18n');
assert.deepEqual(usateNelMarkup.filter((k) => !en[k]), [], 'chiavi nell HTML ma non definite');

// --- le chiavi dei messaggi generati dal planner e dal background ----------
const chiaviMessaggi = [...new Set([...codice.matchAll(/key: '([a-zA-Z]+)'/g)].map((m) => m[1]))];
assert.ok(chiaviMessaggi.length >= 9, 'planner e background usano chiavi, non prosa');
assert.deepEqual(chiaviMessaggi.filter((k) => !en[k]), [], 'chiavi di avvisi non definite');

// --- niente frasi rimaste nel codice --------------------------------------
// Un accento in una stringa letterale tradisce prosa italiana non tradotta.
for (const file of sorgenti) {
  const testo = leggi(file);
  const righe = testo.split('\n');
  const sospette = [];
  righe.forEach((riga, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(riga)) return; // i commenti restano in italiano
    if (/(['"`])[^'"`]*[àèéìòù][^'"`]*\1/.test(riga)) sospette.push(`${file}:${i + 1}`);
  });
  assert.deepEqual(sospette, [], `stringhe non tradotte in ${sospette.join(', ')}`);
}

// --- nessuna chiave definita e mai usata ----------------------------------
// Qui si cerca la chiave come stringa ovunque: alcune finiscono in un ternario
// o in un elenco (i giorni della settimana, singolare/plurale) e la scansione
// delle sole chiamate `t('...')` non le vedrebbe.
const orfane = chiaviEn.filter((chiave) => {
  if (chiave === chiaveDescrizione || usateNelMarkup.includes(chiave)) return false;
  return !new RegExp(`'${chiave}'`).test(codice);
});
assert.deepEqual(orfane, [], `chiavi definite ma mai usate: ${orfane.join(', ')}`);

console.log(`traduzioni: ${chiaviEn.length} chiavi in 2 lingue, tutti i controlli passati.`);
