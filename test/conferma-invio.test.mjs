// Quando l'invio va confermato. Lo sforo del monte ore era l'unico caso
// previsto, ma il doppione è più insidioso: 30m su una issue che oggi ne ha già
// 30 non sfora niente su 8h, e scrive comunque un worklog di troppo.

import assert from 'node:assert/strict';

/** Le righe che verranno scritte, come le calcola il popup. */
const inviabili = (rows) => rows.filter((r) => r.enabled && r.issueKey && r.minutes);

/** La condizione che arma la conferma, e cosa la fa scattare. */
function rischio(rows, { alreadyLoggedMinutes, dayBudgetMinutes }) {
  const righe = inviabili(rows);
  const totale = righe.reduce((s, r) => s + r.minutes, 0);
  const overflowMinutes = Math.max(0, alreadyLoggedMinutes + totale - dayBudgetMinutes);
  const duplicateRows = righe.filter((r) => r.existingMinutes);
  return {
    overflowMinutes,
    duplicateRows,
    conferma: overflowMinutes > 0 || duplicateRows.length > 0
  };
}

const riga = (over = {}) => ({
  issueKey: 'ABC-1', enabled: true, minutes: 60, existingMinutes: 0, ...over
});
const giornata = { alreadyLoggedMinutes: 0, dayBudgetMinutes: 480 };

// --- giornata normale: nessuna conferma, si invia e basta ------------------
{
  const r = rischio([riga({ minutes: 300 }), riga({ issueKey: 'ABC-2', minutes: 180 })], giornata);
  assert.equal(r.conferma, false, '8h pulite non chiedono conferma');
  assert.equal(r.overflowMinutes, 0);
  assert.equal(r.duplicateRows.length, 0);
}

// --- IL CASO: doppione che non sfora --------------------------------------
// 30m su una issue che oggi ne ha già 30, su un monte ore di 8h.
{
  const r = rischio([riga({ minutes: 30, existingMinutes: 30 })], {
    alreadyLoggedMinutes: 30, dayBudgetMinutes: 480
  });
  assert.equal(r.overflowMinutes, 0, 'la giornata resta ben dentro le 8h');
  assert.equal(r.duplicateRows.length, 1, 'ma è un doppione');
  assert.equal(r.conferma, true, 'e va confermato: prima passava liscio');
  assert.equal(r.duplicateRows[0].issueKey, 'ABC-1', 'si sa quale, per poterlo dire');
  assert.equal(r.duplicateRows[0].existingMinutes, 30, 'e quanto c è già');
}

// --- doppione su più righe ------------------------------------------------
{
  const r = rischio([
    riga({ issueKey: 'ABC-1', minutes: 60, existingMinutes: 60 }),
    riga({ issueKey: 'ABC-2', minutes: 60, existingMinutes: 120 }),
    riga({ issueKey: 'ABC-3', minutes: 60, existingMinutes: 0 })
  ], { alreadyLoggedMinutes: 180, dayBudgetMinutes: 480 });
  assert.equal(r.duplicateRows.length, 2, 'solo quelle che hanno già ore');
  assert.equal(r.conferma, true);
}

// --- una riga spenta non conta, anche se ha ore già registrate -------------
{
  const r = rischio([riga({ enabled: false, existingMinutes: 120 })], {
    alreadyLoggedMinutes: 120, dayBudgetMinutes: 480
  });
  assert.equal(r.conferma, false, 'spenta non scrive niente: niente da confermare');
}

// --- una riga senza ticket nemmeno -----------------------------------------
{
  const r = rischio([riga({ issueKey: '', existingMinutes: 60 })], giornata);
  assert.equal(r.conferma, false);
}

// --- lo sforo continua a valere da solo -----------------------------------
{
  const r = rischio([riga({ minutes: 120 })], { alreadyLoggedMinutes: 420, dayBudgetMinutes: 480 });
  assert.equal(r.overflowMinutes, 60, '7h già messe + 2h = 9h su 8h');
  assert.equal(r.duplicateRows.length, 0, 'senza doppioni');
  assert.equal(r.conferma, true);
}

// --- e i due casi insieme: lo sforo è il messaggio che vince ---------------
{
  const r = rischio([riga({ minutes: 120, existingMinutes: 420 })], {
    alreadyLoggedMinutes: 420, dayBudgetMinutes: 480
  });
  assert.ok(r.overflowMinutes > 0 && r.duplicateRows.length > 0, 'entrambi presenti');
  assert.equal(r.conferma, true);
}

console.log('conferma invio: tutti i controlli passati.');
