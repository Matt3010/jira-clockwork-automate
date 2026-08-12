// Le due pagine, vive.
//
// Il resto della suite guarda il sorgente: che un id esista, che una classe
// abbia la sua regola, che un comando abbia il suo handler. Sono controlli che
// non eseguono niente, e quindi non vedono la meta' dei modi in cui una pagina
// si rompe — un `render` che solleva, un gestore agganciato all'elemento
// sbagliato, un pulsante che parte col piano di ieri.
//
// Qui si apre davvero `popup.html` (o `options.html`) dentro jsdom, si mette
// in piedi un finto `chrome` che risponde quello che gli si dice, e si importa
// il modulo. Da li' in poi si clicca e si legge il DOM, come farebbe chi la usa.
//
// jsdom e' una devDependency: come esbuild, serve a lavorare e non finisce nel
// pacchetto — il build copia solo `src`, `icons` e `_locales`.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MESSAGGI = JSON.parse(readFileSync(join(root, '_locales/en/messages.json'), 'utf8'));

// Il `setTimeout` vero, preso prima di sostituirlo: le attese dei test devono
// tenere sveglio node, mentre quelle dell'interfaccia no.
const timeoutVero = globalThis.setTimeout;

// I moduli ESM si importano una volta sola per processo, e le suite girano
// tutte nello stesso: senza un contrassegno diverso a ogni apertura, la
// seconda pagina riuserebbe lo stato della prima.
let giro = 0;

const definisci = (nome, valore) =>
  Object.defineProperty(globalThis, nome, { value: valore, configurable: true, writable: true });

/**
 * @param {'popup'|'options'} pagina
 * @param {object} opzioni
 * @param {Record<string, any|Function>} opzioni.risposte  cosa risponde il fondo,
 *   per tipo di comando. Un valore con `ok` viene passato cosi' com'e' (serve a
 *   simulare gli errori), qualsiasi altra cosa diventa `{ ok: true, data }`.
 * @param {string} opzioni.query  la parte dopo `?` nell'URL della pagina
 * @param {object} opzioni.disco  cosa c'e' gia' in `chrome.storage.local`
 */
