import assert from 'node:assert/strict';
import { buildPlan, busyIntervals, reflow, reservedByMeetings } from '../src/lib/planner.js';
import { timeToMinutes } from '../src/lib/dates.js';
import { DEFAULT_CONFIG } from '../src/lib/storage.js';

/**
 * Riproduce la catena reale: il background marca le righe che hanno gia' un
 * worklog quel giorno, il popup le disattiva e ridistribuisce.
 */
const contestoDi = (plan) => ({
  dayBudgetMinutes: plan.dayBudgetMinutes,
  alreadyLoggedMinutes: plan.alreadyLoggedMinutes,
  loggedEntries: plan.loggedEntries
});

function comePopup(plan, config) {
  const rows = plan.rows.map((r) => ({ ...r, locked: false }));
  reflow(rows, config, contestoDi(plan));
  return rows;
}

/** Come quando nel popup si spunta o si toglie una riga. */
function commuta(rows, config, plan, predicato, acceso) {
  for (const row of rows) if (predicato(row)) row.enabled = acceso;
  return reflow(rows, config, contestoDi(plan)).budgetMinutes;
}
const inviabili = (rows) => rows.filter((r) => r.enabled && r.issueKey && r.minutes);
const totale = (rows) => inviabili(rows).reduce((s, r) => s + r.minutes, 0);

/**
 * Nessun segmento che verra' scritto deve accavallarsi a un altro, alle pause,
 * o alle ore gia' registrate che non stiamo rifacendo.
 */
function nonSiAccavallano(rows, plan, config) {
  const blocchi = [];
  for (const row of inviabili(rows)) {
    for (const s of row.segments) {
      blocchi.push({ key: row.issueKey, from: timeToMinutes(s.time), to: timeToMinutes(s.time) + s.minutes });
    }
  }
  blocchi.sort((a, b) => a.from - b.from);
  for (let i = 1; i < blocchi.length; i += 1) {
    assert.ok(blocchi[i].from >= blocchi[i - 1].to,
      `${blocchi[i].key} parte prima che finisca ${blocchi[i - 1].key}`);
  }

  const occupato = busyIntervals(rows, config, plan.loggedEntries);
  for (const b of blocchi.filter((x) => rows.some((r) => r.kind === 'task' && r.issueKey === x.key))) {
    for (const busy of occupato) {
      assert.ok(b.to <= busy.from || b.from >= busy.to,
        `${b.key} (${b.from}-${b.to}) invade una fascia occupata (${busy.from}-${busy.to})`);
    }
  }
}

const config = DEFAULT_CONFIG;
const byIssueDa = (entries) => entries.reduce((acc, e) => ({ ...acc, [e.key]: (acc[e.key] || 0) + e.minutes }), {});
const recentIssues = [
  { key: 'XYZ-289', summary: 'Weekly Meet 2026-08-10' },
  { key: 'ABC-1969', summary: 'Standup - Team Sprint 8' },
  { key: 'ABC-2075', summary: 'Implementazione modulo' }
];
const attivita = (keys) => new Map(keys.map((k, i) => [k, {
  key: k, id: String(i), summary: `Titolo ${k}`,
  events: [{ kind: 'changelog', at: '2026-08-10T11:00:00.000Z' }]
}]));

// ===========================================================================
// SCENARIO A - flusso completamente automatico: non ho segnato niente a mano
// ===========================================================================
const a = buildPlan({
  isoDate: '2026-08-10', config,
  jiraActivity: attivita(['ABC-2075', 'ABC-1996']),
  gitByIssue: new Map(), recentIssues,
  loggedEntries: [], alreadyLoggedMinutes: 0
});
const aRows = comePopup(a, config);

assert.equal(a.budgetMinutes, 480, 'niente registrato: monte ore intero');
assert.ok(aRows.every((r) => r.enabled), 'tutte le righe attive');
assert.equal(totale(aRows), 480, 'A: la giornata viene coperta per intero, 8h esatte');
assert.equal(reservedByMeetings(aRows), 60, 'due riunioni da 30m');
nonSiAccavallano(aRows, a, config);

// La finestra 09:00-09:30, prima della prima riunione, non va sprecata:
// altrimenti la giornata slitta di mezz'ora e finisce alle 18:30.
const aTasks = inviabili(aRows).filter((r) => r.kind === 'task');
assert.equal(aTasks[0].segments[0].time, '09:00', 'si parte alle 9, non dopo le riunioni');
assert.equal(a.endOfDay, '18:00',
  '8h di lavoro dalle 9:00 con 1h di pausa finiscono alle 18:00, sempre');

