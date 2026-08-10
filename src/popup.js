import { breakRanges, redoneKeys, reflow } from './lib/planner.js';
import {
  addMinutes,
  formatMinutes,
  localDateTime,
  minutesToTime,
  timeToMinutes,
  toIsoDate,
  todayIso
} from './lib/dates.js';
import { icon, setIcon } from './lib/icons.js';

const el = {
  date: document.getElementById('date'),
  prevDay: document.getElementById('prev-day'),
  nextDay: document.getElementById('next-day'),
  analyze: document.getElementById('analyze'),
  openOptions: document.getElementById('open-options'),
  messages: document.getElementById('messages'),
  table: document.getElementById('plan'),
  timeline: document.getElementById('timeline'),
  legend: document.getElementById('legend'),
  toggleAll: document.getElementById('toggle-all'),
  addRow: document.getElementById('add-row'),
  rows: document.getElementById('rows'),
  empty: document.getElementById('empty'),
  total: document.getElementById('total'),
  site: document.getElementById('site'),
  submit: document.getElementById('submit'),
  cancelSend: document.getElementById('cancel-send'),
  datalist: document.getElementById('recent-issues')
};

const state = {
  isoDate: todayIso(),
  rows: [],
  budgetMinutes: 480,
  dayBudgetMinutes: 480,
  alreadyLoggedMinutes: 0,
  endOfDay: null,
  overflowMinutes: 0,
  loggedEntries: [],
  // Righe con l'elenco dei worklog già su Jira aperto.
  expanded: new Set(),
  analyzedAt: 0,
  config: null,
  recentIssues: []
};

function send(type, payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, payload }, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response?.ok) {
        const error = new Error(response?.error || 'Errore sconosciuto');
        error.code = response?.code || null;
        error.detail = response?.detail || null;
        return reject(error);
      }
      resolve(response.data);
    });
  });
}

// Peso dei messaggi: piu' basso = piu' in alto. Cosi' quello che richiede un
// intervento non finisce sotto tre righe informative.
const LEVELS = {
  err: { rank: 0, glyph: 'xCircle' },
  action: { rank: 1, glyph: 'alert' },
  ok: { rank: 2, glyph: 'check' },
  info: { rank: 3, glyph: 'info' }
};

/**
 * Accetta sia una stringa sia { text, level }. La tolleranza serve a non
 * mostrare mai "undefined": basta un service worker non ricaricato, che serve
 * ancora il formato vecchio, per ritrovarsi messaggi vuoti in faccia.
 */
function normalizeMessage(input, fallbackLevel) {
  if (typeof input === 'string') return { text: input, level: fallbackLevel || 'info' };
  if (input && typeof input.text === 'string') {
    return { text: input.text, level: input.level || fallbackLevel || 'info' };
  }
  return null;
}

/** Pulsante con icona + testo, ricostruito ogni volta che il testo cambia. */
function setButton(button, name, text) {
  button.replaceChildren(icon(name, { size: 14 }), document.createTextNode(text));
}

function message(text, kind = 'info', action = null) {
  if (typeof text !== 'string' || !text) return;
  const level = LEVELS[kind] ? kind : 'info';
  const { rank, glyph } = LEVELS[level];

  const node = document.createElement('div');
  node.className = `msg ${level}`;
  node.dataset.rank = String(rank);

  const mark = document.createElement('span');
  mark.className = 'glyph';
  mark.appendChild(icon(glyph, { size: 15 }));

  const body = document.createElement('span');
  body.className = 'body';
  body.append(text);
  if (action) {
    const button = document.createElement('button');
    button.className = 'ghost inline';
    button.textContent = action.label;
    button.addEventListener('click', action.onClick);
    body.appendChild(button);
  }

  node.append(mark, body);

  const after = [...el.messages.children].find((child) => Number(child.dataset.rank) > rank);
  el.messages.insertBefore(node, after || null);
}

function clearMessages() {
  el.messages.replaceChildren();
}

function shiftDay(days) {
  const date = localDateTime(state.isoDate);
  date.setDate(date.getDate() + days);
  state.isoDate = toIsoDate(date);
  el.date.value = state.isoDate;
}

/**
 * Ridistribuisce le ore libere; le righe modificate a mano restano intoccate.
 * Stessa funzione usata dal planner: una sola implementazione, nessuna deriva.
 */
function redistribute() {
  if (!state.config) return;
  // Stessa funzione che costruisce il piano: monte ore e orari seguono
  // entrambi le righe accese, e non ci sono due ricette da tenere allineate.
  const { budgetMinutes, endOfDay } = reflow(state.rows, state.config, {
    dayBudgetMinutes: state.dayBudgetMinutes,
    alreadyLoggedMinutes: state.alreadyLoggedMinutes,
    loggedEntries: state.loggedEntries
  });
  state.budgetMinutes = budgetMinutes;
  state.endOfDay = endOfDay;
}

/** Le righe che verranno davvero scritte: accese, con un ticket e con ore. */
function sendableRows() {
  return state.rows.filter((row) => row.enabled && row.issueKey && row.minutes);
}

