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
  assert.doesNotMatch(onDateChanged, /[^e]\banalyze\(/,
    'e nemmeno il piano');
}

// --- ogni ritardo accorpa: il timer precedente va annullato ---------------
// Vale anche per la ricerca: un tasto premuto è l'equivalente di un clic su
// ‹, e una ricerca per lettera digitata sarebbe la stessa raffica.
for (const nome of ['scheduleAnalyze', 'scheduleSearch']) {
  const corpo = blocco(nome);
  assert.match(corpo, /clearTimeout\(/,
    `${nome} non annulla il timer di prima: i clic si accodano invece di accorparsi`);
  assert.match(corpo, /setTimeout\(/, `${nome} deve rimandare, non partire subito`);
}

// --- e chi legge scarta le risposte superate ------------------------------
// Vale per tutte e tre le letture, non solo per quelle legate al giorno:
// due Aggiorna ravvicinati bastano a far tornare le risposte fuori ordine.
for (const [nome, token] of [
  ['analyze', 'analyzeToken'],
  ['runSearch', 'searchToken'], ['loadTickets', 'ticketsToken']
]) {
  const corpo = blocco(nome);
  assert.match(corpo, new RegExp(`const token = \\+\\+${token}`),
    `${nome} deve prendere un contrassegno prima di partire`);
  assert.match(corpo, new RegExp(`token !== ${token}`),
    `${nome} non controlla il contrassegno: una risposta vecchia può sovrascrivere quella buona`);
}

// --- il dato su cui si legge va congelato all'inizio ----------------------
// Leggendolo dopo l'attesa si mostrerebbe il risultato di una richiesta con
// l'etichetta di un'altra: il giorno o il termine nel frattempo è cambiato.
for (const [nome, campo] of [
  ['analyze', 'forDate = state.isoDate'],
  ['runSearch', 'query = state.searchQuery']
]) {
  const corpo = blocco(nome);
  assert.ok(corpo.includes(`const ${campo}`), `${nome} deve fissare il dato prima della richiesta`);
  const dopoAttesa = corpo.slice(corpo.indexOf('await send('));
  assert.doesNotMatch(dopoAttesa, /state\.(isoDate|searchQuery)/,
    `${nome} rilegge lo stato dopo l attesa: nel frattempo può essere cambiato`);
}

// --- il controllo va fatto anche sull'errore ------------------------------
// Un errore di una richiesta superata cancellerebbe a schermo il risultato
// buono, e mostrerebbe un messaggio che non riguarda quello che stai vedendo.
for (const nome of ['analyze', 'runSearch']) {
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
