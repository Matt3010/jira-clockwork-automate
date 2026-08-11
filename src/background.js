// Service worker: tutte le chiamate di rete passano da qui.
//
// Unica autenticazione: la sessione del browser. Le richieste vengono eseguite
// dentro una scheda aperta sul sito Jira (vedi transport.js), quindi usano il
// login che l'utente ha gia' fatto. Nessuna credenziale viene mai salvata.
//
// Unica destinazione: Jira. Anche i commit arrivano da li', dal pannello
// "Sviluppo" delle issue.

import { loadConfig, saveConfig } from './lib/storage.js';
import {
  JiraClient,
  collectJiraActivity,
  collectDevPanelCommits,
  loggedMinutesForDay
} from './lib/jira.js';
import { Channel, TransportError, detectAtlassianHosts, hostOf, tabsOnHost } from './lib/transport.js';
import { buildPlan } from './lib/planner.js';
import { formatMinutes, jiraStarted, shortMinutes, todayIso } from './lib/dates.js';
import { t } from './lib/i18n.js';

const HANDLERS = {
  analyze,
  submit,
  deleteLogged,
  refreshLogged,
  reloadSite,
  copyFrom,
  refreshBadge,
  testJira,
  siteStatus,
  detectSite,
  rememberMeetingIssue
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = HANDLERS[message?.type];
  if (!handler) {
    sendResponse({ ok: false, error: `Comando sconosciuto: ${message?.type}` });
    return false;
  }
  Promise.resolve(handler(message.payload || {}))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({
      ok: false,
      error: error?.message || String(error),
      code: error?.code || null,
      detail: error?.detail || null
    }));
  return true; // risposta asincrona
});

// Il badge si aggiorna da solo: all'avvio, e poi a intervalli. Senza sveglia
// resterebbe fermo al momento in cui hai aperto il popup l'ultima volta.
const BADGE_ALARM = 'badge';

function scheduleBadge() {
  chrome.alarms.create(BADGE_ALARM, { periodInMinutes: 15 });
  refreshBadge();
}

chrome.runtime.onInstalled.addListener(scheduleBadge);
chrome.runtime.onStartup.addListener(scheduleBadge);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BADGE_ALARM) refreshBadge();
});

// ---------------------------------------------------------------- canale

/**
 * Host Jira da usare. Se la configurazione lo specifica vince lei, sempre:
 * non vogliamo scrivere ore sul sito sbagliato solo perche' era aperto.
 */
async function resolveJiraHost(config) {
  const configured = hostOf(config.jira.baseUrl);
  if (configured) return configured;
  const [detected] = await detectAtlassianHosts();
  return detected?.host || '';
}

async function jiraChannel(config) {
  const host = await resolveJiraHost(config);
  if (!host) {
    throw new TransportError(
      'NO_HOST',
      t('errNoHost')
    );
  }
  return new Channel({
    label: 'Jira',
    host,
    base: `https://${host}`,
    probePath: '/rest/api/3/myself'
  });
}

/** Arricchisce l'errore col contesto che serve al popup per proporre un rimedio. */
async function withSiteContext(error, host) {
  if (error instanceof TransportError) {
    error.detail = { host, openHosts: (await detectAtlassianHosts()).map((h) => h.host) };
  }
  throw error;
}

/** Unisce piu' elenchi di issue tenendo il primo che si presenta per chiave. */
function mergeIssues(...lists) {
  const byKey = new Map();
  for (const list of lists) {
    for (const issue of list || []) {
      if (issue?.key && !byKey.has(issue.key)) byKey.set(issue.key, issue);
    }
  }
  return [...byKey.values()];
}

/**
 * Registra la scelta del ticket per una riunione nella settimana corrente.
 * Scrive solo se qualcosa e' davvero cambiato.
 */
