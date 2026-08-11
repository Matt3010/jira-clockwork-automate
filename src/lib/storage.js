// Configurazione persistente dell'estensione (chrome.storage.local).

export const DEFAULT_CONFIG = {
  jira: {
    // Vuoto di proposito: si compila dalle opzioni, oppure viene dedotto dalla
    // scheda Atlassian aperta nel browser. Nessun sito e nessun progetto
    // cablati nel codice.
    baseUrl: '',
    projects: [],
    scanComments: true,
    // Legge i commit dal pannello "Sviluppo" delle issue: nessuna scheda
    // Bitbucket da tenere aperta.
    devPanel: true,
    // Oltre alle issue toccate oggi, quante altre issue tue controllare per
    // trovare commit su ticket che oggi non hai aperto in Jira.
    devCandidates: 25
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
    startTime: '09:00',
    // Ore mancanti sull'icona dell'estensione: si vedono senza aprire niente.
    showBadge: true,
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

export async function loadConfig() {
  const stored = await chrome.storage.local.get('config');
  const config = deepMerge(DEFAULT_CONFIG, stored.config || {});
  if (pruneLegacy(config)) {
    await chrome.storage.local.set({ config });
  }
  return config;
}

export async function saveConfig(patch) {
  const current = await loadConfig();
  const next = deepMerge(current, patch);
  await chrome.storage.local.set({ config: next });
  return next;
}

/** Chiave di memoria settimanale per la issue di una riunione ricorrente. */
export function meetingMemoryKey(isoWeek, label) {
  return `${isoWeek}|${label}`;
}
