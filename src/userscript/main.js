// Clockwork Autofill come userscript: un pannello dentro la pagina My Work di
// Clockwork, accanto al calendario.
//
// Clockwork vive in un iframe su un altro dominio, quindi dentro non si entra:
// il pannello sta nella pagina Jira che lo contiene, e da li' parla con le API
// Jira con il login gia' fatto.
//
// L'aspetto e' quello del popup dell'estensione — stesso foglio di stile,
// stesse icone, stesso markup — con due linguette: Ore, il piano della
// giornata da correggere e inviare, e Verifica, che ricostruisce i giorni
// passati come se fossero vuoti e li confronta con i worklog veri. Le
// impostazioni si aprono dall'ingranaggio, come le Opzioni dell'estensione.

import { JiraClient, loggedMinutesForDay } from '../lib/jira.js';
import { formatMinutes, todayIso } from '../lib/dates.js';
import { PageChannel } from './channel.js';
import { collectDay, planFromDay, resolveMe } from './analysis.js';
import { compareDay, lastWorkingDays } from './verify.js';
import {
  applySettingsForm, exportSettingsFile, importSettingsFile, loadSettings, saveSettings
} from './settings.js';
import { breakRow, meetingRow, readSettingsForm, renderSettings } from './settings-view.js';
import {
  addManualRow, applyCopy, applyLogged, confirmedGuesses, copyEntries, deleteMessage, deleteWorklogs, loadPlan,
  newDayState, notePending, previousWorkday, rememberMeetings, removeRow, setRowIssue, setRowMinutes, shiftIsoDate,
  submitMessages, submitRows, summary, toggleAll, toggleRow
} from './day.js';
import {
  conIcona, drawTimeline, highlightRow, hoursValue, ico, noteRows, renderDayBar, renderDayMain, renderFooter,
  renderMessages, timeLabel
} from './day-view.js';
import { PANEL_CSS } from './style.js';
import { t } from './i18n.js';

const MY_WORK = /\/jira\/apps\/[^/]+\/[^/]+\/my-work/;

const STATUS = {
  ok: { icon: '✓', label: 'giusto' },
  hours: { icon: '≈', label: 'ore diverse' },
  missing: { icon: '✗', label: 'mancante' },
  extra: { icon: '+', label: 'in più' }
};

const REASONS = {
  disabled: 'nel piano ma spento',
  zeroMinutes: 'nel piano a 0 ore',
  onlyOthers: 'solo modifiche di colleghi',
  onlyOthersCommits: 'solo commit di colleghi',
  noTrace: 'nessuna traccia trovata'
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));
const fmt = (m) => (m ? formatMinutes(m) : '—');
const dayLabel = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('it-IT', {
  weekday: 'short', day: 'numeric', month: 'short'
});

let host;
let root;
let panel;
let config = loadSettings();
// 'day' | 'verify' | 'settings'. Le impostazioni non hanno linguetta: si
// aprono dall'ingranaggio e si chiudono tornando a una linguetta.
let tab = 'day';

// Verifica.
let running = false;
let report = [];
let count = 5;

// Ore.
const jira = new JiraClient(new PageChannel());
let me = null;
let day = newDayState(todayIso());
let dayBusy = false;
let daySending = false;
let dayConfirming = false;
let dayError = '';
let dayStale = true;
let dayToken = 0;
let dayTimer = 0;
// Righe con l'elenco dei worklog aperto, e il giorno da cui copiare.
const expanded = new Set();
let copyDate = previousWorkday(todayIso());
// Una cancellazione o una copia in corso: i loro pulsanti restano spenti.
let dayWorking = false;

// ------------------------------------------------------------------ verifica

/** La verifica gira anche a scheda cambiata: ridisegna solo se la si sta guardando. */
function refreshVerify() {
  if (tab === 'verify') render();
}

async function verify(giorni) {
  if (running) return report;
  running = true;
  report = [];
  refreshVerify();
  try {
    const who = await whoAmI();
    const days = lastWorkingDays(giorni, todayIso());
    for (const [index, isoDate] of days.entries()) {
      setProgress(`Analisi ${dayLabel(isoDate)} (${index + 1}/${days.length})…`);
      try {
        const raccolto = await collectDay(jira, { isoDate, config, me: who });
        const plan = planFromDay(raccolto, config, { asIfEmpty: true });
        report.push({ ...compareDay(raccolto, plan), warnings: plan.warnings });
      } catch (error) {
        report.push({ isoDate, error: error.message || String(error) });
      }
      refreshVerify();
    }
    setProgress('');
  } catch (error) {
    setProgress(`Errore: ${error.message || error}`);
  } finally {
    running = false;
    refreshVerify();
  }
  return report;
}