async function saveMeetingChoices(config, scelte) {
  const memory = { ...(config.weeklyMeetingIssues || {}) };
  let changed = false;
  for (const [memoryKey, issueKey] of scelte) {
    if (!memoryKey) continue;
    if (issueKey && memory[memoryKey] !== issueKey) {
      memory[memoryKey] = issueKey;
      changed = true;
    } else if (!issueKey && memoryKey in memory) {
      delete memory[memoryKey];
      changed = true;
    }
  }
  if (changed) {
    await chrome.storage.local.set({ config: { ...config, weeklyMeetingIssues: memory } });
  }
  return changed;
}

function projectClause(projects) {
  const list = (projects || []).map((p) => String(p).trim()).filter(Boolean);
  return list.length ? `project in (${list.join(', ')}) AND ` : '';
}

// ---------------------------------------------------------------- handler

async function siteStatus() {
  const config = await loadConfig();
  const host = await resolveJiraHost(config);
  const tabs = await tabsOnHost(host);
  return {
    host,
    configured: Boolean(hostOf(config.jira.baseUrl)),
    tabsOnSite: tabs.length,
    openHosts: (await detectAtlassianHosts()).map((h) => h.host)
  };
}

/**
 * Ricarica le schede aperte sul sito Jira. Clockwork disegna il calendario una
 * volta sola: dopo che abbiamo scritto o cancellato worklog, la pagina resta
 * ferma ai dati vecchi e non c'e' modo documentato di farglieli rileggere.
 */
async function reloadSite() {
  const config = await loadConfig();
  const host = await resolveJiraHost(config);
  const tabs = await tabsOnHost(host);
  for (const tab of tabs) {
    try {
      await chrome.tabs.reload(tab.id);
    } catch {
      // Scheda sparita nel frattempo: non e' un motivo per fallire.
    }
  }
  return { reloaded: tabs.length };
}

async function detectSite() {
  const hosts = await detectAtlassianHosts();
  if (!hosts.length) throw new Error(t('msgNoAtlassianTab'));
  return { hosts: hosts.map((h) => h.host) };
}

async function resolveMe(client, config) {
  if (config.cache?.accountId && config.cache?.displayName) return config.cache;
  const me = await client.myself();
  if (!me?.accountId) throw new Error(t('errNoIdentity'));
  const identity = {
    accountId: me.accountId,
    displayName: me.displayName || '',
    emailAddress: me.emailAddress || ''
  };
  await saveConfig({ cache: identity });
  return identity;
}

async function testJira() {
  const config = await loadConfig();
  const channel = await jiraChannel(config);
  const client = new JiraClient(channel);
  const me = await client.myself().catch((error) => withSiteContext(error, channel.host));
  await saveConfig({
    cache: {
      accountId: me.accountId,
      displayName: me.displayName || '',
      emailAddress: me.emailAddress || ''
    }
  });
  return { displayName: me.displayName, accountId: me.accountId, host: channel.host };
}

/**
 * Solo le ore gia' registrate, senza rifare tutta l'analisi.
 *
 * Tornando sul popup l'unica cosa che puo' essere cambiata sotto è questa: le
 * attivita' Jira, i commit e le issue recenti non si muovono da soli. Un'analisi
 * completa costa una ricerca piu' una chiamata per issue candidata al pannello
 * Sviluppo — decine di richieste per aggiornare un badge.
 */
async function refreshLogged({ isoDate }) {
  const config = await loadConfig();
  const channel = await jiraChannel(config);
  const jira = new JiraClient(channel);
  const me = await resolveMe(jira, config).catch((error) => withSiteContext(error, channel.host));
  const logged = await loggedMinutesForDay(jira, { isoDate, accountId: me.accountId });
  return {
    alreadyLoggedMinutes: logged.total,
    loggedByIssue: logged.byIssue,
    loggedEntries: logged.entries,
    reliable: logged.reliable
  };
}

