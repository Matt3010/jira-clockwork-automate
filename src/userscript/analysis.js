// L'analisi di una giornata, fuori dall'estensione.
//
// E' il corpo di `analyze` del vecchio background dell'estensione, senza chrome: riceve un
// JiraClient gia' pronto e la configurazione, e non legge ne' scrive nessuno
// storage. Torna i pezzi grezzi oltre al piano, perche' la verifica sui giorni
// passati deve poter ricostruire il piano *come se* la giornata fosse vuota e
// confrontarlo con quello che e' stato registrato davvero.
//
// Una differenza voluta rispetto al background: le finestre "recenti" (issue
// candidate per i commit, worklog delle ultime settimane) partono dal giorno
// analizzato e non da oggi. Analizzando un giorno di dieci giorni fa, "le
// ultime tre settimane" contate da oggi ne coprivano solo undici prima di
// quel giorno — e i worklog di quel giorno stesso finivano fra i suggerimenti
// per indovinare le riunioni, cioe' la verifica sbirciava la risposta.

import {
  collectCreatedIssues,
  collectDevPanelCommits,
  collectJiraActivity,
  estimateMinutes,
  loggedMinutesForDay,
  mergeCreatedIssues
} from '../lib/jira.js';
import { buildPlan } from '../lib/planner.js';
import { localDateTime, toIsoDate } from '../lib/dates.js';
import { t } from './i18n.js';

function projectClause(projects) {
  const list = (projects || []).map((p) => String(p).trim()).filter(Boolean);
  return list.length ? `project in (${list.join(', ')}) AND ` : '';
}

/** La data `giorni` giorni prima di `isoDate`, nel formato che vuole JQL. */
export function daysBefore(isoDate, giorni) {
  const d = localDateTime(isoDate);
  d.setDate(d.getDate() - giorni);
  return toIsoDate(d);
}

/** Unisce piu' elenchi di issue tenendo il primo che si presenta per chiave. */
export function mergeIssues(...lists) {
  const byKey = new Map();
  for (const list of lists) {
    for (const issue of list || []) {
      if (issue?.key && !byKey.has(issue.key)) byKey.set(issue.key, issue);
    }
  }
  return [...byKey.values()];
}

export async function resolveMe(client) {
  const me = await client.myself();
  if (!me?.accountId) throw new Error('Jira did not return the current user');
  return {
    accountId: me.accountId,
    displayName: me.displayName || '',
    emailAddress: me.emailAddress || ''
  };
}

/**
 * Issue candidate per il pannello Sviluppo: quelle del giorno, quelle su cui
 * hai registrato ore nelle tre settimane prima, e quelle assegnate a te.
 *
 * Le seconde ci sono perche' "assegnata a me" non basta: una task lunga puo'
 * stare in mano a un collega — al capo progetto, a chi l'ha aperta — mentre ci
 * lavori tu tutti i giorni. Se in quei giorni non la tocchi in Jira, l'unica
 * traccia sono i commit, e i commit si cercano solo sulle candidate: la task
 * su cui passavi sette ore al giorno non entrava mai nel piano. I worklog
 * dicono su cosa lavori davvero, a chiunque sia assegnata. Si contano solo
 * quelli *prima* del giorno: quelli del giorno stesso, nella verifica, sono la
 * risposta da indovinare.
 */
async function devCandidates(jira, { jiraActivity, config, isoDate }) {
  const byKey = new Map();
  for (const entry of jiraActivity.values()) {
    if (entry.id) byKey.set(entry.key, { id: entry.id, key: entry.key });
  }

  const limit = Math.max(0, config.jira.devCandidates || 0);
  if (limit > 0) {
    const dal = daysBefore(isoDate, 21);
    const queries = [
      `worklogAuthor = currentUser() AND worklogDate >= "${dal}" AND worklogDate < "${isoDate}" `
        + 'ORDER BY updated DESC',
      `${projectClause(config.jira.projects)}assignee = currentUser() `
        + `AND updated >= "${dal}" ORDER BY updated DESC`
    ];
    for (const jql of queries) {
      try {
        const issues = await jira.search(jql, {
          fields: ['summary', 'timeoriginalestimate'], maxResults: limit
        });
        for (const issue of issues) {
          if (byKey.has(issue.key)) continue;
          byKey.set(issue.key, {
            id: issue.id,
            key: issue.key,
            summary: issue.fields?.summary || '',
            estimateMinutes: estimateMinutes(issue.fields)
          });
        }
      } catch {
        // Una query che fallisce non deve togliere le candidate dell'altra.
      }
    }
  }
  return [...byKey.values()];
}

/**
 * Issue da suggerire per le riunioni: quelle su cui hai registrato nelle
 * quattro settimane *prima* del giorno, e quelle dei progetti mosse da allora.
 */
