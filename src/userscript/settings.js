// Impostazioni dello userscript, nel localStorage del sito Jira.
//
// Stessa forma della configurazione dell'estensione — DEFAULT_CONFIG e il file
// di esportazione sono gli stessi — cosi' il file esportato dalle opzioni
// dell'estensione si importa qui cosi' com'e'.

import { DEFAULT_CONFIG, deepMerge, importData, pruneMemory } from '../lib/storage.js';

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

/** Importa il file esportato dall'estensione. Solleva ImportError se non e' nostro. */
export function importSettingsFile(text) {
  const { config, meetingMemory } = importData(JSON.parse(text));
  const next = deepMerge(DEFAULT_CONFIG, config);
  next.weeklyMeetingIssues = pruneMemory(meetingMemory || {});
  saveSettings(next);
  return next;
}
