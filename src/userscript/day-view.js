// La scheda Giorno: disegno del piano. Solo HTML da stato, niente eventi —
// quelli li collega main.js, per delega, sui `data-act`.

import { addMinutes, formatMinutes, todayIso } from '../lib/dates.js';
import { summary } from './day.js';
import { t } from './i18n.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

const RIGHE_NOTA_MAX = 8;
export const noteRows = (testo) => Math.min(Math.max(testo ? testo.split('\n').length : 1, 1), RIGHE_NOTA_MAX);

/** I segmenti di una riga, o l'unico blocco se non sono stati calcolati. */
function segmentsOf(row) {
  if (row.segments?.length) return row.segments;
  return row.time && row.minutes ? [{ time: row.time, minutes: row.minutes }] : [];
}

/** "09:00–13:00 + 14:00–18:00" */
export function timeLabel(row) {
  const segments = segmentsOf(row);
  if (!segments.length) return '—';
  return segments.map((s) => `${s.time}–${addMinutes(s.time, s.minutes)}`).join(' + ');
}

export const hoursValue = (row) => (row.minutes ? +(row.minutes / 60).toFixed(2) : 0);

/** La riga in una frase: da dove viene. */
function describeRow(row) {
  if (row.kind === 'meeting') {
    const slot = t('meetingRecurring', row.time, addMinutes(row.time, row.defaultMinutes ?? row.minutes));
    return row.summary ? `${slot} · ${row.summary}` : slot;
  }
  if (row.detail) return row.detail;
  const { changes = 0, created = 0, comments = 0, commits = 0 } = row.activity || {};
  const parti = [];
  if (created) parti.push(t('activityCreated'));
  if (changes) parti.push(t(changes === 1 ? 'activityChange' : 'activityChanges', changes));
  if (comments) parti.push(t(comments === 1 ? 'activityComment' : 'activityComments', comments));
  if (commits) parti.push(t(commits === 1 ? 'activityCommit' : 'activityCommits', commits));
  return parti.join(' · ');
}

function badges(row) {
  const out = [];
  if (row.sources?.includes('jira')) out.push('<span class="badge jira">jira</span>');
  if (row.sources?.includes('git')) out.push('<span class="badge git">git</span>');
  if (row.guessed) {
    const why = { orario: t('whyTime'), nome: t('whyName'), data: t('whyDate') }[row.guessReason] || t('whyAuto');
    out.push(`<span class="badge warn" title="${esc(why)}">${esc(t('badgeProposed'))}</span>`);
  }
  if (row.existingMinutes) {
    out.push(`<span class="badge warn">${esc(t('badgeAlready', formatMinutes(row.existingMinutes)))}</span>`);
  }
  return out.join('');
}

function rowCard(row, config) {
  const esempio = config?.jira?.projects?.[0];
  const placeholder = row.kind === 'meeting'
    ? t('phMeetingTicket')
    : (esempio ? t('phIssuePrefix', esempio) : t('phIssueExample'));
  const titolo = row.kind === 'meeting' ? row.label : (row.summary || t('rowNoTitle'));
  const step = (config?.work.roundingMinutes || 15) / 60;
  const detail = describeRow(row);
  const spezzata = segmentsOf(row).length > 1;
  const link = row.issueKey
    ? `<a href="/browse/${encodeURIComponent(row.issueKey)}" target="_blank" title="${esc(row.issueKey)}">↗</a>`
    : '';
  return `<div class="prow ${row.kind}${row.enabled ? '' : ' off'}" data-id="${esc(row.id)}">
    <div class="ptop">
      <input type="checkbox" data-act="toggle" ${row.enabled ? 'checked' : ''} title="Includi">
      <input type="text" class="issue" list="cw-recent" data-act="issue" value="${esc(row.issueKey)}"
        placeholder="${esc(placeholder)}" spellcheck="false">
      ${link}
      <input type="number" class="hours${row.locked ? ' locked' : ''}" data-act="hours" min="0" step="${step}"
        value="${hoursValue(row)}" title="Ore">
      <span class="muted">h</span>
      <button class="icon" data-act="remove-plan-row" title="${esc(t('titleRemoveRow'))}">✕</button>
    </div>
    <div class="psum">${row.kind === 'meeting' ? '📅 ' : ''}<b>${esc(titolo)}</b> ${badges(row)}</div>
    ${detail ? `<div class="pdetail muted">${esc(detail)}</div>` : ''}
    <div class="ptime muted"${spezzata ? ` title="${esc(t('titleSplitByBreak'))}"` : ''}>🕘 <span class="time">${esc(timeLabel(row))}</span></div>
    <textarea class="comment" data-act="comment" rows="${noteRows(row.comment)}"
      placeholder="${esc(t('phComment'))}">${esc(row.comment)}</textarea>
  </div>`;
}

