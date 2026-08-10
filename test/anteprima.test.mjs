// L'anteprima disegna quello che il planner ha deciso. Qui si verifica che i
// dati da cui nasce siano coerenti con i worklog che verranno davvero scritti:
// stessi minuti, stesse fasce, nessuna sovrapposizione.

import assert from 'node:assert/strict';
import { buildPlan, breakRanges, busyIntervals } from '../src/lib/planner.js';
import { timeToMinutes } from '../src/lib/dates.js';
import { DEFAULT_CONFIG } from '../src/lib/storage.js';

const config = DEFAULT_CONFIG;
const recentIssues = [
  { key: 'XYZ-289', summary: 'Weekly Meet 2026-08-10' },
  { key: 'ABC-1969', summary: 'Standup di progetto' }
];
const jiraActivity = new Map([
  ['ABC-2075', { key: 'ABC-2075', id: '1', summary: 'Lavoro', events: [{ kind: 'changelog', at: '2026-08-10T11:00:00.000Z' }] }]
]);

const plan = buildPlan({
  isoDate: '2026-08-10', config,
  jiraActivity, gitByIssue: new Map(), recentIssues,
  loggedEntries: [], loggedByIssue: {}, alreadyLoggedMinutes: 0
});

/** Gli stessi blocchi che l'anteprima disegna, ricavati dal piano. */
function blocchi(rows) {
  const out = [];
  for (const row of rows) {
    if (!row.enabled || !row.issueKey) continue;
    for (const s of row.segments || []) {
      out.push({ tipo: row.kind, key: row.issueKey, from: timeToMinutes(s.time), to: timeToMinutes(s.time) + s.minutes });
    }
  }
  return out.sort((a, b) => a.from - b.from);
}

const disegnati = blocchi(plan.rows);
assert.ok(disegnati.length >= 3, 'ci sono blocchi da mostrare');

// 1. l'anteprima non inventa e non perde minuti rispetto a cio' che verra' scritto
const minutiDisegnati = disegnati.reduce((s, b) => s + (b.to - b.from), 0);
const minutiDaScrivere = plan.rows
  .filter((r) => r.enabled && r.issueKey)
  .reduce((s, r) => s + r.minutes, 0);
assert.equal(minutiDisegnati, minutiDaScrivere, 'i blocchi mostrati valgono quanto i worklog');
assert.equal(minutiDisegnati, 480, 'e coprono la giornata intera');

// 2. nessun blocco si sovrappone a un altro
for (let i = 1; i < disegnati.length; i += 1) {
  assert.ok(disegnati[i].from >= disegnati[i - 1].to,
    `${disegnati[i].key} si sovrappone a ${disegnati[i - 1].key}`);
}

// 3. nessun blocco cade dentro una pausa
for (const pausa of breakRanges(config)) {
  for (const b of disegnati.filter((x) => x.tipo === 'task')) {
    assert.ok(b.to <= pausa.from || b.from >= pausa.to,
      `un blocco di lavoro (${b.from}-${b.to}) cade nella pausa`);
  }
}

// 4. gli estremi dell'anteprima contengono tutto
const primo = Math.min(...disegnati.map((b) => b.from));
const ultimo = Math.max(...disegnati.map((b) => b.to));
assert.equal(primo, timeToMinutes(config.work.startTime), 'si parte a inizio giornata');
assert.equal(ultimo, 18 * 60, 'e si chiude alle 18:00');
assert.equal(plan.endOfDay, '18:00', 'coerente con quanto riportato dal piano');

// 5. le fasce occupate viste dall'anteprima sono quelle che il planner ha usato
const occupato = busyIntervals(plan.rows, config, plan.loggedEntries);
assert.ok(occupato.some((r) => r.from === 13 * 60 && r.to === 14 * 60), 'la pausa è fra le fasce occupate');
assert.ok(occupato.some((r) => r.from === 570), 'e anche la prima riunione');

// 6. spegnendo tutto non resta niente da disegnare
const spente = plan.rows.map((r) => ({ ...r, enabled: false }));
assert.equal(blocchi(spente).length, 0, 'niente righe attive, niente blocchi');

// 7. ...ma l'asse deve comunque coprire la giornata configurata, altrimenti si
//    stringe attorno alla sola pausa e si ferma alle 14:00
function estensione(bs, cfg) {
  const inizio = timeToMinutes(cfg.work.startTime);
  const minutiPausa = breakRanges(cfg).reduce((s, p) => s + (p.to - p.from), 0);
  const fine = inizio + Math.round(cfg.work.dailyHours * 60) + minutiPausa;
  const da = Math.floor(Math.min(inizio, ...bs.map((b) => b.from)) / 60) * 60;
  const a = Math.ceil(Math.max(fine, ...bs.map((b) => b.to)) / 60) * 60;
  return { da, a: Math.max(a, da + 60) };
}

// con tutto spento restano solo le pause fra i blocchi disegnati
const soloPause = breakRanges(config).map((p) => ({ from: p.from, to: p.to }));
const vuota = estensione(soloPause, config);
assert.equal(vuota.da, 9 * 60, 'l asse parte dall inizio giornata');
assert.equal(vuota.a, 18 * 60, 'e arriva a fine giornata, non alle 14:00');

// con la giornata piena l'asse resta lo stesso
const piena = estensione(disegnati, config);
assert.deepEqual(piena, vuota, 'l asse non cambia a seconda di cosa e acceso');

// una giornata piu lunga allarga l asse
const lunga = { ...config, work: { ...config.work, dailyHours: 10, startTime: '08:00' } };
assert.deepEqual(estensione([], lunga), { da: 8 * 60, a: 19 * 60 },
  '8:00 + 10h + 1h di pausa = 19:00');

console.log('anteprima: tutti i controlli passati.');
