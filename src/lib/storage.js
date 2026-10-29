// La configurazione: i default, come si fondono, la memoria delle riunioni e
// il file di esportazione. Niente qui sa dove la configurazione viene salvata:
// lo decide lo userscript (settings.js), nel localStorage del sito Jira.
//
// La memoria delle riunioni — il ticket scelto per le cerimonie, una voce a
// settimana per riunione — sta dentro `config.weeklyMeetingIssues`, ma nel file
// di esportazione viaggia a parte (`meetingMemory`), come faceva l'estensione:
// cosi' i file esportati da li' si importano ancora.

// Quante settimane di cache tenere. Serve a ricordare il ticket delle
// cerimonie della settimana in corso, e a poter tornare indietro di qualche
// giorno: piu' in la' nel passato non si compilano ore.
const SETTIMANE_TENUTE = 8;

export const DEFAULT_CONFIG = {
  jira: {
    // Vuoto di proposito: nessun progetto cablato nel codice. Il sito non c'e':
    // e' quello della pagina su cui gira lo userscript.
    projects: [],
    scanComments: true,
    // Oltre alle issue toccate oggi, quante altre issue tue controllare per
    // trovare commit su ticket che oggi non hai aperto in Jira.
    devCandidates: 25,
    // I merge contano come lavoro? Acceso e' quello che faceva prima. Spento,
    // spariscono da tutte e tre le cose che i commit alimentano: il conto sulla
    // riga, la nota precompilata e il peso nella divisione a proporzione.
    countMerges: true
  },
  // Nomi ed email con cui firmi i commit, se diversi dal tuo nome Jira.
  // Servono a riconoscere i tuoi commit fra quelli dei colleghi.
  identity: { extraAuthors: [] },
  work: {
    dailyHours: 8,
    roundingMinutes: 15,
    // Come si dividono le ore fra le task: in parti uguali, in proporzione a
    // quanto risulta fatto su ognuna (commit e modifiche Jira), o in
    // proporzione alla stima originale ('equal' | 'activity' | 'estimate').
    // Default alle parti uguali: e' quello che faceva prima, e non e' una
    // scelta peggiore — una task con un commit solo puo' esserti costata
    // l'intera mattina.
    split: 'equal',
    startTime: '09:00',
    // La nota del worklog. Chi la vuole non trova niente di diverso; chi tiene
    // i worklog nudi la spegne e non deve piu' svuotare i campi a mano.
    sendComments: true,
    // Le pause non consumano monte ore: sono buchi nella linea del tempo. Un
    // blocco di lavoro che ci finisce sopra viene spezzato in piu' worklog.
    breaks: [
      { id: 'pranzo', label: 'Pausa pranzo', start: '13:00', end: '14:00' }
    ]
  },
  // days: 1 = lunedi ... 7 = domenica
  meetings: [
    { id: 'giornaliero', label: 'Giornaliero', days: [1], time: '09:30', minutes: 30 },
    { id: 'standup-lun', label: 'Standup di progetto', days: [1], time: '10:00', minutes: 30 },
    { id: 'standup', label: 'Standup di progetto', days: [2, 3, 4, 5], time: '09:30', minutes: 30 }
  ],
  // Cache "issue delle cerimonie" scelta a mano: { "2026-W33|Standup": "ABC-123" }
  weeklyMeetingIssues: {},
  // La tua identita' Jira: si chiede a Jira a ogni apertura e non si salva.
  cache: { accountId: null, displayName: '', emailAddress: '' }
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function deepMerge(base, override) {
  if (!isPlainObject(override)) return override === undefined ? base : override;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = isPlainObject(base[key]) ? deepMerge(base[key], value) : value;
  }
  return out;
}

/**
 * Le impostazioni senza l'identita' in cache.
 *
 * `cache` e' la tua identita' Jira risolta al primo utilizzo: si ricava di
 * nuovo da sola, e non e' una preferenza — e' un dato personale. Non finisce
 * nel file di esportazione, e se qualcuno la mette a mano in un file non
 * entra. Una regola sola, un posto solo.
 */
function senzaIdentita(impostazioni) {
  const { cache, ...resto } = impostazioni;
  return resto;
}

/**
 * Tiene le ultime settimane e butta il resto: la cache serve alla settimana in
 * corso e a un paio indietro, non a ricordare marzo.
 */
export function pruneMemory(memoria, tenute = SETTIMANE_TENUTE) {
  const settimane = [...new Set(Object.keys(memoria).map((k) => k.split('|')[0]))].sort();
  if (settimane.length <= tenute) return memoria;
  const vive = new Set(settimane.slice(-tenute));
  return Object.fromEntries(
    Object.entries(memoria).filter(([k]) => vive.has(k.split('|')[0]))
  );
}

/** Chiave di memoria settimanale per la issue di una riunione ricorrente. */
export function meetingMemoryKey(isoWeek, label) {
  return `${isoWeek}|${label}`;
}

// ------------------------------------------------------------ il file di esportazione

// Il formato del file. `app` serve a riconoscere il file come nostro — un
// JSON qualunque, importato, svuoterebbe la configurazione senza dire niente —
// e `version` a poter cambiare forma piu' avanti sapendo cosa si sta leggendo.
export const FILE_APP = 'clockwork-autofill';
export const FILE_VERSION = 1;

export class ImportError extends Error {
  constructor(code) {
    super(`Import refused: ${code}`);
    this.name = 'ImportError';
    this.code = code;
  }
}

/** La configurazione come finisce nel file. L'identita' resta fuori. */
export function exportData(config) {
  const { weeklyMeetingIssues, ...impostazioni } = config;
  return {
    app: FILE_APP,
    version: FILE_VERSION,
    config: senzaIdentita(impostazioni),
    meetingMemory: weeklyMeetingIssues || {}
  };
}

/**
 * Il contrario, con i controlli. Non restituisce mai un mezzo risultato: o il
 * file e' nostro e leggibile, o solleva — importare a meta' lascerebbe una
 * configurazione che non e' ne' quella vecchia ne' quella del file.
 *
 * @returns {{config: object, meetingMemory: object}}
 */
export function importData(dati) {
  if (!isPlainObject(dati) || dati.app !== FILE_APP) throw new ImportError('NOT_OURS');
  if (Number(dati.version) > FILE_VERSION) throw new ImportError('TOO_NEW');
  if (!isPlainObject(dati.config)) throw new ImportError('BROKEN');

  const { weeklyMeetingIssues, ...impostazioni } = dati.config;
  return {
    config: senzaIdentita(impostazioni),
    meetingMemory: isPlainObject(dati.meetingMemory) ? dati.meetingMemory : {}
  };
}
