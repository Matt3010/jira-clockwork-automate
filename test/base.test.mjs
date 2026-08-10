// Primitive che stavano senza rete: date, configurazione, e i mattoni del
// planner (monte ore, finestre libere, fine giornata).

import assert from 'node:assert/strict';
import {
  todayIso, toIsoDate, localDateTime, minutesToTime, timeToMinutes, addMinutes
} from '../src/lib/dates.js';
import { budgetFor, redoneKeys, freeSlots, endOfPlan } from '../src/lib/planner.js';

// ---------------------------------------------------------------- date
assert.match(todayIso(), /^\d{4}-\d{2}-\d{2}$/);
assert.equal(toIsoDate(new Date(2026, 0, 5)), '2026-01-05', 'mese e giorno con lo zero davanti');
assert.equal(toIsoDate(new Date(2026, 11, 31)), '2026-12-31');

// localDateTime e toIsoDate devono essere l'una l'inversa dell'altra
for (const iso of ['2026-01-01', '2026-02-28', '2026-08-10', '2026-12-31']) {
  assert.equal(toIsoDate(localDateTime(iso)), iso, `andata e ritorno su ${iso}`);
}

// e il giro attraverso un cambio di mese non deve slittare
const fine = localDateTime('2026-08-31');
fine.setDate(fine.getDate() + 1);
assert.equal(toIsoDate(fine), '2026-09-01');

// minutesToTime / timeToMinutes
assert.equal(minutesToTime(0), '00:00');
assert.equal(minutesToTime(570), '09:30');
assert.equal(minutesToTime(1439), '23:59');
assert.equal(minutesToTime(2000), '23:59', 'oltre la mezzanotte resta a fine giornata');
assert.equal(minutesToTime(-30), '00:00');
for (const t of ['00:00', '09:30', '13:45', '23:59']) {
  assert.equal(minutesToTime(timeToMinutes(t)), t, `andata e ritorno su ${t}`);
}
assert.equal(addMinutes('09:30', 0), '09:30');

// ---------------------------------------------------------------- monte ore
const riga = (over) => ({ enabled: true, issueKey: 'ABC-1', existingMinutes: 0, ...over });

assert.equal(budgetFor([], 480, 0), 480, 'giornata vuota: monte ore intero');
assert.equal(budgetFor([], 480, 120), 360, 'due ore gia registrate ne bloccano due');
assert.equal(budgetFor([], 480, 600), 0, 'non va mai sotto zero');

// una riga spenta con ore gia registrate le lascia bloccate
assert.equal(budgetFor([riga({ enabled: false, existingMinutes: 120 })], 480, 120), 360);
// riaccesa, le rimette in gioco
assert.equal(budgetFor([riga({ existingMinutes: 120 })], 480, 120), 480);
// piu righe riaccese si sommano
assert.equal(
  budgetFor([riga({ existingMinutes: 60 }), riga({ issueKey: 'ABC-2', existingMinutes: 60 })], 480, 120),
  480
);
// una riga accesa senza ore pregresse non cambia nulla
assert.equal(budgetFor([riga({})], 480, 120), 360);

// ---------------------------------------------------------------- rifatte
const righe = [
  riga({ issueKey: 'A', existingMinutes: 30 }),
  riga({ issueKey: 'B', existingMinutes: 30, enabled: false }),
  riga({ issueKey: 'C', existingMinutes: 0 }),
  riga({ issueKey: '', existingMinutes: 30 })
];
assert.deepEqual([...redoneKeys(righe)], ['A'],
  'solo le righe accese, con ticket e con ore gia registrate');

// ---------------------------------------------------------------- finestre libere
assert.deepEqual(freeSlots([], 540), [{ from: 540, to: Infinity }], 'niente occupato: una finestra sola');

assert.deepEqual(
  freeSlots([{ from: 570, to: 630 }, { from: 780, to: 840 }], 540),
  [{ from: 540, to: 570 }, { from: 630, to: 780 }, { from: 840, to: Infinity }],
  'la finestra prima del primo impegno non va persa'
);

assert.deepEqual(
  freeSlots([{ from: 480, to: 600 }], 540),
  [{ from: 600, to: Infinity }],
  'un impegno che copre la partenza la sposta in avanti'
);

assert.deepEqual(
  freeSlots([{ from: 540, to: 600 }], 540),
  [{ from: 600, to: Infinity }],
  'un impegno che comincia esattamente alla partenza non lascia buchi'
);

assert.deepEqual(
  freeSlots([{ from: 400, to: 500 }], 540),
  [{ from: 540, to: Infinity }],
  'quello che sta tutto prima della partenza si ignora'
);

// ---------------------------------------------------------------- fine giornata
assert.equal(endOfPlan([]), 0);
assert.equal(endOfPlan([{ segments: [] }]), 0);
assert.equal(
  endOfPlan([
    { segments: [{ time: '09:00', minutes: 30 }] },
    { segments: [{ time: '10:30', minutes: 150 }, { time: '14:00', minutes: 240 }] }
  ]),
  18 * 60,
  'vince la fine del segmento piu tardi, non l ordine nell elenco'
);

console.log('primitive: tutti i controlli passati.');
