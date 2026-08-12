// Rileggere da soli, e dirlo.
//
// Jira non ha un canale a cui restare in ascolto — niente WebSocket
// pubbliche, e i webhook vogliono un server che li riceva, cioè credenziali
// depositate da qualche parte. Resta il rileggere ogni tanto, e allora quello
// che vedi ha un'ora di lettura: l'etichetta la scrive, così non si indovina.
//
// È comportamento del DOM e qui non c'è un DOM: si verifica sul sorgente.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const popup = readFileSync(join(root, 'src/popup.js'), 'utf8');
const blocco = (nome) => {
  const inizio = popup.indexOf(`function ${nome}(`);
  assert.ok(inizio > -1, `manca la funzione ${nome}`);
  return popup.slice(inizio, popup.indexOf('\n}', inizio));
};

// --- ogni vista ha la sua freschezza --------------------------------------
// Un contrassegno unico direbbe "letto ora" anche su una scheda che non si
// apre da dieci minuti.
{
  const corpo = blocco('freshnessAt');
  for (const [vista, campo] of [
    ['tickets', 'state.ticketsAt'], ['log', 'state.logAt'], ['ore', 'state.analyzedAt']
  ]) {
    assert.ok(corpo.includes(campo), `la vista ${vista} non ha un momento di lettura suo`);
  }

  // E i tre campi devono essere davvero scritti quando la lettura riesce,
  // non solo dichiarati.
  for (const campo of ['ticketsAt', 'logAt', 'analyzedAt']) {
    assert.match(popup, new RegExp(`state\\.${campo} = Date\\.now\\(\\)`),
      `state.${campo} non viene mai aggiornato: l etichetta resterebbe ferma`);
  }
}

// --- l'etichetta dice un'ora, non un'età ---------------------------------
// L'età non diceva niente: la rilettura scatta al minuto e riazzera il conto,
// quindi restava «ora» sempre — tranne quando la rilettura è bloccata, cioè
// quando non stai guardando. Un orario vale qualunque sia il passo.
{
  const corpo = blocco('syncLabel');
  assert.match(corpo, /eventTime\(quando\)/, 'l etichetta deve scrivere l ora della lettura');
  assert.doesNotMatch(corpo, /Date\.now\(\) - /,
    'un conto sull età torna a dire «ora» a ogni rilettura');
}

// --- l'etichetta si riscrive quando il momento di lettura cambia ----------
{
  assert.match(popup, /setInterval\(pollIfIdle/, 'niente batte il tempo');
  assert.match(blocco('pollIfIdle'), /syncLabel\(\)/,
    'il battito deve riscrivere l etichetta anche quando non rilegge');

  // E dopo ogni disegno, per non aspettare il battito successivo.
  for (const nome of ['render', 'renderLog', 'renderTickets', 'showTab']) {
    assert.match(blocco(nome), /syncLabel\(\)/, `${nome} non aggiorna l etichetta`);
  }

  // L'analisi registra il momento di lettura *dopo* aver disegnato: se non
  // riscrive l'etichetta li', all'apertura del popup resta vuota per un
  // battito intero.
  assert.match(popup, /state\.analyzedAt = Date\.now\(\);\n\s*(\/\/[^\n]*\n\s*)*syncLabel\(\)/,
    'chi registra il momento di lettura deve riscrivere subito l etichetta');
}

// --- il battito è più fitto della rilettura -------------------------------
// Il battito controlla se è ora di rileggere: con lo stesso passo della
// rilettura, ogni giro arriverebbe sistematicamente in ritardo di un giro.
{
  const passo = (nome) => Number(popup.match(new RegExp(`const ${nome} = (\\d+)`))?.[1]);
  const poll = passo('POLL_MS');
  const tick = passo('TICK_MS');
  assert.ok(poll >= 30000, `rileggere ogni ${poll}ms è troppo spesso per una richiesta di rete`);
  assert.ok(tick < poll, 'il battito dell etichetta deve essere più fitto della rilettura');
}

// --- rileggere non deve rovinare quello che stai facendo ------------------
// Ognuna di queste è un modo concreto di togliere il lavoro di mano a chi sta
// usando il popup in quel momento, non prudenza generica.
{
  const corpo = blocco('pollIfIdle');
  assert.match(corpo, /visibilityState !== 'visible'/,
    'a finestra nascosta non c è niente da tenere fresco, e sono richieste buttate');
  assert.match(corpo, /state\.busy/, 'durante un analisi decide lei quando i dati cambiano');
  assert.match(corpo, /'INPUT'|'TEXTAREA'/,
    'mentre scrivi, ricaricare ti toglierebbe il campo da sotto le dita');
  assert.match(corpo, /\.moves:not\(\[hidden\]\)/,
    'un menu di spostamento aperto è un azione a metà: non va richiusa da sola');

  // Sulle ore la rilettura dev'essere quella leggera: l'analisi completa
  // rifarebbe attività e commit, che non cambiano da soli, e ogni minuto.
  assert.match(corpo, /refreshLogged\(\)/, 'il piano va riletto nella versione leggera');
  assert.doesNotMatch(corpo, /\banalyze\(/,
    'un analisi completa al minuto sono decine di richieste per un dato che non cambia');
}

console.log('freschezza: tutti i controlli passati.');
