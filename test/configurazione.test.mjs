// La configurazione: fusione con i default, e la potatura delle chiavi vecchie
// — che cancella dal disco token e workspace di versioni precedenti. Non era
// mai stata verificata, ed è il punto in cui si buttano via credenziali.

import assert from 'node:assert/strict';

// Finto chrome.storage, con un contatore delle scritture. `local` è il disco,
// `sync` è la copia che segue l'account: due archivi separati, come nel browser.
let disco = {};
let nuvola = {};
let scritture = 0;
let scrittureSync = 0;

const prendi = (archivio) => async (chiavi) => {
  const elenco = Array.isArray(chiavi) ? chiavi : [chiavi];
  return Object.fromEntries(elenco.filter((k) => k in archivio()).map((k) => [k, archivio()[k]]));
};

globalThis.chrome = {
  storage: {
    local: {
      get: prendi(() => disco),
      set: async (patch) => {
        scritture += 1;
        Object.assign(disco, patch);
      }
    },
    sync: {
      get: prendi(() => nuvola),
      set: async (patch) => {
        scrittureSync += 1;
        Object.assign(nuvola, patch);
      }
    }
  }
};

const {
  DEFAULT_CONFIG, loadConfig, saveConfig, saveMeetingMemory, pruneMemory, meetingMemoryKey
} = await import('../src/lib/storage.js');

function reset(config, memoria) {
  disco = {};
  if (config) disco.config = config;
  if (memoria) disco.meetingMemory = memoria;
  nuvola = {};
  scritture = 0;
  scrittureSync = 0;
}

// --- chiave di memoria settimanale ----------------------------------------
assert.equal(meetingMemoryKey('2026-W33', 'Standup'), '2026-W33|Standup');

// --- default sensati e agnostici -------------------------------------------
assert.equal(DEFAULT_CONFIG.jira.baseUrl, '', 'nessun sito cablato');
assert.deepEqual(DEFAULT_CONFIG.jira.projects, [], 'nessun progetto cablato');
assert.ok(DEFAULT_CONFIG.work.breaks.length, 'una pausa pranzo di partenza');

// --- prima esecuzione: si ottengono i default senza scrivere ----------------
reset(null);
let config = await loadConfig();
assert.equal(config.work.dailyHours, 8);
assert.equal(scritture, 0, 'leggere non deve scrivere');

// --- fusione: quello che salvi vince, il resto resta ------------------------
reset(null);
config = await saveConfig({ work: { dailyHours: 6 } });
assert.equal(config.work.dailyHours, 6, 'il valore salvato vince');
assert.equal(config.work.startTime, '09:00', 'gli altri campi della sezione restano');
assert.ok(config.meetings.length, 'e le altre sezioni pure');

// gli array si sostituiscono, non si fondono elemento per elemento
reset(null);
config = await saveConfig({ jira: { projects: ['ABC'] } });
assert.deepEqual(config.jira.projects, ['ABC']);
config = await saveConfig({ jira: { projects: [] } });
assert.deepEqual(config.jira.projects, [], 'svuotare un elenco deve essere possibile');

// --- potatura delle chiavi vecchie -----------------------------------------
reset({
  auth: { mode: 'token' },
  bitbucket: { workspace: 'esempio', apiToken: 'segreto' },
  jira: { baseUrl: 'https://x.atlassian.net', email: 'io@x.it', apiToken: 'ATATT-segreto', projects: ['ABC'] },
  work: { dailyHours: 7, breakEnabled: true, breakStart: '12:30', breakEnd: '13:30' }
});
config = await loadConfig();

assert.equal(config.auth, undefined, 'la vecchia sezione auth sparisce');
assert.equal(config.bitbucket, undefined, 'e anche Bitbucket');
assert.equal(config.jira.email, undefined, 'email rimossa');
assert.equal(config.jira.apiToken, undefined, 'token rimosso');
assert.equal(config.work.breakEnabled, undefined, 'vecchia pausa singola rimossa');
assert.equal(config.work.breakStart, undefined);
assert.equal(config.work.breakEnd, undefined);

assert.deepEqual(config.jira.projects, ['ABC'], 'quello che serve ancora resta');
assert.equal(config.jira.baseUrl, 'https://x.atlassian.net');
assert.equal(config.work.dailyHours, 7);

assert.equal(scritture, 1, 'la potatura viene salvata su disco, una volta sola');
assert.equal(disco.config.jira.apiToken, undefined, 'e il token non e piu nemmeno sul disco');

// una seconda lettura non trova piu niente da potare
scritture = 0;
await loadConfig();
assert.equal(scritture, 0, 'niente da potare, niente scritture');

