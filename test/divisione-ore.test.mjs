// Come si dividono le ore fra le task.
//
// Due modi, e la scelta è dell'utente: in parti uguali — quello di sempre — o
// in proporzione a quanto risulta fatto su ogni task. Nessuno dei due è più
// giusto dell'altro: una task con un commit solo può esserti costata la
// mattina intera, e una con sei commit può essere stata mezz'ora di rebase.
// Quello che deve valere sempre è che la somma torni esatta e che nessuna
// riga inviabile resti a zero senza che il piano lo dica.

import assert from 'node:assert/strict';
import { allocate, buildPlan, distributeByWeight } from '../src/lib/planner.js';
import { DEFAULT_CONFIG } from '../src/lib/storage.js';

const base = { ...DEFAULT_CONFIG, work: { ...DEFAULT_CONFIG.work, dailyHours: 8, roundingMinutes: 15 } };
const conSplit = (split) => ({ ...base, work: { ...base.work, split } });
const quando = (h) => new Date(2026, 7, 10, h, 0).toISOString();

// --- la divisione in proporzione, da sola ---------------------------------
{
  // 8h in multipli di 15' = 32 unità. Pesi 3 e 1 → 24 e 8 unità.
  assert.deepEqual(distributeByWeight(480, [3, 1], 15), [360, 120]);
  assert.deepEqual(distributeByWeight(480, [1, 1], 15), [240, 240]);

  // La somma torna esatta anche quando la proporzione non è divisibile.
  for (const pesi of [[1, 1, 1], [5, 3, 2], [7, 1], [1, 2, 3, 4], [9, 9, 2]]) {
    const fette = distributeByWeight(480, pesi, 15);
    assert.equal(fette.reduce((s, m) => s + m, 0), 480, `somma esatta con pesi ${pesi}`);
    assert.ok(fette.every((m) => m % 15 === 0), 'e sempre in multipli dell arrotondamento');
  }

  // Il resto va a chi ha la frazione più alta, non a chi viene prima: con pesi
  // diversi, darlo per posizione premierebbe l'ordine invece del lavoro.
  assert.deepEqual(distributeByWeight(480, [2, 1, 1], 15), [240, 120, 120]);
  assert.deepEqual(distributeByWeight(60, [1, 1, 1], 15), [30, 15, 15]);

  // Casi limite: senza pesi si ricade sulle parti uguali invece di dare tutto
  // alla prima riga; senza righe non c'è niente da dividere.
  assert.deepEqual(distributeByWeight(480, [0, 0], 15), [240, 240]);
  assert.deepEqual(distributeByWeight(480, [], 15), []);
  assert.deepEqual(distributeByWeight(0, [1, 1], 15), [0, 0]);
}

// --- in parti uguali resta quello di prima --------------------------------
// È il difetto che conta di più: chi non tocca l'impostazione non deve vedere
// la giornata dividersi in un altro modo dopo un aggiornamento.
{
  const rows = [
    { kind: 'task', enabled: true, issueKey: 'ABC-1', activity: { commits: 6 } },
    { kind: 'task', enabled: true, issueKey: 'ABC-2', activity: { commits: 1 } }
  ];
  allocate(rows, base, 480);
  assert.deepEqual(rows.map((r) => r.minutes), [240, 240], 'il default non guarda l attività');
}

// --- in proporzione, chi ha fatto di più prende di più --------------------
{
  const rows = [
    { kind: 'task', enabled: true, issueKey: 'ABC-1', activity: { commits: 3 } },
    { kind: 'task', enabled: true, issueKey: 'ABC-2', activity: { commits: 1 } }
  ];
  allocate(rows, conSplit('activity'), 480);
  assert.deepEqual(rows.map((r) => r.minutes), [360, 120]);
}

// --- commit e modifiche Jira contano insieme ------------------------------
// Sono due tracce dello stesso lavoro: una task seguita solo dentro Jira non
// deve valere zero solo perché non ci sono commit.
{
  const rows = [
    { kind: 'task', enabled: true, issueKey: 'ABC-1', activity: { commits: 2, changes: 1, comments: 1 } },
    { kind: 'task', enabled: true, issueKey: 'ABC-2', activity: { changes: 0, created: 1 } }
  ];
  allocate(rows, conSplit('activity'), 480);
  // 32 unità da 15': 4/5 fa 25,6 e 1/5 fa 6,4 — l'unità di resto va alla
  // frazione più alta, cioè alla prima.
  assert.deepEqual(rows.map((r) => r.minutes), [390, 90], 'quattro tracce contro una');
}

// --- una riga senza tracce prende comunque la sua parte -------------------
// Le righe aggiunte a mano non hanno attività, e il lavoro fatto senza
// lasciare niente in Jira nemmeno: a peso zero sparirebbero dalla giornata
// proprio nel caso in cui te le sei scritte tu.
{
  const rows = [
    { kind: 'task', enabled: true, issueKey: 'ABC-1', activity: { commits: 3 } },
    { kind: 'task', enabled: true, issueKey: 'ABC-2' }
  ];
  allocate(rows, conSplit('activity'), 480);
  assert.deepEqual(rows.map((r) => r.minutes), [360, 120], 'vale come una traccia, non come zero');
  assert.equal(rows.reduce((s, r) => s + r.minutes, 0), 480);
}

