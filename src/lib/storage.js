// Configurazione persistente dell'estensione.
//
// Sul disco sono due chiavi, non una: `config` sono le impostazioni, che sono
// poche e non crescono, e `meetingMemory` e' la cache del ticket scelto per le
// cerimonie, che cresce di una voce a settimana per riunione. In memoria
// restano un oggetto solo — `config.weeklyMeetingIssues` — perche' e' cosi' che
// il resto del codice le legge.
//
// Divise perche' vanno in due posti diversi. Le impostazioni finiscono anche in
// `storage.sync`, che le riporta indietro dopo una reinstallazione sullo stesso
// profilo; la cache no, e proprio perche' cresce: `storage.sync` ha un limite
// di 8 kB per voce, e un anno di cerimonie ci arriva da solo. La cache si rifa'
// da sola usando l'estensione, le impostazioni no.
//
// La sincronizzazione e' un ripiego comodo, non una garanzia: nessuno dei due
// browser promette di conservare la copia dopo una disinstallazione, e serve
// essere collegati a un account. Quello che regge sempre e' il file di
// esportazione — `exportData`/`importData` qui sotto, i pulsanti nelle opzioni.

const CHIAVE_CONFIG = 'config';
const CHIAVE_MEMORIA = 'meetingMemory';

// Quante settimane di cache tenere. Serve a ricordare il ticket delle
// cerimonie della settimana in corso, e a poter tornare indietro di qualche
// giorno: piu' in la' nel passato non si compilano ore.
const SETTIMANE_TENUTE = 8;

