// Il piano del giorno nel pannello: lo stato e tutto quello che gli si fa.
//
// E' la logica del popup dell'estensione staccata dal DOM: chi disegna legge
// lo stato e chiama queste funzioni, e nessuna di queste tocca la pagina. Le
// regole sono quelle del popup, commentate la' per esteso; qui c'e' il
// riassunto e il perche' quando cambia qualcosa.

import { reflow } from '../lib/planner.js';
import { formatMinutes, jiraStarted, toIsoDate } from '../lib/dates.js';
import { t } from './i18n.js';

export function newDayState(isoDate) {
  return {
    isoDate,
    rows: [],
    config: null,
    budgetMinutes: 0,
    dayBudgetMinutes: 0,
    alreadyLoggedMinutes: 0,
    endOfDay: null,
    loggedEntries: [],
    recentIssues: [],
    messages: [],
    // Le ore appena scritte che la ricerca worklog di Jira non riporta ancora:
    // valgono come minimo finche' Jira non le rilegge da solo.
    pending: { isoDate: '', perIssue: {} },
    analyzedAt: 0
  };
}

/** Avviso del planner o dell'analisi (chiave + parametri) in testo. */
export function messageOf(entry) {
  if (!entry?.key) return null;
  return { level: entry.level || 'info', text: t(entry.key, ...(entry.params || [])) };
}

/**
 * Carica un piano appena costruito. La nota precompilata arriva come chiave e
 * diventa testo qui, perche' finisce in un campo modificabile.
 */
export function loadPlan(state, { plan, day, config }) {
  state.config = config;
  state.budgetMinutes = plan.budgetMinutes;
  state.dayBudgetMinutes = plan.dayBudgetMinutes;
  state.alreadyLoggedMinutes = plan.alreadyLoggedMinutes || 0;
  state.endOfDay = plan.endOfDay || null;
  state.loggedEntries = plan.loggedEntries || [];
  state.recentIssues = [...(day.logged?.issues || []), ...(day.recentIssues || [])]
    .filter((issue, i, all) => all.findIndex((x) => x.key === issue.key) === i);
  state.rows = plan.rows.map((row) => ({
    ...row,
    locked: false,
    comment: row.comment || (row.commentKey ? t(row.commentKey) : '')
  }));
  state.messages = [...(plan.warnings || []), ...(day.notes || [])].map(messageOf).filter(Boolean);

  const senzaTicket = state.rows.filter((row) => row.enabled && !row.issueKey);
  if (senzaTicket.length) state.messages.push({ level: 'action', text: t('msgMeetingsNoTicket', senzaTicket.length) });
  const proposti = state.rows.filter((row) => row.guessed && row.enabled && row.issueKey);
  if (proposti.length) {
    state.messages.push({ level: 'action', text: t('msgProposedTickets', proposti.map((r) => r.issueKey).join(', ')) });
  }
  state.analyzedAt = Date.now();
  redistribute(state);
}

export function redistribute(state) {
  if (!state.config) return;
  const { budgetMinutes, endOfDay } = reflow(state.rows, state.config, {
    dayBudgetMinutes: state.dayBudgetMinutes,
    alreadyLoggedMinutes: state.alreadyLoggedMinutes,
    loggedEntries: state.loggedEntries
  });
  state.budgetMinutes = budgetMinutes;
  state.endOfDay = endOfDay;
}

/** Le righe che verranno davvero scritte: accese, con un ticket e con ore. */
export function sendableRows(state) {
  return state.rows.filter((row) => row.enabled && row.issueKey && row.minutes);
}

/**
 * Il riepilogo sotto il piano, e se l'invio va confermato: quando la giornata
 * sforerebbe il monte ore, o quando si riscrivono ore su una issue che quel
 * giorno ne ha gia'.
 */