function updateTotal() {
  const inviabili = sendableRows();
  const total = inviabili.reduce((sum, row) => sum + row.minutes, 0);
  const sendable = inviabili.length;
  // Quanto avrà la giornata dopo l'invio: le ore già registrate che stiamo
  // rifacendo contano due volte, ed è giusto che si veda.
  const rifatte = state.rows
    .filter((row) => row.enabled && row.existingMinutes)
    .reduce((sum, row) => sum + row.existingMinutes, 0);
  const finale = state.alreadyLoggedMinutes + total;
  const sforo = finale - state.dayBudgetMinutes;

  el.total.classList.toggle('over', sforo > 0);
  el.total.replaceChildren();
  const strong = document.createElement('strong');
  strong.textContent = formatMinutes(total);

  const parti = [` da distribuire su ${formatMinutes(state.budgetMinutes)}`];
  if (state.alreadyLoggedMinutes) {
    parti.push(` · ${formatMinutes(state.alreadyLoggedMinutes)} già registrate su ${formatMinutes(state.dayBudgetMinutes)}`);
  }
  parti.push(` · ${sendable} riga/e`);
  if (sendable && state.endOfDay) parti.push(` · fine giornata ${state.endOfDay}`);
  if (sforo > 0) {
    parti.push(rifatte
      ? ` · la giornata arriverebbe a ${formatMinutes(finale)}: stai rimettendo ${formatMinutes(rifatte)} già registrate`
      : ` · la giornata arriverebbe a ${formatMinutes(finale)}`);
  }
  el.total.append(strong, parti.join(''));

  // Ogni ricalcolo annulla una conferma in sospeso: il piano è cambiato, e
  // confermare un totale che non è più quello sarebbe una trappola.
  state.overflowMinutes = Math.max(0, sforo);
  disarmSubmit();
  el.submit.disabled = sendable === 0;
  setButton(el.submit, 'send', sendable ? `Invia ${sendable} worklog` : 'Invia worklog');
}

// Invio in due passi quando la giornata sforerebbe il monte ore: il pulsante
// diventa rosso e chiede conferma, con la via d'uscita accanto.
let confirmingSend = false;

function armSubmit() {
  confirmingSend = true;
  el.submit.classList.remove('primary');
  el.submit.classList.add('danger');
  setButton(el.submit, 'send', `Conferma: la giornata arriverà a ${formatMinutes(
    state.alreadyLoggedMinutes + sendableRows().reduce((s, r) => s + r.minutes, 0)
  )}`);
  el.cancelSend.hidden = false;
}

// Senza uscita anticipata: dev'essere idempotente, altrimenti basta un giro in
// cui `confirmingSend` è già falso perché "Annulla" resti visibile per sempre.
function disarmSubmit() {
  confirmingSend = false;
  el.submit.classList.remove('danger');
  el.submit.classList.add('primary');
  el.cancelSend.hidden = true;
}

/** I segmenti di una riga, o l'unico blocco se non sono stati calcolati. */
function segmentsOf(row) {
  if (row.segments?.length) return row.segments;
  return row.time && row.minutes ? [{ time: row.time, minutes: row.minutes }] : [];
}

/** "09:00–13:00 + 14:00–18:00" */
function timeLabel(row) {
  const segments = segmentsOf(row);
  if (!segments.length) return '—';
  return segments.map((s) => `${s.time}–${addMinutes(s.time, s.minutes)}`).join(' + ');
}

/** Aggiorna solo ore e orari, per non far perdere il focus mentre si digita. */
function syncValues() {
  for (const row of state.rows) {
    const tr = el.rows.querySelector(`tr[data-id="${CSS.escape(row.id)}"]`);
    if (!tr) continue;
    const hours = tr.querySelector('.hours');
    if (hours && document.activeElement !== hours) {
      hours.value = row.minutes ? +(row.minutes / 60).toFixed(2) : 0;
    }
    hours?.classList.toggle('locked', Boolean(row.locked));
    const time = tr.querySelector('.time');
    if (time) time.textContent = timeLabel(row);
  }
  // Anche l'anteprima segue la modifica: senza, restava ferma al piano vecchio.
  renderTimeline();
  updateTotal();
}

function badge(text, kind) {
  const span = document.createElement('span');
  span.className = `badge ${kind}`;
  span.textContent = text;
  return span;
}

