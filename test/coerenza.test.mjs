// Il giro d'insieme, fatto dalla macchina.
//
// Non verifica un comportamento: verifica che i pezzi si conoscano fra loro.
// Sono i controlli che uno farebbe a mano leggendo tutto il codice — un
// comando chiamato che non esiste, una chiave di traduzione rimasta senza
// frase, un id sparito dall'HTML, un pezzo di stato che nessuno legge più.
// Fatti a mano si fanno una volta; qui si rifanno a ogni `npm test`.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const leggi = (rel) => readFileSync(join(root, rel), 'utf8');

const LIB = readdirSync(join(root, 'src/lib')).map((f) => `src/lib/${f}`);
const SORGENTI = ['src/popup.js', 'src/options.js', 'src/background.js', ...LIB];
const MARKUP = ['src/popup.html', 'src/options.html'];
const TUTTO = [...SORGENTI, ...MARKUP, 'manifest.json'].map(leggi).join('\n');

// --- ogni tipo di campo deve essere vestito -------------------------------
// Due volte oggi lo stesso difetto: la `textarea` della nota è nata col testo
// nero su fondo scuro, e il menu della divisione ore con la freccia del
// sistema in mezzo ai campi nostri. La regola condivisa è scritta per
// esclusione (`input:not([type="checkbox"])`) proprio per non dimenticarsene,
// ma un tipo che non è un `input` le sfugge comunque. Qui si controlla che
// ogni tipo di campo presente nel markup sia dentro quella regola.
{
  for (const [markup, foglio] of [
    ['src/popup.html', 'src/popup.css'],
    ['src/options.html', 'src/options.css']
  ]) {
    const html = leggi(markup);
    const css = leggi(foglio);
    const selettore = css.slice(
      css.indexOf('input:not([type="checkbox"])'),
      css.indexOf('{', css.indexOf('input:not([type="checkbox"])'))
    );
    assert.ok(selettore, `${foglio} non ha una regola condivisa per i campi`);

    for (const tag of ['textarea', 'select']) {
      if (!new RegExp(`<${tag}[\\s>]`).test(html)) continue;
      assert.ok(selettore.includes(tag),
        `${markup} usa <${tag}> ma ${foglio} non lo veste: nascerà con lo stile del browser`);
    }
  }
}

// --- un passo verticale solo dentro la card -------------------------------
// I margini decisi uno per uno facevano 2px fra titolo e dettaglio, 4px prima
// della nota e 5px prima dell'orario: ogni riga risultava spaziata a modo suo
// a seconda dei pezzi che aveva. Uno che aggiunge un blocco nuovo con il suo
// `margin-top` rimette esattamente quel difetto.
{
  const css = leggi('src/popup.css');
  const regola = (selettore) => {
    const inizio = css.indexOf(selettore + ' {');
    return inizio < 0 ? '' : css.slice(inizio, css.indexOf('}', inizio));
  };

  for (const selettore of ['tr', '.col-what']) {
    assert.match(regola(selettore), /gap: var\(--passo-card\)/,
      `${selettore} deve usare il passo condiviso, non una misura sua`);
  }
  for (const selettore of ['.detail', '.altri', '.comment', '.time']) {
    assert.doesNotMatch(regola(selettore), /margin-top|padding-top/,
      `${selettore} si spazia da sé: la card torna a due passi diversi`);
  }
}

