// La scheda Ticket: i tuoi ticket aperti, la ricerca, il cambio di stato.
//
// Sono gli handler `openIssues`, `findIssues`, `issueTransitions` e
// `moveIssue` del background dell'estensione, senza chrome: ricevono un
// JiraClient e la configurazione. Il raggruppamento e il filtro delle
// transizioni sono quelli di lib/ticket.js.

import { collectOpenIssues, searchIssues } from '../lib/jira.js';
import { groupOpenIssues, usefulTransitions } from '../lib/ticket.js';

export function newTicketsState() {
  return {
    groups: [],
    total: 0,
    at: 0,
    loading: false,
    error: '',
    query: '',
    results: [],
    searching: false,
    // Le transizioni gia' lette, per non richiederle a ogni apertura del menu.
    transitions: new Map(),
    // Il ticket col menu degli stati aperto (uno alla volta), e quello in viaggio.
    openMenu: '',
    menuError: '',
    moving: '',
    // L'ultimo spostato: si segue con lo sguardo, perche' cambia gruppo.
    justMoved: '',
    messages: []
  };
}

/** I ticket che hai in mano adesso, divisi per stato e per giorno dell'ultimo movimento. */
export async function loadOpenIssues(jira, config) {
  const issues = await collectOpenIssues(jira, { projects: config.jira.projects || [] });
  return { groups: groupOpenIssues(issues), total: issues.length };
}

/** Cerca per chiave o per testo, anche fra i ticket degli altri. */
export async function findIssues(jira, config, query) {
  return searchIssues(jira, { query, projects: config.jira.projects || [] });
}

/** Gli stati a un passo da quello attuale, senza quello in cui si e' gia'. */
export async function transitionsFor(jira, issueKey, status) {
  return usefulTransitions(await jira.getTransitions(issueKey), status);
}

/**
 * Sposta la issue e rilegge l'elenco. Lo stato d'arrivo si rilegge da Jira
 * invece di darlo per buono: un'automazione puo' averlo cambiato ancora.
 */
export async function moveIssue(jira, config, issueKey, transitionId) {
  await jira.transitionIssue(issueKey, transitionId);
  const reached = await jira.getIssue(issueKey, ['status'])
    .then((issue) => issue?.fields?.status?.name || '')
    .catch(() => '');
  return { ...(await loadOpenIssues(jira, config)), moved: issueKey, reached };
}

/** Il ticket com'e' a schermo: nei gruppi o fra i risultati di ricerca. */
export function findShown(state, issueKey) {
  if (state.query) return state.results.find((issue) => issue.key === issueKey) || null;
  for (const gruppo of state.groups) {
    for (const giorno of gruppo.days) {
      const trovato = giorno.issues.find((issue) => issue.key === issueKey);
      if (trovato) return trovato;
    }
  }
  return null;
}