function renderRow(row) {
  const tr = document.createElement('tr');
  tr.dataset.id = row.id;
  tr.className = row.kind;
  tr.classList.toggle('disabled', !row.enabled);
  tr.addEventListener('mouseenter', () => highlight(row.id, true));
  tr.addEventListener('mouseleave', () => highlight(row.id, false));

  // Attiva / disattiva
  const tdCheck = document.createElement('td');
  const check = document.createElement('input');
  check.type = 'checkbox';
  check.checked = row.enabled;
  check.addEventListener('change', () => {
    row.enabled = check.checked;
    // Da qui in poi la riga la comandi tu: un aggiornamento in background non
    // deve più riaccenderla o rispegnerla sotto le mani.
    row.userToggled = true;
    row.autoDisabled = false;
    redistribute();
    render();
  });
  tdCheck.appendChild(check);

  // Issue (testo libero con suggerimenti dalle issue recenti)
  const tdIssue = document.createElement('td');
  const issue = document.createElement('input');
  issue.type = 'text';
  issue.className = 'issue-input';
  issue.setAttribute('list', 'recent-issues');
  // Il progetto nel suggerimento viene dalla configurazione, non dal codice.
  const esempio = state.config?.jira?.projects?.[0];
  issue.placeholder = row.kind === 'meeting'
    ? 'Ticket cerimonie…'
    : (esempio ? `${esempio}-…` : 'ABC-123');
  issue.value = row.issueKey || '';
  issue.addEventListener('change', () => {
    row.issueKey = issue.value.trim().toUpperCase();
    row.guessed = false;
    const match = state.recentIssues.find((i) => i.key === row.issueKey);
    if (match) row.summary = match.summary;

    if (row.kind === 'meeting' && row.memoryKey) {
      send('rememberMeetingIssue', { memoryKey: row.memoryKey, issueKey: row.issueKey }).catch(() => {});

      // Se quel ticket era finito anche fra le task, quella riga sparisce:
      // l'attività Jira sul ticket cerimonie è la riunione stessa.
      const clashes = state.rows.filter((r) => r.kind === 'task' && r.issueKey === row.issueKey);
      if (clashes.length) {
        state.rows = state.rows.filter((r) => !(r.kind === 'task' && r.issueKey === row.issueKey));
        message(`${row.issueKey} era anche fra le task: l'ho tolto, resta solo come riunione.`, 'info');
      }
    }
    redistribute();
    render();
  });
  tdIssue.appendChild(issue);

  // Descrizione + nota che finira' nel commento del worklog
  const tdWhat = document.createElement('td');
  const summary = document.createElement('div');
  summary.className = 'summary';
  if (row.kind === 'meeting') summary.appendChild(icon('calendar', { size: 14 }));
  summary.append(row.kind === 'meeting' ? row.label : (row.summary || '(titolo non disponibile)'));

  const badges = document.createElement('span');
  badges.className = 'badges';
  if (row.sources?.includes('jira')) badges.appendChild(badge('jira', 'jira'));
  if (row.sources?.includes('git')) badges.appendChild(badge('git', 'git'));
  if (row.guessed) {
    const why = {
      orario: "proposto perché a quell'ora risulta già un worklog su questo ticket",
      nome: 'proposto per somiglianza col nome della riunione',
      data: 'proposto perché il titolo contiene la data di oggi'
    }[row.guessReason] || 'proposta automatica';
    const mark = badge('proposto', 'dup');
    mark.title = why;
    badges.appendChild(mark);
  }
  if (row.existingMinutes) badges.appendChild(badge(`già ${formatMinutes(row.existingMinutes)}`, 'dup'));
  summary.appendChild(badges);

  const detail = document.createElement('div');
  detail.className = 'detail';
  detail.textContent = row.kind === 'meeting' && row.summary
    ? `${row.detail} · ${row.summary}`
    : (row.detail || '');

  const comment = document.createElement('input');
  comment.type = 'text';
  comment.className = 'comment';
  comment.placeholder = 'Nota del worklog (opzionale)';
  comment.value = row.comment || '';
  comment.addEventListener('input', () => { row.comment = comment.value; });

  tdWhat.append(summary, detail, comment);

  // Ore
  const tdHours = document.createElement('td');
  const hours = document.createElement('input');
  hours.type = 'number';
  hours.className = 'hours';
  hours.min = '0';
  hours.step = String((state.config?.work.roundingMinutes || 15) / 60);
  hours.value = row.minutes ? +(row.minutes / 60).toFixed(2) : 0;
  hours.classList.toggle('locked', Boolean(row.locked));
  hours.addEventListener('change', () => {
    row.minutes = Math.max(0, Math.round(Number(hours.value || 0) * 60));
    // Memorizzato a parte: spegnendo la riga le ore mostrate vanno a zero, ma
    // riaccendendola torna il valore che hai scritto tu.
    row.lockedMinutes = row.minutes;
    row.locked = true;
    redistribute();
    syncValues();
  });
  tdHours.appendChild(hours);

  // Intervallo occupato: per una riunione è lo slot, per una task il blocco
  // che verrà scritto.
  const tdTime = document.createElement('td');
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = timeLabel(row);
  if (segmentsOf(row).length > 1) {
    time.title = 'Spezzato dalla pausa: verranno scritti più worklog.';
  }
  tdTime.appendChild(time);

  // Azioni: togliere la riga dal piano, e — se ci sono già ore su Jira —
  // cancellarle davvero.
  const tdActions = document.createElement('td');

  if (row.existingMinutes && row.issueKey) {
    const wipe = document.createElement('button');
    wipe.className = 'remove wipe';
    wipe.classList.toggle('open', state.expanded.has(row.id));
    setIcon(wipe, 'trash');
    wipe.title = `Mostra le ${formatMinutes(row.existingMinutes)} già registrate ` +
      `oggi su ${row.issueKey}, per cancellarle`;
    // Niente conferma cieca: si apre l'elenco dei singoli worklog e si sceglie.
    // Con un doppione, cancellarli tutti in blocco sarebbe la cosa sbagliata.
    wipe.addEventListener('click', () => {
      if (state.expanded.has(row.id)) state.expanded.delete(row.id);
      else state.expanded.add(row.id);
      render();
    });
    tdActions.appendChild(wipe);
  }

  const remove = document.createElement('button');
  remove.className = 'remove';
  setIcon(remove, 'x');
  remove.title = 'Togli dal piano (non tocca Jira)';
  remove.addEventListener('click', () => {
    state.rows = state.rows.filter((r) => r.id !== row.id);
    redistribute();
    render();
  });
  tdActions.appendChild(remove);

  tr.append(tdCheck, tdIssue, tdWhat, tdHours, tdTime, tdActions);
  return tr;
}

