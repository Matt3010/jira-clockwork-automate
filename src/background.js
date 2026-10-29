// Service worker: tutte le chiamate di rete passano da qui.
//
// Unica autenticazione: la sessione del browser. Le richieste vengono eseguite
// dentro una scheda aperta sul sito Jira (vedi transport.js), quindi usano il
// login che l'utente ha gia' fatto. Nessuna credenziale viene mai salvata.
//
// Unica destinazione: Jira. Anche i commit arrivano da li', dal pannello
// "Sviluppo" delle issue.

import { loadConfig, saveConfig, saveMeetingMemory } from './lib/storage.js';
import {
  JiraClient,
  collectJiraActivity,
  estimateMinutes,
  collectDevPanelCommits,
  collectCreatedIssues,
  mergeCreatedIssues,
  collectOpenIssues,
  searchIssues,
  loggedMinutesForDay
} from './lib/jira.js';
import { groupOpenIssues, usefulTransitions } from './lib/ticket.js';
import { Channel, TransportError, detectAtlassianHosts, hostOf, tabsOnHost } from './lib/transport.js';
import { buildPlan } from './lib/planner.js';
import {
  dayBounds, formatMinutes, isSameLocalDay, jiraStarted, shortMinutes, todayIso
} from './lib/dates.js';
import { t } from './lib/i18n.js';

const HANDLERS = {
  analyze,
  submit,
  deleteLogged,
  refreshLogged,
  reloadSite,
  copyFrom,
  openIssues,
  findIssues,
  issueTransitions,
  moveIssue,
  refreshBadge,
  testJira,
  siteStatus,
  detectSite,
  rememberMeetingIssue,
  refreshUiMode
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

// Il pannello laterale ha due nomi e due modi di aprirsi. `chrome.sidePanel`
// esiste da Chrome 114 e lo lega al click sull'icona da solo, con
// `setPanelBehavior`; su Firefox e' `sidebarAction`, e il pannello si apre solo
// dentro il gestore di un gesto dell'utente — cioe' da `action.onClicked`.
// Dove non c'e' ne' l'uno ne' l'altro resta il popup, che e' il motivo per cui
// il popup non e' stato buttato via.
// Su Firefox le API stanno sotto `browser`, e `chrome` le rispecchia quasi
// tutte — ma il pannello e' roba loro, e scommettere sullo specchio qui
// costerebbe un pannello che non si apre mai.
const sidebar = globalThis.browser?.sidebarAction || chrome.sidebarAction;
const PANNELLO = chrome.sidePanel?.setPanelBehavior ? 'chrome'
  : sidebar?.toggle ? 'firefox'
    : null;

/**
 * Decide cosa apre il click sull'icona: il pannello laterale o il popup.
 *
 * Il manifest non dichiara `default_popup` perche' quello vincerebbe sempre
 * sul pannello; il popup si riattiva da qui, a runtime, quando lo si sceglie
 * nelle opzioni.
 */
async function applyUiMode(config) {
  const pannello = config?.ui?.sidePanel !== false;
  const disponibile = Boolean(PANNELLO);
  const attivo = pannello && disponibile;

  if (PANNELLO === 'chrome') {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: attivo }).catch(() => {});
  }
  await chrome.action.setPopup({ popup: attivo ? '' : 'src/popup.html' });
  return { sidePanel: attivo, available: disponibile };
}

/** Rilegge la scelta dalle opzioni e la applica subito. */
async function refreshUiMode() {
  return applyUiMode(await loadConfig());
}

async function startup() {
  scheduleBadge();
  await refreshUiMode();
}

chrome.runtime.onInstalled.addListener(startup);
chrome.runtime.onStartup.addListener(startup);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BADGE_ALARM) refreshBadge();
});

