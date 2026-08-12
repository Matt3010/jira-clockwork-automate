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
import { send } from './lib/comandi.js';
import { t, applyI18n } from './lib/i18n.js';
import { describeEvent, eventTime, logAsText } from './lib/registro.js';

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
  listHead: document.getElementById('list-head'),
  sync: document.getElementById('sync'),
  rowTools: document.getElementById('row-tools'),
  addRow: document.getElementById('add-row'),
  copyDate: document.getElementById('copy-date'),
  copyDo: document.getElementById('copy-do'),
  rows: document.getElementById('rows'),
  empty: document.getElementById('empty'),
  total: document.getElementById('total'),
  site: document.getElementById('site'),
  submit: document.getElementById('submit'),
  cancelSend: document.getElementById('cancel-send'),
  datalist: document.getElementById('recent-issues'),
  tabHours: document.getElementById('tab-hours'),
  tabLog: document.getElementById('tab-log'),
  tabTickets: document.getElementById('tab-tickets'),
  dayPicker: document.getElementById('day-picker'),
  logView: document.getElementById('log-view'),
  log: document.getElementById('log'),
  logEmpty: document.getElementById('log-empty'),
  logCount: document.getElementById('log-count'),
  logCopy: document.getElementById('log-copy'),
  ticketsView: document.getElementById('tickets-view'),
  tickets: document.getElementById('tickets'),
  ticketsEmpty: document.getElementById('tickets-empty'),
  ticketsCount: document.getElementById('tickets-count'),
  ticketsSearch: document.getElementById('tickets-search'),
  main: document.querySelector('main'),
  footer: document.querySelector('footer')
};

const state = {
  isoDate: todayIso(),
  rows: [],
  budgetMinutes: 480,
  dayBudgetMinutes: 480,
  alreadyLoggedMinutes: 0,
  endOfDay: null,
  overflowMinutes: 0,
  duplicateRows: [],
  busy: false,
  loggedEntries: [],
  // Righe con l'elenco dei worklog già su Jira aperto.
  expanded: new Set(),
  analyzedAt: 0,
  // Vista corrente e registro attività: il registro si carica solo quando lo
  // apri, e la giornata per cui vale serve a sapere se è da rileggere.
  tab: 'hours',
  logEvents: [],
  logDate: null,
  logAt: 0,
  config: null,
  recentIssues: [],
  // I ticket aperti non dipendono dal giorno: si leggono una volta e restano.
  ticketGroups: [],
  ticketsTotal: 0,
  ticketsLoaded: false,
  ticketsAt: 0,
  // Le transizioni già lette, per non richiederle a ogni apertura del menu.
  transitionsByKey: new Map(),
  // Ricerca: quando è attiva prende il posto dell'elenco, e i risultati non
  // sono raggruppati — hanno già un ordine loro, di rilevanza.
  searchQuery: '',
  searchResults: [],
  host: ''
};

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
  if (!input) return null;
  const level = input.level || fallbackLevel || 'info';
  // Planner e background mandano chiave + parametri: la frase la compone qui,
  // nella lingua giusta. `text` resta accettato per i messaggi già pronti.
  if (input.key) return { text: t(input.key, ...(input.params || [])), level };
  if (typeof input.text === 'string') return { text: input.text, level };
  return null;
}

/**
 * Pulsante con icona + testo. L'etichetta sta in un elemento suo perché possa
 * essere troncata invece di mandare a capo il pulsante: con una conferma lunga
 * il testo si spezzava e il pulsante si deformava. Il testo intero resta nel
 * title, così non si perde niente.
 */
function setButton(button, name, text) {
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = text;
  button.replaceChildren(icon(name, { size: 14 }), label);
  button.title = text;
}

/** Quanto resta a schermo una conferma prima di togliersi di mezzo. */
const DURATA_OK = 5000;

/**
 * Un avviso nel popup.
 *
 * `channel` raggruppa gli avvisi che si riferiscono alla stessa cosa: il
 * nuovo prende il posto del vecchio invece di accodarsi. Serve dove l'azione
 * si ripete — spostare cinque ticket di fila lasciava cinque conferme
 * impilate, che insieme dicono meno dell'ultima da sola.
 */
