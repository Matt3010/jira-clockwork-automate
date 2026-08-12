// Il canale verso il fondo: un comando, una risposta.
//
// Popup e opzioni parlano tutti e due col service worker, e lo facevano con
// due copie della stessa funzione — la seconda gia' piu' povera della prima,
// che e' come vanno le copie: perdeva `code` e `detail`, cioe' proprio i campi
// con cui il popup decide che rimedio proporre.
//
// `chrome.runtime.lastError` va letto dentro la callback: leggerlo fuori, o non
// leggerlo affatto, lascia l'errore in console e la promessa appesa per sempre.

/**
 * @param {string} type    nome del comando, fra quelli in HANDLERS
 * @param {object} [payload]
 * @returns {Promise<any>} il dato della risposta, o solleva con `code`/`detail`
 */
export function send(type, payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, payload }, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response?.ok) {
        const error = new Error(response?.error || 'Unknown error');
        error.code = response?.code || null;
        error.detail = response?.detail || null;
        return reject(error);
      }
      resolve(response.data);
    });
  });
}