const aMeet = aRows.filter((r) => r.kind === 'meeting');
assert.equal(aMeet[0].issueKey, 'XYZ-289', 'giornaliero agganciato per data nel titolo');
assert.equal(aMeet[1].issueKey, 'ABC-1969', 'standup agganciato per nome');
const chiavi = aRows.filter((r) => r.issueKey).map((r) => r.issueKey);
assert.equal(new Set(chiavi).size, chiavi.length, 'nessuna issue ripetuta su due righe');

// A-bis: una riunione senza ticket non deve mangiarsi mezz'ora nel nulla
const senzaTicket = buildPlan({
  isoDate: '2026-08-10', config,
  jiraActivity: attivita(['ABC-2075']),
  gitByIssue: new Map(), recentIssues: [],
  loggedEntries: [], alreadyLoggedMinutes: 0
});
const senzaRows = comePopup(senzaTicket, config);
assert.ok(senzaRows.filter((r) => r.kind === 'meeting').every((r) => !r.issueKey));
assert.equal(totale(senzaRows), 480,
  'le riunioni senza ticket non riservano tempo: le 8h vanno tutte sulle task');

// ===========================================================================
// SCENARIO B - ho gia' segnato tutto a mano: non deve aggiungere niente
// ===========================================================================
const loggedTutto = [
  { key: 'XYZ-289', summary: 'Weekly Meet 2026-08-10', startMinutes: 570, minutes: 30 },
  { key: 'ABC-1969', summary: 'Standup - Team Sprint 8', startMinutes: 600, minutes: 30 },
  { key: 'ABC-2075', summary: 'Titolo', startMinutes: 630, minutes: 150 },
  { key: 'ABC-2075', summary: 'Titolo', startMinutes: 840, minutes: 240 }
];
const b = buildPlan({
  isoDate: '2026-08-10', config,
  jiraActivity: attivita(['ABC-2075', 'XYZ-289']),
  gitByIssue: new Map(), recentIssues,
  loggedEntries: loggedTutto, loggedByIssue: byIssueDa(loggedTutto), alreadyLoggedMinutes: 450
});
const bRows = comePopup(b, config);
assert.equal(b.budgetMinutes, 30, '8h meno 7h30 gia registrate');
assert.equal(totale(bRows), 0, 'B: niente da inviare, la giornata e gia a posto');
assert.ok(bRows.every((r) => !r.enabled), 'tutte le righe spente');

const bMeet = bRows.filter((r) => r.kind === 'meeting');
assert.equal(bMeet[0].issueKey, 'XYZ-289', 'aggancio per orario: 9:30 -> XYZ-289');
assert.equal(bMeet[0].guessReason, 'orario');
assert.equal(bMeet[1].issueKey, 'ABC-1969');
assert.ok(!bRows.some((r) => r.kind === 'task' && r.issueKey === 'XYZ-289'),
  'XYZ-289 e la riunione, non una task: niente doppione');

// Giornata piena esatta: 30 + 30 + 150 + 270 = 480. Il totale e la somma per
// issue devono coincidere, come coincidono nel flusso reale.
const loggedPieno = [
  { key: 'XYZ-289', summary: 'Weekly Meet 2026-08-10', startMinutes: 570, minutes: 30 },
  { key: 'ABC-1969', summary: 'Standup - Team Sprint 8', startMinutes: 600, minutes: 30 },
  { key: 'ABC-2075', summary: 'Titolo', startMinutes: 630, minutes: 150 },
  { key: 'ABC-2075', summary: 'Titolo', startMinutes: 840, minutes: 270 }
];
const bPieno = buildPlan({
  isoDate: '2026-08-10', config,
  jiraActivity: attivita(['ABC-2075']), gitByIssue: new Map(), recentIssues,
  loggedEntries: loggedPieno, loggedByIssue: byIssueDa(loggedPieno), alreadyLoggedMinutes: 480
});
assert.equal(totale(comePopup(bPieno, config)), 0);
assert.equal(bPieno.warnings.length, 1, 'un solo messaggio, non due che dicono lo stesso');

