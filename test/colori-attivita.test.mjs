// I colori delle attività nell'anteprima.
//
// Due regole reggono tutto, e sono quelle che si rompono in silenzio:
// il colore segue il ticket (non la sua posizione, non quali righe sono
// accese), e le tinte sono tre perché tre è quanto regge il controllo su tutte
// le coppie — una quarta tinta sarebbe indistinguibile da un'altra (sotto
// protanopia il viola *è* blu: 2.7 di distanza percettiva, cioè lo stesso
// colore).
//
// Da qui la seconda dimensione: le stesse tre tinte con tre riempimenti —
// pieno, rigato, vuoto col contorno — fanno nove identità tutte diverse, e il
// riempimento si legge anche in bianco e nero.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(root, 'src/popup.css'), 'utf8');

/** La stessa assegnazione che fa il popup. */
function seriesClass(rows, issueKey) {
  if (!issueKey) return '';
  const chiavi = [...new Set(
    rows.filter((r) => r.kind === 'task' && r.issueKey).map((r) => r.issueKey)
  )].sort();
  const posizione = chiavi.indexOf(issueKey);
  if (posizione < 0) return '';
  const tinta = `s${(posizione % 3) + 1}`;
  const riempimento = Math.floor(posizione / 3) % 3;
  return riempimento ? `${tinta} v${riempimento + 1}` : tinta;
}

const task = (issueKey, over = {}) => ({ kind: 'task', issueKey, enabled: true, ...over });

// --- colori diversi per attività diverse ----------------------------------
{
  const rows = [task('ABC-1'), task('ABC-2'), task('XYZ-9')];
  const colori = rows.map((r) => seriesClass(rows, r.issueKey));
  assert.deepEqual(colori, ['s1', 's2', 's3']);
  assert.equal(new Set(colori).size, 3, 'tre attività, tre colori distinti');
}

// --- una riunione non prende un colore di serie ---------------------------
{
  const rows = [{ kind: 'meeting', issueKey: 'XYZ-9', enabled: true }, task('ABC-1')];
  assert.equal(seriesClass(rows, 'ABC-1'), 's1',
    'la riunione non occupa uno slot: ha già il suo colore');
}

// --- IL PUNTO: spegnere una riga non ricolora le altre --------------------
{
  const rows = [task('ABC-1'), task('ABC-2'), task('XYZ-9')];
  const prima = rows.map((r) => seriesClass(rows, r.issueKey));

  rows[0].enabled = false;
  const dopo = rows.map((r) => seriesClass(rows, r.issueKey));
  assert.deepEqual(dopo, prima, 'una riga spenta non deve ridipingere le superstiti');
}

// --- né riordinare il piano -----------------------------------------------
{
  const rows = [task('ABC-1'), task('ABC-2'), task('XYZ-9')];
  const atteso = Object.fromEntries(rows.map((r) => [r.issueKey, seriesClass(rows, r.issueKey)]));

  const riordinate = [rows[2], rows[0], rows[1]];
  for (const [chiave, colore] of Object.entries(atteso)) {
    assert.equal(seriesClass(riordinate, chiave), colore,
      `${chiave} cambia colore solo perché è cambiato l ordine`);
  }
}

// --- IL PUNTO: due attività non devono mai apparire uguali ----------------
// Prima la quarta e le successive ripiegavano tutte sullo stesso neutro: in una
// giornata da cinque ticket, due pastiglie identiche e nessun modo di sapere
// quale blocco fosse quale.
{
  const rows = Array.from({ length: 9 }, (_, i) => task(`ABC-${i + 1}`));
  const aspetti = rows.map((r) => seriesClass(rows, r.issueKey));
  assert.equal(new Set(aspetti).size, 9, 'nove attività, nove aspetti diversi');
  assert.deepEqual(aspetti, [
    's1', 's2', 's3',
    's1 v2', 's2 v2', 's3 v2',
    's1 v3', 's2 v3', 's3 v3'
  ], 'prima si esauriscono le tinte, poi si cambia riempimento');

  // Oltre la nona si ricomincia, e va detto: nessun codice visivo regge più in
  // là. La chiave accanto alla pastiglia resta l'identità vera della riga.
  // Chiavi con lo zero davanti: l'ordine è alfabetico, e senza lo zero
  // «ABC-10» starebbe fra «ABC-1» e «ABC-2» invece che in fondo.
  const dieci = Array.from({ length: 10 }, (_, i) => task(`ABC-${String(i + 1).padStart(2, '0')}`));
  assert.equal(seriesClass(dieci, 'ABC-10'), 's1', 'la decima ricomincia dalla prima combinazione');
}

// --- i tre colori esistono in entrambi i temi -----------------------------
const chiaro = css.slice(css.indexOf(':root {'), css.indexOf('@media'));
const scuro = css.slice(css.indexOf('@media'), css.indexOf('* { box-sizing'));
for (const slot of ['--series-1', '--series-2', '--series-3', '--series-other']) {
  assert.ok(chiaro.includes(`${slot}:`), `${slot} manca nel tema chiaro`);
  assert.ok(scuro.includes(`${slot}:`), `${slot} manca nel tema scuro — non è un ribaltamento automatico`);
}

// I valori sono quelli usciti dal validatore: se qualcuno li ritocca a occhio,
// la terna va rivalidata su tutte le coppie prima di cambiarli qui.
for (const hex of ['#2a78d6', '#1baf7a', '#e34948']) {
  assert.ok(chiaro.includes(hex), `il tema chiaro non usa più ${hex}: rivalidare la terna`);
}
for (const hex of ['#3987e5', '#199e70', '#e66767']) {
  assert.ok(scuro.includes(hex), `il tema scuro non usa più ${hex}: rivalidare la terna`);
}

// --- ogni colore ha una regola, per il blocco e per la pastiglia ----------
for (const s of ['s1', 's2', 's3']) {
  assert.match(css, new RegExp(`\\.block\\.task\\.${s}`), `manca lo stile del blocco ${s}`);
  assert.match(css, new RegExp(`\\.chip\\.${s}`), `manca lo stile della pastiglia ${s}`);
}

// --- e ogni riempimento, o le classi in più non fanno niente --------------
// È il modo silenzioso di rompere tutto: `seriesClass` distingue nove casi, il
// foglio ne disegna tre, e le sei attività in fondo tornano identiche.
for (const v of ['v2', 'v3']) {
  assert.match(css, new RegExp(`\\.block\\.task\\.${v} \\{`), `manca il riempimento ${v} sul blocco`);
  assert.match(css, new RegExp(`\\.chip\\.${v} \\{`), `manca il riempimento ${v} sulla pastiglia`);
  // Il riempimento disegna con `currentColor`: senza la tinta passata da lì,
  // riga e contorno prendono il colore del testo e sono tutti uguali.
  for (const s of ['s1', 's2', 's3']) {
    assert.match(css, new RegExp(`\\.chip\\.${v}\\.${s}`), `la pastiglia ${v}.${s} non ha una tinta`);
    assert.match(css, new RegExp(`\\.block\\.task\\.${v}\\.${s}`), `il blocco ${v}.${s} non ha una tinta`);
  }
}

console.log('colori attività: tutti i controlli passati.');
