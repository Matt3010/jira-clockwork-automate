// Traduzioni per lo userscript: le stesse dell'estensione, in italiano.
//
// Planner e analisi non producono frasi ma chiavi con parametri, che
// l'estensione traduce con `chrome.i18n`. Qui `chrome` non c'e': si legge lo
// stesso `messages.json`, impacchettato da esbuild, e si sostituiscono i
// segnaposto come fa Chrome — `$NOME$` rimanda a `placeholders.nome.content`,
// che a sua volta e' `$1`, `$2`, ...

import messages from './messages.it.json' with { type: 'json' };

export function translate(catalog, key, ...subs) {
  const entry = catalog[key];
  if (!entry?.message) return key;
  const placeholders = entry.placeholders || {};
  const valori = subs.map(String);
  return entry.message
    .replace(/\$([a-zA-Z0-9_]+)\$/g, (tutto, nome) => {
      const content = placeholders[nome.toLowerCase()]?.content;
      return content === undefined ? tutto : content;
    })
    .replace(/\$(\d)/g, (tutto, n) => valori[Number(n) - 1] ?? '')
    .replace(/\$\$/g, '$');
}

export const t = (key, ...subs) => translate(messages, key, ...subs);
