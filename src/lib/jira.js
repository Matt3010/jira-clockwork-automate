// Client Jira Cloud REST v3.
//
// I worklog di Clockwork sono sincronizzati con i worklog nativi di Jira, quindi
// scrivere su /issue/{key}/worklog e' sufficiente perche' le ore compaiano in
// Clockwork. L'API pubblica di Clockwork e' read-only sui worklog.

import { dayBounds, isSameLocalDay, jqlDayRange } from './dates.js';

export class JiraError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'JiraError';
    this.status = status;
    this.body = body;
  }
}

/** Querystring da un oggetto, saltando i valori vuoti. */
function queryString(query) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null) params.set(key, value);
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : '';
}

export class JiraClient {
  /** @param {import('./transport.js').Channel} channel */
  constructor(channel) {
    this.channel = channel;
  }

  async request(path, { method = 'GET', body, query } = {}) {
    const result = await this.channel.request(path + queryString(query), {
      method,
      body,
      headers: { 'X-Atlassian-Token': 'no-check' }
    });

    let parsed = null;
    if (result.text) {
      try {
        parsed = JSON.parse(result.text);
      } catch {
        parsed = result.text;
      }
    }

    if (result.status < 200 || result.status >= 300) {
      throw new JiraError(describeError(parsed, result.status), result.status, parsed);
    }
    return parsed;
  }

  async myself() {
    return this.request('/rest/api/3/myself');
  }

  /**
   * Ricerca issue, su `/search/jql`.
   *
   * Qui c'era un ripiego su `/rest/api/3/search`, per i siti che non
   * esponessero ancora l'endpoint nuovo. Atlassian ha rimosso quello vecchio da
   * Jira Cloud il 1° maggio 2025: non e' piu' una rete, e' un secondo tentativo
   * che fallisce sempre. Peggio, si mangiava gli errori 400 — una chiave
   * progetto sbagliata nelle opzioni risponde 400 «JQL non valido», e chi
   * guardava si vedeva arrivare il 404 del tentativo dopo, su un endpoint che
   * non esiste piu'. Adesso l'errore che si legge e' quello vero.
   */
  async search(jql, { fields = ['summary', 'status', 'issuetype'], expand, maxResults = 100 } = {}) {
    const payload = { jql, fields, maxResults };
    if (expand) payload.expand = expand;
    const data = await this.request('/rest/api/3/search/jql', { method: 'POST', body: payload });
    return data.issues || [];
  }

  async getIssue(key, fields = ['summary', 'status', 'issuetype']) {
    return this.request(`/rest/api/3/issue/${encodeURIComponent(key)}`, {
      query: { fields: fields.join(',') }
    });
  }

  /** Coda del changelog: `expand=changelog` nella search e' troncato sulle issue lunghe. */
  async getChangelogTail(key, total, size = 50) {
    const startAt = Math.max(0, total - size);
    const data = await this.request(`/rest/api/3/issue/${encodeURIComponent(key)}/changelog`, {
      query: { startAt, maxResults: size }
    });
    return data.values || [];
  }

  /**
   * Pannello "Sviluppo" di una issue: e' l'endpoint interno che usa la UI di
   * Jira per mostrare commit e branch collegati. Non e' documentato ne'
   * supportato da Atlassian, ma evita di dover aprire anche Bitbucket.
   * Vuole l'id numerico, non la chiave.
   */
  async getDevelopment(issueId, applicationType = 'bitbucket', dataType = 'repository') {
    return this.request('/rest/dev-status/1.0/issue/detail', {
      query: { issueId, applicationType, dataType }
    });
  }

