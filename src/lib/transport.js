// Canale HTTP verso Jira.
//
// Un solo meccanismo di autenticazione: la sessione del browser. La richiesta
// viene eseguita DENTRO una scheda gia' aperta sul sito giusto, quindi e'
// same-origin e usa il cookie del login che l'utente ha gia' fatto.
// Nessun token, nessuna credenziale salvata da nessuna parte.

// I messaggi degli errori qui dentro sono diagnostici, non testo da leggere:
// il popup li rimpiazza con la versione tradotta a partire dal `code`. Restano
// in inglese come il resto delle diagnostiche, e non passano da `t` perche'
// devono conservare l'host anche quando le traduzioni non ci sono.
export class TransportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TransportError';
    this.code = code;
  }
}

/** Eseguita nella scheda: deve essere autosufficiente (viene serializzata). */
function pageFetch(url, init) {
  return fetch(url, { ...init, credentials: 'include' })
    .then((response) =>
      response.text().then((text) => ({
        status: response.status,
        text,
        contentType: response.headers.get('content-type') || '',
        finalUrl: response.url
      }))
    )
    .catch((error) => ({ status: 0, text: String((error && error.message) || error), contentType: '' }));
}

/**
 * Una risposta e' utilizzabile se viene davvero dall'API: 401/403 e le pagine
 * HTML (il redirect al login) significano "sessione non valida qui".
 */
function isApiResponse(result) {
  if (!result || result.status === 0) return false;
  if (result.status === 401 || result.status === 403) return false;
  if (result.status === 204) return true;
  return result.contentType.includes('json');
}

/** Schede aperte su un host preciso. Bastano gli host_permissions, non serve "tabs". */
export async function tabsOnHost(host) {
  if (!host) return [];
  try {
    return await chrome.tabs.query({ url: `*://${host}/*` });
  } catch {
    return [];
  }
}

/** Host Atlassian attualmente aperti nel browser, per il rilevamento automatico. */
export async function detectAtlassianHosts() {
  try {
    const tabs = await chrome.tabs.query({ url: '*://*.atlassian.net/*' });
    const hosts = new Map();
    for (const tab of tabs) {
      try {
        const { host } = new URL(tab.url);
        hosts.set(host, (hosts.get(host) || 0) + 1);
      } catch {
        // scheda senza url leggibile
      }
    }
    return [...hosts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([host, tabCount]) => ({ host, tabCount }));
  } catch {
    return [];
  }
}

export class Channel {
  /**
   * @param {object} options
   * @param {string} options.host      host su cui deve esistere la scheda
   * @param {string} options.base      base delle URL API su quell'host
   * @param {string} options.probePath endpoint leggero per validare la sessione
   * @param {string} options.label     nome del servizio, per i messaggi
   */
  constructor({ host, base, probePath, label }) {
    this.host = host;
    this.base = base;
    this.probePath = probePath;
    this.label = label;
    this.tabId = null;
    this._resolving = null;
  }

  /**
   * Trova una scheda con sessione valida. La ricerca e' vincolata a `host`:
   * una scheda su un altro sito non viene mai usata come ripiego.
   */
  resolve() {
    if (!this._resolving) this._resolving = this._resolve();
    return this._resolving;
  }

  /**
   * L'errore si porta dietro dove stava cercando di andare.
   *
   * Senza, chi lo riceve ha un codice e una frase ma nessun sito, e non puo'
   * proporre nessun rimedio: aprire *cosa*? Il contesto veniva appeso da chi
   * chiamava, un `.catch` alla volta, e bastava una strada che non ci passava
   * — l'identita' letta dalla cache, per dire — perche' l'errore arrivasse
   * spoglio e il rimedio sparisse.
   */
  async _errore(code, message) {
    const errore = new TransportError(code, message);
    errore.detail = {
      host: this.host,
      openHosts: (await detectAtlassianHosts().catch(() => [])).map((h) => h.host)
    };
    return errore;
  }

  async _resolve() {
    const tabs = await tabsOnHost(this.host);
    if (!tabs.length) {
      throw await this._errore('NO_TAB', `${this.label}: no tab open on ${this.host}.`);
    }

    for (const tab of tabs) {
      let probe;
      try {
        probe = await this._viaTab(tab.id, this.base + this.probePath, { method: 'GET' });
      } catch {
        continue; // scheda non iniettabile (sta caricando, o e' stata chiusa)
      }
      if (isApiResponse(probe)) {
        this.tabId = tab.id;
        return this;
      }
    }

    throw await this._errore(
      'SESSION_INVALID',
      `${this.label}: a tab on ${this.host} exists but the session is not valid.`
    );
  }

  async _viaTab(tabId, url, init) {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: pageFetch,
      args: [url, init]
    });
    return injection?.result;
  }

  async request(path, { method = 'GET', headers = {}, body } = {}) {
    await this.resolve();
    const init = { method, headers: { Accept: 'application/json', ...headers } };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    // Se la scheda e' stata chiusa nel frattempo, `executeScript` solleva un
    // errore di Chrome: va tradotto, altrimenti l'utente vede un messaggio
    // incomprensibile invece del pulsante "riapri e riprova".
    let result;
    try {
      result = await this._viaTab(this.tabId, this.base + path, init);
    } catch (error) {
      throw await this._errore(
        'TAB_GONE',
        `${this.label}: the session tab no longer responds (${error.message}).`
      );
    }
    if (!result) {
      throw await this._errore('TAB_GONE', `${this.label}: the session tab no longer responds.`);
    }
    return result;
  }

  describe() {
    return { via: 'session', host: this.host, resolved: this.tabId !== null };
  }
}

export function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}