function message(text, kind = 'info', action = null, { channel = '' } = {}) {
  if (typeof text !== 'string' || !text) return;
  // Lo stesso avviso tre volte non informa tre volte di più: succede quando un
  // errore si ripete a ogni tentativo, e riempie il popup di rumore.
  for (const esistente of el.messages.children) {
    if (esistente.dataset.text === text) return;
  }
  if (channel) {
    for (const esistente of [...el.messages.children]) {
      if (esistente.dataset.channel === channel) esistente.remove();
    }
  }
  const level = LEVELS[kind] ? kind : 'info';
  const { rank, glyph } = LEVELS[level];

  const node = document.createElement('div');
  node.className = `msg ${level}`;
  node.dataset.rank = String(rank);
  node.dataset.text = text;
  if (channel) node.dataset.channel = channel;

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

  // Una conferma ha finito il suo lavoro appena l'hai letta, e in un popup
  // alto quattro righe lo spazio che occupa è quello del contenuto. Errori e
  // avvisi restano: quelli vanno letti con calma, e a volte agiti.
  if (level === 'ok' && !action) setTimeout(() => node.remove(), DURATA_OK);
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

/**
 * Un solo interruttore per "sto analizzando": finché il piano non è arrivato,
 * i comandi che agiscono su di esso non devono essere premibili, e il totale
 * non deve mostrare numeri riferiti a un piano che non esiste più.
 */
function setBusy(on) {
  state.busy = on;
  // Anche visivamente: i pulsanti spenti non bastano a far capire che il
  // contenuto sotto non è più valido.
  document.body.classList.toggle('busy', on);
  el.analyze.disabled = on;
  el.addRow.disabled = on;
  el.copyDo.disabled = on;
  el.copyDate.disabled = on;
  el.toggleAll.disabled = on || state.rows.length === 0;
  updateTotal();
}

function updateTotal() {
  // Durante l'analisi non si sa ancora niente: si dice quello, invece di
  // lasciare in vista i conti di prima.
  if (state.busy) {
    disarmSubmit();
    state.overflowMinutes = 0;
    state.duplicateRows = [];
    el.total.classList.remove('over');
    el.total.replaceChildren(document.createTextNode(t('emptyAnalysing')));
    el.submit.disabled = true;
    setButton(el.submit, 'send', t('btnSend'));
    return;
  }

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

  const parti = [t('totalDistribute', formatMinutes(state.budgetMinutes))];
  if (state.alreadyLoggedMinutes) {
    parti.push(t('totalAlready', formatMinutes(state.alreadyLoggedMinutes), formatMinutes(state.dayBudgetMinutes)));
  }
  parti.push(t('totalRows', sendable));
  if (sendable && state.endOfDay) parti.push(t('totalEndOfDay', state.endOfDay));
  if (sforo > 0) {
    parti.push(rifatte
      ? t('totalOverflowRedo', formatMinutes(finale), formatMinutes(rifatte))
      : t('totalOverflow', formatMinutes(finale)));
  }
  el.total.append(strong, parti.join(''));

  // Ogni ricalcolo annulla una conferma in sospeso: il piano è cambiato, e
  // confermare un totale che non è più quello sarebbe una trappola.
  state.overflowMinutes = Math.max(0, sforo);
  // Righe che stanno per scrivere ore su una issue che oggi ne ha già: non
  // sforano per forza il monte ore, ma restano doppioni.
  state.duplicateRows = inviabili.filter((row) => row.existingMinutes);
  disarmSubmit();
  el.submit.disabled = sendable === 0;
  // Una riga sola ha la sua frase: in inglese «Send 1 worklogs» si legge come
  // un difetto, ed e' il pulsante che si guarda piu' spesso di tutti.
  const etichetta = sendable === 1 ? t('btnSendCountOne') : t('btnSendCount', sendable);
  setButton(el.submit, 'send', sendable ? etichetta : t('btnSend'));
}

// Invio in due passi quando la giornata sforerebbe il monte ore: il pulsante
// diventa rosso e chiede conferma, con la via d'uscita accanto.
let confirmingSend = false;

/** Un invio è da confermare se sfora il monte ore o se riscrive ore già messe. */
function needsConfirm() {
  return state.overflowMinutes > 0 || state.duplicateRows.length > 0;
}

/** Cosa dire sul pulsante rosso. Lo sforo vince: è il problema più grande. */
function confirmLabel() {
  if (state.overflowMinutes > 0) {
    return t('btnConfirmDay', formatMinutes(
      state.alreadyLoggedMinutes + sendableRows().reduce((s, r) => s + r.minutes, 0)
    ));
  }
  const doppioni = state.duplicateRows;
  return doppioni.length === 1
    ? t('btnConfirmDuplicateOne', doppioni[0].issueKey, formatMinutes(doppioni[0].existingMinutes))
    : t('btnConfirmDuplicateMany', doppioni.length);
}

/**
 * Unico interruttore dello stato di conferma: colore del pulsante, etichetta e
 * presenza di "Annulla" cambiano sempre insieme.
 *
 * Erano tre istruzioni sparse in due funzioni, e bastava un giro in cui una non
 * veniva eseguita perché "Annulla" restasse in vista con il pulsante ancora blu.
 * Legandole qui, quello stato non è più rappresentabile.
 */
function setConfirming(on) {
  confirmingSend = on;
  el.submit.classList.toggle('danger', on);
  el.submit.classList.toggle('primary', !on);
  el.cancelSend.hidden = !on;
  if (on) setButton(el.submit, 'send', confirmLabel());
}

const armSubmit = () => setConfirming(true);
const disarmSubmit = () => setConfirming(false);

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

/**
 * La riga in una frase. Il planner conta gli eventi, la frase si compone qui:
 * singolare e plurale cambiano da lingua a lingua.
 */
function describeRow(row) {
  if (row.kind === 'meeting') {
    const slot = t('meetingRecurring', row.time, addMinutes(row.time, row.defaultMinutes ?? row.minutes));
    return row.summary ? `${slot} · ${row.summary}` : slot;
  }
  if (row.detail) return row.detail; // righe aggiunte a mano
  const { changes = 0, created = 0, comments = 0, commits = 0 } = row.activity || {};
  const parti = [];
  // Prima la creazione: se il ticket l'hai aperto tu quel giorno, è il fatto
  // che spiega tutti gli altri.
  if (created) parti.push(t('activityCreated'));
  if (changes) parti.push(t(changes === 1 ? 'activityChange' : 'activityChanges', changes));
  if (comments) parti.push(t(comments === 1 ? 'activityComment' : 'activityComments', comments));
  if (commits) parti.push(t(commits === 1 ? 'activityCommit' : 'activityCommits', commits));
  return parti.join(' · ');
}

/**
 * A quale colore appartiene un ticket.
 *
 * L'assegnazione parte dalle chiavi in ordine alfabetico, non dall'ordine in
 * tabella né da quali righe sono accese: spegnere una riga o riordinare il
 * piano non deve ricolorare le altre. Oltre la terza attività si ripiega su un
 * neutro — tre è il numero che regge il controllo su tutte le coppie, e
 * inventare una quarta tinta la renderebbe indistinguibile da una delle altre.
 */
function seriesClass(issueKey) {
  if (!issueKey) return '';
  const chiavi = [...new Set(
    state.rows.filter((row) => row.kind === 'task' && row.issueKey).map((row) => row.issueKey)
  )].sort();
  const posizione = chiavi.indexOf(issueKey);
  return posizione >= 0 && posizione < 3 ? `s${posizione + 1}` : '';
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
  tdCheck.className = 'col-check';
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
  tdIssue.className = 'col-issue';
  const issue = document.createElement('input');
  issue.type = 'text';
  issue.className = 'issue-input';
  issue.setAttribute('list', 'recent-issues');
  // Il progetto nel suggerimento viene dalla configurazione, non dal codice.
  const esempio = state.config?.jira?.projects?.[0];
  issue.placeholder = row.kind === 'meeting'
    ? t('phMeetingTicket')
    : (esempio ? t('phIssuePrefix', esempio) : t('phIssueExample'));
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
        message(t('msgClash', row.issueKey), 'info');
      }
    }
    redistribute();
    render();
  });
  tdIssue.appendChild(issue);

  // Descrizione + nota che finira' nel commento del worklog
  const tdWhat = document.createElement('td');
  tdWhat.className = 'col-what';
  const summary = document.createElement('div');
  summary.className = 'summary';
  if (row.kind === 'meeting') {
    summary.appendChild(icon('calendar', { size: 14 }));
  } else {
    const chip = document.createElement('span');
    chip.className = `chip ${seriesClass(row.issueKey)}`.trim();
    summary.appendChild(chip);
  }
  summary.append(row.kind === 'meeting' ? row.label : (row.summary || t('rowNoTitle')));

  const badges = document.createElement('span');
  badges.className = 'badges';
  if (row.sources?.includes('jira')) badges.appendChild(badge('jira', 'jira'));
  if (row.sources?.includes('git')) badges.appendChild(badge('git', 'git'));
  if (row.guessed) {
    const why = {
      orario: t('whyTime'),
      nome: t('whyName'),
      data: t('whyDate')
    }[row.guessReason] || t('whyAuto');
    const mark = badge(t('badgeProposed'), 'dup');
    mark.title = why;
    badges.appendChild(mark);
  }
  if (row.existingMinutes) badges.appendChild(badge(t('badgeAlready', formatMinutes(row.existingMinutes)), 'dup'));
  summary.appendChild(badges);

  const detail = document.createElement('div');
  detail.className = 'detail';
  detail.textContent = describeRow(row);

  const comment = document.createElement('input');
  comment.type = 'text';
  comment.className = 'comment';
  comment.placeholder = t('phComment');
  comment.value = row.comment || '';
  comment.addEventListener('input', () => { row.comment = comment.value; });

  tdWhat.append(summary, detail, comment);

  // Ore
  const tdHours = document.createElement('td');
  tdHours.className = 'col-hours';
  const hours = document.createElement('input');
  hours.type = 'number';
  hours.className = 'hours';
  hours.min = '0';
  hours.step = String((state.config?.work.roundingMinutes || 15) / 60);
  hours.value = row.minutes ? +(row.minutes / 60).toFixed(2) : 0;
  // Stretto l'intestazione non c'è: un campo numerico da solo non dice di
  // cosa sia il numero.
  hours.title = t('labelHours');
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
  tdTime.className = 'col-time';
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = timeLabel(row);
  if (segmentsOf(row).length > 1) {
    time.title = t('titleSplitByBreak');
  }
  tdTime.appendChild(time);

  // Azioni: togliere la riga dal piano, e — se ci sono già ore su Jira —
  // cancellarle davvero.
  const tdActions = document.createElement('td');
  tdActions.className = 'col-actions';

  if (row.existingMinutes && row.issueKey) {
    const wipe = document.createElement('button');
    wipe.className = 'remove wipe';
    wipe.classList.toggle('open', state.expanded.has(row.id));
    setIcon(wipe, 'trash');
    wipe.title = t('titleWipe', formatMinutes(row.existingMinutes), row.issueKey);
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
  remove.title = t('titleRemoveRow');
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
        t('msgReloadNone'),
        'info'
      );
    }
  } catch (error) {
    message(t('msgReloadFailed', error.message), 'action');
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
        t('msgDeletedPartial', row.issueKey, out.deleted, out.total, formatMinutes(out.minutes), out.error),
        'err'
      );
    } else {
      message(
        t('msgDeleted', row.issueKey, out.deleted, formatMinutes(out.minutes)),
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
    titolo.textContent = t('worklogsUnlistable', row.issueKey, formatMinutes(row.existingMinutes));
    td.appendChild(titolo);
    const tutti = document.createElement('button');
    tutti.className = 'ghost inline danger-text';
    tutti.textContent = t('btnDeleteAllAmount', formatMinutes(row.existingMinutes));
    tutti.addEventListener('click', () => removeWorklogs(row, null, tutti));
    td.appendChild(tutti);
    tr.append(document.createElement('td'), document.createElement('td'), td);
    return tr;
  }

  titolo.textContent = entries.length === 1
    ? t('worklogsOne', row.issueKey)
    : t('worklogsMany', entries.length, row.issueKey);
  td.appendChild(titolo);

  for (const entry of entries) {
    const riga = document.createElement('div');
    riga.className = 'worklog-item';

    const quando = document.createElement('span');
    quando.textContent = `${minutesToTime(entry.startMinutes)}–` +
      `${minutesToTime(entry.startMinutes + entry.minutes)} · ${formatMinutes(entry.minutes)}`;

    const del = document.createElement('button');
    del.className = 'ghost inline';
    del.textContent = t('btnDelete');
    del.addEventListener('click', () => removeWorklogs(row, [entry.id], del));

    riga.append(quando, del);
    td.appendChild(riga);
  }

  if (entries.length > 1) {
    const tutti = document.createElement('button');
    tutti.className = 'ghost inline danger-text';
    tutti.textContent = t('btnDeleteAllCount', entries.length);
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
        serie: row.kind === 'meeting' ? '' : seriesClass(row.issueKey),
        rowId: row.id,
        from,
        to: from + segment.minutes,
        label: t('tlBlock', row.issueKey, segment.time, addMinutes(segment.time, segment.minutes))
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
      label: t('tlLogged', entry.key)
    });
  }

  for (const pausa of state.config ? breakRanges(state.config) : []) {
    blocchi.push({ tipo: 'pause', from: pausa.from, to: pausa.to, label: t('tlPause') });
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

  // Verticale o orizzontale non lo decide il JS: lo dichiara il foglio di
  // stile in `--asse`, e qui si legge. Così la larghezza a cui l'anteprima si
  // corica sta scritta in un posto solo, insieme a tutte le altre soglie.
  const orizzontale = getComputedStyle(el.timeline).getPropertyValue('--asse').trim() === 'orizzontale';

  const scale = el.timeline.querySelector('.scale');
  // Il pavimento serve alla prima apertura, quando la finestra non ha ancora
  // le sue dimensioni e l'area misurata risulta quasi zero: senza, l'anteprima
  // nasceva schiacciata. Subito dopo `render` rimisura a layout avvenuto.
  const disponibile = Math.max(300, (el.timeline.parentElement?.clientHeight || 0) - 20);
  // Coricata la lunghezza è quella che c'è: una giornata non può allargare la
  // finestra. In piedi sono circa 40px per ora, ma mai più dello spazio
  // disponibile — una giornata lunga deve comprimersi, non far scorrere via
  // tutto il resto.
  const lungoAsse = orizzontale
    ? Math.max(240, el.timeline.clientWidth)
    : Math.min(Math.round((span / 60) * 40), disponibile);
  // La misura la applica il CSS, che sa su quale lato metterla. Coricata gli
  // serve solo per diradare le etichette: la larghezza la prende dal
  // contenitore, così l'ultima ora cade sul bordo e non poco prima.
  scale.style.setProperty('--lungo-asse', `${lungoAsse}px`);

  const ruler = el.timeline.querySelector('.ruler');
  ruler.replaceChildren();
  // Le etichette si diradano quando lo spazio si stringe, così non si
  // accavallano. Coricate ne serve di più: "09:00" è largo, ma alto una riga.
  const pxPerMinuto = lungoAsse / span;
  const minimo = orizzontale ? 46 : 22;
  let passo = 60;
  while (passo * pxPerMinuto < minimo && passo < 8 * 60) passo *= 2;
  for (let m = da; m <= a; m += passo) {
    const tick = document.createElement('span');
    tick.className = 'tick';
    // Un'etichetta è centrata sul suo istante, quindi agli estremi metà di
    // essa cadrebbe fuori dall'asse — ed è la metà che si legge per prima:
    // "09:00" diventava "9:00". Le due di bordo si appoggiano al bordo.
    const quota = ((m - da) / span) * 100;
    if (quota <= 1.5) tick.classList.add('bordo-inizio');
    else if (quota >= 98.5) tick.classList.add('bordo-fine');
    tick.style.setProperty('--inizio', pct(m));
    tick.textContent = minutesToTime(m);
    ruler.appendChild(tick);
  }

  const track = el.timeline.querySelector('.track');
  track.replaceChildren();
  // Le pause per prime, così stanno sotto agli altri blocchi.
  const ordine = { pause: 0, logged: 1, meeting: 2, task: 3 };
  for (const blocco of [...blocchi].sort((x, y) => ordine[x.tipo] - ordine[y.tipo])) {
    const nodo = document.createElement('div');
    nodo.className = `block ${blocco.tipo} ${blocco.serie || ''}`.trim();
    // Dove comincia e quanto dura, in percentuale della giornata mostrata: su
    // quale asse diventino non è affare di qui.
    nodo.style.setProperty('--inizio', pct(blocco.from));
    nodo.style.setProperty('--durata', `${((blocco.to - blocco.from) / span) * 100}%`);
    nodo.title = blocco.label;
    if (blocco.rowId) nodo.dataset.rowId = blocco.rowId;
    track.appendChild(nodo);
  }

  // La legenda sta sopra la tabella, non in fondo alla colonna: lì finiva
  // fuori dall'area visibile del popup.
  const legend = el.legend;
  legend.replaceChildren();
  legend.hidden = false;
  // Le attività non hanno una voce di legenda: hanno un colore ciascuna, e la
  // corrispondenza sta nella pastiglia accanto alla riga — che è una legenda
  // migliore, perché dice anche di quale ticket si tratta. Qui restano le
  // categorie fisse, che un colore solo ce l'hanno davvero.
  const voci = [
    ['meeting', t('legendMeeting')],
    ['logged', t('legendLogged')],
    ['pause', t('legendPause')]
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

let emptyMessage = t('emptyAnalysing');

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
  el.toggleAll.disabled = state.busy || state.rows.length === 0;

  const hasRows = state.rows.length > 0;
  el.table.hidden = !hasRows;
  el.listHead.hidden = !hasRows;
  el.empty.hidden = hasRows;
  // Aggiungere o copiare ha senso solo dopo un'analisi riuscita: prima non si
  // sa nemmeno su che sito si sta lavorando.
  el.rowTools.hidden = !state.config;
  el.empty.textContent = emptyMessage;
  updateTotal();
  syncLabel();
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
    // Serve anche ai link dei ticket: senza host non si sa dove puntano.
    state.host = status.host || '';
    if (!status.host) return setSite(t('siteNoneConfigured'), 'down');

    const origin = status.configured ? '' : t('siteDetectedSuffix');
    if (!status.tabsOnSite) {
      return setSite(t('siteNoTab', status.host, origin), 'down');
    }
    setSite(t('siteSession', status.host, origin), 'live');
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
      ? t('errNoTabOthers', altri.join(', '), host)
      : '';
    return message(
      t('errNoTab', host, extra),
      'action',
      {
        label: t('btnOpenRetry'),
        onClick: async () => { await openAndWait(host); retry(); }
      }
    );
  }

  if (error.code === 'SESSION_INVALID' && host) {
    return message(
      t('errSessionInvalid', host),
      'action',
      {
        label: t('btnGoLogin'),
        onClick: () => chrome.tabs.create({ url: `https://${host}/`, active: true })
      }
    );
  }

  if (error.code === 'TAB_GONE' && host) {
    return message(t('errTabGone', host), 'action', {
      label: t('btnReopenRetry'),
      onClick: async () => { await openAndWait(host); retry(); }
    });
  }

  if (error.code === 'NO_HOST') {
    return message(error.message, 'err', {
      label: t('btnOpenOptions'),
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
    if (!silent) message(t('msgPlanNotUpdated', error.message), 'action');
  }
  return undefined;
}

async function analyze({ preserveMessages = false } = {}) {
  clearTimeout(analyzeTimer);
  const token = ++analyzeToken;
  const forDate = state.isoDate;

  if (!preserveMessages) clearMessages();
  setButton(el.analyze, 'refresh', t('btnAnalysing'));

  // Si riparte dallo stato di apertura: tabella e anteprima spariscono finché
  // non arriva il piano nuovo, invece di lasciare in vista quello vecchio.
  emptyMessage = t('emptyAnalysing');
  state.rows = [];
  state.expanded.clear();
  setBusy(true);
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
    // gia' un worklog quel giorno parte spenta. La nota precompilata arriva come
    // chiave e diventa testo qui, perché finisce in un campo modificabile.
    state.rows = data.rows.map((row) => ({
      ...row,
      locked: false,
      comment: row.comment || (row.commentKey ? t(row.commentKey) : '')
    }));
    emptyMessage = t('emptyNothing');
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
        t('msgMeetingsNoTicket', missing.length),
        'action'
      );
    }

    // Solo per le righe che verranno davvero inviate: su una riga spenta la
    // proposta non ha conseguenze, e l'avviso sarebbe rumore.
    const guessed = state.rows.filter((row) => row.guessed && row.enabled && row.issueKey);
    if (guessed.length) {
      message(
        t('msgProposedTickets', guessed.map((r) => r.issueKey).join(', ')),
        'action'
      );
    }
    if (data.site?.host) setSite(t('siteSession', data.site.host, ''), 'live');
  } catch (error) {
    if (token !== analyzeToken) return;
    reportAuthError(error, analyze);
    state.rows = [];
    emptyMessage = t('emptyNoPlan');
    render();
  } finally {
    // Solo se non è già partita un'altra analisi: sarebbe lei a dover decidere
    // quando i comandi tornano premibili.
    if (token === analyzeToken) {
      state.analyzedAt = Date.now();
      setBusy(false);
      setButton(el.analyze, 'refresh', t('btnRefresh'));
    }
  }
}