// --- le righe bloccate e le riunioni restano fuori dalla proporzione ------
// Una riga corretta a mano vale quello che ci hai scritto: la proporzione si
// applica a quello che avanza, come nella divisione in parti uguali.
{
  const rows = [
    { kind: 'meeting', enabled: true, issueKey: 'ABC-9', defaultMinutes: 30, minutes: 30 },
    { kind: 'task', enabled: true, issueKey: 'ABC-1', locked: true, lockedMinutes: 90, minutes: 90, activity: { commits: 1 } },
    { kind: 'task', enabled: true, issueKey: 'ABC-2', activity: { commits: 3 } },
    { kind: 'task', enabled: true, issueKey: 'ABC-3', activity: { commits: 1 } }
  ];
  allocate(rows, conSplit('activity'), 480);
  assert.equal(rows[0].minutes, 30, 'la riunione tiene la sua durata');
  assert.equal(rows[1].minutes, 90, 'la riga bloccata tiene quello che hai scritto');
  assert.deepEqual([rows[2].minutes, rows[3].minutes], [270, 90], 'il resto si divide 3 a 1');
  assert.equal(rows.reduce((s, r) => s + r.minutes, 0), 480, 'e la giornata torna intera');
}

// --- se qualcuno resta a zero, il piano lo dice --------------------------
// Con la proporzione lo zero non è più per forza l'ultima riga: chi ha fatto
// poco può restare a secco anche stando in mezzo, e l'avviso deve scattare
// lo stesso.
{
  const rows = [
    { kind: 'task', enabled: true, issueKey: 'ABC-1', activity: { commits: 40 } },
    { kind: 'task', enabled: true, issueKey: 'ABC-2', activity: { commits: 1 } },
    { kind: 'task', enabled: true, issueKey: 'ABC-3', activity: { commits: 40 } }
  ];
  const warnings = [];
  allocate(rows, conSplit('activity'), 30, warnings);
  assert.equal(rows[1].minutes, 0, 'la riga in mezzo è quella che resta a secco');
  assert.deepEqual(warnings.map((w) => w.key), ['planTooManyTasks'], 'e il piano lo dice');
}

// --- dentro un piano vero ------------------------------------------------
{
  const jiraActivity = new Map([
    ['ABC-1', { key: 'ABC-1', summary: 'Tanta roba', events: [
      { kind: 'changelog', at: quando(10), by: '', items: [{ field: 'status', from: 'To Do', to: 'In Progress' }] }
    ] }],
    ['ABC-2', { key: 'ABC-2', summary: 'Poca roba', events: [
      { kind: 'changelog', at: quando(11), by: '', items: [{ field: 'labels', from: '', to: 'x' }] }
    ] }]
  ]);
  const gitByIssue = new Map([
    ['ABC-1', [{ subject: 'uno', at: quando(12) }, { subject: 'due', at: quando(13) }, { subject: 'tre', at: quando(14) }]]
  ]);
  const argomenti = {
    isoDate: '2026-08-10',
    jiraActivity,
    gitByIssue,
    recentIssues: [],
    loggedEntries: [],
    alreadyLoggedMinutes: 0
  };

  const uguali = buildPlan({ ...argomenti, config: { ...base, meetings: [] } });
  assert.deepEqual(uguali.rows.map((r) => r.minutes), [240, 240]);

  const proporzione = buildPlan({ ...argomenti, config: { ...conSplit('activity'), meetings: [] } });
  // ABC-1: 3 commit + 1 modifica = 4; ABC-2: 1 modifica. Quattro a uno.
  assert.deepEqual(proporzione.rows.map((r) => r.issueKey), ['ABC-1', 'ABC-2']);
  assert.deepEqual(proporzione.rows.map((r) => r.minutes), [390, 90]);
}

// --- le ore messe a mano da Clockwork hanno la loro riga -----------------
// Segnare un'ora dal calendario di Clockwork e poi non trovarla qui faceva
// sembrare la giornata vuota, e la riga che mancava era proprio quella che
// spiega dove sono finite le ore.
{
  const riga = buildPlan({
    isoDate: '2026-08-10',
    config: { ...base, meetings: [] },
    jiraActivity: new Map(),
    gitByIssue: new Map(),
    recentIssues: [],
    loggedEntries: [{ key: 'ABC-7', summary: 'Segnata da Clockwork', minutes: 60, startMinutes: 9 * 60 }],
    loggedByIssue: { 'ABC-7': 60 },
    alreadyLoggedMinutes: 60
  }).rows.find((r) => r.issueKey === 'ABC-7');

  assert.ok(riga, 'la issue con ore già registrate deve avere una riga');
  assert.equal(riga.summary, 'Segnata da Clockwork',
    'il titolo arriva dal worklog: la ricerca del giorno non la restituisce, perché registrare ore non è un attività');
  assert.equal(riga.existingMinutes, 60);
  assert.equal(riga.enabled, false, 'e parte spenta: le ore ci sono già');
  assert.equal(riga.minutes, 0, 'quindi non si prende niente della giornata');
}

console.log('divisione ore: tutti i controlli passati.');
