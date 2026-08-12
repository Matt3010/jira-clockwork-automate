// Il file di configurazione: l'unica copia che sopravvive a una
// disinstallazione.
//
// La sincronizzazione è comoda ma non è una promessa — nessuno dei due browser
// garantisce di conservare la copia dell'account dopo che l'estensione è stata
// tolta. Il file sì, ed è per questo che qui si controlla soprattutto il caso
// storto: un JSON qualunque importato per sbaglio non deve svuotare la
// configurazione senza dire niente.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let disco = {};
let nuvola = {};
const prendi = (archivio) => async (chiavi) => {
  const elenco = Array.isArray(chiavi) ? chiavi : [chiavi];
  return Object.fromEntries(elenco.filter((k) => k in archivio()).map((k) => [k, archivio()[k]]));
};
globalThis.chrome = {
  storage: {
    local: { get: prendi(() => disco), set: async (patch) => Object.assign(disco, patch) },
    sync: { get: prendi(() => nuvola), set: async (patch) => Object.assign(nuvola, patch) }
  }
};

const {
  DEFAULT_CONFIG, loadConfig, saveConfig, saveMeetingMemory,
  exportData, importData, replaceAll, FILE_APP, FILE_VERSION
} = await import('../src/lib/storage.js');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const leggi = (rel) => readFileSync(join(root, rel), 'utf8');

// --- cosa finisce nel file ------------------------------------------------
disco = {};
nuvola = {};
await saveConfig({ jira: { projects: ['ABC'] }, cache: { accountId: 'acc-1', displayName: 'Nessuno' } });
await saveMeetingMemory({ '2026-W33|Standup': 'ABC-1' });
const file = exportData(await loadConfig());

assert.equal(file.app, FILE_APP, 'il file si dichiara nostro, o non si riconosce all import');
assert.equal(file.version, FILE_VERSION);
assert.deepEqual(file.config.jira.projects, ['ABC'], 'le impostazioni ci sono');
assert.deepEqual(file.meetingMemory, { '2026-W33|Standup': 'ABC-1' }, 'e la cache delle cerimonie');
// Un file di configurazione si passa a un collega, si mette in un repository,
// si allega a un messaggio: l'identità Jira lì dentro non ci deve stare.
assert.equal(file.config.cache, undefined, 'la cache dell identità resta fuori dal file');
assert.equal(file.config.weeklyMeetingIssues, undefined, 'la cache sta nel suo campo, non dentro le impostazioni');
assert.doesNotThrow(() => JSON.parse(JSON.stringify(file)), 'il file dev essere JSON, senza sorprese');

// --- e cosa ne torna indietro ---------------------------------------------
{
  const { config, meetingMemory } = importData(JSON.parse(JSON.stringify(file)));
  assert.deepEqual(config.jira.projects, ['ABC'], 'il giro completo non perde niente');
  assert.deepEqual(meetingMemory, { '2026-W33|Standup': 'ABC-1' });
}

// --- i file che vanno rifiutati -------------------------------------------
// Rifiutati con un motivo, e prima di toccare il disco: importare a metà
// lascerebbe una configurazione che non è né quella vecchia né quella del file.
const rifiuti = [
  [null, 'NOT_OURS'],
  ['{}', 'NOT_OURS'],
  [{ app: 'altro', version: 1, config: {} }, 'NOT_OURS'],
  [{ version: 1, config: {} }, 'NOT_OURS'],
  [{ app: FILE_APP, version: FILE_VERSION + 1, config: {} }, 'TOO_NEW'],
  [{ app: FILE_APP, version: FILE_VERSION }, 'BROKEN'],
  [{ app: FILE_APP, version: FILE_VERSION, config: 'niente' }, 'BROKEN']
];
for (const [dati, codice] of rifiuti) {
  assert.throws(() => importData(dati), (errore) => errore.code === codice,
    `${JSON.stringify(dati)} doveva essere rifiutato con ${codice}`);
}

// Una versione più vecchia invece si legge: i file di ieri devono restare
// buoni, o esportare non serve a niente.
assert.doesNotThrow(() => importData({ app: FILE_APP, version: FILE_VERSION - 1, config: { work: { dailyHours: 6 } } }));

