// Il registro delle attività: come un evento diventa una riga leggibile e come
// l'insieme diventa il testo da incollare nel daily.
//
// Senza `chrome`, `t` restituisce la chiave: le asserzioni sono quindi sulle
// chiavi e sulla struttura, che è quello che conta — la traduzione la verifica
// la suite dedicata.

import assert from 'node:assert/strict';
import { describeEvent, eventMinutes, eventTime, logLine, logAsText } from '../src/lib/registro.js';

const alle = (h, m = 0) => new Date(2026, 7, 11, h, m).getTime();

// --- l'ora dell'evento ------------------------------------------------------
assert.equal(eventMinutes(alle(9, 41)), 9 * 60 + 41);
assert.equal(eventTime(alle(9, 41)), '09:41');
assert.equal(eventTime(alle(0, 0)), '00:00');
assert.equal(eventTime(alle(23, 59)), '23:59');

// --- ogni tipo di evento dice la cosa giusta -------------------------------
{
  const creata = describeEvent({ tipo: 'created', key: 'ABC-1', summary: 'Titolo' });
  assert.equal(creata.verbo, 'logCreated');
  assert.equal(creata.dettaglio, 'Titolo');
}
{
  // Il passaggio di stato è il segnale più forte: deve dire dove è arrivata,
  // e da dove veniva — con la direzione esplicita, non due nomi accostati.
  const stato = describeEvent({ tipo: 'status', from: 'Da fare', to: 'In corso' });
  assert.equal(stato.verbo, 'logStatus');
  assert.equal(stato.dettaglio, 'logStatusFrom');

  // Il primo passaggio non ha un "da": non deve restare una parola sospesa.
  assert.equal(describeEvent({ tipo: 'status', to: 'In corso' }).dettaglio, '');
}

{
  // I nomi tecnici dei campi diventano parole; quelli che non conosciamo —
  // i campi personalizzati di ogni installazione — restano come sono, che è
  // meglio di una riga vuota.
  assert.equal(describeEvent({ tipo: 'field', field: 'assignee' }).verbo, 'logField');
  assert.equal(describeEvent({ tipo: 'field', field: 'Qualcosa Di Personalizzato' }).verbo, 'logField');
}
{
  const commit = describeEvent({ tipo: 'commit', subject: 'fix tunnel' });
  assert.equal(commit.verbo, 'logCommit');
  assert.equal(commit.dettaglio, 'fix tunnel');
}
{
  const campo = describeEvent({ tipo: 'field', field: 'assignee', to: 'Nome' });
  assert.equal(campo.verbo, 'logField');
  assert.equal(campo.dettaglio, 'Nome');
}

// --- campi mancanti non devono produrre "undefined" a schermo -------------
for (const evento of [
  { tipo: 'created' }, { tipo: 'status' }, { tipo: 'comment' },
  { tipo: 'commit' }, { tipo: 'field' }, { tipo: 'boh' }
]) {
  const { verbo, dettaglio } = describeEvent(evento);
  assert.equal(typeof verbo, 'string');
  assert.equal(typeof dettaglio, 'string');
  assert.doesNotMatch(`${verbo}${dettaglio}`, /undefined|null/,
    `l evento ${evento.tipo} senza dati produce testo sporco`);
}

// --- una riga di testo ------------------------------------------------------
{
  const riga = logLine({ at: alle(9, 41), key: 'ABC-1', tipo: 'status', from: 'Da fare', to: 'In corso' });
  assert.ok(riga.startsWith('- 09:41 ABC-1 '), `riga inattesa: ${riga}`);
  assert.ok(riga.includes('logStatus'));
  assert.ok(riga.includes('logStatusFrom'), 'la riga porta anche lo stato di partenza');
}
{
  // Senza dettaglio non deve restare il separatore appeso.
  const riga = logLine({ at: alle(14, 3), key: 'ABC-2', tipo: 'comment' });
  assert.ok(!riga.trim().endsWith('·'), `separatore appeso: ${riga}`);
}

// --- il testo intero --------------------------------------------------------
{
  const eventi = [
    { at: alle(9, 41), key: 'ABC-1', tipo: 'status', to: 'In corso' },
    { at: alle(11, 20), key: 'ABC-2', tipo: 'comment' },
    { at: alle(14, 3), key: 'ABC-3', tipo: 'created', summary: 'Nuova' }
  ];
  const testo = logAsText(eventi);
  assert.equal(testo.split('\n').length, 3, 'una riga per evento');
  assert.ok(testo.split('\n').every((r) => r.startsWith('- ')), 'elenco puntato, incollabile');
  assert.ok(testo.indexOf('09:41') < testo.indexOf('14:03'), 'in ordine di orario');
}

assert.equal(logAsText([]), '', 'niente eventi, niente testo');
assert.equal(logAsText(undefined), '', 'e nemmeno un errore');

console.log('registro: tutti i controlli passati.');