async function submit() {
  el.submit.disabled = true;
  setButton(el.submit, 'send', t('btnSending'));
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
      const chiavi = ok.map((r) => r.issueKey).join(', ');
      message(parti > ok.length
        ? t('msgSentSplit', ok.length, parti, chiavi)
        : t('msgSent', ok.length, chiavi), 'ok');
    }
    failed.forEach((r) => message(t('msgSendFailed', r.issueKey, r.error), 'err'));

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
el.copyDate.value = previousWorkday(state.isoDate);
/**
 * Cambiare giorno tocca entrambe le viste: il piano si rilegge comunque, o
 * tornando su «Ore» si troverebbe quello di un altro giorno; il registro solo
 * se lo stai guardando, e altrimenti al prossimo passaggio.
 */
function onDateChanged(delay) {
  el.copyDate.value = previousWorkday(state.isoDate);
  scheduleAnalyze(delay);
  if (state.tab === 'log') scheduleLoadLog(delay);
}

el.date.addEventListener('change', () => {
  if (!el.date.value) return;
  state.isoDate = el.date.value;
  onDateChanged(0);
});
el.prevDay.addEventListener('click', () => { shiftDay(-1); onDateChanged(); });
el.nextDay.addEventListener('click', () => { shiftDay(1); onDateChanged(); });
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
    detail: t('detailManual'),
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

