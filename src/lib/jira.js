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
   * Ricerca issue. Usa /search/jql (endpoint corrente su Jira Cloud) e ricade
   * su /search se il sito non lo espone ancora.
   */
  async search(jql, { fields = ['summary', 'status', 'issuetype'], expand, maxResults = 100 } = {}) {
    try {
      const payload = { jql, fields, maxResults };
      if (expand) payload.expand = expand;
      const data = await this.request('/rest/api/3/search/jql', { method: 'POST', body: payload });
      return data.issues || [];
    } catch (error) {
      // 400 incluso: alcuni siti rifiutano `expand` sull'endpoint nuovo.
      if (![400, 404, 410].includes(error.status)) throw error;
      const payload = { jql, fields, maxResults };
      if (expand) payload.expand = [expand];
      const data = await this.request('/rest/api/3/search', { method: 'POST', body: payload });
      return data.issues || [];
    }
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
  async getDevelopment(issueId, applicationType = 'bitbucket') {
    return this.request('/rest/dev-status/1.0/issue/detail', {
      query: { issueId, applicationType, dataType: 'repository' }
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

/** Il testo dentro un documento ADF, per rileggere la nota di un worklog. */
export function textFromAdf(doc) {
  if (!doc) return '';
  if (typeof doc === 'string') return doc;
  if (doc.type === 'text') return doc.text || '';
  return (doc.content || []).map(textFromAdf).join(doc.type === 'paragraph' ? '' : ' ').trim();
}

/** Commento in Atlassian Document Format, richiesto dall'API v3. */
function toAdf(text) {
  return {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
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

function projectClause(projects) {
  const list = (projects || []).map((p) => String(p).trim()).filter(Boolean);
  if (!list.length) return '';
  return `project in (${list.join(', ')}) AND `;
}

/**
 * Le issue su cui l'utente ha fatto qualcosa nella giornata indicata.
 * Ritorna una mappa key -> { key, summary, events: [...] }.
 */
export async function collectJiraActivity(client, { isoDate, projects, accountId, scanComments }) {
  const { from, to } = jqlDayRange(isoDate);
  const jql = `${projectClause(projects)}updated >= "${from}" AND updated < "${to}" ORDER BY updated DESC`;
  const issues = await client.search(jql, {
    fields: ['summary', 'status', 'issuetype'],
    expand: 'changelog',
    maxResults: 100
  });

  const activity = new Map();
  const record = (issue, kind, at, detail) => {
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
    activity.get(key).events.push({ kind, at, detail });
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

    for (const history of histories) {
      if (history.author?.accountId !== accountId) continue;
      if (!isSameLocalDay(history.created, isoDate)) continue;
      const fields = (history.items || []).map((item) => item.field).filter(Boolean);
      record(issue, 'changelog', history.created, fields.join(', ') || 'modifica');
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
      for (const comment of comments) {
        if (comment.author?.accountId !== accountId) continue;
        if (!isSameLocalDay(comment.created, isoDate)) continue;
        record(issue, 'comment', comment.created, 'commento');
      }
    }
  }

  return activity;
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

/** L'autore di un commit sei tu se il nome o l'email combaciano con una delle identita'. */
function isMine(author, identities) {
  const name = normalize(author?.name);
  const email = normalize(author?.emailAddress);
  const local = email.split('@')[0];
  return identities.some((raw) => {
    const id = normalize(raw);
    if (!id) return false;
    return id === name || id === email || (local && id.split('@')[0] === local);
  });
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
 * @returns {{byIssue: Map, checked: number, skippedOther: number, appType: string|null}}
 */
export async function collectDevPanelCommits(client, { candidates, isoDate, identities, concurrency = 6 }) {
  const byIssue = new Map();
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
        if (!isMine(commit.author, identities)) {
          skippedOther += 1;
          continue;
        }
        if (!byIssue.has(candidate.key)) byIssue.set(candidate.key, []);
        byIssue.get(candidate.key).push({
          repo: repository,
          subject: String(commit.message || '').split('\n')[0].trim(),
          at,
          hash: commit.displayId || commit.id || ''
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

  return { byIssue, checked: candidates.length, skippedOther, appType };
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
