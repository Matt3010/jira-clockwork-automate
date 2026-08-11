// Una riunione resta all'orario che hai configurato, ma le pause valgono anche
// per lei. E soprattutto: lo spazio che occupa dev'essere quello vero, o una
// task le finisce scritta sopra.

import assert from 'node:assert/strict';
import { layoutTimes, busyIntervals, reflow, breakRanges } from '../src/lib/planner.js';
import { timeToMinutes } from '../src/lib/dates.js';
import { DEFAULT_CONFIG } from '../src/lib/storage.js';

const config = { ...DEFAULT_CONFIG, meetings: [] }; // pausa 13:00–14:00
const contesto = { dayBudgetMinutes: 480, alreadyLoggedMinutes: 0, loggedEntries: [] };

const riunione = (time, minutes, over = {}) => ({
  kind: 'meeting', id: `m-${time}`, issueKey: 'XYZ-1', enabled: true, existingMinutes: 0,
  time, minutes, defaultMinutes: minutes, locked: true, lockedMinutes: minutes, segments: [], ...over
});
const task = (key, over = {}) => ({
  kind: 'task', id: `t-${key}`, issueKey: key, enabled: true, existingMinutes: 0,
  minutes: 0, segments: [], ...over
});

// --- una riunione breve non viene toccata ----------------------------------
{
  const rows = [riunione('09:30', 30)];
  layoutTimes(rows, config);
  assert.deepEqual(rows[0].segments, [{ time: '09:30', minutes: 30 }],
    'mezz ora alle 9:30 resta un blocco solo');
}

// --- una riunione che scavalca la pausa viene spezzata ---------------------
{
  const rows = [riunione('11:00', 240)]; // 11:00 + 4h
  layoutTimes(rows, config);
  assert.deepEqual(rows[0].segments, [
    { time: '11:00', minutes: 120 },
    { time: '14:00', minutes: 120 }
  ], 'due ore prima di pranzo, due dopo');
  assert.equal(rows[0].segments.reduce((s, x) => s + x.minutes, 0), 240, 'niente minuti persi');
  assert.equal(rows[0].time, '11:00', 'l orario di inizio resta quello configurato');
}

// --- una riunione che comincia dentro la pausa slitta alla fine ------------
{
  const rows = [riunione('13:15', 60)];
  layoutTimes(rows, config);
  assert.deepEqual(rows[0].segments, [{ time: '14:00', minutes: 60 }]);
}

// --- IL PUNTO: lo spazio occupato segue i segmenti, non inizio + durata ----
{
  const rows = [riunione('11:00', 240)];
  layoutTimes(rows, config);
  const occupato = busyIntervals(rows, config, []);

  // Gli intervalli adiacenti vengono fusi, quindi non si cercano estremi
  // precisi ma la copertura: quali minuti risultano occupati.
  const pieno = (minuto) => occupato.some((r) => minuto >= r.from && minuto < r.to);

  assert.ok(pieno(11 * 60), 'la riunione occupa dalle 11:00');
  assert.ok(pieno(12 * 60 + 59), 'fino a pranzo');
  assert.ok(pieno(13 * 60 + 30), 'la pausa è occupata di suo');
  // Sommando inizio e durata la riunione risulterebbe 11:00–15:00: la coda
  // 15:00–16:00, dove sta ancora, risulterebbe libera e ci finirebbe una task.
  assert.ok(pieno(15 * 60), 'e la coda dopo la pausa resta occupata');
  assert.ok(pieno(15 * 60 + 59), 'fino alla fine vera della riunione');
  assert.ok(!pieno(16 * 60), 'ma non oltre');
  assert.ok(!pieno(10 * 60 + 59), 'e non prima che cominci');
}

// --- di conseguenza nessuna task le finisce scritta sopra ------------------
{
  const rows = [riunione('11:00', 240), task('ABC-1')];
  reflow(rows, config, contesto);

  const blocchi = [];
  for (const row of rows) {
    for (const s of row.segments) {
      blocchi.push({ key: row.issueKey, from: timeToMinutes(s.time), to: timeToMinutes(s.time) + s.minutes });
    }
  }
  blocchi.sort((a, b) => a.from - b.from);
  for (let i = 1; i < blocchi.length; i += 1) {
    assert.ok(blocchi[i].from >= blocchi[i - 1].to,
      `${blocchi[i].key} scritta sopra ${blocchi[i - 1].key}`);
  }

  // e nemmeno la task cade nella pausa
  const [pausa] = breakRanges(config);
  for (const b of blocchi) {
    assert.ok(b.to <= pausa.from || b.from >= pausa.to, 'un blocco cade nella pausa');
  }

  const totale = rows.reduce((s, r) => s + r.minutes, 0);
  assert.equal(totale, 480, 'la giornata resta di 8h: riunione 4h + lavoro 4h');
}

// --- il caso dello screenshot: 8h su una riunione, nessuna task ------------
{
  const rows = [riunione('09:30', 480)];
  layoutTimes(rows, config);
  assert.deepEqual(rows[0].segments, [
    { time: '09:30', minutes: 210 },
    { time: '14:00', minutes: 270 }
  ], 'niente più un unico blocco 09:30–17:30 che si mangia il pranzo');
  const fine = rows[0].segments.at(-1);
  assert.equal(timeToMinutes(fine.time) + fine.minutes, 18 * 60 + 30, 'e finisce alle 18:30');
}

console.log('riunioni lunghe: tutti i controlli passati.');
