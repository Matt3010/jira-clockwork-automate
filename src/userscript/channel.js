// Canale verso Jira dalla pagina stessa.
//
// Lo userscript gira dentro <sito>.atlassian.net: le richieste sono
// same-origin e usano il login gia' fatto, senza schede da cercare ne' script
// da iniettare. La risposta ha la stessa forma del Channel dell'estensione —
// `{ status, text, contentType }` — cosi' JiraClient resta quello che e'.

export class PageChannel {
  constructor({ base = globalThis.location?.origin || '', fetchImpl } = {}) {
    this.base = base;
    this.fetch = fetchImpl || ((...args) => globalThis.fetch(...args));
  }

  get host() {
    try {
      return new URL(this.base).host;
    } catch {
      return '';
    }
  }

  async request(path, { method = 'GET', headers = {}, body } = {}) {
    const init = {
      method,
      credentials: 'include',
      headers: { Accept: 'application/json', ...headers }
    };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    try {
      const response = await this.fetch(this.base + path, init);
      return {
        status: response.status,
        text: await response.text(),
        contentType: response.headers.get('content-type') || ''
      };
    } catch (error) {
      // Rete giu' o richiesta bloccata: status 0, come fa l'estensione, e
      // JiraClient lo trasforma in un errore leggibile.
      return { status: 0, text: String(error?.message || error), contentType: '' };
    }
  }
}