const LIVELLI = { err: 0, action: 1, ok: 2, info: 3 };

function messages(state) {
  return [...state.messages]
    .sort((a, b) => (LIVELLI[a.level] ?? 3) - (LIVELLI[b.level] ?? 3))
    .map((m) => `<div class="msg ${esc(m.level)}">${esc(m.text)}</div>`).join('');
}

/** Il riepilogo e il pulsante di invio: si ridisegnano da soli a ogni modifica. */
export function renderFooter(state, { busy, sending, confirming }) {
  if (busy || !state.config) {
    return `<div class="total muted">${esc(t('emptyAnalysing'))}</div>
      <button class="primary" disabled>${esc(t('btnSend'))}</button>`;
  }
  const s = summary(state);
  const etichetta = sending ? t('btnSending') : (confirming && s.needsConfirm ? s.confirmLabel : s.sendLabel);
  return `<div class="total${s.overflow ? ' over' : ''}"><b>${esc(formatMinutes(s.total))}</b>${esc(s.text)}</div>
    <div class="row">
      <button class="${confirming && s.needsConfirm ? 'danger' : 'primary'}" data-act="send"
        ${s.sendable && !sending ? '' : 'disabled'} title="${esc(etichetta)}">${esc(etichetta)}</button>
      ${confirming && s.needsConfirm ? `<button data-act="cancel-send">${esc(t('btnCancel'))}</button>` : ''}
    </div>`;
}

export function renderDay(state, { busy, sending, confirming, error }) {
  const oggi = state.isoDate === todayIso();
  const letto = state.analyzedAt
    ? new Date(state.analyzedAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })
    : '';
  const corpo = busy
    ? `<p class="muted empty">${esc(t('emptyAnalysing'))}</p>`
    : error
      ? `<p class="bad empty">${esc(error)}</p>`
      : state.rows.length
        ? state.rows.map((row) => rowCard(row, state.config)).join('')
        : `<p class="muted empty">${esc(t('emptyNothing'))}</p>`;
  return `<div class="dayview">
    <div class="daybar">
      <button class="icon" data-act="prev-day" title="${esc(t('titlePrevDay'))}">‹</button>
      <input type="date" class="date" data-act="date" value="${esc(state.isoDate)}">
      <button class="icon" data-act="next-day" title="${esc(t('titleNextDay'))}">›</button>
      ${oggi ? '' : `<button data-act="today">${esc(t('btnToday'))}</button>`}
      <span class="sp"></span>
      ${letto && !busy ? `<span class="muted small">letto alle ${esc(letto)}</span>` : ''}
      <button data-act="analyze" ${busy ? 'disabled' : ''}>${esc(busy ? t('btnAnalysing') : t('btnRefresh'))}</button>
    </div>
    <div class="msgs">${busy ? '' : messages(state)}</div>
    <div class="plan">${corpo}</div>
    ${busy || error ? '' : `<button data-act="add-row">${esc(t('btnAddRow'))}</button>`}
    <datalist id="cw-recent">${state.recentIssues.map((i) =>
      `<option value="${esc(i.key)}">${esc(i.summary)}</option>`).join('')}</datalist>
  </div>`;
}
