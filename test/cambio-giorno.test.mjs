// Cambiare giorno tenendo premuto ‹ o ›.
//
// Cinque giorni in un secondo sono cinque letture complete di Jira, di cui
// quattro buttate — e le risposte tornano fuori ordine, quindi l'ultima ad
// arrivare può essere quella di un giorno che non stai più guardando. Servono
// due cose insieme: un ritardo che accorpi i clic, e un contrassegno che
// scarti le risposte superate. Una sola delle due non basta.
//
// È comportamento del DOM e qui non c'è un DOM: si verifica la regola sul
// sorgente, perché la regressione probabile è aggiungere una vista nuova e
// collegarla al cambio giorno senza nessuna delle due protezioni.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const popup = readFileSync(join(root, 'src/popup.js'), 'utf8');

const blocco = (nome) => {
  const inizio = popup.indexOf(`function ${nome}(`);
  assert.ok(inizio > -1, `manca la funzione ${nome}`);
  const fine = popup.indexOf('\n}', inizio);
  return popup.slice(inizio, fine);
};

// --- il cambio giorno non lancia mai una lettura diretta ------------------
{
  const onDateChanged = blocco('onDateChanged');
  assert.match(onDateChanged, /scheduleAnalyze\(/, 'il piano passa dal ritardo');
  assert.match(onDateChanged, /scheduleLoadLog\(/, 'e anche il registro');
  assert.doesNotMatch(onDateChanged, /[^e]\bloadLog\(\)/,
    'il registro non va chiamato di colpo: era il bug — una richiesta per clic');
  assert.doesNotMatch(onDateChanged, /[^e]\banalyze\(/,
    'e nemmeno il piano');
}

// --- ogni ritardo accorpa: il timer precedente va annullato ---------------
for (const nome of ['scheduleAnalyze', 'scheduleLoadLog']) {
  const corpo = blocco(nome);
  assert.match(corpo, /clearTimeout\(/,
    `${nome} non annulla il timer di prima: i clic si accodano invece di accorparsi`);
  assert.match(corpo, /setTimeout\(/, `${nome} deve rimandare, non partire subito`);
}

// Il contrassegno sale quando si programma la lettura, non quando parte: una
// richiesta già in volo va invalidata al clic, non 250 ms dopo.
assert.match(blocco('scheduleLoadLog'), /logToken\+\+|\+\+logToken/,
  'programmare una lettura nuova deve invalidare subito quella in corso');

// --- e chi legge scarta le risposte superate ------------------------------
for (const [nome, token] of [['analyze', 'analyzeToken'], ['loadLog', 'logToken']]) {
  const corpo = blocco(nome);
  assert.match(corpo, new RegExp(`const token = \\+\\+${token}`),
    `${nome} deve prendere un contrassegno prima di partire`);
  assert.match(corpo, new RegExp(`token !== ${token}`),
    `${nome} non controlla il contrassegno: una risposta vecchia può sovrascrivere quella buona`);

  // Il giorno va congelato all'inizio: leggendo `state.isoDate` dopo l'attesa
  // si scriverebbe in tabella il risultato di ieri con l'etichetta di oggi.
  assert.match(corpo, /const forDate = state\.isoDate/,
    `${nome} deve fissare il giorno prima della richiesta`);
  const dopoAttesa = corpo.slice(corpo.indexOf('await send('));
  assert.doesNotMatch(dopoAttesa, /isoDate: state\.isoDate/,
    `${nome} usa il giorno corrente dopo l attesa: nel frattempo può essere cambiato`);
}

// --- il controllo va fatto anche sull'errore ------------------------------
// Un errore di una richiesta superata cancellerebbe a schermo il risultato
// buono, e mostrerebbe un messaggio che non riguarda il giorno che stai vedendo.
for (const nome of ['analyze', 'loadLog']) {
  const corpo = blocco(nome);
  const dopoCatch = corpo.slice(corpo.indexOf('} catch'));
  assert.match(dopoCatch, /token !== \w+Token/,
    `${nome} non protegge il ramo di errore`);
}

// --- i ticket non c'entrano col giorno ------------------------------------
// Sono quelli aperti adesso: se il cambio giorno li rileggesse, sarebbero
// chiamate inutili per un elenco identico.
{
  const onDateChanged = blocco('onDateChanged');
  assert.doesNotMatch(onDateChanged, /loadTickets/,
    'i ticket aperti non dipendono dal giorno scelto');
  assert.match(blocco('showTab'), /el\.dayPicker\.hidden = ticket/,
    'e nella loro scheda il selettore del giorno non deve nemmeno comparire');
}

console.log('cambio giorno: tutti i controlli passati.');