export function summary(state) {
  const inviabili = sendableRows(state);
  const total = inviabili.reduce((sum, row) => sum + row.minutes, 0);
  const redone = state.rows
    .filter((row) => row.enabled && row.existingMinutes)
    .reduce((sum, row) => sum + row.existingMinutes, 0);
  const final = state.alreadyLoggedMinutes + total;
  const overflow = Math.max(0, final - state.dayBudgetMinutes);
  const duplicates = inviabili.filter((row) => row.existingMinutes);

  const parti = [t('totalDistribute', formatMinutes(state.budgetMinutes))];
  if (state.alreadyLoggedMinutes) {
    parti.push(t('totalAlready', formatMinutes(state.alreadyLoggedMinutes), formatMinutes(state.dayBudgetMinutes)));
  }
  parti.push(t('totalRows', inviabili.length));
  if (inviabili.length && state.endOfDay) parti.push(t('totalEndOfDay', state.endOfDay));
  if (overflow > 0) {
    parti.push(redone
      ? t('totalOverflowRedo', formatMinutes(final), formatMinutes(redone))
      : t('totalOverflow', formatMinutes(final)));
  }

  let confirmLabel = '';
  if (overflow > 0) confirmLabel = t('btnConfirmDay', formatMinutes(final));
  else if (duplicates.length === 1) {
    confirmLabel = t('btnConfirmDuplicateOne', duplicates[0].issueKey, formatMinutes(duplicates[0].existingMinutes));
  } else if (duplicates.length > 1) confirmLabel = t('btnConfirmDuplicateMany', duplicates.length);

  return {
    total,
    sendable: inviabili.length,
    overflow,
    duplicates,
    needsConfirm: overflow > 0 || duplicates.length > 0,
    confirmLabel,
    sendLabel: inviabili.length === 1 ? t('btnSendCountOne') : (inviabili.length ? t('btnSendCount', inviabili.length) : t('btnSend')),
    text: parti.join('')
  };
}

// ------------------------------------------------------------ modifiche

export function toggleRow(state, row, on) {
  row.enabled = on;
  // Da qui in poi la riga la comandi tu: una rilettura non la rigira.
  row.userToggled = true;
  row.autoDisabled = false;
  redistribute(state);
}

/** Ore scritte a mano: la riga si blocca e le altre si ridistribuiscono attorno. */
export function setRowMinutes(state, row, minutes) {
  row.minutes = Math.max(0, Math.round(minutes));
  row.lockedMinutes = row.minutes;
  row.locked = true;
  redistribute(state);
}

/**
 * Ticket scritto a mano. Su una riunione diventa la scelta della settimana, e
 * se quel ticket era anche fra le task quella riga sparisce: l'attivita' sul
 * ticket delle cerimonie e' la riunione stessa.
 *
 * @returns {{remember: [string, string] | null, clash: boolean}}
 */
export function setRowIssue(state, row, value) {
  row.issueKey = String(value || '').trim().toUpperCase();
  row.guessed = false;
  const match = state.recentIssues.find((issue) => issue.key === row.issueKey);
  if (match) row.summary = match.summary;

  let remember = null;
  let clash = false;
  if (row.kind === 'meeting' && row.memoryKey) {
    remember = [row.memoryKey, row.issueKey];
    const prima = state.rows.length;
    state.rows = state.rows.filter((r) => !(r.kind === 'task' && r.issueKey === row.issueKey));
    clash = state.rows.length !== prima;
  }
  redistribute(state);
  return { remember, clash };
}

export function removeRow(state, id) {
  state.rows = state.rows.filter((row) => row.id !== id);
  redistribute(state);
}

export function addManualRow(state) {
  const row = {
    id: `manuale:${Date.now()}`,
    kind: 'task',
    issueKey: '',
    summary: '',
    label: '',
    minutes: 0,
    time: '',
    segments: [],
    sources: [],
    detail: t('detailManual'),
    comment: '',
    enabled: true,
    existingMinutes: 0,
    locked: false
  };
  state.rows.push(row);
  redistribute(state);
  return row;
}

// ------------------------------------------------------------ memoria riunioni

/** Scrive nella memoria settimanale le scelte cambiate. Ritorna se e' cambiato qualcosa. */
export function rememberMeetings(config, coppie) {
  const memoria = config.weeklyMeetingIssues || (config.weeklyMeetingIssues = {});
  let cambiato = false;
  for (const [memoryKey, issueKey] of coppie) {
    if (!memoryKey) continue;
    if (issueKey && memoria[memoryKey] !== issueKey) {
      memoria[memoryKey] = issueKey;
      cambiato = true;
    } else if (!issueKey && memoryKey in memoria) {
      delete memoria[memoryKey];
      cambiato = true;
    }
  }
  return cambiato;
}

/**
 * Le proposte confermate dai fatti: una riunione con ticket indovinato su cui
 * quel giorno ci sono gia' ore. Si ricordano e si smette di chiedere.
 */
export function confirmedGuesses(state) {
  const coppie = [];
  for (const row of state.rows) {
    if (row.kind === 'meeting' && row.guessed && row.issueKey && row.existingMinutes > 0) {
      row.guessed = false;
      coppie.push([row.memoryKey, row.issueKey]);
    }
  }
  return coppie;
}

