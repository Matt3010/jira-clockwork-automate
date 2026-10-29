// Clockwork Autofill come userscript: un pannello dentro la pagina My Work di
// Clockwork, accanto al calendario.
//
// Clockwork vive in un iframe su un altro dominio, quindi dentro non si entra:
// il pannello sta nella pagina Jira che lo contiene, e da li' parla con le API
// Jira con il login gia' fatto.
//
// Per ora due schede: la verifica sui giorni passati — ricostruisce ogni
// giorno come se fosse vuoto e lo confronta con i worklog che hai registrato
// davvero — e le impostazioni. Niente viene scritto su Jira.

import { JiraClient } from '../lib/jira.js';
import { formatMinutes, todayIso } from '../lib/dates.js';
import { PageChannel } from './channel.js';
import { collectDay, planFromDay, resolveMe } from './analysis.js';
import { compareDay, lastWorkingDays } from './verify.js';
import {
  applySettingsForm, exportSettingsFile, importSettingsFile, loadSettings, saveSettings
} from './settings.js';
import { breakRow, meetingRow, readSettingsForm, renderSettings } from './settings-view.js';

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
let running = false;
let report = [];
let tab = 'verify';
let count = 5;

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
    const jira = new JiraClient(new PageChannel());
    const me = await resolveMe(jira);
    const days = lastWorkingDays(giorni, todayIso());
    for (const [index, isoDate] of days.entries()) {
      setProgress(`Analisi ${dayLabel(isoDate)} (${index + 1}/${days.length})…`);
      try {
        const day = await collectDay(jira, { isoDate, config, me });
        const plan = planFromDay(day, config, { asIfEmpty: true });
        report.push({ ...compareDay(day, plan), warnings: plan.warnings });
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
  for (const day of report) {
    if (day.error) {
      lines.push(`${day.isoDate}  ERRORE: ${day.error}`);
      continue;
    }
    lines.push(`${day.isoDate}  registrate ${fmt(day.loggedTotal)} · ricostruite ${fmt(day.plannedTotal)} `
      + `· ticket ${day.matchedTickets}/${day.loggedTickets}`);
    for (const r of day.rows) {
      const why = r.reason ? ` (${REASONS[r.reason] || r.reason})` : '';
      lines.push(`  ${STATUS[r.status].icon} ${r.key.padEnd(12)} reg ${fmt(r.logged).padEnd(7)} `
        + `piano ${fmt(r.planned).padEnd(7)} ${r.kind === 'meeting' ? '[riunione] ' : ''}${r.summary}${why}`);
    }
  }
  return lines.join('\n');
}

// ------------------------------------------------------------------ disegno

function setProgress(text) {
  const el = root?.querySelector('.progress');
  if (el) el.textContent = text;
}

function configSummary() {
  const projects = config.jira.projects || [];
  if (!projects.length) {
    return '<p class="warn">Nessun progetto configurato: impostali, o importa il file di '
      + 'configurazione, nella scheda Impostazioni.</p>';
  }
  return `<p class="muted">Progetti: <b>${esc(projects.join(', '))}</b> · `
    + `${(config.meetings || []).length} riunioni · ${config.work.dailyHours}h al giorno</p>`;
}

function dayBlock(day) {
  if (day.error) {
    return `<details class="day" open><summary><b>${esc(dayLabel(day.isoDate))}</b>`
      + `<span class="bad">errore</span></summary><p class="bad">${esc(day.error)}</p></details>`;
  }
  const perc = day.loggedTotal ? Math.round((day.overlapMinutes / day.loggedTotal) * 100) : 100;
  const tone = perc >= 90 ? 'good' : perc >= 60 ? 'mid' : 'bad';
  const righe = day.rows.map((r) => `
    <tr class="${r.status}">
      <td class="st" title="${STATUS[r.status].label}">${STATUS[r.status].icon}</td>
      <td><a href="/browse/${encodeURIComponent(r.key)}" target="_blank">${esc(r.key)}</a>
        ${r.kind === 'meeting' ? '<span class="tag">riunione</span>' : ''}
        <div class="sum">${esc(r.summary)}</div>
        ${r.reason ? `<div class="why">${esc(REASONS[r.reason] || r.reason)}</div>` : ''}</td>
      <td class="num">${fmt(r.logged)}</td>
      <td class="num">${fmt(r.planned)}</td>
    </tr>`).join('');
  return `<details class="day" ${tone === 'good' ? '' : 'open'}>
    <summary><b>${esc(dayLabel(day.isoDate))}</b>
      <span class="muted">reg ${fmt(day.loggedTotal)} · piano ${fmt(day.plannedTotal)} · `
      + `ticket ${day.matchedTickets}/${day.loggedTickets}</span>
      <span class="${tone}">${perc}%</span></summary>
    ${day.rows.length ? `<table><thead><tr><th></th><th>Ticket</th><th>Registrate</th><th>Piano</th></tr></thead>
      <tbody>${righe}</tbody></table>` : '<p class="muted">Niente registrato e niente trovato.</p>'}
  </details>`;
}

function verifyBody() {
  return `<section>${configSummary()}</section>
    <section>
      <h3>Verifica giorni passati</h3>
      <p class="muted">Ricostruisce ogni giorno come se fosse vuoto e lo confronta con i worklog che hai
        registrato. Solo letture: su Jira non scrive niente.</p>
      <div class="row">
        <label>Ultimi <input type="number" min="1" max="30" value="${count}" class="count"> giorni lavorativi</label>
        <button class="primary" data-act="verify" ${running ? 'disabled' : ''}>Verifica</button>
        ${report.length && !running ? '<button data-act="copy">Copia report</button>' : ''}
      </div>
      <p class="progress muted"></p>
      ${report.map(dayBlock).join('')}
    </section>`;
}

const TABS = [['verify', 'Verifica'], ['settings', 'Impostazioni']];

function render() {
  if (!panel) return;
  const scroll = panel.querySelector('.body')?.scrollTop || 0;
  const stessaScheda = panel.dataset.tab === tab;
  panel.dataset.tab = tab;
  panel.innerHTML = `
    <header>
      <h2>Clockwork Autofill</h2>
      <button class="icon" data-act="close" title="Chiudi">✕</button>
    </header>
    <nav class="tabs">${TABS.map(([id, label]) =>
      `<button data-act="tab" data-tab="${id}" class="${tab === id ? 'on' : ''}">${label}</button>`).join('')}</nav>
    <div class="body">${tab === 'settings' ? renderSettings(config) : verifyBody()}</div>`;
  // Lo scroll si tiene solo ridisegnando la stessa scheda: cambiandola si
  // riparte dall'alto.
  if (stessaScheda) panel.querySelector('.body').scrollTop = scroll;
}

// ------------------------------------------------------------------ impostazioni

function settingsMessage(text, tone = 'muted') {
  const el = root?.querySelector('.save-result');
  if (!el) return;
  el.textContent = text;
  el.className = `save-result ${tone}`;
}

function saveFromForm() {
  const { config: next, invalid } = applySettingsForm(config, readSettingsForm(panel.querySelector('.settings')));
  if (invalid.length) {
    settingsMessage(`Non salvato: la fine deve venire dopo l'inizio (${invalid.join(', ')}).`, 'bad');
    return;
  }
  config = next;
  saveSettings(config);
  render();
  settingsMessage('Salvato.', 'good');
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
  const el = root.querySelector('.test-result');
  el.textContent = 'Verifica…';
  el.className = 'test-result muted';
  try {
    const me = await resolveMe(new JiraClient(new PageChannel()));
    el.textContent = `Connesso come ${me.displayName}.`;
    el.className = 'test-result good';
  } catch (error) {
    el.textContent = error.message || String(error);
    el.className = 'test-result bad';
  }
}

function addRow(kind) {
  const id = `${kind}-${Date.now()}`;
  const html = kind === 'break'
    ? breakRow({ id, label: 'Pausa', start: '13:00', end: '14:00' })
    : meetingRow({ id, label: 'Riunione', days: [1, 2, 3, 4, 5], time: '09:30', minutes: 30 });
  panel.querySelector(kind === 'break' ? '.list.breaks' : '.list.meetings').insertAdjacentHTML('beforeend', html);
}

// ------------------------------------------------------------------ montaggio

const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .tab {
    position: fixed; right: 0; top: 50%; transform: translateY(-50%); z-index: 2147483000;
    writing-mode: vertical-rl; padding: 12px 6px; border: 0; border-radius: 8px 0 0 8px; cursor: pointer;
    font: 600 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--ds-background-brand-bold, #0c66e4); color: var(--ds-text-inverse, #fff);
  }
  .panel {
    position: fixed; top: 0; right: 0; bottom: 0; width: min(480px, 100vw); z-index: 2147483001;
    display: flex; flex-direction: column;
    background: var(--ds-surface-overlay, #fff); color: var(--ds-text, #172b4d);
    border-left: 1px solid var(--ds-border, #dfe1e6); box-shadow: -8px 0 24px rgba(0,0,0,.25);
    font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  .panel[hidden] { display: none; }
  header { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px;
    border-bottom: 1px solid var(--ds-border, #dfe1e6); }
  h2 { font-size: 16px; margin: 0; }
  h3 { font-size: 14px; margin: 0 0 4px; }
  /* Niente padding in fondo: il pulsante Salva e' sticky, e col padding restava
     sollevato con le righe che scorrevano visibili sotto. */
  .body { flex: 1; overflow: auto; padding: 0 16px; }
  .body > section:last-child { padding-bottom: 24px; }
  section { padding: 12px 0; border-bottom: 1px solid var(--ds-border, #dfe1e6); }
  section:last-child { border-bottom: 0; }
  p { margin: 4px 0 8px; }
  .muted { color: var(--ds-text-subtle, #626f86); }
  .warn { color: var(--ds-text-warning, #a54800); }
  .good { color: var(--ds-text-success, #216e4e); font-weight: 600; }
  .mid { color: var(--ds-text-warning, #a54800); font-weight: 600; }
  .bad { color: var(--ds-text-danger, #ae2e24); font-weight: 600; }
  button, .file {
    font: inherit; color: inherit; background: var(--ds-background-neutral, #091e420f);
    border: 0; border-radius: 4px; padding: 6px 12px; cursor: pointer; display: inline-block;
  }
  button:hover, .file:hover { background: var(--ds-background-neutral-hovered, #091e4224); }
  button.primary { background: var(--ds-background-brand-bold, #0c66e4); color: var(--ds-text-inverse, #fff); }
  button[disabled] { opacity: .5; cursor: default; }
  .icon { background: transparent; padding: 4px 8px; }
  .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  input.count { width: 52px; font: inherit; padding: 4px; border-radius: 4px;
    border: 1px solid var(--ds-border-input, #8590a2); background: transparent; color: inherit; }
  .day { margin: 8px 0; border: 1px solid var(--ds-border, #dfe1e6); border-radius: 6px; }
  .day summary { cursor: pointer; padding: 8px 10px; display: flex; gap: 8px; align-items: baseline; }
  .day summary .muted { flex: 1; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-weight: 500; font-size: 11px; color: var(--ds-text-subtle, #626f86);
    padding: 4px 8px; border-top: 1px solid var(--ds-border, #dfe1e6); }
  td { padding: 6px 8px; border-top: 1px solid var(--ds-border, #dfe1e6); vertical-align: top; }
  td.num, th:nth-child(n+3) { text-align: right; white-space: nowrap; }
  td.st { width: 20px; font-weight: 700; }
  tr.ok td.st { color: var(--ds-text-success, #216e4e); }
  tr.hours td.st { color: var(--ds-text-warning, #a54800); }
  tr.missing td.st, tr.extra td.st { color: var(--ds-text-danger, #ae2e24); }
  a { color: var(--ds-link, #0c66e4); text-decoration: none; font-weight: 600; }
  .sum { color: var(--ds-text-subtle, #626f86); font-size: 12px; }
  .why { color: var(--ds-text-danger, #ae2e24); font-size: 12px; }
  .tag { font-size: 10px; padding: 0 4px; border-radius: 3px; margin-left: 4px;
    background: var(--ds-background-accent-yellow-subtler, #f8e6a0); color: var(--ds-text-accent-yellow, #7f5f01); }
  .tabs { display: flex; gap: 4px; padding: 0 16px; border-bottom: 1px solid var(--ds-border, #dfe1e6); }
  .tabs button { background: transparent; border-radius: 0; padding: 8px 10px; color: var(--ds-text-subtle, #626f86);
    border-bottom: 2px solid transparent; }
  .tabs button.on { color: var(--ds-text-selected, #0c66e4); border-bottom-color: var(--ds-border-selected, #0c66e4); }
  .tabs button:hover { background: transparent; color: var(--ds-text, #172b4d); }
  .settings input[type=text], .settings input[type=number], .settings input[type=time], .settings select {
    font: inherit; color: inherit; background: var(--ds-background-input, transparent);
    border: 1px solid var(--ds-border-input, #8590a2); border-radius: 4px; padding: 4px 6px; }
  .field { display: flex; flex-direction: column; gap: 4px; margin: 8px 0; font-weight: 500; }
  .field input[type=text], .field select { width: 100%; }
  .field input[type=number] { width: 90px; }
  .check { display: flex; gap: 6px; align-items: center; margin: 8px 0; }
  .hint { font-weight: 400; font-size: 12px; color: var(--ds-text-subtle, #626f86); }
  .list { display: flex; flex-direction: column; gap: 6px; margin: 6px 0 8px; }
  .item { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 6px;
    border: 1px solid var(--ds-border, #dfe1e6); border-radius: 6px; }
  .item .f-label { flex: 1; min-width: 120px; }
  .item.meeting .f-label { flex-basis: calc(100% - 40px); }
  .item.meeting .days { margin-right: auto; }
  .days { display: flex; gap: 2px; }
  .day-box { display: flex; flex-direction: column; align-items: center; font-size: 10px; cursor: pointer; }
  .footer { position: sticky; bottom: 0; padding: 12px 0; display: flex; gap: 8px; align-items: center;
    background: var(--ds-surface-overlay, #fff); border-top: 1px solid var(--ds-border, #dfe1e6); }
`;

function onClick(event) {
  const el = event.target.closest('[data-act]');
  const act = el?.dataset.act;
  if (act === 'close') panel.hidden = true;
  else if (act === 'tab') {
    tab = el.dataset.tab;
    render();
  } else if (act === 'verify') {
    count = Math.max(1, Math.min(30, Number(panel.querySelector('.count').value) || 5));
    verify(count);
  } else if (act === 'copy') {
    navigator.clipboard.writeText(reportText()).then(() => setProgress('Report copiato.'));
  } else if (act === 'save') saveFromForm();
  else if (act === 'export') exportFile();
  else if (act === 'test') testConnection();
  else if (act === 'add-break') addRow('break');
  else if (act === 'add-meeting') addRow('meeting');
  else if (act === 'remove-row') el.closest('.item')?.remove();
}

async function onChange(event) {
  if (event.target.dataset.act !== 'import') return;
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    config = importSettingsFile(await file.text());
    render();
    settingsMessage('Configurazione importata.', 'good');
  } catch (error) {
    render();
    settingsMessage(`File non valido: ${error.code || error.message}`, 'bad');
  }
}

function mount() {
  host = document.createElement('div');
  host.id = 'clockwork-autofill';
  root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${CSS}</style><button class="tab">Autofill</button><aside class="panel" hidden></aside>`;
  panel = root.querySelector('.panel');
  root.querySelector('.tab').addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) render();
  });
  panel.addEventListener('click', onClick);
  panel.addEventListener('change', onChange);
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