/**
 * Dopo aver scritto o cancellato: si rilegge il piano e poi si ricarica la
 * pagina Jira, che altrimenti resta ferma ai dati vecchi. In quest'ordine,
 * perché l'analisi passa proprio da quella scheda.
 */
async function afterWrite(issueKeys) {
  // Basta rileggere le ore: scrivere o cancellare worklog non cambia quali
  // issue compongono la giornata, solo quante ore hanno già sopra.
  await refreshLogged({ force: issueKeys, silent: false });
  // L'esito va detto: ingoiando l'errore, un service worker non ricaricato
  // (che risponde "comando sconosciuto") sembrava un semplice non-succede-nulla.
  try {
    const out = await send('reloadSite');
    if (!out.reloaded) {
      message(
        'Nessuna scheda Jira da ricaricare: il calendario sotto potrebbe mostrare i dati di prima.',
        'info'
      );
    }
  } catch (error) {
    message(`Non ho potuto ricaricare la pagina Jira: ${error.message}`, 'action');
  }
}

/** I worklog già registrati oggi su una issue, in ordine di orario. */
function loggedFor(issueKey) {
  return state.loggedEntries
    .filter((entry) => entry.key === issueKey && entry.id)
    .sort((a, b) => a.startMinutes - b.startMinutes);
}

async function removeWorklogs(row, worklogIds, button) {
  button.disabled = true;
  const originale = button.textContent;
  button.textContent = '…';
  try {
    const out = await send('deleteLogged', {
      isoDate: state.isoDate,
      issueKey: row.issueKey,
      worklogIds
    });
    clearMessages();
    if (out.error) {
      message(
        `${row.issueKey}: cancellati ${out.deleted} worklog su ${out.total} ` +
        `(${formatMinutes(out.minutes)}), poi si è fermato: ${out.error}`,
        'err'
      );
    } else {
      message(
        `${row.issueKey}: cancellati ${out.deleted} worklog (${formatMinutes(out.minutes)}).`,
        'ok'
      );
    }
    state.expanded.delete(row.id);
    await afterWrite([row.issueKey]);
  } catch (error) {
    reportAuthError(error, () => {});
    button.disabled = false;
    button.textContent = originale;
  }
}

/** Riga espansa: i singoli worklog già su Jira, ciascuno cancellabile da solo. */
function renderWorklogRow(row) {
  const entries = loggedFor(row.issueKey);
  const tr = document.createElement('tr');
  tr.className = 'worklogs';

  // Due celle vuote (spunta e issue) così il pannello parte allineato alla
  // colonna COSA, sotto il contenuto della riga a cui appartiene.
  const td = document.createElement('td');
  td.colSpan = 4;

  const titolo = document.createElement('div');
  titolo.className = 'worklogs-title';

  if (!entries.length) {
    // Il badge dice che ci sono ore, ma i singoli worklog non sono arrivati:
    // succede col service worker non ricaricato, che non manda ancora gli id.
    titolo.textContent = `Non riesco a elencare i singoli worklog di ${row.issueKey} ` +
      `(${formatMinutes(row.existingMinutes)} in totale). Ricarica l'estensione, ` +
      'oppure cancellali tutti:';
    td.appendChild(titolo);
    const tutti = document.createElement('button');
    tutti.className = 'ghost inline danger-text';
    tutti.textContent = `Cancella tutte le ${formatMinutes(row.existingMinutes)}`;
    tutti.addEventListener('click', () => removeWorklogs(row, null, tutti));
    td.appendChild(tutti);
    tr.append(document.createElement('td'), document.createElement('td'), td);
    return tr;
  }

  titolo.textContent = entries.length === 1
    ? `Worklog già su Jira per ${row.issueKey}:`
    : `${entries.length} worklog già su Jira per ${row.issueKey} — cancellali singolarmente:`;
  td.appendChild(titolo);

  for (const entry of entries) {
    const riga = document.createElement('div');
    riga.className = 'worklog-item';

    const quando = document.createElement('span');
    quando.textContent = `${minutesToTime(entry.startMinutes)}–` +
      `${minutesToTime(entry.startMinutes + entry.minutes)} · ${formatMinutes(entry.minutes)}`;

    const del = document.createElement('button');
    del.className = 'ghost inline';
    del.textContent = 'Cancella';
    del.addEventListener('click', () => removeWorklogs(row, [entry.id], del));

    riga.append(quando, del);
    td.appendChild(riga);
  }

  if (entries.length > 1) {
    const tutti = document.createElement('button');
    tutti.className = 'ghost inline danger-text';
    tutti.textContent = `Cancella tutti e ${entries.length}`;
    tutti.addEventListener('click', () => removeWorklogs(row, entries.map((e) => e.id), tutti));
    td.appendChild(tutti);
  }

  tr.append(document.createElement('td'), document.createElement('td'), td);
  return tr;
}