async function recentIssuesFor(jira, { projects, isoDate }) {
  const dal = daysBefore(isoDate, 28);
  const queries = [
    `worklogAuthor = currentUser() AND worklogDate >= "${dal}" AND worklogDate < "${isoDate}" `
      + 'ORDER BY updated DESC',
    `${projectClause(projects)}updated >= "${dal}" ORDER BY updated DESC`
  ];
  const lists = [];
  for (const jql of queries) {
    try {
      const issues = await jira.search(jql, { fields: ['summary'], maxResults: 60 });
      lists.push(issues.map((issue) => ({ key: issue.key, summary: issue.fields?.summary || '' })));
    } catch {
      // Una query che fallisce non deve azzerare i suggerimenti dell'altra.
    }
  }
  return mergeIssues(...lists);
}

/**
 * Tutto quello che si sa di una giornata: attivita' Jira, commit, worklog gia'
 * registrati, issue recenti. Solo letture.
 */
export async function collectDay(jira, { isoDate, config, me, extraLoggedKeys = [] }) {
  const projects = config.jira.projects || [];
  // Gli avvisi dell'analisi, come chiavi: li traduce chi disegna.
  const notes = [];
  if (!projects.length) notes.push({ level: 'action', key: 'noteNoProjects', params: [] });

  const jiraActivity = await collectJiraActivity(jira, {
    isoDate,
    projects,
    accountId: me.accountId,
    displayName: me.displayName,
    scanComments: config.jira.scanComments
  });
  mergeCreatedIssues(jiraActivity, await collectCreatedIssues(jira, { isoDate, projects }));
  if (jiraActivity.truncated) notes.push({ level: 'info', key: 'noteActivityTruncated', params: [] });

  const candidates = await devCandidates(jira, { jiraActivity, config, isoDate });
  const dev = await collectDevPanelCommits(jira, {
    candidates,
    isoDate,
    identities: [me.displayName, me.emailAddress, ...(config.identity?.extraAuthors || [])],
    countMerges: config.jira.countMerges !== false
  });
  if (!dev.appType && candidates.length) {
    notes.push({
      level: 'info',
      key: candidates.length === 1 ? 'noteNoCommitsOne' : 'noteNoCommits',
      params: [candidates.length]
    });
  }

  const summaries = {};
  const estimates = {};
  for (const candidate of candidates) {
    if (jiraActivity.has(candidate.key) || !dev.byIssue.has(candidate.key)) continue;
    summaries[candidate.key] = candidate.summary || '';
    estimates[candidate.key] = candidate.estimateMinutes || 0;
  }

  // Le chiavi del giorno si leggono dirette, non solo dall'indice worklog di
  // Jira: subito dopo un invio l'indice e' indietro di qualche secondo, e le
  // righe appena scritte tornerebbero accese — pronte per il doppione.
  const logged = await loggedMinutesForDay(jira, {
    isoDate,
    accountId: me.accountId,
    extraKeys: [...new Set([...jiraActivity.keys(), ...dev.byIssue.keys(), ...extraLoggedKeys])]
  });
  if (!logged.reliable) notes.push({ level: 'action', key: 'noteWorklogsUnreadable', params: [] });

  return {
    isoDate,
    notes,
    jiraActivity,
    gitByIssue: dev.byIssue,
    foreignGitByIssue: dev.othersByIssue,
    appType: dev.appType,
    candidates: candidates.length,
    summaries,
    estimates,
    recentIssues: await recentIssuesFor(jira, { projects, isoDate }),
    logged
  };
}

/**
 * Il piano di una giornata raccolta.
 *
 * `asIfEmpty` lo costruisce ignorando i worklog gia' presenti: e' il piano che
 * l'estensione ti avrebbe proposto la sera di quel giorno, prima che tu
 * registrassi niente.
 */
export function planFromDay(day, config, { asIfEmpty = false } = {}) {
  const logged = asIfEmpty
    ? { entries: [], byIssue: {}, total: 0, issues: [] }
    : day.logged;
  const plan = buildPlan({
    isoDate: day.isoDate,
    config,
    jiraActivity: day.jiraActivity,
    gitByIssue: day.gitByIssue,
    foreignGitByIssue: day.foreignGitByIssue,
    summaries: day.summaries,
    estimates: day.estimates,
    recentIssues: mergeIssues(logged.issues, day.recentIssues),
    loggedEntries: logged.entries,
    loggedByIssue: logged.byIssue,
    alreadyLoggedMinutes: logged.total
  });

  // I commit dei colleghi stanno sulla riga a cui appartengono. L'avviso in
  // cima resta solo per quelli che una riga non ce l'hanno: per tutti,
  // direbbe ogni giorno una cosa che si legge due centimetri piu' sotto.
  const senzaRiga = [...(day.foreignGitByIssue || [])]
    .filter(([key]) => !plan.rows.some((row) => row.issueKey === key))
    .flatMap(([, commits]) => commits);
  if (senzaRiga.length) {
    const chi = [...new Set(senzaRiga.map((c) => c.author).filter(Boolean))].join(', ')
      || t('noteOtherAuthorsUnknown');
    plan.warnings.push({
      level: 'info',
      key: senzaRiga.length === 1 ? 'noteOtherAuthorsOne' : 'noteOtherAuthors',
      params: senzaRiga.length === 1 ? [chi] : [senzaRiga.length, chi]
    });
  }
  return plan;
}
