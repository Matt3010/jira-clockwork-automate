// La scheda Attività, eseguita davvero.
//
// Era l'ultimo pezzo di interfaccia che nessuna suite disegnava: il registro
// veniva verificato solo sulle funzioni pure — `describeEvent`, `logLine` — e
// quindi nessuno vedeva quello che si rompe montandolo. Qui conta soprattutto
// una cosa: il registro finisce incollato nel daily, dove chi legge dà per
// scontato che parli di te. Una modifica di un collega senza il suo nome
// diventa lavoro tuo per distrazione, a schermo e nel testo copiato.

import assert from 'node:assert/strict';
// Il finto browser sgancia i timer che installa sul globale (o l'ultimo avviso
// terrebbe aperto node per cinque secondi): per aspettare sul serio serve un
// timer che non passi di lì.
import { setTimeout as respira } from 'node:timers/promises';
import { apriPagina, testo, tutti } from './pagina.mjs';
import { DEFAULT_CONFIG } from '../src/lib/storage.js';

const HOST = 'esempio.atlassian.net';
const config = {
  ...DEFAULT_CONFIG,
  jira: { ...DEFAULT_CONFIG.jira, projects: ['ABC'], baseUrl: `https://${HOST}` }
};

const alle = (h, m = 0) => new Date(2026, 7, 10, h, m).getTime();

const EVENTI = [
  { at: alle(9, 15), key: 'ABC-1', tipo: 'created', summary: 'Titolo uno' },
  { at: alle(11, 0), key: 'ABC-1', tipo: 'status', from: 'Da fare', to: 'In corso', summary: 'Titolo uno' },
  // Questa non è tua: l'ha mossa un collega su una issue che ti riguarda.
  { at: alle(12, 30), key: 'ABC-2', tipo: 'status', from: 'In corso', to: 'In revisione', by: 'Dario Decarlo', summary: 'Titolo due' },
  { at: alle(15, 45), key: 'ABC-2', tipo: 'commit', subject: 'fix: qualcosa', summary: 'Titolo due' }
];

const RISPOSTE = {
  siteStatus: { host: HOST, configured: true, tabsOnSite: 1, openHosts: [HOST] },
  analyze: { rows: [], warnings: [], notes: [], config, site: { host: HOST } },
  refreshLogged: { loggedEntries: [], alreadyLoggedMinutes: 0, loggedByIssue: {} },
  activity: { isoDate: '2026-08-10', events: EVENTI }
};

const apriRegistro = async (risposte = RISPOSTE) => {
  const p = await apriPagina('popup', { risposte });
  await p.attendi();
  p.document.getElementById('tab-log').click();
  await p.attendi(1);
  return p;
};

// --- il registro arriva a schermo ----------------------------------------
{
  const p = await apriRegistro();

  const voci = tutti(p.document, '#log li');
  assert.equal(voci.length, 4, 'quattro eventi, quattro righe');
  assert.deepEqual(voci.map((li) => testo(li.querySelector('.quando'))),
    ['09:15', '11:00', '12:30', '15:45'], 'ognuna con la sua ora');
  assert.deepEqual(voci.map((li) => testo(li.querySelector('.chiave'))),
    ['ABC-1', 'ABC-1', 'ABC-2', 'ABC-2']);

  // La direzione per intero: «passata a In corso» da sola lasciava indovinare
  // quale dei due stati fosse il punto di partenza.
  assert.equal(testo(voci[1].querySelector('.cosa')), 'moved to In corso · from Da fare');
  assert.equal(testo(voci[3].querySelector('.cosa')), 'commit · fix: qualcosa');

  assert.equal(testo(p.document.querySelector('#log-count')), '4 events');
  assert.equal(p.document.querySelector('#log-copy').hidden, false, 'con qualcosa dentro si può copiare');
  assert.equal(p.document.querySelector('#log-empty').hidden, true);
  p.chiudi();
}

// --- IL PUNTO: la modifica di un collega porta il suo nome ----------------
{
  const p = await apriRegistro();
  const voci = tutti(p.document, '#log li');

  const altrui = voci[2].querySelector('.cosa .da-altri');
  assert.ok(altrui, 'la modifica di un collega deve portare il suo nome');
  assert.equal(testo(altrui), 'by Dario Decarlo');

  // E le tue no: sono già tue, e un nome su ognuna sarebbe rumore.
  for (const indice of [0, 1, 3]) {
    assert.equal(voci[indice].querySelector('.cosa .da-altri'), null,
      'sulle tue non si aggiunge niente');
  }
  p.chiudi();
}

// --- e il nome resta anche nel testo che incolli nel daily ----------------
// È lì che il danno succede: a schermo puoi ancora vedere il contorno, nel
// testo incollato resta solo la riga.
{
  const p = await apriRegistro();
  p.document.getElementById('log-copy').click();
  await p.attendi(1);

  const [copiato] = p.appunti;
  assert.ok(copiato, 'il tasto deve copiare qualcosa');
  const righe = copiato.split('\n');
  assert.equal(righe.length, 4, 'una riga per evento');
  assert.match(righe[2], /ABC-2/);
  assert.match(righe[2], /Dario Decarlo/, 'senza il nome quella riga la firmi tu');
  for (const indice of [0, 1, 3]) {
    assert.doesNotMatch(righe[indice], /Dario Decarlo/);
  }
  p.chiudi();
}

// --- una giornata senza niente lo dice, invece di restare vuota ----------
{
  const p = await apriRegistro({ ...RISPOSTE, activity: { isoDate: '2026-08-10', events: [] } });

  assert.equal(tutti(p.document, '#log li').length, 0);
  assert.equal(p.document.querySelector('#log-empty').hidden, false, 'la spiegazione deve comparire');
  assert.equal(p.document.querySelector('#log-copy').hidden, true,
    'e non si offre di copiare un registro vuoto');
  p.chiudi();
}

// --- cambiando giorno il registro si rilegge, ma non a ogni tasto --------
// La scheda resta quella: senza una rilettura mostrerebbe gli eventi di ieri
// sotto la data di oggi, che è il modo peggiore di sbagliare. Tenendo premuto
// ‹ però si attraversano cinque giorni in un secondo, e cinque letture di rete
// sono quattro di troppo: la richiesta parte quando ti fermi.
{
  const p = await apriRegistro();
  p.chiamate.length = 0;

  p.document.getElementById('prev-day').click();
  p.document.getElementById('prev-day').click();
  await p.attendi(2);
  assert.equal(p.chiamate.filter((c) => c.type === 'activity').length, 0,
    'subito non parte niente: si aspetta che tu abbia finito di sfogliare');

  await respira(320);
  await p.attendi(2);

  const chieste = p.chiamate.filter((c) => c.type === 'activity');
  assert.equal(chieste.length, 1, 'due giorni sfogliati, una lettura sola');
  // Il giorno di partenza è oggi, qualunque giorno sia quando gira la suite:
  // quello che conta è che la lettura sia per il giorno dove ti sei fermato,
  // cioè quello scritto nel campo.
  assert.equal(chieste[0].payload.isoDate, p.document.getElementById('date').value,
    'e per il giorno dove ti sei fermato');
  p.chiudi();
}

console.log('registro vivo: tutti i controlli passati.');