// ------------------------------------------------------- registro attività

function renderLog() {
  const eventi = state.logEvents;
  el.log.replaceChildren(...eventi.map((evento) => {
    const li = document.createElement('li');

    const quando = document.createElement('span');
    quando.className = 'quando';
    quando.textContent = eventTime(evento.at);

    const chiave = document.createElement('span');
    chiave.className = 'chiave';
    chiave.textContent = evento.key;

    const cosa = document.createElement('span');
    cosa.className = 'cosa';
    const { verbo, dettaglio } = describeEvent(evento);
    const forte = document.createElement('strong');
    forte.textContent = verbo;
    cosa.append(forte);
    if (dettaglio) cosa.append(` · ${dettaglio}`);

    li.append(quando, chiave, cosa);
    return li;
  }));

  el.logEmpty.hidden = eventi.length > 0;
  el.logCopy.hidden = eventi.length === 0;
  el.logCount.textContent = eventi.length ? t('logCount', eventi.length) : '';
  syncLabel();
}

// Stessa protezione del piano, e per lo stesso motivo: tenendo premuto ‹ o ›
// si attraversano cinque giorni in un secondo. Il timer fa partire una sola
// lettura, il token impedisce a una risposta di un giorno superato di
// atterrare comunque — arrivano fuori ordine, e vincerebbe l'ultima.
let logToken = 0;
let logTimer = null;

