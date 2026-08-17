// L'ora di un evento Jira: quella locale, non quella del fuso in cui è
// scritta. È il numero con cui il piano ordina la giornata e con cui a schermo
// si dice «letto alle 09:41»: sbagliarlo di un'ora sposta il lavoro di giorno.

import assert from 'node:assert/strict';
import { eventMinutes, eventTime } from '../src/lib/registro.js';

const alle = (h, m = 0) => new Date(2026, 7, 11, h, m).getTime();

assert.equal(eventMinutes(alle(9, 41)), 9 * 60 + 41);
assert.equal(eventTime(alle(9, 41)), '09:41');
assert.equal(eventTime(alle(0, 0)), '00:00');
assert.equal(eventTime(alle(23, 59)), '23:59');

// La stringa ISO è la forma in cui gli eventi arrivano da Jira: va letta
// nell'ora locale, che è quella in cui hai lavorato.
assert.equal(eventTime(new Date(alle(14, 3)).toISOString()), '14:03');

console.log('registro: tutti i controlli passati.');