// ---------------------------------------------------------------- anteprima

/** I blocchi che compongono la giornata, pronti da disegnare. */
function timelineBlocks() {
  const blocchi = [];

  for (const row of state.rows) {
    if (!row.enabled || !row.issueKey) continue;
    for (const segment of row.segments || []) {
      const from = timeToMinutes(segment.time);
      blocchi.push({
        tipo: row.kind === 'meeting' ? 'meeting' : 'task',
        rowId: row.id,
        from,
        to: from + segment.minutes,
        label: `${row.issueKey} · ${segment.time}–${addMinutes(segment.time, segment.minutes)}`
      });
    }
  }

  // Le ore già registrate che non stai rifacendo: occupano la giornata ma non
  // verranno riscritte. Stessa definizione che usa il planner, così il grafico
  // non può mostrare una giornata diversa da quella che verrà scritta.
  const rifatte = redoneKeys(state.rows);
  for (const entry of state.loggedEntries) {
    if (rifatte.has(entry.key)) continue;
    blocchi.push({
      tipo: 'logged',
      from: entry.startMinutes,
      to: entry.startMinutes + entry.minutes,
      label: `${entry.key} · già registrate`
    });
  }

  for (const pausa of state.config ? breakRanges(state.config) : []) {
    blocchi.push({ tipo: 'pause', from: pausa.from, to: pausa.to, label: 'Pausa' });
  }

  return blocchi;
}

/**
 * L'asse copre sempre la giornata come l'hai configurata — inizio, monte ore e
 * pause — e non solo i blocchi presenti: con tutte le righe spente si sarebbe
 * ristretto attorno alla sola pausa.
 */
function timelineExtent(blocchi) {
  const work = state.config?.work || {};
  const inizio = timeToMinutes(work.startTime || '09:00');
  const pause = state.config ? breakRanges(state.config) : [];
  const minutiPausa = pause.reduce((sum, p) => sum + (p.to - p.from), 0);
  const fine = inizio + Math.round((work.dailyHours || 8) * 60) + minutiPausa;

  const da = Math.floor(Math.min(inizio, ...blocchi.map((b) => b.from)) / 60) * 60;
  const a = Math.ceil(Math.max(fine, ...blocchi.map((b) => b.to)) / 60) * 60;
  return { da, a: Math.max(a, da + 60) };
}

function renderTimeline() {
  if (!state.config || !state.rows.length) {
    el.timeline.hidden = true;
    el.legend.hidden = true;
    return;
  }
  el.timeline.hidden = false;

  const blocchi = timelineBlocks();
  const { da, a } = timelineExtent(blocchi);
  const span = a - da;
  const pct = (minuti) => `${((minuti - da) / span) * 100}%`;

  // Circa 40px per ora, ma mai più alta dello spazio disponibile: una giornata
  // lunga deve comprimersi, non far scorrere via tutto il resto.
  const scale = el.timeline.querySelector('.scale');
  // Il pavimento serve alla prima apertura, quando il popup non ha ancora le
  // sue dimensioni e l'area misurata risulta quasi zero: senza, l'anteprima
  // nasceva schiacciata. Subito dopo `render` rimisura a layout avvenuto.
  const disponibile = Math.max(300, (el.timeline.parentElement?.clientHeight || 0) - 20);
  const altezza = Math.min(Math.round((span / 60) * 40), disponibile);
  scale.style.height = `${altezza}px`;

  const ruler = el.timeline.querySelector('.ruler');
  ruler.replaceChildren();
  // Le etichette si diradano quando lo spazio si stringe, così non si accavallano.
  const pxPerMinuto = altezza / span;
  let passo = 60;
  while (passo * pxPerMinuto < 22 && passo < 8 * 60) passo *= 2;
  for (let m = da; m <= a; m += passo) {
    const tick = document.createElement('span');
    tick.className = 'tick';
    tick.style.top = pct(m);
    tick.textContent = minutesToTime(m);
    ruler.appendChild(tick);
  }

  const track = el.timeline.querySelector('.track');
  track.replaceChildren();
  // Le pause per prime, così stanno sotto agli altri blocchi.
  const ordine = { pause: 0, logged: 1, meeting: 2, task: 3 };
  for (const blocco of [...blocchi].sort((x, y) => ordine[x.tipo] - ordine[y.tipo])) {
    const nodo = document.createElement('div');
    nodo.className = `block ${blocco.tipo}`;
    nodo.style.top = pct(blocco.from);
    nodo.style.height = `${((blocco.to - blocco.from) / span) * 100}%`;
    nodo.title = blocco.label;
    if (blocco.rowId) nodo.dataset.rowId = blocco.rowId;
    track.appendChild(nodo);
  }

  // La legenda sta sopra la tabella, non in fondo alla colonna: lì finiva
  // fuori dall'area visibile del popup.
  const legend = el.legend;
  legend.replaceChildren();
  legend.hidden = false;
  const voci = [
    ['task', 'da scrivere'],
    ['meeting', 'riunioni'],
    ['logged', 'già registrate'],
    ['pause', 'pausa']
  ];
  for (const [tipo, testo] of voci) {
    if (!blocchi.some((b) => b.tipo === tipo)) continue;
    const voce = document.createElement('span');
    voce.className = 'legend-item';
    const swatch = document.createElement('i');
    swatch.className = `block ${tipo}`;
    voce.append(swatch, document.createTextNode(testo));
    legend.appendChild(voce);
  }
}