// Anche l'identità che qualcuno avesse aggiunto a mano nel file viene ignorata:
// si importa una configurazione, non una sessione.
{
  const { config } = importData({
    app: FILE_APP, version: FILE_VERSION,
    config: { work: { dailyHours: 6 }, cache: { accountId: 'acc-altrui' } }
  });
  assert.equal(config.cache, undefined, 'l identità nel file non deve entrare');
}

// --- importare sostituisce, non fonde -------------------------------------
// Fondere lascerebbe in giro le riunioni di prima insieme a quelle del file, e
// nessuno saprebbe più da dove vengono.
disco = {};
nuvola = {};
await saveConfig({ meetings: [{ id: 'vecchia', label: 'Vecchia', days: [1], time: '09:00', minutes: 30 }] });
const dopo = await replaceAll(importData({
  app: FILE_APP,
  version: FILE_VERSION,
  config: { meetings: [{ id: 'nuova', label: 'Nuova', days: [2], time: '10:00', minutes: 15 }] },
  meetingMemory: { '2026-W33|Standup': 'ABC-1' }
}));
assert.deepEqual(dopo.meetings.map((m) => m.id), ['nuova'], 'le riunioni di prima se ne vanno');
assert.equal(dopo.work.dailyHours, DEFAULT_CONFIG.work.dailyHours,
  'quello che il file non dice torna al default, non al valore di prima');
assert.deepEqual(disco.meetingMemory, { '2026-W33|Standup': 'ABC-1' }, 'la cache finisce nella sua chiave');
assert.equal(disco.config.weeklyMeetingIssues, undefined);
assert.ok(nuvola.config, 'e la copia dell account si aggiorna con quella importata');

// Un file senza cache è legittimo: è una cache, si rifà da sola.
disco = {};
nuvola = {};
const senzaCache = await replaceAll(importData({ app: FILE_APP, version: FILE_VERSION, config: { work: { dailyHours: 6 } } }));
assert.deepEqual(senzaCache.weeklyMeetingIssues, {}, 'senza cache non si rompe niente');

// --- i pulsanti e i loro messaggi -----------------------------------------
{
  const html = leggi('src/options.html');
  const js = leggi('src/options.js');

  for (const id of ['export-config', 'import-config', 'import-file', 'backup-result']) {
    assert.ok(html.includes(`id="${id}"`), `manca #${id} nelle opzioni`);
  }
  assert.match(html, /type="file"[^>]*id="import-file"/, 'importare passa da un campo file');

  // Ogni motivo di rifiuto deve avere la sua frase: senza, l'errore uscirebbe
  // come il messaggio diagnostico inglese, o come niente.
  const codici = [...new Set([...leggi('src/lib/storage.js').matchAll(/ImportError\('(\w+)'\)/g)].map((m) => m[1]))];
  assert.ok(codici.length >= 3, 'la scansione ha trovato i codici di rifiuto');
  for (const codice of codici) {
    assert.match(js, new RegExp(`${codice}: '(\\w+)'`), `il codice ${codice} non ha una frase nelle opzioni`);
  }
  // E il file illeggibile — che non ha codice, perché è JSON.parse a saltare.
  assert.match(js, /msgImportUnreadable/, 'un file che non è JSON deve dire cosa non va');

  // Reimportare lo stesso file deve poter funzionare: senza azzerare il campo,
  // il secondo tentativo non solleverebbe nessun evento.
  assert.match(js, /\.value = ''/, 'il campo file va azzerato dopo la lettura');

  // Dopo un import la pagina mostra la configurazione nuova, e il fondo la
  // applica: badge e pannello dipendono da quello che è appena cambiato. È lo
  // stesso seguito del salvataggio, e sta scritto una volta sola — due copie
  // divergerebbero alla prima cosa nuova da rinfrescare.
  const blocco = js.slice(js.indexOf("$('import-file')"));
  for (const atteso of ['fill()', 'applicaSubito()']) {
    assert.ok(blocco.includes(atteso), `dopo l import manca ${atteso}`);
  }
  const seguito = js.slice(js.indexOf('function applicaSubito'));
  for (const comando of ['refreshBadge', 'refreshUiMode']) {
    assert.match(seguito.slice(0, seguito.indexOf('\n}')), new RegExp(`send\\('${comando}'\\)`),
      `applicaSubito non rinfresca ${comando}`);
  }
  assert.equal(js.split("send('refreshUiMode')").length - 1, 1,
    'il seguito della configurazione cambiata va scritto in un posto solo');
}

console.log('esportazione: tutti i controlli passati.');
