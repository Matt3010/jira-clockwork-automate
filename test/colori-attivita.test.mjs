// I colori delle attività nell'anteprima.
//
// Due regole reggono tutto, e sono quelle che si rompono in silenzio:
// il colore segue il ticket (non la sua posizione, non quali righe sono
// accese), e i colori sono tre perché tre è quanto regge il controllo su
// tutte le coppie — un quarto sarebbe indistinguibile da un altro.

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
  return posizione >= 0 && posizione < 3 ? `s${posizione + 1}` : '';
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

// --- oltre la terza si ripiega su un neutro, non si inventa ---------------
{
  const rows = [task('ABC-1'), task('ABC-2'), task('ABC-3'), task('ABC-4'), task('ABC-5')];
  assert.deepEqual(rows.map((r) => seriesClass(rows, r.issueKey)), ['s1', 's2', 's3', '', '']);
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

console.log('colori attività: tutti i controlli passati.');