  async getComments(key, maxResults = 30) {
    const data = await this.request(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
      query: { orderBy: '-created', maxResults }
    });
    return data.comments || [];
  }

  async getWorklogs(key, startedAfterMs) {
    const data = await this.request(`/rest/api/3/issue/${encodeURIComponent(key)}/worklog`, {
      query: { startedAfter: startedAfterMs }
    });
    return data.worklogs || [];
  }

  /** Gli stati verso cui la issue puo' passare, per come e' messa adesso. */
  async getTransitions(key) {
    const data = await this.request(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`);
    return (data.transitions || []).map((transizione) => ({
      id: transizione.id,
      name: transizione.name,
      to: transizione.to?.name || '',
      category: transizione.to?.statusCategory?.key || ''
    }));
  }

  async transitionIssue(key, transitionId) {
    return this.request(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
      method: 'POST',
      body: { transition: { id: String(transitionId) } }
    });
  }

  async deleteWorklog(key, worklogId) {
    return this.request(
      `/rest/api/3/issue/${encodeURIComponent(key)}/worklog/${encodeURIComponent(worklogId)}`,
      { method: 'DELETE', query: { notifyUsers: 'false' } }
    );
  }

  async addWorklog(key, { started, timeSpentSeconds, comment }) {
    return this.request(`/rest/api/3/issue/${encodeURIComponent(key)}/worklog`, {
      method: 'POST',
      query: { notifyUsers: 'false' },
      body: {
        started,
        timeSpentSeconds,
        comment: comment ? toAdf(comment) : undefined
      }
    });
  }
}

/**
 * Il testo dentro un documento ADF, per rileggere la nota di un worklog.
 *
 * I paragrafi tornano separati da un a capo, come sono stati scritti: la nota
 * precompilata e' la lista dei commit, una riga per commit, e rileggendola
 * unita da uno spazio diventerebbe di nuovo una frase sola — che e' esattamente
 * quello che succedeva copiando una giornata.
 */
export function textFromAdf(doc) {
  if (!doc) return '';
  if (typeof doc === 'string') return doc;
  if (doc.type === 'text') return doc.text || '';
  const dentro = (doc.content || []).map(textFromAdf);
  if (doc.type === 'paragraph') return dentro.join('').trim();
  return dentro.join('\n').trim();
}

/**
 * Commento in Atlassian Document Format, richiesto dall'API v3.
 *
 * Un a capo dentro un nodo di testo ADF non e' un a capo: Jira lo mostrerebbe
 * come uno spazio, e la lista dei commit tornerebbe una riga sola. Ogni riga
 * diventa quindi un paragrafo suo.
 */
function toAdf(text) {
  const righe = String(text).split('\n').map((r) => r.trim()).filter(Boolean);
  return {
    type: 'doc',
    version: 1,
    content: (righe.length ? righe : [String(text)])
      .map((riga) => ({ type: 'paragraph', content: [{ type: 'text', text: riga }] }))
  };
}

function describeError(body, status) {
  if (body && Array.isArray(body.errorMessages) && body.errorMessages.length) {
    return `Jira ${status}: ${body.errorMessages.join(' / ')}`;
  }
  if (body && body.errors && Object.keys(body.errors).length) {
    return `Jira ${status}: ${Object.entries(body.errors).map(([k, v]) => `${k}: ${v}`).join(' / ')}`;
  }
  if (typeof body === 'string' && body.trim()) return `Jira ${status}: ${body.slice(0, 300)}`;
  return `Jira ${status}`;
}

/**
 * Campi del changelog che non sono attivita': sono il contraccolpo contabile
 * della registrazione delle ore, e li genera anche questa estensione quando
 * scrive un worklog.
 *
 * Tenerli sarebbe sbagliato due volte: nel registro seppelliscono le cose vere
 * sotto righe come "modificato timespent", e nel piano gonfiano il peso della
 * issue — che decide chi prende il resto della divisione. Ed e' circolare:
 * registri ore, l'analisi dopo le legge come lavoro e te le ripropone.
 *
 * `rank` sta qui per un motivo diverso: cambia ogni volta che trascini una
 * scheda nella board, e non dice niente su cosa hai fatto.
 */
const CONTABILITA = new Set([
  'worklogid', 'worklogtimespent', 'timespent', 'timeestimate',
  'timeoriginalestimate', 'remainingestimate', 'aggregatetimespent', 'rank'
]);

function projectClause(projects) {
  const list = (projects || []).map((p) => String(p).trim()).filter(Boolean);
  if (!list.length) return '';
  return `project in (${list.join(', ')}) AND `;
}

/**
 * Sei tu la persona di cui parla questa issue: assegnatario o richiedente.
 *
 * Serve a distinguere le issue che ti riguardano da quelle che quel giorno si
 * sono mosse per conto loro. Sulle tue vale la pena riportare anche le
 * modifiche fatte da altri; sulle altre sarebbe rumore.
 */
function issueIsMine(issue, accountId) {
  if (!accountId) return false;
  const fields = issue.fields || {};
  return fields.assignee?.accountId === accountId || fields.reporter?.accountId === accountId;
}

/**
 * Le issue della giornata che ti riguardano.
 * Ritorna una mappa key -> { key, summary, events: [...] }.
 *
 * Due cose diverse finiscono qui dentro, e restano distinguibili dal `kind`
 * dell'evento: quello che hai fatto tu (`changelog`, `comment`) e quello che
 * hanno fatto altri su una issue tua (`foreign`). Senza la seconda, farsi
 * assegnare un ticket da un collega era invisibile — la modifica portava il
 * suo nome, non il tuo, e veniva scartata: il ticket non compariva da nessuna
 * parte, nemmeno spento.
 */
export async function collectJiraActivity(client, { isoDate, projects, accountId, displayName, scanComments }) {
  // La finestra e' larga una settimana, non un giorno, ed e' il punto:
  // `updated` in JQL e' l'*ultima* modifica della issue, non "e' stata
  // modificata quel giorno". Con la finestra di un giorno esatto, una issue
  // ripresa in mano il giorno dopo usciva dall'insieme e spariva dal giorno in
  // cui ci avevi lavorato — compilare ieri stamattina, dopo averci messo mano,
  // la faceva sparire da ieri. In JQL non esiste "ha avuto una modifica in
  // quella finestra": quella cosa sta nel changelog, che non e' interrogabile.
  // Quindi si allarga la rete e si taglia riga per riga, come gia' si faceva.
  //
  // Una settimana e non oltre: senza limite superiore, su un giorno di mesi fa
  // "toccate da allora" sono migliaia, il tetto scatta sempre e quello che
  // rientra e' rumore. Sette giorni coprono il caso vero — compilare ieri, o
  // recuperare la settimana — e oltre quello il recupero e' perso comunque,
  // perche' finisce sotto il tetto.
  //
  // In ordine crescente, non decrescente: col tetto il decrescente riempirebbe
  // l'elenco con le issue piu' fresche della settimana, e taglierebbe proprio
  // quelle ferme dal giorno che stai guardando.
  const { from, to } = jqlDayRange(isoDate, 7);
  const jql = `${projectClause(projects)}updated >= "${from}" AND updated < "${to}" `
    + 'ORDER BY updated ASC';
  const MAX = 100;
  const issues = await client.search(jql, {
    // `assignee` e `reporter` non si disegnano: dicono se la issue e' tua, e
    // quindi se le modifiche altrui vanno riportate o buttate.
    fields: ['summary', 'status', 'issuetype', 'assignee', 'reporter'],
    expand: 'changelog',
    maxResults: MAX
  });

  const activity = new Map();
  // La rete larga ha un tetto, e un tetto raggiunto vuol dire che qualcosa e'
  // rimasto fuori: va detto, non lasciato indovinare. Sta appeso alla mappa
  // per non cambiare la forma del ritorno a tutti quelli che la leggono.
  activity.truncated = issues.length >= MAX;
  /**
   * Il campo assegnatario e' passato *a te*, non solo cambiato.
   *
   * Nel changelog `to` e' l'accountId e `toString` il nome: il primo e' quello
   * su cui si decide, il secondo e' il ripiego per le istanze che non lo
   * mandano. Senza questo controllo, un collega che passa la issue a un terzo
   * risultava come "te l'ha assegnata".
   */
  const assegnaATe = (items) => (items || []).some((item) => {
    if (String(item.field).toLowerCase() !== 'assignee') return false;
    if (item.to) return item.to === accountId;
    return Boolean(displayName) && item.toString === displayName;
  });

  const record = (issue, kind, at, items = [], by = '', extra = {}) => {
    const key = issue.key;
    if (!activity.has(key)) {
      activity.set(key, {
        key,
        id: issue.id,
        summary: issue.fields?.summary || '',
        issueType: issue.fields?.issuetype?.name || '',
        events: []
      });
    }
    // `items` conserva il dettaglio del cambiamento — quale campo, da cosa a
    // cosa. Al piano serve solo contarli, ma al registro delle attivita' serve
    // poter dire "passata a In corso" invece di "una modifica".
    // `by` e' vuoto quando la modifica e' tua: il nome serve solo a non far
    // passare per tuo il lavoro di un altro.
    activity.get(key).events.push({ kind, at, items, by, ...extra });
  };

  for (const issue of issues) {
    const changelog = issue.changelog || {};
    let histories = changelog.histories || [];
    if (typeof changelog.total === 'number' && changelog.total > histories.length) {
      try {
        histories = await client.getChangelogTail(issue.key, changelog.total);
      } catch {
        // Se il fetch di coda fallisce restano le histories parziali: meglio
        // qualche evento in meno che far fallire l'intera analisi.
      }
    }

    const mia = issueIsMine(issue, accountId);

    for (const history of histories) {
      const tua = history.author?.accountId === accountId;
      // Le modifiche di altri contano solo sulle issue tue: altrove sarebbe
      // mezzo progetto dentro la giornata di chi guarda.
      if (!tua && !mia) continue;
      if (!isSameLocalDay(history.created, isoDate)) continue;
      // Attenzione a `toString`: Jira chiama cosi' il campo, ma e' anche un
      // metodo che ogni oggetto eredita. Quando Jira non lo manda, `||` non
      // scatta e ci si ritrova la funzione al posto del testo.
      const testo = (valore) => (typeof valore === 'string' ? valore : '');
      const items = (history.items || [])
        .filter((item) => item.field && !CONTABILITA.has(String(item.field).toLowerCase()))
        .map((item) => ({
          field: item.field,
          from: testo(item.fromString),
          to: testo(item.toString)
        }));
      // Se restava solo contabilita', non e' successo niente da registrare: la
      // issue non deve nemmeno entrare nell'elenco.
      if (!items.length) continue;
      if (tua) record(issue, 'changelog', history.created, items);
      else {
        record(issue, 'foreign', history.created, items, history.author?.displayName || '',
          { assignsYou: assegnaATe(history.items) });
      }
    }
  }

  if (scanComments) {
    for (const issue of issues) {
      let comments = [];
      try {
        comments = await client.getComments(issue.key);
      } catch {
        continue;
      }
      const mia = issueIsMine(issue, accountId);
      for (const comment of comments) {
        const tuo = comment.author?.accountId === accountId;
        if (!tuo && !mia) continue;
        if (!isSameLocalDay(comment.created, isoDate)) continue;
        // Un commento di un collega sotto una issue tua e' una cosa che ti
        // riguarda, ma non e' lavoro tuo: kind diverso, come per il changelog.
        if (tuo) record(issue, 'comment', comment.created, 'commento');
        else record(issue, 'foreignComment', comment.created, 'commento', comment.author?.displayName || '');
      }
    }
  }

  return activity;
}

/**
 * Le issue che hai creato tu quel giorno.
 *
 * Non stanno nel changelog — la creazione non e' una modifica — quindi senza
 * questa ricerca "ho aperto un ticket" resterebbe fuori dal registro.
 */
export async function collectCreatedIssues(client, { isoDate, projects }) {
  const { from, to } = jqlDayRange(isoDate);
  const jql = `${projectClause(projects)}creator = currentUser() ` +
    `AND created >= "${from}" AND created < "${to}" ORDER BY created ASC`;
  try {
    const issues = await client.search(jql, { fields: ['summary', 'created'], maxResults: 50 });
    return issues.map((issue) => ({
      // L'id serve al pannello Sviluppo: senza, una issue vista solo di qui
      // non potrebbe portarsi dietro i suoi commit.
      id: issue.id,
      key: issue.key,
      summary: issue.fields?.summary || '',
      at: issue.fields?.created || null
    }));
  } catch {
    // Alcune istanze non espongono `creator` in JQL: il registro perde le
    // creazioni ma resta valido per tutto il resto.
    return [];
  }
}

/**
 * Aggiunge le issue che hai aperto tu a quelle su cui hai lavorato.
 *
 * Aprire un ticket non lascia traccia nel changelog — creare non e'
 * modificare — quindi senza questo passaggio una issue creata e non piu'
 * toccata non esiste per il piano, e una creata e poi committata sembra
 * solo lavoro di git. Ma scrivere il ticket *e'* lavoro della giornata.
 */
export function mergeCreatedIssues(activity, created) {
  for (const issue of created || []) {
    if (!issue?.key) continue;
    const quando = issue.at ? Date.parse(issue.at) : NaN;
    if (!Number.isFinite(quando)) continue;

    if (!activity.has(issue.key)) {
      activity.set(issue.key, {
        id: issue.id, key: issue.key, summary: issue.summary || '', events: []
      });
    }
    const voce = activity.get(issue.key);
    // L'id puo' mancare se la issue e' arrivata prima dai commit.
    if (!voce.id && issue.id) voce.id = issue.id;
    if (!voce.summary && issue.summary) voce.summary = issue.summary;
    voce.events.push({ kind: 'created', at: quando, items: [] });
  }
  return activity;
}

/**
 * I tuoi ticket ancora aperti — tutto quello che non e' chiuso.
 *
 * Non dipende dal giorno scelto: e' quello che hai in ballo adesso. Serve a
 * sapere su cosa stai lavorando, e da qui si possono anche spostare di stato.
 *
 * "Tuoi" comprende anche quelli che hai aperto tu e sono in mano a un altro:
 * il richiedente aspetta una risposta, ed e' lavoro suo tenerli d'occhio.
 */
export async function collectOpenIssues(client, { projects, limit = 60, mine = true }) {
  // `mine: false` serve alla vista delle pull request, che guarda il lavoro
  // della squadra: una PR che aspetta la tua revisione sta quasi sempre su un
  // ticket di qualcun altro, e restringendo ai tuoi non si vedrebbe mai.
  const tuoi = mine ? '(assignee = currentUser() OR reporter = currentUser()) AND ' : '';
  const jql = `${projectClause(projects)}${tuoi}`
    + 'statusCategory != Done ORDER BY updated DESC';
  const issues = await client.search(jql, {
    fields: ['summary', 'status', 'created', 'updated', 'issuetype'],
    maxResults: limit
  });

  return issues.map((issue) => ({
    key: issue.key,
    summary: issue.fields?.summary || '',
    status: issue.fields?.status?.name || '',
    // La categoria e' quella canonica di Jira: gli stati hanno nomi diversi in
    // ogni progetto, le categorie no.
    category: issue.fields?.status?.statusCategory?.key || '',
    type: issue.fields?.issuetype?.name || '',
    created: issue.fields?.created || null,
    updated: issue.fields?.updated || null
  }));
}

/** Dentro una stringa JQL virgolette e barre vanno protette, o la query si spezza. */
const jqlString = (testo) => String(testo).replace(/["\\]/g, '\\$&');

/** Sembra una chiave di issue: due lettere o piu', trattino, numero. */
const PARE_UNA_CHIAVE = /^[A-Za-z][A-Za-z0-9_]+-\d+$/;

/** Solo cifre: il numero di un ticket, senza il progetto davanti. */
const SOLO_NUMERO = /^\d+$/;

/** Progetto e numero senza trattino, o col trattino sbagliato: "EGLVPN 2004". */
const CHIAVE_SCIOLTA = /^([A-Za-z][A-Za-z0-9_]+)[\s_-]+(\d+)$/;

/**
 * Le chiavi che l'utente potrebbe avere in mente.
 *
 * Digitare solo "2004" e' il modo piu' rapido di cercare un ticket, e finora
 * finiva nella ricerca a testo — che il numero dentro la chiave non lo guarda
 * nemmeno, e restituiva i ticket che avevano "2004" nel titolo. Con i progetti
 * configurati le chiavi possibili sono poche e si provano tutte.
 */
function chiaviCandidate(termine, projects) {
  if (PARE_UNA_CHIAVE.test(termine)) return [termine.toUpperCase()];

  const sciolta = termine.match(CHIAVE_SCIOLTA);
  if (sciolta) return [`${sciolta[1].toUpperCase()}-${sciolta[2]}`];

  if (SOLO_NUMERO.test(termine)) {
    return (projects || [])
      .map((p) => String(p).trim().toUpperCase())
      .filter(Boolean)
      .map((p) => `${p}-${termine}`);
  }
  return [];
}

/**
 * Cerca un ticket, anche di altri.
 *
 * A differenza di tutto il resto qui non c'e' `assignee = currentUser()`: e'
 * il caso in cui ti serve il ticket di un collega — per capire a che punto e',
 * o perche' ci devi registrare sopra delle ore. Per questo torna anche
 * l'assegnatario: senza, un elenco di ticket non tuoi non dice di chi sono.
 */
const CAMPI_RICERCA = ['summary', 'status', 'created', 'updated', 'issuetype', 'assignee'];

export async function searchIssues(client, { query, projects, limit = 25 }) {
  const termine = String(query || '').trim();
  if (!termine) return [];

  // Le chiavi si chiedono una per una, non con `key in (...)`: una chiave che
  // non esiste fa fallire tutta la query con un 400, e provando "2004" su tre
  // progetti quasi sempre due non esistono. Chieste separatamente, quelle che
  // non ci sono rispondono 404 e basta.
  const candidate = chiaviCandidate(termine, projects);
  if (candidate.length) {
    const trovate = (await Promise.all(
      candidate.map((key) => client.getIssue(key, CAMPI_RICERCA).catch(() => null))
    )).filter(Boolean);
    if (trovate.length) return trovate.map(mappaIssue);
    // Nessuna esiste: puo' essere un titolo che sembra una chiave. Si continua
    // con la ricerca a testo invece di rispondere "niente".
  }

  const jql = `${projectClause(projects)}text ~ "${jqlString(termine)}" ORDER BY updated DESC`;

  const issues = await client.search(jql, {
    fields: CAMPI_RICERCA,
    maxResults: limit
  }).catch(() => []);

  return issues.map(mappaIssue);
}

function mappaIssue(issue) {
  return {
    key: issue.key,
    summary: issue.fields?.summary || '',
    status: issue.fields?.status?.name || '',
    category: issue.fields?.status?.statusCategory?.key || '',
    type: issue.fields?.issuetype?.name || '',
    assignee: issue.fields?.assignee?.displayName || '',
    created: issue.fields?.created || null,
    updated: issue.fields?.updated || null
  };
}

// ------------------------------------------------ commit dal pannello Sviluppo

/** Esegue `worker` su tutti gli elementi, al massimo `limit` in parallelo. */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runner() {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

/**
 * Come si chiama l'autore di un commit, per come lo scrive il pannello.
 *
 * Il nome puo' arrivare come firma git intera — `Nome Cognome <mail@dominio>`
 * — invece che nel solo campo email. Confrontata cosi' com'e' non combacia con
 * niente, e il commit finisce fra quelli "di un altro autore": tuo, ma non
 * contato, e l'avviso ti manda a dichiarare un nome che avevi gia' dichiarato.
 */
function authorIdentities(author) {
  const grezzo = String(author?.name || '');
  const dentro = grezzo.match(/<([^>]+)>/)?.[1] || '';
  return [
    normalize(grezzo.replace(/<[^>]*>/, '')),
    normalize(dentro),
    normalize(author?.emailAddress)
  ].filter(Boolean);
}

/** L'autore di un commit sei tu se il nome o l'email combaciano con una delle identita'. */
function isMine(author, identities) {
  const sue = authorIdentities(author);
  const locali = sue.map((valore) => valore.split('@')[0]).filter(Boolean);
  return identities.some((raw) => {
    const id = normalize(raw);
    if (!id) return false;
    return sue.includes(id) || locali.includes(id.split('@')[0]);
  });
}

/** Come chiamare in un avviso l'autore che non hai riconosciuto. */
function authorLabel(author) {
  return String(author?.name || author?.emailAddress || '').replace(/\s*<[^>]*>/, '').trim();
}

/**
 * Il commit e' un merge.
 *
 * Il pannello lo dichiara con `merge`, ma non tutte le istanze lo mandano:
 * il ripiego e' il soggetto, che git scrive sempre allo stesso modo.
 */
function isMerge(commit) {
  if (typeof commit?.merge === 'boolean') return commit.merge;
  return /^merge (branch|pull request|remote-tracking branch|commit)/i
    .test(String(commit?.message || '').trim());
}

function extractCommits(payload) {
  const out = [];
  for (const detail of payload?.detail || []) {
    for (const repository of detail.repositories || []) {
      for (const commit of repository.commits || []) {
        out.push({ repository: repository.name || '', commit });
      }
    }
  }
  return out;
}

/**
 * Commit della giornata letti dal pannello Sviluppo delle issue candidate.
 *
 * Il limite strutturale: si vedono solo i commit delle issue che passiamo come
 * candidate. Per questo le candidate non sono solo quelle toccate oggi in Jira,
 * ma anche quelle assegnate a te di recente — cosi' un commit su un ticket che
 * oggi non hai aperto in Jira viene comunque trovato.
 *
 * @returns {{byIssue: Map, othersByIssue: Map, checked: number, skippedOther: number, skippedAuthors: string[], appType: string|null}}
 */
export async function collectDevPanelCommits(client, {
  candidates, isoDate, identities, countMerges = true, concurrency = 6
}) {
  const byIssue = new Map();
  // Chi sono, non solo quanti: un conto non ti fa distinguere il commit di un
  // collega — dove non c'e' niente da fare — dal tuo firmato con un altro nome.
  const skippedAuthors = new Set();
  // E su quale issue: un commit di un collega su una task tua e' una cosa che
  // vuoi vedere accanto a quella task, non contata in un avviso in cima.
  const othersByIssue = new Map();
  let skippedOther = 0;
  let appType = null;

  async function pass(type) {
    let found = 0;
    await mapLimit(candidates, concurrency, async (candidate) => {
      let payload;
      try {
        payload = await client.getDevelopment(candidate.id, type);
      } catch {
        return; // pannello non disponibile su questa issue: si tira dritto
      }
      for (const { repository, commit } of extractCommits(payload)) {
        found += 1;
        const at = Date.parse(commit.authorTimestamp);
        if (!Number.isFinite(at) || !isSameLocalDay(at, isoDate)) continue;
        // I merge si contano solo se lo hai chiesto: "Merge branch X into Y"
        // non e' lavoro da registrare, ed e' la riga che si prende la nota.
        // `found` resta contato: serve a capire se il pannello risponde, e
        // saltarlo farebbe ripiegare sul vecchio applicationType per niente.
        if (!countMerges && isMerge(commit)) continue;
        if (!isMine(commit.author, identities)) {
          skippedOther += 1;
          const chi = authorLabel(commit.author);
          if (chi) skippedAuthors.add(chi);
          if (!othersByIssue.has(candidate.key)) othersByIssue.set(candidate.key, []);
          othersByIssue.get(candidate.key).push({
            repo: repository,
            author: chi,
            subject: String(commit.message || '').split('\n')[0].trim(),
            at,
            hash: commit.displayId || commit.id || '',
            url: commit.url || ''
          });
          continue;
        }
        if (!byIssue.has(candidate.key)) byIssue.set(candidate.key, []);
        byIssue.get(candidate.key).push({
          repo: repository,
          subject: String(commit.message || '').split('\n')[0].trim(),
          at,
          hash: commit.displayId || commit.id || '',
          url: commit.url || ''
        });
      }
    });
    return found;
  }

  // Su Jira Cloud con Bitbucket Cloud il tipo giusto e' "bitbucket"; alcune
  // istanze usano ancora il vecchio nome "stash". Si prova il secondo solo se
  // il primo non ha trovato proprio nulla.
  if (await pass('bitbucket') > 0) appType = 'bitbucket';
  else if (await pass('stash') > 0) appType = 'stash';

  return {
    byIssue, othersByIssue, checked: candidates.length, skippedOther, appType,
    skippedAuthors: [...skippedAuthors]
  };
}

/**
 * Le pull request collegate alle issue indicate.
 *
 * Stesso pannello dei commit, altro `dataType`. Ed e' l'unica strada che non
 * chiede una scheda su Bitbucket: quei dati Jira se li tiene per disegnare il
 * pannello che vedi in fondo a ogni ticket. In cambio si legge e basta —
 * unire, rifiutare e approvare sono scritture sull'API di Bitbucket, che Jira
 * non fa da tramite: da qui si puo' solo aprire la PR dove quei tasti stanno.
 *
 * La stessa PR puo' essere collegata a piu' issue: si tiene una volta sola,
 * con la chiave da cui e' arrivata per prima.
 */
export async function collectPullRequests(client, { candidates, identities, concurrency = 6 }) {
  const perId = new Map();
  let appType = null;

  async function pass(type) {
    let trovate = 0;
    await mapLimit(candidates, concurrency, async (candidate) => {
      let payload;
      try {
        payload = await client.getDevelopment(candidate.id, type, 'pullrequest');
      } catch {
        return; // pannello non disponibile su questa issue: si tira dritto
      }
      for (const detail of payload?.detail || []) {
        for (const pr of detail.pullRequests || []) {
          trovate += 1;
          const id = String(pr.id || pr.url || '');
          if (!id || perId.has(id)) continue;
          perId.set(id, leggiPr(pr, candidate.key, identities));
        }
      }
    });
    return trovate;
  }

  if (await pass('bitbucket') > 0) appType = 'bitbucket';
  else if (await pass('stash') > 0) appType = 'stash';

  return { items: [...perId.values()], checked: candidates.length, appType };
}

/** Una PR come la scrive il pannello, ridotta a quello che serve a schermo. */
function leggiPr(pr, issueKey, identities) {
  const revisori = (pr.reviewers || []).map((r) => ({
    name: r.name || r.displayName || '',
    approved: Boolean(r.approved)
  }));
  const autore = pr.author?.name || pr.author?.displayName || '';
  const mioPr = isMine({ name: autore, emailAddress: pr.author?.emailAddress }, identities);
  const revisoreTu = revisori.find((r) => isMine({ name: r.name }, identities));

  return {
    id: String(pr.id || pr.url || ''),
    issueKey,
    // Il nome che il pannello da' alla PR e' del tipo "#42: titolo": il titolo
    // e' l'unica parte che dice qualcosa a chi guarda.
    title: String(pr.name || '').replace(/^#\d+:?\s*/, '').trim(),
    number: String(pr.id || '').replace(/^#/, ''),
    url: pr.url || '',
    status: String(pr.status || '').toUpperCase(),
    author: autore,
    mine: mioPr,
    // "Aspetta te" e' la domanda vera della giornata: sei fra i revisori e non
    // hai ancora approvato.
    waitingForYou: Boolean(revisoreTu) && !revisoreTu.approved,
    reviewers: revisori,
    approvals: revisori.filter((r) => r.approved).length,
    comments: Number(pr.commentCount) || 0,
    source: pr.source?.branch || '',
    destination: pr.destination?.branch || '',
    at: Date.parse(pr.lastUpdate) || null
  };
}

/**
 * Quanto hai gia' registrato in quella data, su qualunque issue.
 *
 * Serve a due cose: segnalare i duplicati riga per riga, e soprattutto
 * scalare il monte ore. Senza questo, una giornata gia' quasi piena farebbe
 * distribuire altre 8 ore sopra a quelle esistenti.
 */
export async function loggedMinutesForDay(client, { isoDate, accountId }) {
  const { start } = dayBounds(isoDate);

  let issues = [];
  try {
    issues = await client.search(
      `worklogAuthor = currentUser() AND worklogDate = "${isoDate}"`,
      { fields: ['summary'], maxResults: 100 }
    );
  } catch {
    // Se la ricerca per worklog non e' disponibile si prosegue senza scalare
    // nulla: meglio un piano da rivedere che nessun piano.
    return { total: 0, byIssue: {}, issues: [], entries: [], reliable: false };
  }

  const byIssue = {};
  const entries = [];
  let total = 0;
  for (const issue of issues) {
    try {
      const worklogs = await client.getWorklogs(issue.key, start - 1);
      const mine = worklogs.filter(
        (w) => w.author?.accountId === accountId && isSameLocalDay(w.started, isoDate)
      );
      const minutes = mine.reduce((sum, w) => sum + Math.round((w.timeSpentSeconds || 0) / 60), 0);
      if (minutes > 0) {
        byIssue[issue.key] = minutes;
        total += minutes;
      }
      // Ogni singolo worklog con la sua ora di inizio: e' cosi' che si capisce
      // quale ticket corrisponde a una riunione ricorrente.
      for (const worklog of mine) {
        const startedAt = new Date(worklog.started);
        if (Number.isNaN(startedAt.getTime())) continue;
        entries.push({
          id: worklog.id,
          key: issue.key,
          summary: issue.fields?.summary || '',
          startMinutes: startedAt.getHours() * 60 + startedAt.getMinutes(),
          minutes: Math.round((worklog.timeSpentSeconds || 0) / 60),
          // Serve a copiare una giornata portandosi dietro anche le note.
          comment: textFromAdf(worklog.comment)
        });
      }
    } catch {
      // Nessun permesso di lettura worklog su quella issue: si tira dritto.
    }
  }
  // Le issue su cui hai gia' registrato ore oggi tornano indietro con il titolo:
  // sono le candidate migliori per capire su quale ticket va una riunione.
  const loggedIssues = issues.map((issue) => ({ key: issue.key, summary: issue.fields?.summary || '' }));
  return { total, byIssue, issues: loggedIssues, entries, reliable: true };
}