// Una sola rimisurazione in coda, non una per ogni `render` della raffica.
let pendingMeasure = null;
function measureLater() {
  if (pendingMeasure) return;
  pendingMeasure = requestAnimationFrame(() => {
    pendingMeasure = null;
    renderTimeline();
  });
}

/** Evidenzia nell'anteprima i blocchi della riga sotto il mouse. */
function highlight(rowId, on) {
  for (const nodo of el.timeline.querySelectorAll('.block[data-row-id]')) {
    if (nodo.dataset.rowId === rowId) nodo.classList.toggle('hot', on);
  }
}

let emptyMessage = 'Analizzo la giornata…';

function render() {
  // Riga di stacco fra riunioni ricorrenti e attività: sono due cose diverse
  // e la tabella lo deve far vedere.
  const nodes = [];
  let previousKind = null;
  for (const row of state.rows) {
    const tr = renderRow(row);
    if (previousKind && previousKind !== row.kind) tr.classList.add('section-start');
    previousKind = row.kind;
    nodes.push(tr);
    if (state.expanded.has(row.id) && row.existingMinutes && row.issueKey) {
      nodes.push(renderWorklogRow(row));
    }
  }
  el.rows.replaceChildren(...nodes);
  renderTimeline();
  // L'altezza disponibile è attendibile solo a layout avvenuto: si rimisura al
  // frame successivo, così l'anteprima si adatta invece di restare schiacciata.
  measureLater();

  // Lo stato del "seleziona tutto" riflette le righe: parziale = indeterminato.
  const accese = state.rows.filter((row) => row.enabled).length;
  el.toggleAll.checked = accese > 0 && accese === state.rows.length;
  el.toggleAll.indeterminate = accese > 0 && accese < state.rows.length;
  el.toggleAll.disabled = state.rows.length === 0;

  const hasRows = state.rows.length > 0;
  el.table.hidden = !hasRows;
  el.empty.hidden = hasRows;
  // Aggiungere a mano ha senso solo dopo un'analisi riuscita: prima non si sa
  // nemmeno su che sito si sta lavorando.
  el.addRow.hidden = !state.config;
  el.empty.textContent = emptyMessage;
  updateTotal();
}

function splitKey(key) {
  const match = /^(.*)-(\d+)$/.exec(String(key || ''));
  return match ? { project: match[1], number: Number(match[2]) } : { project: String(key || ''), number: 0 };
}

/**
 * I suggerimenti si leggono meglio raggruppati: progetto in ordine alfabetico,
 * e dentro ogni progetto il numero piu' alto per primo, che e' il lavoro
 * recente. L'ordine originale (per ultimo aggiornamento) resta quello che usa
 * il planner per sciogliere i pareggi fra proposte, quindi si ordina una copia.
 */
function sortedIssues(issues) {
  return [...issues].sort((a, b) => {
    const left = splitKey(a.key);
    const right = splitKey(b.key);
    return left.project.localeCompare(right.project) || right.number - left.number;
  });
}

function renderDatalist() {
  el.datalist.replaceChildren(
    ...sortedIssues(state.recentIssues).map((issue) => {
      const option = document.createElement('option');
      option.value = issue.key;
      option.textContent = issue.summary;
      return option;
    })
  );
}

/** Indicatore in basso: da che sito stiamo leggendo e con quale autenticazione. */
function setSite(text, kind = '') {
  el.site.className = `site ${kind}`;
  el.site.replaceChildren();
  const dot = document.createElement('span');
  dot.className = 'dot';
  el.site.append(dot, text);
}

async function refreshSite() {
  try {
    const status = await send('siteStatus');
    if (!status.host) return setSite('Nessun sito Jira configurato', 'down');

    const origin = status.configured ? '' : ' (rilevato dal browser)';
    if (!status.tabsOnSite) {
      return setSite(`${status.host}${origin} · nessuna scheda aperta`, 'down');
    }
    setSite(`${status.host}${origin} · sessione del browser`, 'live');
  } catch (error) {
    setSite(error.message, 'down');
  }
}

/** Apre il sito in una scheda di servizio e aspetta che abbia finito di caricare. */
function openAndWait(host, { active = false } = {}) {
  return new Promise((resolve) => {
    chrome.tabs.create({ url: `https://${host}/`, active }, (tab) => {
      const timer = setTimeout(finish, 15000);
      function onUpdated(tabId, info) {
        if (tabId === tab.id && info.status === 'complete') finish();
      }
      function finish() {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve(tab.id);
      }
      chrome.tabs.onUpdated.addListener(onUpdated);
    });
  });
}