// ===========================================================================
// SCENARIO C - giornata a meta': riunioni segnate, manca il lavoro
// ===========================================================================
const soloRiunioni = [
  { key: 'XYZ-289', summary: 'Weekly Meet 2026-08-10', startMinutes: 570, minutes: 30 },
  { key: 'ABC-1969', summary: 'Standup - Team Sprint 8', startMinutes: 600, minutes: 30 }
];
const c = buildPlan({
  isoDate: '2026-08-10', config,
  jiraActivity: attivita(['ABC-2075', 'ABC-1996']),
  gitByIssue: new Map(), recentIssues,
  loggedEntries: soloRiunioni, loggedByIssue: byIssueDa(soloRiunioni), alreadyLoggedMinutes: 60
});
const cRows = comePopup(c, config);
assert.equal(c.budgetMinutes, 420, 'restano 7h');
assert.equal(reservedByMeetings(cRows), 0, 'riunioni spente: non riservano piu nulla');
assert.equal(totale(cRows), 420, 'le 7h residue vanno tutte sul lavoro, niente perso');
nonSiAccavallano(cRows, c, config);
const cTasks = inviabili(cRows).filter((r) => r.kind === 'task');
// Le riunioni gia' registrate occupano 9:30-10:30, ma la mezz'ora prima resta
// libera e va usata.
assert.equal(cTasks[0].segments[0].time, '09:00', 'la finestra prima delle riunioni viene riempita');
assert.deepEqual(cTasks.map((t) => t.minutes), [210, 210]);
assert.equal(c.endOfDay, '18:00', 'e la giornata chiude comunque alle 18:00');

// ===========================================================================
// SCENARIO D - correzioni a mano nel popup
// ===========================================================================
const d = comePopup(a, config);
const bloccata = d.find((r) => r.kind === 'task');
bloccata.minutes = 60;
bloccata.locked = true;
commuta(d, config, a, () => false, true);
assert.equal(bloccata.minutes, 60, 'la riga corretta a mano non viene toccata');
assert.equal(totale(d), 480, 'D: il totale resta esatto dopo la correzione');
nonSiAccavallano(d, a, config);

const e = comePopup(a, config);
commuta(e, config, a, (r) => r.kind === 'meeting', false);
assert.equal(totale(e), 480, 'E: tolta una riunione, le 8h restano coperte');
assert.equal(reservedByMeetings(e), 0, 'nessuna riunione accesa');

// ===========================================================================
// SCENARIO F - giornata piena, ma riaccendo tutto a mano
// (il caso dello screenshot: 8h gia registrate, tre righe riaccese)
// ===========================================================================
const f = comePopup(bPieno, config);
assert.ok(f.every((r) => !r.enabled), 'di default tutto spento');
assert.equal(totale(f), 0);

const budgetRiacceso = commuta(f, config, bPieno, () => true, true);
assert.equal(budgetRiacceso, 480,
  'riaccendendo tutte le righe gia registrate, il monte ore torna intero');
assert.equal(reservedByMeetings(f), 60, 'le due riunioni si riprendono la loro ora');

const fTask = f.filter((r) => r.kind === 'task' && r.issueKey);
assert.equal(fTask.length, 1, 'una sola entry non-riunione');
assert.equal(fTask[0].minutes, 420,
  'la task prende monte ore meno le riunioni: 8h - 1h = 7h');
assert.equal(totale(f), 480);
nonSiAccavallano(f, bPieno, config);

// La giornata reale: 9:00-9:30 di lavoro, le due riunioni, lavoro fino a pranzo,
// pausa, e chiusura alle 18:00 in punto. Prima il lavoro partiva dalle 18:00
// (dopo i vecchi worklog) e sfondava la mezzanotte.
assert.deepEqual(fTask[0].segments, [
  { time: '09:00', minutes: 30 },
  { time: '10:30', minutes: 150 },
  { time: '14:00', minutes: 240 }
], 'riempie tutti gli spazi liberi, pausa esclusa');
const fineF = fTask[0].segments.at(-1);
assert.equal(timeToMinutes(fineF.time) + fineF.minutes, 18 * 60,
  'la giornata finisce alle 18:00, non alle 18:30 e non a mezzanotte');

// e riaccendendo solo la task, le riunioni restano spente e lei prende tutto
const g = comePopup(bPieno, config);
commuta(g, config, bPieno, (r) => r.kind === 'task', true);
const gTask = g.filter((r) => r.kind === 'task' && r.issueKey);
assert.equal(gTask[0].minutes, 420,
  'restano fuori solo le ore delle due riunioni ancora spente');

console.log('flusso completo A/B/C/D/F: tutti i controlli passati.');