/** Il report in testo, da incollare dove serve. */
function reportText() {
  const lines = [];
  for (const giorno of report) {
    if (giorno.error) {
      lines.push(`${giorno.isoDate}  ERRORE: ${giorno.error}`);
      continue;
    }
    lines.push(`${giorno.isoDate}  registrate ${fmt(giorno.loggedTotal)} · ricostruite ${fmt(giorno.plannedTotal)} `
      + `· ticket ${giorno.matchedTickets}/${giorno.loggedTickets}`);
    for (const r of giorno.rows) {
      const why = r.reason ? ` (${REASONS[r.reason] || r.reason})` : '';
      lines.push(`  ${STATUS[r.status].icon} ${r.key.padEnd(12)} reg ${fmt(r.logged).padEnd(7)} `
        + `piano ${fmt(r.planned).padEnd(7)} ${r.kind === 'meeting' ? '[riunione] ' : ''}${r.summary}${why}`);
    }
  }
  return lines.join('\n');
}

function setProgress(text) {
  const el = root?.querySelector('.progress');
  if (el) el.textContent = text;
}

function configSummary() {
  const projects = config.jira.projects || [];
  if (!projects.length) {
    return '<p class="warn">Nessun progetto configurato: impostali, o importa il file di '
      + 'configurazione, dalle Opzioni.</p>';
  }
  return `<p class="muted">Progetti: <b>${esc(projects.join(', '))}</b> · `
    + `${(config.meetings || []).length} riunioni · ${config.work.dailyHours}h al giorno</p>`;
}

function verifyDay(giorno) {
  if (giorno.error) {
    return `<details class="vday" open><summary><b>${esc(dayLabel(giorno.isoDate))}</b>`
      + `<span class="bad">errore</span></summary><p class="bad">${esc(giorno.error)}</p></details>`;
  }
  const perc = giorno.loggedTotal ? Math.round((giorno.overlapMinutes / giorno.loggedTotal) * 100) : 100;
  const tone = perc >= 90 ? 'good' : perc >= 60 ? 'mid' : 'bad';
  const righe = giorno.rows.map((r) => `
    <tr class="${r.status}">
      <td class="st" title="${STATUS[r.status].label}">${STATUS[r.status].icon}</td>
      <td><a href="/browse/${encodeURIComponent(r.key)}" target="_blank">${esc(r.key)}</a>
        ${r.kind === 'meeting' ? '<span class="tag">riunione</span>' : ''}
        <div class="sum">${esc(r.summary)}</div>
        ${r.reason ? `<div class="why">${esc(REASONS[r.reason] || r.reason)}</div>` : ''}</td>
      <td class="num">${fmt(r.logged)}</td>
      <td class="num">${fmt(r.planned)}</td>
    </tr>`).join('');
  return `<details class="vday" ${tone === 'good' ? '' : 'open'}>
    <summary><b>${esc(dayLabel(giorno.isoDate))}</b>
      <span class="muted">reg ${fmt(giorno.loggedTotal)} · piano ${fmt(giorno.plannedTotal)} · `
      + `ticket ${giorno.matchedTickets}/${giorno.loggedTickets}</span>
      <span class="${tone}">${perc}%</span></summary>
    ${giorno.rows.length ? `<table class="vtab"><thead><tr><th></th><th>Ticket</th><th>Registrate</th><th>Piano</th></tr></thead>
      <tbody>${righe}</tbody></table>` : '<p class="muted">Niente registrato e niente trovato.</p>'}
  </details>`;
}

function verifyBody() {
  return `<div class="verify">
    ${configSummary()}
    <h3>Verifica giorni passati</h3>
    <p class="muted">Ricostruisce ogni giorno come se fosse vuoto e lo confronta con i worklog che hai
      registrato. Solo letture: su Jira non scrive niente.</p>
    <div class="vrow">
      <label>Ultimi <input type="number" min="1" max="30" value="${count}" class="count"> giorni lavorativi</label>
      <button class="primary" data-act="verify" ${running ? 'disabled' : ''}>Verifica</button>
      ${report.length && !running ? '<button class="ghost" data-act="copy">Copia report</button>' : ''}
    </div>
    <p class="progress muted"></p>
    ${report.map(verifyDay).join('')}
  </div>`;
}