/** Errori di autenticazione: invece del solo messaggio, offre il rimedio. */
function reportAuthError(error, retry) {
  const host = error.detail?.host;
  const openHosts = error.detail?.openHosts || [];

  if (error.code === 'NO_TAB' && host) {
    const altri = openHosts.filter((h) => h !== host);
    const extra = altri.length
      ? ` Hai aperto ${altri.join(', ')}, ma la configurazione punta a ${host}.`
      : '';
    return message(
      `Nessuna scheda aperta su ${host}, quindi non posso usare la tua sessione.${extra}`,
      'action',
      {
        label: 'Apri e riprova',
        onClick: async () => { await openAndWait(host); retry(); }
      }
    );
  }

  if (error.code === 'SESSION_INVALID' && host) {
    return message(
      `La scheda su ${host} c'è ma la sessione non è valida: rifai il login e riprova.`,
      'action',
      {
        label: 'Vai al login',
        onClick: () => chrome.tabs.create({ url: `https://${host}/`, active: true })
      }
    );
  }

  if (error.code === 'TAB_GONE' && host) {
    return message(error.message, 'action', {
      label: 'Riapri e riprova',
      onClick: async () => { await openAndWait(host); retry(); }
    });
  }

  if (error.code === 'NO_HOST') {
    return message(error.message, 'err', {
      label: 'Apri opzioni',
      onClick: () => chrome.runtime.openOptionsPage()
    });
  }

  message(error.message, 'err');
}

// L'analisi parte da sola: all'apertura e a ogni cambio data. Il token scarta i
// risultati di una richiesta superata da una piu' recente (succede tenendo
// premuto ‹ o ›), cosi' in tabella non finisce mai il giorno sbagliato.
let analyzeToken = 0;
let analyzeTimer = null;

function scheduleAnalyze(delay = 250) {
  clearTimeout(analyzeTimer);
  analyzeTimer = setTimeout(() => analyze(), delay);
}

/**
 * Aggiornamento leggero: rilegge solo le ore già registrate e ridisegna.
 * Una richiesta invece delle decine di un'analisi completa, che rifarebbe
 * attività, commit e issue recenti — roba che non cambia da sola.
 */
async function refreshLogged({ force = [], silent = true } = {}) {
  if (!state.config || !state.rows.length) return analyze();
  const token = ++analyzeToken;
  const forzate = new Set(force);

  try {
    const dati = await send('refreshLogged', { isoDate: state.isoDate });
    if (token !== analyzeToken) return undefined;

    state.alreadyLoggedMinutes = dati.alreadyLoggedMinutes;
    state.loggedEntries = dati.loggedEntries;

    for (const row of state.rows) {
      row.existingMinutes = dati.loggedByIssue[row.issueKey] || 0;

      // Su una issue appena scritta o ripulita la scelta di prima non vale più:
      // lasciarla accesa dopo un invio significherebbe offrirti il doppione.
      if (forzate.has(row.issueKey)) row.userToggled = false;
      if (row.userToggled) continue;

      if (row.existingMinutes && row.enabled) {
        row.enabled = false;
        row.autoDisabled = true;
      } else if (!row.existingMinutes && row.autoDisabled) {
        row.enabled = true;
        row.autoDisabled = false;
      }
    }

    state.analyzedAt = Date.now();
    redistribute();
    render();
  } catch (error) {
    // Al rientro sul popup è cortesia e si tace; dopo una scrittura no: se il
    // piano non si aggiorna, quello che vedi non è più quello che c'è su Jira.
    if (!silent) message(`Piano non aggiornato: ${error.message}`, 'action');
  }
  return undefined;
}

async function analyze({ preserveMessages = false } = {}) {
  clearTimeout(analyzeTimer);
  const token = ++analyzeToken;
  const forDate = state.isoDate;

  if (!preserveMessages) clearMessages();
  el.analyze.disabled = true;
  setButton(el.analyze, 'refresh', 'Analizzo…');

  // Si riparte dallo stato di apertura: tabella e anteprima spariscono finché
  // non arriva il piano nuovo, invece di lasciare in vista quello vecchio.
  emptyMessage = 'Analizzo la giornata…';
  state.rows = [];
  state.expanded.clear();
  render();

  try {
    const data = await send('analyze', { isoDate: forDate });
    if (token !== analyzeToken) return;
    state.config = data.config;
    state.budgetMinutes = data.budgetMinutes;
    state.dayBudgetMinutes = data.dayBudgetMinutes;
    state.alreadyLoggedMinutes = data.alreadyLoggedMinutes || 0;
    state.endOfDay = data.endOfDay || null;
    state.loggedEntries = data.loggedEntries || [];
    state.recentIssues = data.recentIssues || [];
    // Le righe arrivano gia' con `enabled` deciso dal planner: una issue che ha
    // gia' un worklog quel giorno parte spenta.
    state.rows = data.rows.map((row) => ({ ...row, locked: false }));
    emptyMessage = 'Niente da registrare per questa giornata.';
    redistribute();
    renderDatalist();
    render();

    for (const raw of [...(data.warnings || []), ...(data.notes || [])]) {
      const entry = normalizeMessage(raw);
      if (entry) message(entry.text, entry.level);
    }

    const missing = state.rows.filter((row) => row.enabled && !row.issueKey);
    if (missing.length) {
      message(
        `${missing.length} riunione/i senza ticket: scegli la issue dal campo con i suggerimenti.`,
        'action'
      );
    }

    // Solo per le righe che verranno davvero inviate: su una riga spenta la
    // proposta non ha conseguenze, e l'avviso sarebbe rumore.
    const guessed = state.rows.filter((row) => row.guessed && row.enabled && row.issueKey);
    if (guessed.length) {
      message(
        `Ticket riunione proposto in automatico (${guessed.map((r) => r.issueKey).join(', ')}): ` +
        'controlla che sia quello giusto prima di inviare.',
        'action'
      );
    }
    if (data.site?.host) setSite(`${data.site.host} · sessione del browser`, 'live');
  } catch (error) {
    if (token !== analyzeToken) return;
    reportAuthError(error, analyze);
    state.rows = [];
    emptyMessage = 'Nessun piano per questa giornata.';
    render();
  } finally {
    if (token === analyzeToken) {
      state.analyzedAt = Date.now();
      el.analyze.disabled = false;
      setButton(el.analyze, 'refresh', 'Aggiorna');
    }
  }
}