// --- la nota si manda da un punto solo, e passa dall'impostazione ---------
// È l'unica strada per cui una nota arriva su Jira: se un domani ne spuntasse
// una seconda, l'impostazione varrebbe per metà — e chi l'ha spenta si
// ritroverebbe i worklog scritti lo stesso.
{
  const bg = leggi('src/background.js');
  assert.equal((bg.match(/addWorklog\(/g) || []).length, 1,
    'le ore si scrivono da un posto solo, o l impostazione varrebbe per metà');
  assert.match(bg, /config\.work\.sendComments === false \? undefined/,
    'e chi l ha spenta non deve vedersela scritta lo stesso');
}

// --- i comandi del service worker ----------------------------------------
{
  const bg = leggi('src/background.js');
  const inizio = bg.indexOf('const HANDLERS');
  const dichiarati = [...bg.slice(inizio, bg.indexOf('};', inizio)).matchAll(/^\s*(\w+),?$/gm)]
    .map((m) => m[1]);
  const usati = [...new Set(
    ['src/popup.js', 'src/options.js'].map(leggi).join('\n')
      // Il popup passa da un guscio (`comando`) che dimentica i tentativi di
      // rimedio quando un comando riesce; le opzioni chiamano `send` diretto.
      .matchAll(/\b(?:send|comando)\('(\w+)'/g)
  )].map((m) => m[1]);

  assert.ok(dichiarati.length > 5, 'la scansione ha trovato la tabella dei comandi');
  assert.deepEqual(usati.filter((c) => !dichiarati.includes(c)), [],
    'il popup chiama un comando che il service worker non conosce');
  assert.deepEqual(dichiarati.filter((c) => !usati.includes(c)), [],
    'comandi rimasti nel service worker che nessuno chiama più');
}

// --- le traduzioni --------------------------------------------------------
{
  const en = JSON.parse(leggi('_locales/en/messages.json'));
  const it = JSON.parse(leggi('_locales/it/messages.json'));
  assert.deepEqual(Object.keys(en).sort(), Object.keys(it).sort(),
    'le due lingue non hanno le stesse chiavi');

  // Una chiave senza frase esce a schermo come chiave: lo si scopre solo
  // arrivando su quel caso, che spesso è un caso d'errore.
  const citate = [...TUTTO.matchAll(/['"]([a-zA-Z][a-zA-Z0-9_]{2,})['"]|__MSG_(\w+)__/g)]
    .map((m) => m[1] || m[2]);
  const note = new Set(citate);
  const orfane = Object.keys(en).filter((k) => !note.has(k));
  assert.deepEqual(orfane, [], 'chiavi tradotte che nessuno usa più');
}

// --- gli elementi del DOM -------------------------------------------------
for (const [js, html] of [['src/popup.js', 'src/popup.html'], ['src/options.js', 'src/options.html']]) {
  const markup = leggi(html);
  const mancanti = [...leggi(js).matchAll(/getElementById\(\s*['"`]([\w-]+)['"`]\s*\)/g)]
    .map((m) => m[1])
    .filter((id) => !markup.includes(`id="${id}"`));
  // Un id sparito non dà errore: `el.qualcosa` resta null e il pezzo di
  // interfaccia semplicemente non funziona più, in silenzio.
  assert.deepEqual(mancanti, [], `${js} cerca elementi che in ${html} non ci sono`);
}

// --- lo stato del popup ---------------------------------------------------
{
  const popup = leggi('src/popup.js');
  const inizio = popup.indexOf('const state = {');
  const campi = [...popup.slice(inizio, popup.indexOf('\n};', inizio)).matchAll(/^  (\w+):/gm)]
    .map((m) => m[1]);
  assert.ok(campi.length > 10, 'la scansione ha trovato i campi di stato');

  // Su una Map o un Set, `set`/`add`/`clear` scrivono mentre `get`/`has`
  // leggono: contarli tutti come scritture direbbe che un contenitore
  // interrogato di continuo non viene mai letto.
  const MUTAZIONI = /\.(set|add|delete|clear|push|pop|splice|sort)\(/;
  const morti = campi.filter((campo) => {
    const usi = popup.split(`state.${campo}`).length - 1;
    const scritture = [...popup.matchAll(new RegExp(`state\\.${campo}\\s*=[^=]`, 'g'))].length;
    const mutazioni = [...popup.matchAll(new RegExp(`state\\.${campo}\\.\\w+\\(`, 'g'))]
      .filter((m) => MUTAZIONI.test(m[0])).length;
    return usi - scritture - mutazioni <= 0;
  });
  // Un campo che si scrive e non si legge mai è una decisione presa e poi
  // dimenticata: costa niente tenerlo, e proprio per questo resta.
  assert.deepEqual(morti, [], 'campi di stato scritti e mai letti');
}

// --- le classi CSS --------------------------------------------------------
{
  const css = leggi('src/popup.css');
  const fonte = leggi('src/popup.js') + leggi('src/popup.html');
  const classi = new Set();
  for (const m of fonte.matchAll(/className = '([a-z0-9 -]+)'/g)) {
    m[1].split(' ').forEach((c) => c && classi.add(c));
  }
  for (const m of fonte.matchAll(/classList\.(?:add|toggle)\('([a-z0-9-]+)'/g)) classi.add(m[1]);
  for (const m of fonte.matchAll(/class="([a-z0-9 -]+)"/g)) {
    m[1].split(' ').forEach((c) => c && classi.add(c));
  }

  const senzaRegola = [...classi].filter((c) => !new RegExp(`\\.${c}[^a-z0-9-]`).test(css));
  // Una classe senza regola è o un residuo, o uno stile che credevi di aver
  // scritto: in entrambi i casi vale la pena saperlo.
  assert.deepEqual(senzaRegola, [], 'classi usate nel markup che nel foglio non esistono');
}

// --- il manifest ----------------------------------------------------------
{
  const manifest = JSON.parse(leggi('manifest.json'));
  const codice = SORGENTI.map(leggi).join('\n');
  for (const permesso of manifest.permissions) {
    assert.ok(codice.includes(`chrome.${permesso}`),
      `il manifest chiede il permesso «${permesso}» che il codice non usa`);
  }
  for (const rel of [manifest.action?.default_popup, manifest.options_page, manifest.background?.service_worker]) {
    if (rel) assert.doesNotThrow(() => leggi(rel), `il manifest punta a ${rel}, che non c'è`);
  }
}

// --- le linguette e i loro pannelli ---------------------------------------
{
  const html = leggi('src/popup.html');
  const pannelli = [...html.matchAll(/aria-controls="([\w-]+)"/g)].map((m) => m[1]);
  const tab = [...html.matchAll(/role="tab"/g)].length;
  assert.equal(pannelli.length, tab, 'ogni linguetta deve dire quale pannello comanda');
  for (const id of pannelli) {
    assert.ok(new RegExp(`id="${id}"[^>]*role="tabpanel"`).test(html),
      `la linguetta punta a #${id}, che non è un pannello`);
  }
}

// --- niente tracce di debug -----------------------------------------------
for (const file of [...SORGENTI, ...MARKUP]) {
  assert.doesNotMatch(leggi(file), /\bconsole\.(log|debug|warn|error)\b|\bdebugger\b/,
    `${file} contiene tracce di debug`);
}

console.log('coerenza: tutti i controlli passati.');