/**
 * Le ore mancanti di oggi sull'icona dell'estensione.
 *
 * Il modo in cui si perdono le ore non e' sbagliarle: e' dimenticarsene. Un
 * numero sull'icona lo si vede senza aprire niente.
 *
 * Se non si riesce a leggere (nessuna scheda Jira aperta) il badge viene
 * cancellato invece di restare fermo: un numero vecchio e' peggio di nessuno.
 */
async function refreshBadge() {
  const config = await loadConfig();
  const spegni = async () => {
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setTitle({ title: t('popupTitle') });
  };

  if (!config.work.showBadge) {
    await spegni();
    return { missing: null, shown: false };
  }

  try {
    const channel = await jiraChannel(config);
    const jira = new JiraClient(channel);
    const me = await resolveMe(jira, config);
    const isoDate = todayIso();
    const logged = await loggedMinutesForDay(jira, { isoDate, accountId: me.accountId });

    const budget = Math.round((config.work.dailyHours || 8) * 60);
    const missing = Math.max(0, budget - logged.total);

    await chrome.action.setBadgeBackgroundColor({ color: '#c9372c' });
    await chrome.action.setBadgeText({ text: missing ? shortMinutes(missing) : '' });
    await chrome.action.setTitle({
      title: missing ? t('badgeMissing', formatMinutes(missing)) : t('badgeComplete')
    });
    return { missing, shown: true };
  } catch {
    await spegni();
    return { missing: null, shown: false };
  }
}

/**
 * Le ore registrate in un altro giorno, raccolte per issue.
 *
 * Una settimana di lavoro si somiglia molto: ripartire da un giorno gia' fatto
 * costa un click invece di ricomporre tutto a mano.
 */
async function copyFrom({ fromDate }) {
  if (!fromDate) throw new Error(t('errMissingIssue'));
  const config = await loadConfig();
  const channel = await jiraChannel(config);
  const jira = new JiraClient(channel);
  const me = await resolveMe(jira, config).catch((error) => withSiteContext(error, channel.host));

  const logged = await loggedMinutesForDay(jira, { isoDate: fromDate, accountId: me.accountId });

  // Piu' worklog sulla stessa issue diventano una riga sola: nel piano di oggi
  // la spezzatura la rifa' il planner, in base alle pause di oggi.
  const byKey = new Map();
  for (const entry of logged.entries) {
    const riga = byKey.get(entry.key) || {
      key: entry.key, summary: entry.summary, minutes: 0, comment: ''
    };
    riga.minutes += entry.minutes;
    if (!riga.comment && entry.comment) riga.comment = entry.comment;
    byKey.set(entry.key, riga);
  }
  return { entries: [...byKey.values()], total: logged.total };
}

/**
 * Cancella i worklog che hai registrato quel giorno su una issue. Serve a
 * disfare un invio: senza, l'unico modo era andarci a mano da Jira.
 * Tocca solo i tuoi worklog e solo quella data.
 */
async function deleteLogged({ isoDate, issueKey, worklogIds = null }) {
  if (!issueKey) throw new Error(t('errMissingIssue'));
  const config = await loadConfig();
  const channel = await jiraChannel(config);
  const jira = new JiraClient(channel);
  const me = await resolveMe(jira, config).catch((error) => withSiteContext(error, channel.host));

  const logged = await loggedMinutesForDay(jira, { isoDate, accountId: me.accountId });
  // `worklogIds` assente = tutti quelli del giorno su quella issue. Con un
  // doppione capita di volerne togliere uno solo, quindi si puo' scegliere.
  const wanted = worklogIds ? new Set(worklogIds.map(String)) : null;
  const miei = logged.entries.filter(
    (entry) => entry.key === issueKey && entry.id && (!wanted || wanted.has(String(entry.id)))
  );
  if (!miei.length) return { deleted: 0, minutes: 0, total: 0, error: null };

  // Se una cancellazione fallisce a meta', le precedenti sono gia' andate: si
  // riporta quanto e' stato fatto invece di far credere che non sia successo nulla.
  let deleted = 0;
  let minutes = 0;
  let errore = null;
  for (const entry of miei) {
    try {
      await jira.deleteWorklog(issueKey, entry.id);
      deleted += 1;
      minutes += entry.minutes;
    } catch (error) {
      errore = error.message;
      break;
    }
  }
  return { deleted, minutes, total: miei.length, error: errore };
}