async function submit() {
  el.submit.disabled = true;
  setButton(el.submit, 'send', 'Invio…');
  try {
    const payload = state.rows.map((row) => ({
      kind: row.kind,
      issueKey: row.issueKey,
      minutes: row.minutes,
      time: row.time,
      segments: row.segments,
      comment: row.comment,
      memoryKey: row.memoryKey,
      enabled: row.enabled
    }));
    const { results } = await send('submit', { isoDate: state.isoDate, rows: payload });
    clearMessages();

    const ok = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);
    if (ok.length) {
      const parti = ok.reduce((sum, r) => sum + (r.parts || 1), 0);
      const dettaglio = parti > ok.length ? ` (${parti} worklog, alcune righe spezzate dalla pausa)` : '';
      message(`${ok.length} righe registrate${dettaglio}: ${ok.map((r) => r.issueKey).join(', ')}.`, 'ok');
    }
    failed.forEach((r) => message(`${r.issueKey}: ${r.error}`, 'err'));

    // Le righe andate a buon fine escono subito dal piano, cosi' un secondo
    // invio non puo' duplicarle mentre la tabella si aggiorna.
    // Le righe restano nel piano: rilette da Jira mostrano il badge "già Xh" e
    // si spengono da sole, così resta visibile cosa hai appena scritto — e il
    // cestino per disfarlo. Prima sparivano, e per rivederle serviva
    // un'analisi completa.
    if (ok.length) await afterWrite(ok.map((r) => r.issueKey));
  } catch (error) {
    reportAuthError(error, submit);
  } finally {
    updateTotal(); // rimette anche l'etichetta giusta sul pulsante
  }
}

el.date.value = state.isoDate;
el.date.addEventListener('change', () => {
  if (!el.date.value) return;
  state.isoDate = el.date.value;
  scheduleAnalyze(0);
});
el.prevDay.addEventListener('click', () => { shiftDay(-1); scheduleAnalyze(); });
el.nextDay.addEventListener('click', () => { shiftDay(1); scheduleAnalyze(); });
// Il rilevamento automatico può non vedere qualcosa — una riunione fuori
// programma, un ticket su cui hai lavorato senza lasciare tracce. Senza questo
// pulsante l'unica via era andare a mano su Jira, che è il motivo per cui
// l'estensione esiste.
el.addRow.addEventListener('click', () => {
  state.rows.push({
    id: `manuale:${Date.now()}`,
    kind: 'task',
    issueKey: '',
    summary: '',
    label: '',
    minutes: 0,
    time: '',
    segments: [],
    sources: [],
    detail: 'Aggiunta a mano',
    comment: '',
    enabled: true,
    existingMinutes: 0,
    locked: false
  });
  redistribute();
  render();
  // Il campo della riga nuova prende il fuoco: si è appena chiesto di scriverci.
  el.rows.querySelector('tr:last-child .issue-input')?.focus();
});

el.toggleAll.addEventListener('change', () => {
  for (const row of state.rows) {
    row.enabled = el.toggleAll.checked;
    row.userToggled = true;
    row.autoDisabled = false;
  }
  redistribute();
  render();
});
el.analyze.addEventListener('click', () => analyze());
el.submit.addEventListener('click', () => {
  // Se la giornata sforerebbe, il primo clic arma la conferma invece di inviare.
  if (state.overflowMinutes > 0 && !confirmingSend) {
    armSubmit();
    return;
  }
  disarmSubmit();
  submit();
});

// `updateTotal` disarma da sé e rimette l'etichetta normale.
el.cancelSend.addEventListener('click', updateTotal);
el.openOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());

// All'apertura del popup si parte da oggi, senza dover premere niente.
window.addEventListener('resize', () => renderTimeline());

// Il piano è una fotografia del momento in cui è stato letto: se nel frattempo
// sposti o cancelli un worklog da Clockwork, tornando qui va riletto. Il
// margine evita di rianalizzare a ogni sfarfallio di focus.
window.addEventListener('focus', () => {
  if (Date.now() - state.analyzedAt < 3000) return;
  refreshLogged();
});

setIcon(el.prevDay, 'chevronLeft');
setIcon(el.nextDay, 'chevronRight');
setIcon(el.openOptions, 'settings');

refreshSite();
analyze();