// ------------------------------------------------------------------ disegno

const TABS = [['day', t('tabHours')], ['verify', 'Verifica']];

function headerHtml() {
  const comandi = `<button class="ghost icon-only" data-act="options" title="${esc(t('titleOptions'))}">${ico('settings')}</button>
    <button class="ghost icon-only" data-act="close" title="${esc(t('btnCancel'))}">${ico('x')}</button>`;
  if (tab === 'day') {
    return renderDayBar(day, { busy: dayBusy }).replace(/<\/div>\s*$/, `${comandi}</div>`);
  }
  const titolo = tab === 'settings' ? t('titleOptions') : 'Clockwork Autofill';
  return `<div class="bar-left"><span class="title">${esc(titolo)}</span></div><div class="bar-right">${comandi}</div>`;
}

const dayFooter = () => renderFooter(day, {
  busy: dayBusy, sending: daySending, confirming: dayConfirming, host: location.host
});

function render() {
  if (!panel) return;
  const scroller = panel.querySelector('main, .opts, .verify');
  const scroll = scroller?.scrollTop || 0;
  const stessaScheda = panel.dataset.tab === tab;
  panel.dataset.tab = tab;

  let corpo;
  if (tab === 'settings') corpo = renderSettings(config);
  else if (tab === 'verify') corpo = verifyBody();
  else {
    corpo = `<div id="messages">${dayBusy ? '' : renderMessages(day.messages)}</div>
      <main>${renderDayMain(day, { busy: dayBusy, error: dayError, expanded, copyDate, working: dayWorking })}</main>
      <footer class="bar">${dayFooter()}</footer>`;
  }

  panel.innerHTML = `
    <header class="bar">${headerHtml()}</header>
    <nav class="tabs" role="tablist">${TABS.map(([id, label]) =>
      `<button class="tab" role="tab" data-act="tab" data-tab="${id}" aria-selected="${tab === id}">${esc(label)}</button>`).join('')}</nav>
    ${corpo}`;
  // Lo scroll si tiene solo ridisegnando la stessa scheda.
  const nuovo = panel.querySelector('main, .opts, .verify');
  if (stessaScheda && nuovo) nuovo.scrollTop = scroll;
  if (tab === 'day') afterDayRender();
}

/**
 * Quello che si fa solo a markup presente: lo stato "parziale" della spunta
 * generale, che in HTML non si scrive, e l'anteprima, che si misura. La si
 * ridisegna anche al frame dopo, a layout avvenuto, come fa il popup.
 */
let misura = 0;
function afterDayRender() {
  const tutte = panel.querySelector('[data-act="toggle-all"]');
  if (tutte) tutte.indeterminate = Boolean(tutte.dataset.indeterminate);
  drawTimeline(panel, day);
  cancelAnimationFrame(misura);
  misura = requestAnimationFrame(() => drawTimeline(panel, day));
}

// ------------------------------------------------------------------ impostazioni

function settingsResult(selector, text, tone = '') {
  const el = root?.querySelector(selector);
  if (!el) return;
  el.textContent = text;
  el.className = `result ${selector.slice(1)} ${tone}`;
}

function saveFromForm() {
  const { config: next, invalid } = applySettingsForm(config, readSettingsForm(panel.querySelector('.settings')));
  if (invalid.length) {
    settingsResult('.save-result', t('msgNotSavedTimes', invalid.join(', ')), 'err');
    return;
  }
  config = next;
  saveSettings(config);
  // Il piano del giorno era fatto con le impostazioni di prima.
  dayStale = true;
  render();
  settingsResult('.save-result', t('msgSaved'), 'ok');
}