function scheduleLoadLog(delay = 250) {
  clearTimeout(logTimer);
  // Il token sale subito, non allo scadere: una richiesta già in volo per il
  // giorno di prima va invalidata adesso, non fra 250 ms.
  logToken++;
  logTimer = setTimeout(loadLog, delay);
}

async function loadLog() {
  clearTimeout(logTimer);
  const token = ++logToken;
  const forDate = state.isoDate;

  el.logCount.textContent = t('emptyAnalysing');
  el.log.replaceChildren();
  el.logEmpty.hidden = true;
  el.logCopy.hidden = true;
  try {
    const { events } = await send('activity', { isoDate: forDate });
    if (token !== logToken) return;
    state.logEvents = events;
    state.logDate = forDate;
    state.logAt = Date.now();
    renderLog();
  } catch (error) {
    if (token !== logToken) return;
    state.logEvents = [];
    renderLog();
    reportAuthError(error, loadLog);
  }
}

// ------------------------------------------------------------ ticket aperti

/** La data di apertura per esteso: "04 ago 2026". */
function ticketDay(day) {
  if (!day) return t('ticketsNoDate');
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d)
    .toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Il cartellino di uno stato, coi colori per categoria che ha Jira. */
function statusBadge(name, category) {
  const badge = document.createElement('span');
  badge.className = `stato cat-${category || 'unknown'}`;
  badge.textContent = name;
  return badge;
}

/**
 * Una riga di ticket.
 *
 * Nei gruppi lo stato è già il titolo del gruppo e l'assegnatario sei tu:
 * ripeterli su ogni riga sarebbe rumore. Fra i risultati di ricerca invece
 * servono entrambi — sono ticket sparsi per stati diversi, e possono essere
 * di chiunque.
 */