// ------------------------------------------------------------ invio e rilettura

/**
 * Scrive i worklog delle righe inviabili. Un blocco spezzato dalla pausa
 * diventa piu' worklog; se ne salta uno a meta', lo si dice — il primo e' gia'
 * su Jira, e rilanciare duplicherebbe.
 */
export async function submitRows(jira, { isoDate, rows, config }) {
  const results = [];
  for (const row of rows) {
    if (!row.enabled || !row.issueKey || !row.minutes) continue;
    const segments = row.segments?.length
      ? row.segments
      : [{ time: row.time || config.work.startTime || '09:00', minutes: row.minutes }];

    let scritti = 0;
    try {
      for (const segment of segments) {
        await jira.addWorklog(row.issueKey, {
          started: jiraStarted(isoDate, segment.time),
          timeSpentSeconds: Math.round(segment.minutes * 60),
          comment: config.work.sendComments === false ? undefined : (row.comment || undefined)
        });
        scritti += 1;
      }
      results.push({ issueKey: row.issueKey, minutes: row.minutes, parts: segments.length, ok: true });
    } catch (error) {
      const parziale = scritti > 0 ? t('msgPartialWrite', scritti, segments.length) : '';
      results.push({
        issueKey: row.issueKey, minutes: row.minutes, ok: false, written: scritti,
        error: `${error.message}${parziale}`
      });
    }
  }
  return results;
}

/** I messaggi dopo un invio. */
export function submitMessages(results) {
  const ok = results.filter((r) => r.ok);
  const out = [];
  if (ok.length) {
    const parti = ok.reduce((sum, r) => sum + (r.parts || 1), 0);
    const chiavi = ok.map((r) => r.issueKey).join(', ');
    const una = ok.length === 1;
    out.push({
      level: 'ok',
      text: parti > ok.length
        ? t(una ? 'msgSentSplitOne' : 'msgSentSplit', ok.length, parti, chiavi)
        : t(una ? 'msgSentOne' : 'msgSent', ok.length, chiavi)
    });
  }
  for (const r of results.filter((x) => !x.ok)) {
    out.push({ level: 'err', text: t('msgSendFailed', r.issueKey, r.error) });
  }
  return out;
}

/** Quello appena scritto vale come minimo finche' Jira non lo rilegge. */
export function notePending(state, results) {
  if (state.pending.isoDate !== state.isoDate) state.pending = { isoDate: state.isoDate, perIssue: {} };
  const attesa = state.pending.perIssue;
  for (const r of results.filter((x) => x.ok)) {
    const prima = attesa[r.issueKey]
      ?? state.rows.find((row) => row.issueKey === r.issueKey)?.existingMinutes
      ?? 0;
    attesa[r.issueKey] = prima + (r.minutes || 0);
  }
}

/**
 * Rilettura leggera: solo le ore gia' registrate, che sono l'unica cosa che
 * puo' cambiare sotto. Le righe spente dal controllo duplicati si riaccendono
 * se le ore spariscono; quelle girate a mano restano come le hai lasciate,
 * tranne le `forced` — appena scritte o ripulite, dove la scelta di prima non
 * vale piu'.
 */
export function applyLogged(state, logged, forced = []) {
  const forzate = new Set(forced);
  state.loggedEntries = logged.entries;
  const attesa = state.pending.isoDate === state.isoDate ? state.pending.perIssue : {};
  let ritardo = 0;
  for (const row of state.rows) {
    const letto = logged.byIssue[row.issueKey] || 0;
    const minimo = attesa[row.issueKey] || 0;
    if (minimo && letto >= minimo) delete attesa[row.issueKey];
    row.existingMinutes = Math.max(letto, minimo);
    if (row.existingMinutes > letto) ritardo += row.existingMinutes - letto;

    if (forzate.has(row.issueKey)) row.userToggled = false;
    if (row.userToggled) continue;
    if (row.existingMinutes && row.enabled) {
      row.enabled = false;
      row.autoDisabled = true;
    } else if (!row.existingMinutes && row.autoDisabled) {
      row.enabled = true;
      row.autoDisabled = false;
    }
  }
  state.alreadyLoggedMinutes = logged.total + ritardo;
  state.analyzedAt = Date.now();
  redistribute(state);
}

/** Il giorno spostato di `giorni`. */
export function shiftIsoDate(isoDate, giorni) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return toIsoDate(new Date(y, m - 1, d + giorni));
}