async function rememberMeetingIssue({ memoryKey, issueKey }) {
  if (!memoryKey) return {};
  const config = await loadConfig();
  const saved = await saveMeetingChoices(config, [[memoryKey, issueKey]]);
  return { saved };
}

/**
 * Issue su cui cercare i commit. Non bastano quelle toccate oggi in Jira:
 * capita di committare su un ticket senza aprirlo. Si aggiungono quindi le
 * issue assegnate a te e aggiornate di recente.
 */
async function devCandidates(jira, { jiraActivity, config }) {
  const byKey = new Map();
  for (const entry of jiraActivity.values()) {
    if (entry.id) byKey.set(entry.key, { id: entry.id, key: entry.key });
  }

  const limit = Math.max(0, config.jira.devCandidates || 0);
  if (limit > 0) {
    const jql = `${projectClause(config.jira.projects)}assignee = currentUser() ` +
      'AND updated >= -21d ORDER BY updated DESC';
    try {
      const issues = await jira.search(jql, { fields: ['summary'], maxResults: limit });
      for (const issue of issues) {
        if (!byKey.has(issue.key)) byKey.set(issue.key, { id: issue.id, key: issue.key });
      }
    } catch {
      // Senza le candidate extra restano quelle toccate oggi: meno copertura,
      // ma l'analisi prosegue.
    }
  }
  return [...byKey.values()];
}

async function analyze({ isoDate }) {
  const config = await loadConfig();
  const channel = await jiraChannel(config);
  const jira = new JiraClient(channel);
  const projects = config.jira.projects || [];
  const notes = [];

  const me = await resolveMe(jira, config).catch((error) => withSiteContext(error, channel.host));
  const accountId = me.accountId;

  if (!projects.length) {
    notes.push({
      level: 'action', key: 'noteNoProjects', params: []
    });
  }

  const jiraActivity = await collectJiraActivity(jira, {
    isoDate,
    projects,
    accountId,
    scanComments: config.jira.scanComments
  });

  // I commit arrivano dal pannello "Sviluppo" delle issue: sono dentro Jira,
  // quindi non serve nessun'altra scheda aperta.
  const gitByIssue = new Map();
  if (config.jira.devPanel) {
    try {
      const candidates = await devCandidates(jira, { jiraActivity, config });
      const identities = [me.displayName, me.emailAddress, ...(config.identity.extraAuthors || [])];
      const dev = await collectDevPanelCommits(jira, { candidates, isoDate, identities });
      for (const [key, commits] of dev.byIssue) gitByIssue.set(key, commits);

      if (dev.skippedOther) {
        notes.push({
          level: 'info', key: 'noteOtherAuthors', params: [dev.skippedOther]
        });
      }
      if (!dev.appType && candidates.length) {
        notes.push({
          level: 'info', key: 'noteNoCommits', params: [candidates.length]
        });
      }
    } catch (error) {
      notes.push({
        level: 'info', key: 'noteDevPanelUnreadable', params: [error.message]
      });
    }
  }

  // Le issue viste solo dai commit non hanno ancora un titolo.
  const summaries = {};
  for (const key of gitByIssue.keys()) {
    if (jiraActivity.has(key)) continue;
    try {
      const issue = await jira.getIssue(key, ['summary']);
      summaries[key] = issue.fields?.summary || '';
    } catch {
      summaries[key] = '(titolo non leggibile)';
    }
  }

  // Le issue recenti servono sia al menu dei ticket riunione sia a indovinare
  // quello delle cerimonie di questo sprint, quindi vanno lette prima del piano.
  const logged = await loggedMinutesForDay(jira, { isoDate, accountId });

  // Le issue su cui hai gia' registrato ore oggi vanno in testa ai suggerimenti:
  // se una riunione e' gia' stata segnata da qualche parte, quel ticket e' la
  // risposta migliore alla domanda "su quale issue va questa riunione?".
  const recentIssues = mergeIssues(logged.issues, await recentIssuesFor(jira, projects));

  const plan = buildPlan({
    isoDate,
    config,
    jiraActivity,
    gitByIssue,
    summaries,
    recentIssues,
    loggedEntries: logged.entries,
    loggedByIssue: logged.byIssue,
    alreadyLoggedMinutes: logged.total
  });

  // Se su un ticket riunione proposto hai gia' registrato ore quel giorno, la
  // proposta e' confermata dai fatti: la si ricorda e si smette di chiedere.
  const confermate = [];
  for (const row of plan.rows) {
    if (row.kind === 'meeting' && row.guessed && row.issueKey && row.existingMinutes > 0) {
      row.guessed = false;
      confermate.push([row.memoryKey, row.issueKey]);
    }
  }
  await saveMeetingChoices(config, confermate);

  if (!logged.reliable) {
    notes.push({
      level: 'action', key: 'noteWorklogsUnreadable', params: []
    });
  }

  return { ...plan, notes, recentIssues, config, site: { host: channel.host } };
}