function ticketRow(issue, { conStato = false } = {}) {
  const li = document.createElement('li');
  li.className = 'ticket';
  // Serve a ritrovare la riga dopo che lo spostamento l'ha cambiata di gruppo.
  li.dataset.key = issue.key;

  const riga = document.createElement('div');
  riga.className = 'ticket-line';

  const chiave = document.createElement('a');
  chiave.className = 'chiave';
  chiave.textContent = issue.key;
  chiave.title = t('titleOpenInJira', issue.key);
  // Il link porta alla issue vera: da qui si legge il titolo, non il contenuto.
  if (state.host) {
    chiave.href = `https://${state.host}/browse/${issue.key}`;
    chiave.target = '_blank';
    chiave.rel = 'noreferrer';
  }

  const cosa = document.createElement('span');
  cosa.className = 'cosa';
  cosa.textContent = issue.summary || '';
  cosa.title = issue.summary || '';

  const sposta = document.createElement('button');
  sposta.className = 'ghost move';
  sposta.type = 'button';
  sposta.textContent = t('btnMove');

  const menu = document.createElement('div');
  menu.className = 'moves';
  menu.hidden = true;

  sposta.addEventListener('click', () => toggleMoves(issue, menu, sposta));

  riga.append(chiave, cosa, sposta);
  li.append(riga, menu);

  if (conStato) {
    // Seconda riga: stato e di chi è. Sotto, non accanto, perché il titolo si
    // mangia già tutta la larghezza che c'è.
    const sotto = document.createElement('div');
    sotto.className = 'ticket-meta';
    sotto.append(statusBadge(issue.status || t('ticketsNoStatus'), issue.category));

    const chi = document.createElement('span');
    chi.className = 'assegnato';
    // «Non assegnato» è un'informazione, non un campo vuoto: spesso è proprio
    // il motivo per cui stavi cercando quel ticket.
    chi.textContent = issue.assignee || t('ticketsUnassigned');
    sotto.append(chi);

    li.insertBefore(sotto, menu);
  }

  return li;
}

function ticketGroup(gruppo) {
  const sezione = document.createElement('section');
  sezione.className = 'ticket-group';

  const testa = document.createElement('div');
  testa.className = 'group-head';
  // Stesso cartellino che si vede su Jira: la categoria decide il colore, e la
  // categoria è il dato canonico — gli stati hanno nomi diversi in ogni
  // progetto, quindi cercare il colore per nome darebbe risultati diversi da
  // un progetto all'altro.
  const quanti = document.createElement('span');
  quanti.className = 'group-count';
  quanti.textContent = String(gruppo.count);
  testa.append(statusBadge(gruppo.status || t('ticketsNoStatus'), gruppo.category), quanti);
  sezione.append(testa);

  for (const giorno of gruppo.days) {
    const data = document.createElement('div');
    data.className = 'day-head';
    data.textContent = t('ticketsOpenedOn', ticketDay(giorno.day));

    const elenco = document.createElement('ul');
    elenco.className = 'ticket-list';
    elenco.append(...giorno.issues.map(ticketRow));

    sezione.append(data, elenco);
  }

  return sezione;
}

function renderTickets() {
  if (state.searchQuery) return renderSearch();

  el.tickets.replaceChildren(...state.ticketGroups.map(ticketGroup));
  el.ticketsEmpty.hidden = state.ticketGroups.length > 0;
  el.ticketsEmpty.textContent = t('ticketsEmpty');
  el.ticketsCount.textContent = state.ticketsTotal ? t('ticketsCount', state.ticketsTotal) : '';
  syncLabel();
}

/**
 * I risultati della ricerca, in elenco piatto.
 *
 * Non raggruppati: un risultato di ricerca ha già un ordine suo — l'ultimo
 * toccato per primo — e spezzarlo per stato nasconderebbe proprio quello che
 * stavi cercando in fondo a un gruppo.
 */
function renderSearch() {
  const elenco = document.createElement('ul');
  elenco.className = 'ticket-list piatta';
  elenco.append(...state.searchResults.map((issue) => ticketRow(issue, { conStato: true })));

  el.tickets.replaceChildren(elenco);
  el.ticketsEmpty.hidden = state.searchResults.length > 0;
  el.ticketsEmpty.textContent = t('searchEmpty', state.searchQuery);
  el.ticketsCount.textContent = state.searchResults.length
    ? t('searchCount', state.searchResults.length)
    : '';
}

// Stesso contrassegno delle altre letture: premendo Aggiorna due volte le
// risposte possono tornare fuori ordine, e vincerebbe la più vecchia.
let ticketsToken = 0;

async function loadTickets() {
  const token = ++ticketsToken;
  el.ticketsCount.textContent = t('emptyAnalysing');
  el.tickets.replaceChildren();
  el.ticketsEmpty.hidden = true;
  try {
    const { groups, total } = await send('openIssues');
    if (token !== ticketsToken) return;
    await applyTickets(groups, total);
  } catch (error) {
    if (token !== ticketsToken) return;
    state.ticketGroups = [];
    state.ticketsTotal = 0;
    renderTickets();
    reportAuthError(error, loadTickets);
  }
}

/** Un elenco appena letto sostituisce il precedente, menu e cache compresi. */
async function applyTickets(groups, total, moved = '', { riapri = false } = {}) {
  state.ticketGroups = groups || [];
  state.ticketsTotal = total || 0;
  state.ticketsLoaded = true;
  state.ticketsAt = Date.now();
  // Dopo uno spostamento le transizioni disponibili sono altre: la cache di
  // prima descriveva un punto del workflow in cui non siamo più.
  state.transitionsByKey.clear();

  // Con la ricerca attiva a schermo ci sono i risultati, non i gruppi: vanno
  // riletti, o resterebbero a mostrare lo stato di prima dello spostamento.
  if (state.searchQuery) await runSearch();
  else renderTickets();

  if (moved) followMoved(moved, riapri);
}

// Stessa protezione del piano e del registro: si digita una lettera alla
// volta, e senza ritardo sarebbe una ricerca per tasto premuto.
let searchToken = 0;
let searchTimer = null;

function scheduleSearch(delay = 300) {
  clearTimeout(searchTimer);
  searchToken++;
  searchTimer = setTimeout(runSearch, delay);
}

/** Annulla la ricerca e rimette in vista l'elenco dei tuoi ticket. */
function clearSearch() {
  clearTimeout(searchTimer);
  searchToken++;
  state.searchQuery = '';
  state.searchResults = [];
  renderTickets();
}

async function runSearch() {
  clearTimeout(searchTimer);
  const token = ++searchToken;
  const query = state.searchQuery;
  if (!query) return clearSearch();

  el.ticketsCount.textContent = t('emptyAnalysing');
  el.ticketsEmpty.hidden = true;
  try {
    const { issues } = await send('findIssues', { query });
    if (token !== searchToken) return;
    state.searchResults = issues;
    renderSearch();
  } catch (error) {
    if (token !== searchToken) return;
    state.searchResults = [];
    renderSearch();
    reportAuthError(error, runSearch);
  }
}

