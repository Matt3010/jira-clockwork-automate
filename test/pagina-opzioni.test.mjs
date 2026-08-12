// Le opzioni, eseguite davvero.
//
// È la pagina in cui si decide cosa finirà su Jira: il sito, i progetti, il
// monte ore, le riunioni. Un campo che non si rilegge, un salvataggio che
// scrive metà configurazione, un file importato che non arriva a schermo —
// sono difetti che si scoprono il giorno dopo, guardando ore sbagliate.
//
// Qui la pagina gira per intero: archivio finto, click veri, e si controlla
// quello che resta scritto sul disco.

import assert from 'node:assert/strict';
import { apriPagina, testo, tutti } from './pagina.mjs';
import { DEFAULT_CONFIG, exportData } from '../src/lib/storage.js';

const salvata = {
  ...DEFAULT_CONFIG,
  jira: { ...DEFAULT_CONFIG.jira, baseUrl: 'https://esempio.atlassian.net', projects: ['ABC', 'XYZ'] },
  work: { ...DEFAULT_CONFIG.work, dailyHours: 7, startTime: '08:30' },
  identity: { extraAuthors: ['Nessuno <nessuno@esempio.test>'] },
  meetings: [{ id: 'giornaliero', label: 'Giornaliero', days: [1, 2], time: '09:30', minutes: 30 }]
};

const disco = () => ({ config: JSON.parse(JSON.stringify(salvata)) });
const clic = (nodo) => nodo.click();
const scrivi = (nodo, valore) => { nodo.value = valore; };

// --- quello che c'è sul disco arriva nei campi ---------------------------
{
  const p = await apriPagina('options', { disco: disco() });
  await p.attendi();

  const $ = (id) => p.document.getElementById(id);
  // Il campo del sito porta solo il prefisso: incollare l'URL intero deve
  // funzionare, ma quello che si rilegge è la parte che conta.
  assert.equal($('jira-url').value, 'esempio');
  assert.equal($('jira-projects').value, 'ABC, XYZ');
  assert.equal($('work-hours').value, '7');
  assert.equal($('work-start').value, '08:30');
  assert.equal($('authors').value, 'Nessuno <nessuno@esempio.test>');
  assert.equal($('side-panel').checked, true, 'il pannello è il valore di partenza');

  const riunioni = tutti(p.document, '#meetings .meeting');
  assert.equal(riunioni.length, 1, 'una riunione salvata, una riga a schermo');
  assert.equal(riunioni[0].querySelector('.m-label').value, 'Giornaliero');
  assert.equal(riunioni[0].querySelector('.m-time').value, '09:30');
  // Dentro si tiene la durata, ma si mostra la fine: è come la riunione sta
  // scritta sul calendario di chi la legge.
  assert.equal(riunioni[0].querySelector('.m-end').value, '10:00');
  assert.deepEqual(
    tutti(riunioni[0], '.m-day').filter((i) => i.checked).map((i) => i.value),
    ['1', '2']
  );
  p.chiudi();
}

// --- salvare scrive sul disco e lo applica subito ------------------------
{
  const p = await apriPagina('options', { disco: disco() });
  await p.attendi();

  const $ = (id) => p.document.getElementById(id);
  scrivi($('work-hours'), '6');
  scrivi($('jira-projects'), 'def, abc');
  scrivi($('jira-url'), 'https://altro.atlassian.net/jira/software');
  clic($('save'));
  await p.attendi();

  const scritta = p.archivio.local.config;
  assert.equal(scritta.work.dailyHours, 6);
  assert.deepEqual(scritta.jira.projects, ['DEF', 'ABC'], 'i progetti si normalizzano in maiuscolo');
  assert.equal(scritta.jira.baseUrl, 'https://altro.atlassian.net',
    'dell URL incollato resta il sito, senza percorso');
  assert.equal($('jira-url').value, 'altro', 'e il campo mostra subito quello che è stato salvato');
  assert.equal(testo($('save-result')), 'Saved.');

  // Badge e pannello dipendono da quello che è appena cambiato: rifarli al
  // prossimo avvio del browser vorrebbe dire mostrare il vecchio fino ad allora.
  const comandi = p.chiamate.map((c) => c.type);
  assert.ok(comandi.includes('refreshBadge'), 'il badge va rifatto');
  assert.ok(comandi.includes('refreshUiMode'), 'e la scelta pannello/popup applicata');
  p.chiudi();
}

