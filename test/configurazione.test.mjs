// La configurazione: fusione con i default, e la potatura delle chiavi vecchie
// — che cancella dal disco token e workspace di versioni precedenti. Non era
// mai stata verificata, ed è il punto in cui si buttano via credenziali.

import assert from 'node:assert/strict';

// Finto chrome.storage.local, con un contatore delle scritture.
let disco = {};
let scritture = 0;
globalThis.chrome = {
  storage: {
    local: {
      get: async (key) => (key in disco ? { [key]: disco[key] } : {}),
      set: async (patch) => {
        scritture += 1;
        Object.assign(disco, patch);
      }
    }
  }
};

const { DEFAULT_CONFIG, loadConfig, saveConfig, meetingMemoryKey } = await import('../src/lib/storage.js');

function reset(config) {
  disco = config ? { config } : {};
  scritture = 0;
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

console.log('configurazione: tutti i controlli passati.');
