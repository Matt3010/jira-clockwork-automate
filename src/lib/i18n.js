// Traduzioni.
//
// Si appoggia a `chrome.i18n`, che sceglie la lingua dell'interfaccia del
// browser e ricade sul `default_locale` del manifest (inglese) quando non c'e'
// una traduzione. I testi stanno in `_locales/<lingua>/messages.json`.
//
// Fuori dall'estensione — nei test — `chrome` non esiste: `t` restituisce la
// chiave, cosi' i moduli puri restano eseguibili in node.

/**
 * @param {string} key chiave in messages.json
 * @param {...(string|number)} subs sostituzioni per i segnaposto $1, $2, ...
 */
export function t(key, ...subs) {
  const api = globalThis.chrome?.i18n;
  if (!api) return key;
  const testo = api.getMessage(key, subs.map(String));
  // Una chiave sbagliata restituisce stringa vuota: meglio vedere la chiave che
  // un buco nell'interfaccia.
  return testo || key;
}

/**
 * Traduce il markup statico. Gli elementi dichiarano la chiave con:
 *   data-i18n              -> testo dell'elemento
 *   data-i18n-title        -> attributo title
 *   data-i18n-placeholder  -> attributo placeholder
 *
 * Il testo scritto nell'HTML resta come sorgente inglese leggibile e come
 * ripiego se la chiave sparisce.
 */
export function applyI18n(root = document) {
  for (const node of root.querySelectorAll('[data-i18n]')) {
    const testo = t(node.dataset.i18n);
    if (testo !== node.dataset.i18n) node.textContent = testo;
  }
  for (const [attributo, dato] of [['title', 'i18nTitle'], ['placeholder', 'i18nPlaceholder']]) {
    for (const node of root.querySelectorAll(`[data-i18n-${attributo}]`)) {
      const testo = t(node.dataset[dato]);
      if (testo !== node.dataset[dato]) node.setAttribute(attributo, testo);
    }
  }
  const titolo = root.querySelector?.('title');
  if (titolo?.dataset?.i18n) document.title = t(titolo.dataset.i18n);
}