function exportFile() {
  const { name, text } = exportSettingsFile(config);
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function testConnection() {
  settingsResult('.test-result', t('btnAnalysing'));
  try {
    const io = await resolveMe(jira);
    settingsResult('.test-result', t('msgConnectedAs', io.displayName, location.host), 'ok');
  } catch (error) {
    settingsResult('.test-result', error.message || String(error), 'err');
  }
}

function addRow(kind) {
  const id = `${kind}-${Date.now()}`;
  const html = kind === 'break'
    ? breakRow({ id, label: t('defaultBreakName'), start: '13:00', end: '14:00' })
    : meetingRow({ id, label: t('defaultMeetingName'), days: [1, 2, 3, 4, 5], time: '09:30', minutes: 30 });
  panel.querySelector(kind === 'break' ? '.list.breaks' : '.list.meetings').insertAdjacentHTML('beforeend', html);
}

const ERRORI_IMPORT = { NOT_OURS: 'msgImportNotOurs', TOO_NEW: 'msgImportTooNew', BROKEN: 'msgImportBroken' };

async function importFile(input) {
  const file = input.files?.[0];
  if (!file) return;
  try {
    config = importSettingsFile(await file.text());
    dayStale = true;
    render();
    settingsResult('.save-result', t('msgImported'), 'ok');
  } catch (error) {
    render();
    settingsResult('.save-result', t(ERRORI_IMPORT[error.code] || 'msgImportUnreadable'), 'err');
  }
}

// ------------------------------------------------------------------ ore

async function whoAmI() {
  if (!me) me = await resolveMe(jira);
  return me;
}

function renderDayFooter() {
  const foot = root?.querySelector('footer.bar');
  if (foot) foot.innerHTML = dayFooter();
}

/** L'analisi del giorno guardato. Se intanto si cambia giorno, vince l'ultima. */
async function analyzeDay() {
  clearTimeout(dayTimer);
  const token = ++dayToken;
  const isoDate = day.isoDate;
  dayBusy = true;
  dayError = '';
  dayConfirming = false;
  dayStale = false;
  if (tab === 'day') render();
  try {
    const who = await whoAmI();
    const attesa = day.pending.isoDate === isoDate ? Object.keys(day.pending.perIssue) : [];
    const raccolto = await collectDay(jira, { isoDate, config, me: who, extraLoggedKeys: attesa });
    if (token !== dayToken) return;
    const nuovo = newDayState(isoDate);
    nuovo.pending = day.pending;
    loadPlan(nuovo, { plan: planFromDay(raccolto, config), day: raccolto, config });
    if (rememberMeetings(config, confirmedGuesses(nuovo))) saveSettings(config);
    day = nuovo;
    expanded.clear();
  } catch (error) {
    if (token !== dayToken) return;
    dayError = error.message || String(error);
  } finally {
    if (token === dayToken) {
      dayBusy = false;
      if (tab === 'day') render();
    }
  }
}

/** Cambiare giorno rilegge il piano; i salti ravvicinati si accorpano. */
function setDay(isoDate) {
  if (!isoDate || isoDate === day.isoDate) return;
  const pending = day.pending;
  day = newDayState(isoDate);
  day.pending = pending;
  copyDate = previousWorkday(isoDate);
  dayBusy = true;
  render();
  clearTimeout(dayTimer);
  dayTimer = setTimeout(analyzeDay, 300);
}

const rowOf = (el) => day.rows.find((row) => row.id === el.closest('tr[data-id]')?.dataset.id);

/** Aggiorna ore e orari senza ridisegnare: chi sta scrivendo non perde il fuoco. */
function syncDayValues() {
  dayConfirming = false;
  for (const tr of root.querySelectorAll('tbody tr[data-id]:not(.worklogs)')) {
    const row = day.rows.find((r) => r.id === tr.dataset.id);
    if (!row) continue;
    const hours = tr.querySelector('.hours');
    if (hours && root.activeElement !== hours) hours.value = hoursValue(row);
    hours?.classList.toggle('locked', Boolean(row.locked));
    const time = tr.querySelector('.time');
    if (time) time.textContent = timeLabel(row);
  }
  renderDayFooter();
  drawTimeline(panel, day);
}

/** Clockwork disegna il calendario una volta sola: dopo un invio va ricaricato. */
function reloadClockwork() {
  const frames = [...document.querySelectorAll('iframe')]
    .filter((f) => /atlassian-dev\.net|clockwork/i.test(f.src))
    .sort((a, b) => b.offsetWidth * b.offsetHeight - a.offsetWidth * a.offsetHeight);
  if (!frames.length) return false;
  frames[0].src = frames[0].src;
  return true;
}

// Clockwork non legge Jira al volo: i worklog gli arrivano per sincronizzazione,
// qualche decina di secondi dopo. Ricaricato subito, il calendario mostrava
// solo una parte di quello appena scritto — e sembrava che l'invio non avesse
// fatto niente. Si ricarica a scaglioni, finche' non e' plausibile che abbia
// tutto.
const RICARICHE_MS = [5000, 20000, 45000];
let ricariche = [];

function reloadClockworkSoon() {
  ricariche.forEach(clearTimeout);
  if (!document.querySelector('iframe')) return false;
  ricariche = RICARICHE_MS.map((ms) => setTimeout(reloadClockwork, ms));
  return true;
}

async function sendDay() {
  const s = summary(day);
  if (s.needsConfirm && !dayConfirming) {
    dayConfirming = true;
    renderDayFooter();
    return;
  }
  daySending = true;
  dayConfirming = false;
  renderDayFooter();
  const isoDate = day.isoDate;
  try {
    const results = await submitRows(jira, { isoDate, rows: day.rows, config });
    day.messages = submitMessages(results);
    const riunioni = day.rows
      .filter((row) => row.kind === 'meeting' && row.enabled && row.memoryKey && row.issueKey)
      .map((row) => [row.memoryKey, row.issueKey]);
    if (rememberMeetings(config, riunioni)) saveSettings(config);

    const scritte = results.filter((r) => r.ok).map((r) => r.issueKey);
    if (scritte.length) {
      notePending(day, results);
      try {
        await refreshLogged(scritte);
      } catch (error) {
        day.messages.push({ level: 'action', text: t('msgPlanNotUpdated', error.message) });
      }
      if (reloadClockworkSoon()) {
        day.messages.push({ level: 'info', text: 'Clockwork li mostra fra qualche secondo: il calendario si ricarica da solo nel prossimo minuto.' });
      } else {
        day.messages.push({ level: 'info', text: t('msgReloadNone') });
      }
    }
  } catch (error) {
    day.messages.push({ level: 'err', text: error.message || String(error) });
  } finally {
    daySending = false;
    render();
  }
}

/**
 * Rilegge solo le ore gia' registrate del giorno guardato. `forced` sono le
 * issue appena scritte o ripulite: li' la scelta di prima non vale piu'.
 */
async function refreshLogged(forced = []) {
  const who = await whoAmI();
  const chiavi = [...new Set([...day.rows.map((row) => row.issueKey), ...forced].filter(Boolean))];
  applyLogged(day, await loggedMinutesForDay(jira, { isoDate: day.isoDate, accountId: who.accountId, extraKeys: chiavi }), forced);
}

async function deleteFromRow(row, ids) {
  dayWorking = true;
  render();
  try {
    const who = await whoAmI();
    const out = await deleteWorklogs(jira, { isoDate: day.isoDate, issueKey: row.issueKey, worklogIds: ids, accountId: who.accountId });
    day.messages = [deleteMessage(row.issueKey, out)];
    expanded.delete(row.id);
    // Il minimo di quello appena scritto non vale piu': terrebbe a schermo ore che non ci sono.
    delete day.pending.perIssue[row.issueKey];
    await refreshLogged([row.issueKey]);
    if (out.deleted) reloadClockworkSoon();
  } catch (error) {
    day.messages.push({ level: 'err', text: error.message || String(error) });
  } finally {
    dayWorking = false;
    render();
  }
}

async function copyDay() {
  copyDate = root.querySelector('.copy-date')?.value || copyDate;
  if (!copyDate || !day.config) return;
  dayWorking = true;
  render();
  try {
    const who = await whoAmI();
    const logged = await loggedMinutesForDay(jira, { isoDate: copyDate, accountId: who.accountId });
    day.messages = [applyCopy(day, copyEntries(logged), copyDate)];
  } catch (error) {
    day.messages.push({ level: 'err', text: error.message || String(error) });
  } finally {
    dayWorking = false;
    render();
  }
}

function onDayClick(act, el) {
  if (act === 'prev-day') setDay(shiftIsoDate(day.isoDate, -1));
  else if (act === 'next-day') setDay(shiftIsoDate(day.isoDate, 1));
  else if (act === 'today') setDay(todayIso());
  else if (act === 'analyze') analyzeDay();
  else if (act === 'add-row') {
    addManualRow(day);
    render();
    [...root.querySelectorAll('.issue-input')].pop()?.focus();
  } else if (act === 'remove-plan-row') {
    removeRow(day, el.closest('tr[data-id]').dataset.id);
    render();
  } else if (act === 'wipe') {
    const id = el.closest('tr[data-id]').dataset.id;
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
    render();
  } else if (act === 'delete-worklog') {
    const row = rowOf(el);
    if (row && !dayWorking) deleteFromRow(row, el.dataset.worklog.split(','));
  } else if (act === 'reload-logged') {
    const row = rowOf(el);
    el.disabled = true;
    refreshLogged(row ? [row.issueKey] : [])
      .catch((error) => day.messages.push({ level: 'action', text: t('msgPlanNotUpdated', error.message) }))
      .finally(render);
  } else if (act === 'copy-day') {
    if (!dayWorking) copyDay();
  } else if (act === 'send') sendDay();
  else if (act === 'cancel-send') {
    dayConfirming = false;
    renderDayFooter();
  } else return false;
  return true;
}

function onDayChange(act, el) {
  const row = rowOf(el);
  if (act === 'date') setDay(el.value);
  else if (act === 'copy-date') copyDate = el.value;
  else if (act === 'toggle-all') {
    toggleAll(day, el.checked);
    render();
  }
  else if (act === 'toggle' && row) {
    toggleRow(day, row, el.checked);
    render();
  } else if (act === 'issue' && row) {
    const { remember, clash } = setRowIssue(day, row, el.value);
    if (remember && rememberMeetings(config, [remember])) saveSettings(config);
    if (clash) day.messages.push({ level: 'info', text: t('msgClash', row.issueKey) });
    render();
  } else if (act === 'hours' && row) {
    setRowMinutes(day, row, Number(el.value || 0) * 60);
    syncDayValues();
  }
}

function onInput(event) {
  const el = event.target;
  if (el.dataset.act !== 'comment') return;
  const row = rowOf(el);
  if (!row) return;
  row.comment = el.value;
  el.rows = noteRows(el.value);
}

// ------------------------------------------------------------------ eventi

function showTab(nome) {
  tab = nome;
  render();
  if (tab === 'day' && dayStale && !dayBusy) analyzeDay();
}

function onClick(event) {
  const el = event.target.closest('[data-act]');
  const act = el?.dataset.act;
  if (!act) return;
  if (act === 'close') panel.hidden = true;
  else if (act === 'tab') showTab(el.dataset.tab);
  else if (act === 'options') showTab(tab === 'settings' ? 'day' : 'settings');
  else if (onDayClick(act, el)) {
    // gestito dalla scheda Ore
  } else if (act === 'verify') {
    count = Math.max(1, Math.min(30, Number(panel.querySelector('.count').value) || 5));
    verify(count);
  } else if (act === 'copy') {
    navigator.clipboard.writeText(reportText()).then(() => setProgress('Report copiato.'));
  } else if (act === 'save') saveFromForm();
  else if (act === 'export') exportFile();
  else if (act === 'import-open') panel.querySelector('[data-act="import"]').click();
  else if (act === 'test') testConnection();
  else if (act === 'add-break') addRow('break');
  else if (act === 'add-meeting') addRow('meeting');
  else if (act === 'remove-row') el.closest('[data-kind]')?.remove();
}

function onChange(event) {
  const el = event.target;
  if (el.dataset.act === 'import') importFile(el);
  else onDayChange(el.dataset.act, el);
}

// ------------------------------------------------------------------ montaggio

function mount() {
  host = document.createElement('div');
  host.id = 'clockwork-autofill';
  root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${PANEL_CSS}</style>
    <button class="handle" title="Clockwork Autofill">${conIcona('calendar', 'Autofill')}</button>
    <aside class="panel" hidden></aside>`;
  panel = root.querySelector('.panel');
  root.querySelector('.handle').addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    if (panel.hidden) return;
    render();
    if (tab === 'day' && dayStale && !dayBusy) analyzeDay();
  });
  panel.addEventListener('click', onClick);
  panel.addEventListener('change', onChange);
  panel.addEventListener('input', onInput);
  // Passando sopra una riga se ne accendono i blocchi nell'anteprima.
  for (const [evento, acceso] of [['mouseover', true], ['mouseout', false]]) {
    panel.addEventListener(evento, (event) => {
      const tr = event.target.closest?.('tbody tr[data-id]');
      if (tr && !tr.contains(event.relatedTarget)) highlightRow(panel, tr.dataset.id, acceso);
    });
  }
  window.addEventListener('resize', () => {
    if (!panel.hidden && tab === 'day') drawTimeline(panel, day);
  });
  document.body.appendChild(host);
}

// Jira e' una SPA: si entra e si esce da My Work senza ricaricare.
function sync() {
  const on = MY_WORK.test(location.pathname);
  if (on && !host) mount();
  if (host) host.style.display = on ? '' : 'none';
}

sync();
setInterval(sync, 1000);

// Per guardarci dentro dalla console.
globalThis.clockworkAutofill = { verify, reportText, get report() { return report; }, get config() { return config; } };
