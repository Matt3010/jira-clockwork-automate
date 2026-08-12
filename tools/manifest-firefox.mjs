// Il manifest di Firefox, ricavato da quello di Chrome.
//
// Due manifest scritti a mano sarebbero due file da tenere allineati, e il
// secondo resterebbe indietro alla prima modifica — un permesso aggiunto di la'
// e non di qua non da' errori, da' un'estensione che su un browser solo non
// funziona piu'. Qui il manifest e' uno: `manifest.json` e' quello di Chrome, e
// la versione per Firefox si calcola da quello a ogni build.
//
// Le differenze sono quattro, e sono tutte nella stessa direzione: Firefox
// chiama le stesse cose con altri nomi.
//
//   1. il fondo. Chrome vuole un service worker, Firefox una pagina evento:
//      `background.scripts`. Il codice caricato e' lo stesso file bundlato.
//   2. il pannello laterale. Su Chrome e' `side_panel` piu' il permesso
//      `sidePanel`; su Firefox e' `sidebar_action`, e permessi non ne chiede.
//      Il permesso va tolto: un permesso sconosciuto fa scartare il manifest
//      in revisione, e a Firefox non serve.
//   3. le opzioni. `options_page` su Firefox e' la forma vecchia, e
//      `runtime.openOptionsPage()` — che e' come ci si arriva dal popup — apre
//      solo quella dichiarata in `options_ui`.
//   4. l'identita'. Senza `browser_specific_settings.gecko.id` l'estensione
//      cambia identita' a ogni caricamento e si porta via la configurazione
//      salvata; AMO lo pretende comunque.

// L'id e' un'etichetta, non un indirizzo: deve solo avere la forma di una
// email ed essere stabile nel tempo. Cambiarlo significa, per il browser, una
// estensione diversa — quindi configurazione da rifare per chi l'aveva.
export const GECKO_ID = 'clockwork-autofill@matteoscanferla';

// `scripting.executeScript` accetta `world` da Firefox 128; sotto, la
// proprieta' sconosciuta fa fallire ogni richiesta invece di essere ignorata.
// Tanto vale dirlo qui che installarla piu' in basso non ha senso.
export const GECKO_MIN = '128.0';

/**
 * @param {object} manifest il manifest di Chrome, gia' letto
 * @returns {object} lo stesso manifest come lo vuole Firefox
 */
export function manifestFirefox(manifest) {
  const out = {};

  for (const [chiave, valore] of Object.entries(manifest)) {
    if (chiave === 'permissions') {
      out.permissions = valore.filter((p) => p !== 'sidePanel');
    } else if (chiave === 'background') {
      // Il tipo resta quello dichiarato: il bundle e' un modulo ES in tutti e
      // due i casi, e Firefox li carica nel fondo da tempo.
      out.background = { scripts: [valore.service_worker], type: valore.type || 'classic' };
    } else if (chiave === 'side_panel') {
      out.sidebar_action = {
        default_title: manifest.action?.default_title || manifest.name,
        default_panel: valore.default_path,
        default_icon: manifest.action?.default_icon || manifest.icons,
        // Aprirsi da solo appena installato e' una porta sbattuta in faccia:
        // il pannello si apre al primo click sull'icona, come su Chrome.
        open_at_install: false
      };
    } else if (chiave === 'options_page') {
      // `open_in_tab` per restare come su Chrome: la pagina delle opzioni e'
      // lunga, e dentro il riquadro della gestione estensioni si legge peggio.
      out.options_ui = { page: valore, open_in_tab: true };
    } else {
      out[chiave] = valore;
    }
  }

  out.browser_specific_settings = {
    gecko: { id: GECKO_ID, strict_min_version: GECKO_MIN }
  };

  return out;
}