// --- due chiavi sul disco, un oggetto solo in memoria ----------------------
// La cache delle cerimonie cresce di una voce a settimana per riunione: dentro
// `config` finirebbe anche in sincronizzazione, dove il limite è 8 kB a voce.
reset(null);
await saveConfig({ work: { dailyHours: 7 } });
assert.equal(disco.config.weeklyMeetingIssues, undefined,
  'la cache non deve stare dentro le impostazioni');
assert.deepEqual(disco.meetingMemory, {}, 'ha una chiave sua, anche da vuota');

await saveMeetingMemory({ '2026-W33|Standup': 'ABC-1' });
config = await loadConfig();
assert.deepEqual(config.weeklyMeetingIssues, { '2026-W33|Standup': 'ABC-1' },
  'chi legge la configurazione trova la cache al suo posto, come prima');
assert.equal(disco.config.weeklyMeetingIssues, undefined, 'ma sul disco resta separata');

// --- chi aggiorna se la ritrova dentro, e va spostata ---------------------
reset({ work: { dailyHours: 7 }, weeklyMeetingIssues: { '2026-W33|Standup': 'ABC-1' } });
config = await loadConfig();
assert.deepEqual(config.weeklyMeetingIssues, { '2026-W33|Standup': 'ABC-1' },
  'la scelta della settimana in corso non si perde nel passaggio');
assert.deepEqual(disco.meetingMemory, { '2026-W33|Standup': 'ABC-1' }, 'ora sta nella sua chiave');
assert.equal(disco.config.weeklyMeetingIssues, undefined, 'e non più in quella vecchia');
assert.equal(scritture, 1, 'lo spostamento si scrive una volta sola');

// --- la cache si pota: serve la settimana in corso, non marzo -------------
{
  const dieci = Object.fromEntries(
    Array.from({ length: 10 }, (_, i) => [`2026-W${String(i + 1).padStart(2, '0')}|Standup`, `ABC-${i}`])
  );
  const potata = pruneMemory(dieci, 8);
  assert.equal(Object.keys(potata).length, 8, 'restano le ultime otto settimane');
  assert.ok(potata['2026-W10|Standup'], 'la più recente resta');
  assert.equal(potata['2026-W01|Standup'], undefined, 'la più vecchia se ne va');
  // Sotto la soglia non si tocca niente: potare a ogni scrittura costerebbe
  // una copia dell'oggetto per niente.
  const poche = { '2026-W33|Standup': 'ABC-1' };
  assert.equal(pruneMemory(poche, 8), poche);
}

// --- la copia sincronizzata ----------------------------------------------
// Reinstallare cancella il disco. Se la copia dell'account c'è, le
// impostazioni tornano da lì invece che dai default.
reset(null);
await saveConfig({ work: { dailyHours: 6 } });
assert.equal(nuvola.config.work.dailyHours, 6, 'salvare aggiorna anche la copia');

disco = {}; // disinstallata e reinstallata: il disco è vuoto, la nuvola no
scritture = 0;
config = await loadConfig();
assert.equal(config.work.dailyHours, 6, 'le impostazioni tornano dalla copia');
assert.equal(scritture, 1, 'e vengono riscritte sul disco, per non doverle rileggere');

// La cache dell'identità non è una preferenza: è un dato personale che non ha
// motivo di stare sui server di nessuno, e si ricava di nuovo da sola.
reset(null);
await saveConfig({ cache: { accountId: 'acc-1', displayName: 'Nessuno' } });
assert.equal(disco.config.cache.accountId, 'acc-1', 'sul disco locale ci resta');
assert.equal(nuvola.config.cache, undefined, 'in sincronizzazione no');

// `storage.sync` conta le scritture, non le letture: risalvare le stesse
// impostazioni non deve consumare quota.
reset(null);
await saveConfig({ work: { dailyHours: 6 } });
const dopoPrima = scrittureSync;
await saveConfig({ work: { dailyHours: 6 } });
assert.equal(scrittureSync, dopoPrima, 'due salvataggi identici, una scrittura sola');

// E la cache delle cerimonie non ci va mai: è lei che sfonderebbe il limite.
reset(null);
await saveMeetingMemory({ '2026-W33|Standup': 'ABC-1' });
assert.equal(nuvola.config, undefined, 'la cache resta sul disco e basta');

// --- la sincronizzazione può non esserci ----------------------------------
// Spenta, senza account, o un browser che non la espone: deve degradare, non
// far fallire il salvataggio.
{
  const conSync = globalThis.chrome.storage.sync;
  delete globalThis.chrome.storage.sync;
  reset(null);
  config = await saveConfig({ work: { dailyHours: 5 } });
  assert.equal(config.work.dailyHours, 5, 'senza sincronizzazione si salva lo stesso');
  assert.equal(disco.config.work.dailyHours, 5);
  config = await loadConfig();
  assert.equal(config.work.dailyHours, 5, 'e si rilegge');
  globalThis.chrome.storage.sync = conSync;
}

console.log('configurazione: tutti i controlli passati.');