export async function apriPagina(pagina, { risposte = {}, query = '', disco = {} } = {}) {
  const html = readFileSync(join(root, 'src', `${pagina}.html`), 'utf8');

  // jsdom non sa navigare, e scaricare un file e' una navigazione: quel
  // «Not implemented» e' un suo limite, non un difetto della pagina. Tutto il
  // resto — errori veri, console della pagina — deve continuare a vedersi.
  const consolle = new VirtualConsole();
  for (const livello of ['log', 'info', 'warn', 'error']) {
    consolle.on(livello, (...args) => console[livello](...args));
  }
  consolle.on('jsdomError', (errore) => {
    if (!/Not implemented/.test(errore.message)) console.error(errore);
  });

  const dom = new JSDOM(html, {
    url: `https://estensione.test/src/${pagina}.html${query}`,
    pretendToBeVisual: true,
    virtualConsole: consolle
  });

  for (const nome of ['window', 'document', 'location', 'CSS', 'Blob', 'URL', 'Event', 'HTMLElement']) {
    definisci(nome, dom.window[nome] ?? dom.window.document);
  }
  definisci('document', dom.window.document);
  definisci('getComputedStyle', (...args) => dom.window.getComputedStyle(...args));
  // jsdom non implementa `CSS.escape`, che il popup usa per ritrovare una riga
  // dal suo id (`task:ABC-1`, coi due punti che nei selettori vanno protetti).
  // Non e' un difetto del popup: e' un buco del finto browser, e si tappa qui.
  definisci('CSS', {
    ...dom.window.CSS,
    escape: (valore) => String(valore).replace(/[^a-zA-Z0-9_\u00A0-\uFFFF-]/g, (c) => `\\${c}`)
  });
  // In node recente `navigator` e' un getter di sola lettura sul globale.
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });

  const appunti = [];
  Object.defineProperty(dom.window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (testo) => { appunti.push(testo); } }
  });

  // Il battito del popup non deve tenere in vita il processo: il suo intervallo
  // si raccoglie qui e si fa scattare a mano, che e' anche l'unico modo di
  // verificarlo senza aspettare quindici secondi veri.
  const battiti = [];
  definisci('setInterval', (fn) => { battiti.push(fn); return battiti.length; });
  definisci('clearInterval', () => {});
  // I timeout invece restano veri — sono le attese brevi dell'interfaccia — ma
  // sganciati, o l'ultimo avviso terrebbe aperto node per cinque secondi.
  definisci('setTimeout', (fn, ms, ...args) => {
    const id = timeoutVero(fn, ms, ...args);
    id?.unref?.();
    return id;
  });

  // Il popup misura l'anteprima al fotogramma dopo il disegno. Qui il
  // fotogramma arriva subito: le misure di jsdom sono tutte zero, ma il codice
  // che le legge deve poterci passare sopra senza sollevare.
  definisci('requestAnimationFrame', (fn) => { queueMicrotask(() => fn(0)); return 1; });
  definisci('cancelAnimationFrame', () => {});

  const chiamate = [];
  const tabs = [];
  let opzioniAperte = 0;

  // Le opzioni leggono e scrivono la configurazione da sole, senza passare dal
  // fondo: senza archivio finto la pagina non arriva nemmeno a disegnarsi.
  const archivio = { local: { ...disco }, sync: {} };
  const finge = (dove) => ({
    get: async (chiavi) => {
      const elenco = Array.isArray(chiavi) ? chiavi : [chiavi];
      return Object.fromEntries(elenco.filter((k) => k in archivio[dove]).map((k) => [k, archivio[dove][k]]));
    },
    set: async (patch) => { Object.assign(archivio[dove], patch); }
  });

  definisci('chrome', {
    storage: { local: finge('local'), sync: finge('sync') },
    // Le traduzioni vere, in inglese: cosi' i test leggono quello che si legge
    // a schermo invece delle chiavi, e la sostituzione dei segnaposto — che e'
    // il pezzo che si rompe in silenzio — passa di qui davvero.
    i18n: {
      getMessage(chiave, subs = []) {
        const voce = MESSAGGI[chiave];
        if (!voce) return '';
        let testo = voce.message;
        for (const [nome, dichiarato] of Object.entries(voce.placeholders || {})) {
          const indice = Number(String(dichiarato.content).replace('$', '')) - 1;
          testo = testo.replaceAll(`$${nome.toUpperCase()}$`, subs[indice] ?? '');
        }
        return testo;
      }
    },
    runtime: {
      lastError: null,
      sendMessage(messaggio, callback) {
        chiamate.push(messaggio);
        const risposta = risposte[messaggio.type];
        const valore = typeof risposta === 'function' ? risposta(messaggio.payload) : risposta;
        const finale = valore && typeof valore === 'object' && 'ok' in valore
          ? valore
          : { ok: true, data: valore === undefined ? {} : valore };
        queueMicrotask(() => callback(finale));
      },
      openOptionsPage() { opzioniAperte += 1; }
    },
    tabs: {
      create(opzioni, callback) {
        tabs.push(opzioni);
        callback?.({ id: tabs.length, status: 'complete' });
      },
      onUpdated: { addListener() {}, removeListener() {} }
    }
  });

  const modulo = await import(`../src/${pagina}.js?giro=${++giro}`);

  return {
    dom,
    modulo,
    document: dom.window.document,
    /** Ogni messaggio arrivato al fondo, in ordine. */
    chiamate,
    /** L'ultimo payload di un comando, per non ripetere il filtro ogni volta. */
    ultima: (tipo) => [...chiamate].reverse().find((c) => c.type === tipo)?.payload,
    tabs,
    appunti,
    /** Quello che le opzioni hanno davvero scritto sul disco. */
    archivio,
    opzioniAperte: () => opzioniAperte,
    battito: () => battiti.forEach((fn) => fn()),
    /** Lascia girare le promesse in coda: le risposte del fondo arrivano li'. */
    attendi: async (giri = 3) => {
      for (let i = 0; i < giri; i++) await new Promise((r) => timeoutVero(r, 0));
    },
    chiudi: () => dom.window.close()
  };
}

/** Scorciatoie di lettura, che nei test si ripeterebbero a ogni riga. */
export const testo = (nodo) => (nodo?.textContent || '').trim();
export const tutti = (radice, selettore) => [...radice.querySelectorAll(selettore)];