/**
 * Issue da suggerire nei campi ticket. Due interrogazioni:
 * quelle dei progetti configurati, e — senza filtro progetto — quelle su cui hai
 * registrato ore di recente. La seconda serve perche' i ticket delle cerimonie
 * stanno spesso su un progetto diverso da quello su cui lavori.
 */
async function recentIssuesFor(jira, projects) {
  const queries = [
    // Prima le tue: a parita' di punteggio la proposta preferisce le prime.
    'worklogAuthor = currentUser() AND worklogDate >= -28d ORDER BY updated DESC',
    `${projectClause(projects)}updated >= -28d ORDER BY updated DESC`
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

async function submit({ isoDate, rows }) {
  const config = await loadConfig();
  const channel = await jiraChannel(config);
  const jira = new JiraClient(channel);

  // La scheda si valida prima di scrivere: se la sessione non e' buona lo
  // scopriamo adesso, non a meta' invio.
  await channel.resolve().catch((error) => withSiteContext(error, channel.host));

  const results = [];
  for (const row of rows) {
    if (!row.enabled || !row.issueKey || !row.minutes) continue;

    // Un blocco spezzato dalla pausa diventa piu' worklog: e' cosi' che la
    // giornata risulta davvero, senza un'ora di lavoro dentro il pranzo.
    const segments = row.segments?.length
      ? row.segments
      : [{ time: row.time || config.work.startTime || '09:00', minutes: row.minutes }];

    let scritti = 0;
    try {
      for (const segment of segments) {
        await jira.addWorklog(row.issueKey, {
          started: jiraStarted(isoDate, segment.time),
          timeSpentSeconds: Math.round(segment.minutes * 60),
          comment: row.comment || undefined
        });
        scritti += 1;
      }
      results.push({ issueKey: row.issueKey, minutes: row.minutes, parts: segments.length, ok: true });
    } catch (error) {
      // Una riga spezzata dalla pausa fa piu' worklog: se salta il secondo, il
      // primo e' gia' su Jira. Dirlo, altrimenti si rilancia e si duplica.
      const parziale = scritti > 0
        ? t('msgPartialWrite', scritti, segments.length)
        : '';
      results.push({
        issueKey: row.issueKey,
        minutes: row.minutes,
        ok: false,
        written: scritti,
        error: `${error.message}${parziale}`
      });
    }
  }

  // Le riunioni confermate diventano la scelta della settimana.
  await saveMeetingChoices(
    config,
    rows
      .filter((row) => row.kind === 'meeting' && row.enabled && row.memoryKey && row.issueKey)
      .map((row) => [row.memoryKey, row.issueKey])
  );

  return { results, host: channel.host };
}