// --- una riunione con la fine prima dell'inizio blocca tutto -------------
// Salvare una durata negativa non darebbe errore: darebbe una riunione che si
// mangia ore invece di occuparle. Meglio fermarsi e dirlo.
{
  const p = await apriPagina('options', { disco: disco() });
  await p.attendi();

  const $ = (id) => p.document.getElementById(id);
  scrivi($('work-hours'), '5');
  scrivi(p.document.querySelector('#meetings .m-end'), '09:00'); // prima dell'inizio
  clic($('save'));
  await p.attendi();

  assert.match(testo($('save-result')), /not saved/i, 'lo dice');
  assert.match(testo($('save-result')), /Giornaliero/, 'e dice quale');
  assert.equal(p.archivio.local.config.work.dailyHours, 7,
    'e non scrive niente: nemmeno le parti che andavano bene');
  p.chiudi();
}

// --- il file di configurazione: fuori e dentro ---------------------------
{
  const p = await apriPagina('options', { disco: disco() });
  await p.attendi();

  // Uscita: si intercetta il Blob che finirebbe nel file scaricato.
  let scaricato = null;
  p.dom.window.URL.createObjectURL = (blob) => { scaricato = blob; return 'blob:finto'; };
  p.dom.window.URL.revokeObjectURL = () => {};
  clic(p.document.getElementById('export-config'));
  await p.attendi();

  assert.ok(scaricato, 'il pulsante deve produrre un file, non solo un messaggio');
  const dentro = JSON.parse(await scaricato.text());
  assert.equal(dentro.app, 'clockwork-autofill', 'il file si dichiara nostro');
  assert.deepEqual(dentro.config.jira.projects, ['ABC', 'XYZ'], 'con dentro la configurazione vera');
  assert.equal(dentro.config.cache, undefined, 'e senza l identità Jira');
  assert.equal(testo(p.document.getElementById('backup-result')), 'Written to file.');
  p.chiudi();
}

{
  const p = await apriPagina('options', { disco: disco() });
  await p.attendi();

  // Entrata: un file con una configurazione diversa da quella a schermo.
  const altra = {
    ...DEFAULT_CONFIG,
    jira: { ...DEFAULT_CONFIG.jira, baseUrl: 'https://iltuosito.atlassian.net', projects: ['DEF'] },
    work: { ...DEFAULT_CONFIG.work, dailyHours: 4 },
    meetings: []
  };
  const file = new p.dom.window.File(
    [JSON.stringify(exportData(altra))],
    'clockwork-autofill-2026-08-12.json',
    { type: 'application/json' }
  );
  const campo = p.document.getElementById('import-file');
  Object.defineProperty(campo, 'files', { configurable: true, value: [file] });
  campo.dispatchEvent(new p.dom.window.Event('change', { bubbles: true }));
  await p.attendi(4);

  assert.equal(testo(p.document.getElementById('backup-result')), 'Configuration imported.');
  assert.equal(p.document.getElementById('work-hours').value, '4',
    'la pagina mostra la configurazione importata, non quella di prima');
  assert.equal(p.document.getElementById('jira-url').value, 'iltuosito');
  assert.equal(tutti(p.document, '#meetings .meeting').length, 0,
    'importare sostituisce: le riunioni di prima non restano in giro');
  assert.equal(p.archivio.local.config.work.dailyHours, 4, 'ed è finita sul disco');
  assert.ok(p.chiamate.map((c) => c.type).includes('refreshUiMode'),
    'anche una configurazione arrivata da un file va applicata subito');
  p.chiudi();
}

// --- un file che non è nostro viene rifiutato, con il motivo -------------
{
  const p = await apriPagina('options', { disco: disco() });
  await p.attendi();

  const file = new p.dom.window.File(['{"qualcosa": 1}'], 'altro.json', { type: 'application/json' });
  const campo = p.document.getElementById('import-file');
  Object.defineProperty(campo, 'files', { configurable: true, value: [file] });
  campo.dispatchEvent(new p.dom.window.Event('change', { bubbles: true }));
  await p.attendi(4);

  assert.match(testo(p.document.getElementById('backup-result')), /not a Clockwork Autofill configuration/);
  assert.equal(p.archivio.local.config.work.dailyHours, 7, 'e la configurazione resta quella di prima');
  p.chiudi();
}

console.log('opzioni vive: tutti i controlli passati.');
