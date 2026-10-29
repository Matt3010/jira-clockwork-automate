// Impostazioni dello userscript, nel localStorage del sito Jira.
//
// Stessa forma della configurazione dell'estensione — DEFAULT_CONFIG e il file
// di esportazione sono gli stessi — cosi' il file esportato dalle opzioni
// dell'estensione si importa qui cosi' com'e'.

import { DEFAULT_CONFIG, deepMerge, exportData, importData, pruneMemory } from '../lib/storage.js';
import { timeToMinutes, todayIso } from '../lib/dates.js';

const KEY = 'clockwork-autofill:config';

function storage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

export function loadSettings() {
  let stored = {};
  try {
    stored = JSON.parse(storage()?.getItem(KEY) || '{}') || {};
  } catch {
    stored = {};
  }
  return deepMerge(DEFAULT_CONFIG, stored);
}

export function saveSettings(config) {
  // L'identita' non si salva: si chiede a Jira a ogni apertura, come la sessione.
  const { cache, ...resto } = config;
  storage()?.setItem(KEY, JSON.stringify(resto));
}

/** Il file di esportazione, uguale a quello dell'estensione: nome e contenuto. */
export function exportSettingsFile(config) {
  return {
    name: `clockwork-autofill-${todayIso()}.json`,
    text: `${JSON.stringify(exportData(config), null, 2)}\n`
  };
}

const lista = (testo) => String(testo || '').split(',').map((p) => p.trim()).filter(Boolean);
const durata = (da, a) => (da && a ? timeToMinutes(a) - timeToMinutes(da) : 0);

/**
 * Dal modulo alla configurazione, con gli stessi controlli delle opzioni
 * dell'estensione. Non salva: chi chiama decide, e con `invalid` non vuoto
 * non deve farlo — una pausa o una riunione con la fine prima dell'inizio
 * salvata cosi' diventerebbe una durata finta.
 *
 * Le riunioni si scrivono come da/a, come stanno sul calendario, e diventano
 * orario + durata, che e' quello che vogliono planner e Jira. Una riunione
 * senza giorni non e' un errore: e' una riunione sospesa, e si scarta.
 *
 * @returns {{config: object, invalid: string[]}}
 */
export function applySettingsForm(config, form) {
  const invalid = [];

  const breaks = [];
  for (const pausa of form.breaks || []) {
    const label = String(pausa.label || '').trim() || 'Pausa';
    if (durata(pausa.start, pausa.end) <= 0) {
      invalid.push(label);
      continue;
    }
    breaks.push({ id: pausa.id, label, start: pausa.start, end: pausa.end });
  }

  const meetings = [];
  for (const riunione of form.meetings || []) {
    const label = String(riunione.label || '').trim() || 'Riunione';
    const days = (riunione.days || []).map(Number).filter((d) => d >= 1 && d <= 7);
    if (!days.length) continue;
    const minutes = durata(riunione.start, riunione.end);
    if (minutes <= 0) {
      invalid.push(label);
      continue;
    }
    meetings.push({ id: riunione.id, label, days, time: riunione.start, minutes });
  }

  const split = ['activity', 'estimate'].includes(form.split) ? form.split : 'equal';
  const next = deepMerge(config, {
    jira: {
      projects: lista(form.projects).map((p) => p.toUpperCase()),
      scanComments: Boolean(form.scanComments),
      devCandidates: Math.max(0, Number(form.devCandidates) || 0),
      countMerges: Boolean(form.countMerges)
    },
    identity: { extraAuthors: lista(form.authors) },
    work: {
      dailyHours: Math.max(0.5, Number(form.dailyHours) || 8),
      roundingMinutes: Math.max(1, Number(form.roundingMinutes) || 15),
      startTime: form.startTime || '09:00',
      split,
      sendComments: Boolean(form.sendComments),
      breaks
    },
    meetings
  });
  return { config: next, invalid };
}

/** Importa il file esportato dall'estensione. Solleva ImportError se non e' nostro. */
export function importSettingsFile(text) {
  const { config, meetingMemory } = importData(JSON.parse(text));
  const next = deepMerge(DEFAULT_CONFIG, config);
  next.weeklyMeetingIssues = pruneMemory(meetingMemory || {});
  saveSettings(next);
  return next;
}