export const DEFAULT_CONFIG = {
  jira: {
    // Vuoto di proposito: si compila dalle opzioni, oppure viene dedotto dalla
    // scheda Atlassian aperta nel browser. Nessun sito e nessun progetto
    // cablati nel codice.
    baseUrl: '',
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
  ui: {
    // Il pannello laterale resta aperto mentre lavori su Jira, il popup si
    // chiude al primo click fuori: per un'estensione che si usa *mentre* si
    // guarda Jira il pannello e' l'impostazione giusta. Chi preferisce il
    // popup lo rimette da qui.
    sidePanel: true
  },
  // Nomi ed email con cui firmi i commit, se diversi dal tuo nome Jira.
  // Servono a riconoscere i tuoi commit fra quelli dei colleghi.
  identity: { extraAuthors: [] },
  work: {
    dailyHours: 8,
    roundingMinutes: 15,
    // Come si dividono le ore fra le task: in parti uguali, oppure in
    // proporzione a quanto risulta fatto su ognuna (commit e modifiche Jira).
    // Default alle parti uguali: e' quello che faceva prima, e non e' una
    // scelta peggiore — una task con un commit solo puo' esserti costata
    // l'intera mattina.
    split: 'equal',
    startTime: '09:00',
    // Ore mancanti sull'icona dell'estensione: si vedono senza aprire niente.
    showBadge: true,
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
  // Vive nella sua chiave sul disco, non dentro `config`.
  weeklyMeetingIssues: {},
  // Cache della tua identita' Jira, risolta al primo utilizzo.
  cache: { accountId: null, displayName: '', emailAddress: '' }
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, override) {
  if (!isPlainObject(override)) return override === undefined ? base : override;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = isPlainObject(base[key]) ? deepMerge(base[key], value) : value;
  }
  return out;
}

// Campi di versioni precedenti che non usiamo piu'. Vengono cancellati dal
// disco alla prima lettura: erano credenziali, non ha senso lasciarle li'.
const LEGACY_KEYS = [
  ['auth'],
  ['bitbucket'],
  ['jira', 'email'],
  ['jira', 'apiToken'],
  ['work', 'breakEnabled'],
  ['work', 'breakStart'],
  ['work', 'breakEnd']
];

/**
 * Le impostazioni senza l'identita' in cache.
 *
 * `cache` e' la tua identita' Jira risolta al primo utilizzo: si ricava di
 * nuovo da sola, e non e' una preferenza — e' un dato personale. Non esce da
 * questa macchina, in nessuna delle tre direzioni: non va nella copia
 * sincronizzata, non finisce nel file di esportazione, e se qualcuno la mette a
 * mano in un file non entra. Una regola sola, un posto solo.
 */
function senzaIdentita(impostazioni) {
  const { cache, ...resto } = impostazioni;
  return resto;
}

function pruneLegacy(config) {
  let pruned = false;
  for (const path of LEGACY_KEYS) {
    const parent = path.length === 1 ? config : config[path[0]];
    const key = path[path.length - 1];
    if (parent && Object.prototype.hasOwnProperty.call(parent, key)) {
      delete parent[key];
      pruned = true;
    }
  }
  return pruned;
}

// ------------------------------------------------------------ la copia sincronizzata

async function leggiSync() {
  try {
    const dati = await chrome.storage.sync.get(CHIAVE_CONFIG);
    return isPlainObject(dati?.[CHIAVE_CONFIG]) ? dati[CHIAVE_CONFIG] : null;
  } catch {
    // Sincronizzazione spenta, non disponibile, o nessun account collegato.
    return null;
  }
}

async function scriviSync(impostazioni) {
  const payload = senzaIdentita(impostazioni);
  try {
    const attuale = (await chrome.storage.sync.get(CHIAVE_CONFIG))[CHIAVE_CONFIG];
    // `storage.sync` conta le scritture, non le letture: riscrivere lo stesso
    // oggetto a ogni salvataggio consumerebbe quota per niente.
    if (JSON.stringify(attuale) === JSON.stringify(payload)) return;
    await chrome.storage.sync.set({ [CHIAVE_CONFIG]: payload });
  } catch {
    // Quota piena, account assente, sincronizzazione spenta: la copia locale
    // resta quella buona, e il file di esportazione e' la rete di sicurezza.
  }
}

// ------------------------------------------------------------ lettura e scrittura

async function scrivi(config) {
  const { weeklyMeetingIssues, ...impostazioni } = config;
  await chrome.storage.local.set({
    [CHIAVE_CONFIG]: impostazioni,
    [CHIAVE_MEMORIA]: weeklyMeetingIssues || {}
  });
  await scriviSync(impostazioni);
}

export async function loadConfig() {
  const stored = await chrome.storage.local.get([CHIAVE_CONFIG, CHIAVE_MEMORIA]);
  let salvato = stored[CHIAVE_CONFIG];
  let memoria = stored[CHIAVE_MEMORIA];
  let daRiscrivere = false;

  // Disco vuoto ma copia sincronizzata piena: e' una reinstallazione, o un
  // secondo computer. Le impostazioni tornano da li' invece che dai default.
  if (!salvato) {
    salvato = await leggiSync();
    daRiscrivere = Boolean(salvato);
  }

  const config = deepMerge(DEFAULT_CONFIG, salvato || {});

  // Fino a ieri la cache stava dentro `config`: chi aggiorna se la ritrova qui
  // e va spostata, o la scelta della settimana in corso si perde.
  if (!memoria && Object.keys(config.weeklyMeetingIssues || {}).length) {
    memoria = config.weeklyMeetingIssues;
    daRiscrivere = true;
  }
  config.weeklyMeetingIssues = isPlainObject(memoria) ? memoria : {};

  if (pruneLegacy(config)) daRiscrivere = true;
  if (daRiscrivere) await scrivi(config);
  return config;
}

export async function saveConfig(patch) {
  const current = await loadConfig();
  const next = deepMerge(current, patch);
  await scrivi(next);
  return next;
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

/** La cache delle cerimonie, nella sua chiave. Non va in sincronizzazione. */
export async function saveMeetingMemory(memoria) {
  const potata = pruneMemory(memoria);
  await chrome.storage.local.set({ [CHIAVE_MEMORIA]: potata });
  return potata;
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

/** Scrive quello che arriva da un file, al posto di quello che c'era. */
export async function replaceAll({ config, meetingMemory }) {
  const next = deepMerge(DEFAULT_CONFIG, config);
  next.weeklyMeetingIssues = pruneMemory(meetingMemory || {});
  await scrivi(next);
  return next;
}