// Senza popup il click sull'icona arriva qui, e succede solo dove il pannello
// e' la scelta attiva. Su Chrome non ci arriva mai: il pannello lo apre
// `setPanelBehavior`, e il click non diventa un evento.
chrome.action.onClicked.addListener(() => {
  sidebar?.toggle();
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
  if (changed) await saveMeetingMemory(memory);
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
    tabsOnSite: tabs.length
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
  const me = await client.myself();
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
async function refreshLogged({ isoDate, issueKeys = [] }) {
  const config = await loadConfig();
  const channel = await jiraChannel(config);
  const jira = new JiraClient(channel);
  const me = await resolveMe(jira, config);
  // Le issue del piano si leggono anche se l'indice non le ha ancora: subito
  // dopo un invio sono proprio quelle che devono cambiare a schermo.
  const logged = await loggedMinutesForDay(jira, {
    isoDate, accountId: me.accountId, extraKeys: issueKeys
  });

  // Se il giorno guardato e' oggi, il badge si aggiorna con questi stessi
  // numeri: nessuna richiesta in piu'. Serve quando le ore le hai messe da
  // Clockwork e non da qui — altrimenti il badge le vedrebbe solo alla sveglia.
  if (isoDate === todayIso() && config.work.showBadge) {
    await paintBadge(missingToday(config, logged.total));
  }

  return {
    alreadyLoggedMinutes: logged.total,
    loggedByIssue: logged.byIssue,
    loggedEntries: logged.entries
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
/**
 * Disegna il badge. `missing` a null lo spegne: quando non sappiamo, non si
 * afferma niente.
 */
async function paintBadge(missing) {
  if (missing === null) {
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setTitle({ title: t('popupTitle') });
    return;
  }
  await chrome.action.setBadgeBackgroundColor({ color: '#c9372c' });
  await chrome.action.setBadgeText({ text: missing ? shortMinutes(missing) : '' });
  await chrome.action.setTitle({
    title: missing ? t('badgeMissing', formatMinutes(missing)) : t('badgeComplete')
  });
}

/** Quante ore mancano oggi, dato quanto risulta gia' registrato. */
function missingToday(config, loggedMinutes) {
  return Math.max(0, Math.round((config.work.dailyHours || 8) * 60) - loggedMinutes);
}

async function refreshBadge({ extraKeys = [] } = {}) {
  const config = await loadConfig();
  if (!config.work.showBadge) {
    await paintBadge(null);
    return { missing: null, shown: false };
  }

  try {
    const channel = await jiraChannel(config);
    const jira = new JiraClient(channel);
    const me = await resolveMe(jira, config);
    // Le chiavi appena scritte si leggono dirette, non dall'indice worklog: e'
    // in ritardo di qualche secondo, e il badge resterebbe fermo sul numero di
    // prima proprio subito dopo l'invio, quando conta di piu'.
    const logged = await loggedMinutesForDay(jira, {
      isoDate: todayIso(), accountId: me.accountId, extraKeys
    });
    const missing = missingToday(config, logged.total);
    await paintBadge(missing);
    return { missing, shown: true };
  } catch {
    await paintBadge(null);
    return { missing: null, shown: false };
  }
}

// ------------------------------------------------------------------ i tuoi ticket

/**
 * I ticket che hai aperti, divisi per stato e per giorno di apertura.
 *
 * A differenza di tutto il resto non guarda il giorno scelto in alto: non e'
 * "cosa ho fatto lunedi", e' "cosa ho in mano adesso". Per questo sta in una
 * scheda sua.
 */
async function openIssues() {
  const config = await loadConfig();
  const channel = await jiraChannel(config);
  const jira = new JiraClient(channel);
  const issues = await collectOpenIssues(jira, { projects: config.jira.projects || [] });

  return { groups: groupOpenIssues(issues), total: issues.length };
}

/**
 * Cerca un ticket per chiave o per testo, senza limitarsi ai tuoi.
 *
 * L'elenco sopra risponde a "cosa ho in mano"; questa risponde a "dov'e'
 * finito quel ticket la'", che e' una domanda diversa e capita spesso quando
 * il ticket e' di un collega.
 */
async function findIssues({ query }) {
  const config = await loadConfig();
  const channel = await jiraChannel(config);
  const jira = new JiraClient(channel);
  const issues = await searchIssues(jira, { query, projects: config.jira.projects || [] });

  return { query, issues };
}

/**
 * Gli stati in cui la issue puo' andare da dove si trova adesso.
 *
 * Solo quelli a un passo, che sono quelli che dice Jira: corretti per
 * costruzione. Per arrivare piu' lontano si incatenano — il popup riapre il
 * menu sulla riga appena spostata, quindi e' un click per passo e restano
 * tutti nello stesso punto dello schermo.
 *
 * Si chiedono al click su una riga, non per tutto l'elenco: sarebbe una
 * richiesta per ticket all'apertura, per una vista che il piu' delle volte
 * guardi e basta.
 */
async function issueTransitions({ issueKey, status }) {
  if (!issueKey) throw new Error(t('errMissingIssue'));
  const config = await loadConfig();
  const channel = await jiraChannel(config);
  const jira = new JiraClient(channel);
  const transitions = await jira.getTransitions(issueKey);

  return { issueKey, transitions: usefulTransitions(transitions, status) };
}

/**
 * Sposta la issue di uno stato e restituisce l'elenco aggiornato.
 *
 * Rileggere subito evita il caso in cui la riga resta a schermo con lo stato
 * vecchio: dopo una transizione Jira puo' averne cambiati altri (regole di
 * automazione), e mostrare quello che credevamo di aver scritto sarebbe una
 * bugia comoda. Per lo stesso motivo lo stato d'arrivo si rilegge da Jira
 * invece di darlo per buono dalla transizione.
 */
async function moveIssue({ issueKey, transitionId }) {
  if (!issueKey || !transitionId) throw new Error(t('errMissingIssue'));
  const config = await loadConfig();
  const channel = await jiraChannel(config);
  const jira = new JiraClient(channel);

  await jira.transitionIssue(issueKey, transitionId);

  const reached = await jira.getIssue(issueKey, ['status'])
    .then((issue) => issue?.fields?.status?.name || '')
    .catch(() => '');

  const issues = await collectOpenIssues(jira, { projects: config.jira.projects || [] });
  return { groups: groupOpenIssues(issues), total: issues.length, moved: issueKey, reached };
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
  const me = await resolveMe(jira, config);

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
 * Tocca solo i tuoi worklog, solo quella data, e solo quelli indicati per id.
 *
 * Senza id non si cancella niente. C'era un "tutti quelli del giorno", usato
 * quando il popup non riusciva a elencarli: ma succede proprio subito dopo un
 * invio, e il pulsante mostrava le ore appena scritte mentre cancellava anche
 * quelle messe prima — da Clockwork, o da un invio di ieri sera.
 */
async function deleteLogged({ isoDate, issueKey, worklogIds = [] }) {
  if (!issueKey) throw new Error(t('errMissingIssue'));
  const wanted = new Set((worklogIds || []).map(String));
  if (!wanted.size) return { deleted: 0, minutes: 0, total: 0, error: null };

  const config = await loadConfig();
  const channel = await jiraChannel(config);
  const jira = new JiraClient(channel);
  const me = await resolveMe(jira, config);

  // I worklog di questa issue si leggono diretti: la ricerca per worklog passa
  // dall'indice di Jira, in ritardo di qualche secondo subito dopo un invio —
  // proprio quando si vuole disfarlo.
  const { start } = dayBounds(isoDate);
  const miei = (await jira.getWorklogs(issueKey, start - 1)).filter((worklog) =>
    worklog.author?.accountId === me.accountId
    && isSameLocalDay(worklog.started, isoDate)
    && wanted.has(String(worklog.id))
  ).map((worklog) => ({
    id: worklog.id,
    minutes: Math.round((worklog.timeSpentSeconds || 0) / 60)
  }));
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
  await refreshBadge();
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
 * issue assegnate a te e aggiornate di recente — con titolo e stima, che per
 * quelle viste solo dai commit non arrivano da nessun'altra parte.
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

  const me = await resolveMe(jira, config);
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
    displayName: me.displayName,
    scanComments: config.jira.scanComments
  });

  // Aprire un ticket non lascia traccia nel changelog, quindi va cercato a
  // parte. Prima dei commit, non dopo: una issue creata oggi è una candidata
  // legittima per il pannello Sviluppo — anzi, è quella su cui è più
  // probabile che tu abbia committato.
  mergeCreatedIssues(jiraActivity, await collectCreatedIssues(jira, { isoDate, projects }));

  // La ricerca del giorno ha un tetto: raggiunto, qualcosa e' rimasto fuori e
  // la giornata che stai guardando e' incompleta. Un piano incompleto senza
  // dirlo e' peggio di un piano incompleto.
  if (jiraActivity.truncated) notes.push({ level: 'info', key: 'noteActivityTruncated', params: [] });

  // I commit arrivano dal pannello "Sviluppo" delle issue: sono dentro Jira,
  // quindi non serve nessun'altra scheda aperta. Il pannello non fa fallire
  // l'analisi: le candidate e le singole issue che non rispondono si saltano.
  const candidates = await devCandidates(jira, { jiraActivity, config });
  const dev = await collectDevPanelCommits(jira, {
    candidates,
    isoDate,
    identities: [me.displayName, me.emailAddress, ...(config.identity.extraAuthors || [])],
    countMerges: config.jira.countMerges !== false
  });
  const gitByIssue = dev.byIssue;
  const foreignGitByIssue = dev.othersByIssue;
  if (!dev.appType && candidates.length) {
    notes.push({
      level: 'info',
      key: candidates.length === 1 ? 'noteNoCommitsOne' : 'noteNoCommits',
      params: [candidates.length]
    });
  }

  // Titolo e stima delle issue viste solo dai commit: le ha portate la ricerca
  // delle candidate, l'unica da cui possono arrivare.
  const summaries = {};
  const estimates = {};
  for (const candidate of candidates) {
    if (jiraActivity.has(candidate.key) || !gitByIssue.has(candidate.key)) continue;
    summaries[candidate.key] = candidate.summary || '';
    estimates[candidate.key] = candidate.estimateMinutes || 0;
  }

  // Le issue recenti servono sia al menu dei ticket riunione sia a indovinare
  // quello delle cerimonie di questo sprint, quindi vanno lette prima del piano.
  //
  // Le issue della giornata si leggono anche se l'indice non le ha ancora: un
  // «Aggiorna» subito dopo un invio ripescherebbe altrimenti la giornata di
  // prima, e le righe appena scritte tornerebbero accese e senza badge.
  const logged = await loggedMinutesForDay(jira, {
    isoDate,
    accountId,
    extraKeys: [...new Set([...jiraActivity.keys(), ...gitByIssue.keys()])]
  });

  // Le issue su cui hai gia' registrato ore oggi vanno in testa ai suggerimenti:
  // se una riunione e' gia' stata segnata da qualche parte, quel ticket e' la
  // risposta migliore alla domanda "su quale issue va questa riunione?".
  const recentIssues = mergeIssues(logged.issues, await recentIssuesFor(jira, projects));

  const plan = buildPlan({
    isoDate,
    config,
    jiraActivity,
    gitByIssue,
    foreignGitByIssue,
    summaries,
    estimates,
    recentIssues,
    loggedEntries: logged.entries,
    loggedByIssue: logged.byIssue,
    alreadyLoggedMinutes: logged.total
  });

  // I commit dei colleghi sulle tue task adesso stanno sulla riga a cui
  // appartengono. L'avviso in cima resta solo per quelli che non hanno trovato
  // una riga dove posarsi — altrimenti direbbe tutti i giorni una cosa che si
  // legge gia' due centimetri piu' sotto.
  if (foreignGitByIssue.size) {
    const senzaRiga = [...foreignGitByIssue]
      .filter(([key]) => !plan.rows.some((row) => row.issueKey === key))
      .flatMap(([, commits]) => commits);
    if (senzaRiga.length) {
      const chi = [...new Set(senzaRiga.map((c) => c.author).filter(Boolean))].join(', ')
        || t('noteOtherAuthorsUnknown');
      notes.push({
        level: 'info',
        key: senzaRiga.length === 1 ? 'noteOtherAuthorsOne' : 'noteOtherAuthors',
        params: senzaRiga.length === 1 ? [chi] : [senzaRiga.length, chi]
      });
    }
  }

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
  await channel.resolve();

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
          // La nota si scrive solo se la vuoi: spenta, i worklog restano nudi
          // — e questo e' l'unico punto che la manda, quindi non c'e' modo che
          // sfugga da un'altra strada.
          comment: config.work.sendComments === false ? undefined : (row.comment || undefined)
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

  // Il badge deve seguire subito: aspettare la sveglia dei 15 minuti lo
  // lascerebbe fermo su un numero che non e' piu' vero. Le chiavi appena
  // scritte gli arrivano dirette, cosi' non conta una giornata vecchia mentre
  // l'indice worklog si aggiorna.
  await refreshBadge({ extraKeys: results.filter((r) => r.ok).map((r) => r.issueKey) });

  return { results, host: channel.host };
}