/**
 * Riporta lo sguardo sul ticket appena spostato, e riapre il menu.
 *
 * Cambiare stato vuol dire cambiare gruppo, e il gruppo nuovo può stare fuori
 * schermo: senza questo, ogni spostamento fa perdere di vista il ticket su cui
 * si sta lavorando. Riaprire il menu è l'altra metà: attraversare un workflow
 * di sei stati resta un click per stato, ma tutti nello stesso punto invece
 * che rincorrendo la riga giù per l'elenco.
 */
function followMoved(key, riapri = false) {
  const riga = el.tickets.querySelector(`.ticket[data-key="${CSS.escape(key)}"]`);
  if (!riga) return;
  const fermo = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  riga.scrollIntoView({ block: 'center', behavior: fermo ? 'auto' : 'smooth' });
  riga.classList.add('appena-spostato');
  if (riapri) riga.querySelector('.move')?.click();
}

/**
 * Apre (o chiude) l'elenco degli stati in cui la issue può finire.
 * Si chiedono qui, al primo click, non per tutto l'elenco.
 */
async function toggleMoves(issue, menu, bottone) {
  if (!menu.hidden) {
    menu.hidden = true;
    return;
  }
  // Uno alla volta: due menu aperti in un popup stretto si leggono male.
  for (const altro of el.tickets.querySelectorAll('.moves')) altro.hidden = true;
  menu.hidden = false;

  const cache = state.transitionsByKey.get(issue.key);
  if (cache) return renderMoves(issue, menu, cache);

  menu.replaceChildren(hint(t('ticketsLoadingMoves')));
  bottone.disabled = true;
  try {
    const { transitions } = await send('issueTransitions', {
      issueKey: issue.key, status: issue.status
    });
    state.transitionsByKey.set(issue.key, transitions);
    renderMoves(issue, menu, transitions);
  } catch (error) {
    menu.replaceChildren(hint(error.message));
    // Leggere si può riprovare senza pensarci: non cambia niente su Jira.
    reportAuthError(error, () => { menu.hidden = true; toggleMoves(issue, menu, bottone); });
  } finally {
    bottone.disabled = false;
  }
}

function hint(testo) {
  const span = document.createElement('span');
  span.className = 'moves-hint';
  span.textContent = testo;
  return span;
}

function renderMoves(issue, menu, transitions) {
  if (!transitions.length) return menu.replaceChildren(hint(t('ticketsNoMoves')));

  menu.replaceChildren(...transitions.map((transizione) => {
    const bottone = document.createElement('button');
    // Il colore anticipa dove stai per mandare il ticket.
    bottone.className = `move-to cat-${transizione.category || 'unknown'}`;
    bottone.type = 'button';
    // Conta lo stato d'arrivo, non il nome della transizione: chi guarda
    // pensa "voglio che stia in DEV TEST", non "voglio fare Passa a test".
    bottone.textContent = transizione.to || transizione.name;
    bottone.addEventListener('click', () => moveTicket(issue, transizione, menu));
    return bottone;
  }));
}

async function moveTicket(issue, transizione, menu) {
  for (const b of menu.querySelectorAll('button')) b.disabled = true;
  menu.replaceChildren(hint(t('ticketsMoving', transizione.to || transizione.name)));
  try {
    const esito = await send('moveIssue', {
      issueKey: issue.key, transitionId: transizione.id
    });
    // Il menu si riapre sulla riga spostata: attraversare un workflow lungo è
    // un click per stato, e restano tutti nello stesso punto dello schermo.
    applyTickets(esito.groups, esito.total, esito.moved, { riapri: true });
    // Il canale è la riga: quattro passi di fila lasciavano quattro conferme
    // impilate, e insieme dicevano meno dell'ultima da sola.
    message(t('msgTicketMoved', issue.key, esito.reached || transizione.to), 'ok', null,
      { channel: `ticket:${issue.key}` });
  } catch (error) {
    menu.hidden = true;
    // Qui si riprova a *rileggere*, non a rispostare: uno spostamento può
    // essere andato a segno e fallito subito dopo, e rifarlo lo porterebbe
    // uno stato più avanti di dove volevi. Rileggendo si vede dov'è davvero.
    reportAuthError(error, loadTickets);
  }
}

/** Passa fra le viste. Il footer appartiene alle ore, non alle altre schede. */
function showTab(nome) {
  state.tab = nome;
  const ore = nome === 'hours';
  const registro = nome === 'log';
  const ticket = nome === 'tickets';

  el.tabHours.setAttribute('aria-selected', String(ore));
  el.tabLog.setAttribute('aria-selected', String(registro));
  el.tabTickets.setAttribute('aria-selected', String(ticket));

  el.main.hidden = !ore;
  el.footer.hidden = !ore;
  el.logView.hidden = !registro;
  el.ticketsView.hidden = !ticket;
  // I ticket aperti sono quelli di adesso: il giorno scelto non c'entra, e
  // lasciare il selettore lì accanto farebbe pensare il contrario.
  el.dayPicker.hidden = ticket;

  // Il registro si legge quando lo apri, e si rilegge se hai cambiato giorno.
  if (registro && state.logDate !== state.isoDate) loadLog();
  if (ticket && !state.ticketsLoaded) loadTickets();
  // Ogni vista ha la sua freschezza: cambiando scheda cambia il riferimento.
  syncLabel();
}

// ------------------------------------------------------- quanto è fresco

/*
 * Jira non ha un canale a cui restare in ascolto: niente WebSocket pubbliche,
 * e i webhook vogliono un server che li riceva — cioè credenziali depositate
 * da qualche parte, che è proprio quello che questa estensione evita. Resta
 * il rileggere ogni tanto.
 *
 * Il che rende necessaria l'etichetta: se il dato può avere fino a un minuto,
 * chi guarda deve poterlo sapere senza indovinarlo.
 */
const POLL_MS = 60000;
const TICK_MS = 15000;

/** Quando è stato letto quello che si sta guardando adesso. */
function freshnessAt() {
  if (state.tab === 'tickets') return state.ticketsAt;
  if (state.tab === 'log') return state.logAt;
  return state.analyzedAt;
}

function syncLabel() {
  const quando = freshnessAt();
  if (!quando) {
    el.sync.textContent = '';
    el.sync.title = '';
    return;
  }
  const minuti = Math.floor((Date.now() - quando) / 60000);
  el.sync.textContent = minuti < 1 ? t('syncNow') : t('syncAgo', String(minuti));
  el.sync.title = t('syncAt', eventTime(quando));
}

/**
 * Rilegge da sola la vista che stai guardando, ma solo quando non dà fastidio.
 *
 * Le guardie non sono prudenza generica: ognuna copre un modo concreto di
 * rovinare il lavoro a chi sta usando il popup in quel momento.
 */
function pollIfIdle() {
  syncLabel();

  // A pannello chiuso o finestra nascosta non c'è niente da tenere fresco.
  if (document.visibilityState !== 'visible') return;
  // Un'analisi in corso decide lei quando i dati cambiano.
  if (state.busy) return;
  // Stai scrivendo: ricaricare ti toglierebbe il campo da sotto le dita.
  const attivo = document.activeElement?.tagName;
  if (attivo === 'INPUT' || attivo === 'TEXTAREA') return;
  // Un menu di spostamento aperto è un'azione a metà.
  if (el.tickets.querySelector('.moves:not([hidden])')) return;
  if (Date.now() - freshnessAt() < POLL_MS) return;

  if (state.tab === 'tickets') loadTickets();
  else if (state.tab === 'log') loadLog();
  // Il piano si rilegge nella versione leggera: una richiesta invece delle
  // decine di un'analisi completa, che rifarebbe attività e commit — roba che
  // non cambia da sola.
  else if (state.rows.length) refreshLogged();
}

setInterval(pollIfIdle, TICK_MS);

/** Il giorno lavorativo precedente: sabato e domenica non si copiano. */
function previousWorkday(isoDate) {
  const date = localDateTime(isoDate);
  do {
    date.setDate(date.getDate() - 1);
  } while (date.getDay() === 0 || date.getDay() === 6);
  return toIsoDate(date);
}

/**
 * Riparte da una giornata già fatta. Le ore copiate arrivano "bloccate": sono
 * una tua scelta, non una stima, e non devono essere ridistribuite.
 * Le issue che oggi hanno già ore restano spente: la protezione dai duplicati
 * vale anche qui.
 */
async function copyFromDay() {
  const fromDate = el.copyDate.value;
  if (!fromDate || !state.config) return;

  el.copyDo.disabled = true;
  try {
    const { entries } = await send('copyFrom', { fromDate });
    if (!entries.length) {
      message(t('msgCopiedNone', fromDate), 'info');
      return;
    }

    for (const entry of entries) {
      const esistente = state.rows.find((row) => row.issueKey === entry.key);
      const riga = esistente || {
        id: `copia:${entry.key}`,
        kind: 'task',
        issueKey: entry.key,
        summary: entry.summary,
        label: '',
        sources: [],
        detail: t('detailCopied', fromDate),
        segments: [],
        existingMinutes: 0,
        enabled: true
      };
      riga.minutes = entry.minutes;
      riga.lockedMinutes = entry.minutes;
      riga.locked = true;
      if (entry.comment) riga.comment = entry.comment;
      if (!riga.existingMinutes) riga.enabled = true;
      if (!esistente) state.rows.push(riga);
    }

    redistribute();
    render();
    message(t('msgCopied', entries.length, fromDate), 'ok');
  } catch (error) {
    reportAuthError(error, copyFromDay);
  } finally {
    el.copyDo.disabled = state.busy;
  }
}

el.copyDo.addEventListener('click', copyFromDay);

el.tabHours.addEventListener('click', () => showTab('hours'));
el.tabLog.addEventListener('click', () => showTab('log'));
el.tabTickets.addEventListener('click', () => showTab('tickets'));

el.ticketsSearch.addEventListener('input', () => {
  state.searchQuery = el.ticketsSearch.value.trim();
  // Svuotare il campo deve rimettere subito l'elenco: aspettare il ritardo
  // farebbe sembrare che non sia successo niente.
  if (!state.searchQuery) return clearSearch();
  scheduleSearch();
});
// Esc svuota il campo: è quello che fa ogni campo di ricerca.
el.ticketsSearch.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !state.searchQuery) return;
  el.ticketsSearch.value = '';
  clearSearch();
});

el.logCopy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(logAsText(state.logEvents));
    message(t('msgLogCopied', state.logEvents.length), 'ok');
  } catch (error) {
    message(t('msgLogCopyFailed', error.message), 'err');
  }
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
// Il tasto in alto ricarica quello che stai guardando, non sempre le ore.
el.analyze.addEventListener('click', () => {
  if (state.tab === 'tickets') return loadTickets();
  if (state.tab === 'log') return loadLog();
  analyze();
});
el.submit.addEventListener('click', () => {
  // Se c'è qualcosa da confermare, il primo clic arma invece di inviare.
  if (needsConfirm() && !confirmingSend) {
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
  // Anche i ticket invecchiano mentre sei via, e più in fretta del piano: li
  // sposti da Jira, torni qui, e la scheda mostrerebbe lo stato di prima.
  // Se sei su un'altra scheda non si rilegge subito: ci pensa `showTab`
  // quando ci arrivi, invece di spendere una richiesta per una vista chiusa.
  state.ticketsLoaded = false;
  if (state.tab === 'tickets' && Date.now() - state.ticketsAt >= 3000) loadTickets();

  if (Date.now() - state.analyzedAt < 3000) return;
  refreshLogged();
});

setIcon(el.prevDay, 'chevronLeft');
setIcon(el.nextDay, 'chevronRight');
setIcon(el.openOptions, 'settings');

// Popup e pannello laterale sono la stessa pagina: il manifest apre il
// pannello con `?panel=1`, e da lì il foglio di stile sa che la finestra ha
// una larghezza sua invece di doversela dare da solo.
if (new URLSearchParams(location.search).get('panel')) {
  document.documentElement.dataset.mode = 'panel';
}

// Il markup statico prima di tutto: l'analisi parte subito dopo e i suoi
// messaggi sono già tradotti da `t`.
applyI18n();

refreshSite();
analyze();
