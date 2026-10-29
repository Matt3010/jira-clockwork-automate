// La scheda Ore: disegno del piano, con lo stesso markup del popup
// dell'estensione — stesse classi, stesse icone — cosi' `popup.css` lo veste
// uguale. Solo HTML da stato, niente eventi: quelli li collega main.js, per
// delega, sui `data-act`.

import { addMinutes, eventTime, formatMinutes, minutesToTime, todayIso } from '../lib/dates.js';
import { icon } from '../lib/icons.js';
import { loggedFor, seriesClass, summary, timelineBlocks, timelineExtent } from './day.js';
import { t } from './i18n.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

/** Un'icona del set dell'estensione, come HTML. */
export const ico = (name, size = 16) => icon(name, { size }).outerHTML;

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

/** Pulsante con icona e testo, come `setButton` del popup. */
export const conIcona = (name, text) => `${ico(name, 14)}<span class="label">${esc(text)}</span>`;

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
    out.push(`<span class="badge dup" title="${esc(why)}">${esc(t('badgeProposed'))}</span>`);
  }
  if (row.existingMinutes) {
    out.push(`<span class="badge dup">${esc(t('badgeAlready', formatMinutes(row.existingMinutes)))}</span>`);
  }
  return out.length ? `<span class="badges">${out.join('')}</span>` : '';
}

function rowHtml(state, row, expanded, sectionStart) {
  const config = state.config;
  const esempio = config?.jira?.projects?.[0];
  const placeholder = row.kind === 'meeting'
    ? t('phMeetingTicket')
    : (esempio ? t('phIssuePrefix', esempio) : t('phIssueExample'));
  const titolo = row.kind === 'meeting' ? row.label : (row.summary || t('rowNoTitle'));
  const segno = row.kind === 'meeting'
    ? ico('calendar', 14)
    : `<span class="chip ${seriesClass(state, row.issueKey)}"></span>`;
  const step = (config?.work.roundingMinutes || 15) / 60;
  const detail = describeRow(row);
  const spezzata = segmentsOf(row).length > 1;
  const aperta = expanded.has(row.id);
  const cestino = row.existingMinutes && row.issueKey
    ? `<button class="remove wipe${aperta ? ' open' : ''}" data-act="wipe"
        title="${esc(t('titleWipe', formatMinutes(row.existingMinutes), row.issueKey))}">${ico('trash')}</button>`
    : '';

  const tr = `<tr data-id="${esc(row.id)}" class="${row.kind}${row.enabled ? '' : ' disabled'}${sectionStart ? ' section-start' : ''}">
    <td class="col-check"><input type="checkbox" data-act="toggle" ${row.enabled ? 'checked' : ''}></td>
    <td class="col-issue"><input type="text" class="issue-input" list="recent-issues" data-act="issue"
      value="${esc(row.issueKey)}" placeholder="${esc(placeholder)}" spellcheck="false"></td>
    <td class="col-what">
      <div class="summary">${segno}${esc(titolo)}${badges(row)}</div>
      ${detail ? `<div class="detail">${esc(detail)}</div>` : ''}
      <textarea class="comment" data-act="comment" rows="${noteRows(row.comment)}"
        placeholder="${esc(t('phComment'))}">${esc(row.comment)}</textarea>
    </td>
    <td class="col-hours"><input type="number" class="hours${row.locked ? ' locked' : ''}" data-act="hours"
      min="0" step="${step}" value="${hoursValue(row)}" title="${esc(t('labelHours'))}"></td>
    <td class="col-time"><span class="time"${spezzata ? ` title="${esc(t('titleSplitByBreak'))}"` : ''}>${esc(timeLabel(row))}</span></td>
    <td class="col-actions">${cestino}<button class="remove" data-act="remove-plan-row" title="${esc(t('titleRemoveRow'))}">${ico('x')}</button></td>
  </tr>`;
  return tr + (aperta && row.existingMinutes ? worklogRow(state, row) : '');
}

/**
 * Sotto una riga con ore gia' su Jira: i singoli worklog, ognuno col suo
 * Elimina. Niente "cancella tutto" alla cieca. Se gli id non sono ancora
 * arrivati — subito dopo un invio — si propone di rileggere.
 */
function worklogRow(state, row) {
  const entries = loggedFor(state, row.issueKey);
  let dentro;
  if (!entries.length) {
    dentro = `<div class="worklogs-title">${esc(t('worklogsUnlistable', row.issueKey, formatMinutes(row.existingMinutes)))}</div>
      <button class="ghost inline" data-act="reload-logged">${esc(t('btnRefresh'))}</button>`;
  } else {
    const titolo = entries.length === 1 ? t('worklogsOne', row.issueKey) : t('worklogsMany', entries.length, row.issueKey);
    dentro = `<div class="worklogs-title">${esc(titolo)}</div>` + entries.map((e) => `<div class="worklog-item">
        <span>${esc(minutesToTime(e.startMinutes))}–${esc(minutesToTime(e.startMinutes + e.minutes))} · ${esc(formatMinutes(e.minutes))}</span>
        <button class="ghost inline" data-act="delete-worklog" data-worklog="${esc(e.id)}">${esc(t('btnDelete'))}</button>
      </div>`).join('')
      + (entries.length > 1
        ? `<button class="ghost inline danger-text" data-act="delete-worklog"
            data-worklog="${esc(entries.map((e) => e.id).join(','))}">${esc(t('btnDeleteAllCount', entries.length))}</button>`
        : '');
  }
  return `<tr class="worklogs" data-id="${esc(row.id)}"><td></td><td></td><td colspan="4">${dentro}</td></tr>`;
}

const LIVELLI = { err: ['xCircle', 0], action: ['alert', 1], ok: ['check', 2], info: ['info', 3] };

/** Gli avvisi, come quelli del popup: prima quello che chiede un intervento. */
export function renderMessages(messages) {
  return [...messages]
    .sort((a, b) => (LIVELLI[a.level]?.[1] ?? 3) - (LIVELLI[b.level]?.[1] ?? 3))
    .map((m) => `<div class="msg ${esc(m.level)}"><span class="glyph">${ico((LIVELLI[m.level] || LIVELLI.info)[0], 15)}</span>`
      + `<span class="body">${esc(m.text)}</span></div>`).join('');
}

/** La barra in alto: giorno, quando e' stato letto, Aggiorna, Opzioni, chiudi. */
export function renderDayBar(state, { busy }) {
  const letto = state.analyzedAt && !busy ? eventTime(state.analyzedAt) : '';
  return `<div class="bar-left">
      <label>${esc(t('labelDay'))}</label>
      <input type="date" data-act="date" value="${esc(state.isoDate)}">
      <button class="ghost icon-only" data-act="prev-day" title="${esc(t('titlePrevDay'))}">${ico('chevronLeft')}</button>
      <button class="ghost icon-only" data-act="next-day" title="${esc(t('titleNextDay'))}">${ico('chevronRight')}</button>
      ${state.isoDate === todayIso() ? '' : `<button class="ghost" data-act="today" title="${esc(t('titleToday'))}">${esc(t('btnToday'))}</button>`}
    </div>
    <div class="bar-right">
      <span class="sync" title="${letto ? esc(t('syncAt', letto)) : ''}">${letto ? esc(t('syncTime', letto)) : ''}</span>
      <button class="ghost" data-act="analyze" ${busy ? 'disabled' : ''} title="${esc(t('btnRefresh'))}">${conIcona('refresh', busy ? t('btnAnalysing') : t('btnRefresh'))}</button>
    </div>`;
}

/** Il corpo della scheda Ore: anteprima, righe, strumenti, suggerimenti. */
export function renderDayMain(state, { busy, error, expanded = new Set(), copyDate = '', working = false }) {
  const righe = !busy && !error && state.rows.length;
  const vuoto = busy ? t('emptyAnalysing') : (error || t('emptyNothing'));
  // Stacco fra riunioni e attivita': sono due cose diverse.
  const html = righe ? state.rows.map((row, i) =>
    rowHtml(state, row, expanded, i > 0 && state.rows[i - 1].kind !== row.kind)).join('') : '';
  const accese = state.rows.filter((row) => row.enabled).length;
  const tutte = accese > 0 && accese === state.rows.length;
  return `<div class="timeline"${state.config ? '' : ' hidden'}>
      <div class="scale"><div class="ruler"></div><div class="track"></div></div>
    </div>
    <div class="grid-area">
      <div class="legend" hidden></div>
      <div class="list-head"${righe ? '' : ' hidden'}>
        <label class="pick-all">
          <input type="checkbox" data-act="toggle-all" title="${esc(t('titleToggleAll'))}" ${tutte ? 'checked' : ''}
            ${accese > 0 && !tutte ? 'data-indeterminate="1"' : ''}>
          <span>${esc(t('labelSelectAll'))}</span>
        </label>
      </div>
      <table${righe ? '' : ' hidden'}><tbody>${html}</tbody></table>
      <p class="empty"${righe ? ' hidden' : ''}>${esc(vuoto)}</p>
      <div class="row-tools"${busy || error ? ' hidden' : ''}>
        <button class="ghost" data-act="add-row">${esc(t('btnAddRow'))}</button>
        <span class="copy-from">
          <label>${esc(t('labelCopyFrom'))}</label>
          <input type="date" class="copy-date" data-act="copy-date" value="${esc(copyDate)}">
          <button class="ghost" data-act="copy-day" ${working ? 'disabled' : ''}>${esc(t('btnCopy'))}</button>
        </span>
      </div>
    </div>
    <datalist id="recent-issues">${state.recentIssues.map((i) =>
      `<option value="${esc(i.key)}">${esc(i.summary)}</option>`).join('')}</datalist>`;
}

/**
 * Disegna l'anteprima della giornata dentro `scope`. Va chiamata a layout
 * avvenuto: verticale o coricata lo decide il foglio di stile (`--asse`), e
 * la lunghezza dell'asse dipende dallo spazio che c'e'. Stessa logica del
 * popup.
 */
export function drawTimeline(scope, state) {
  const timeline = scope.querySelector('.timeline');
  const legend = scope.querySelector('.legend');
  if (!timeline || !state.config) return;

  const blocchi = state.rows.length ? timelineBlocks(state) : [];
  const { da, a } = timelineExtent(state, blocchi);
  const span = a - da;
  const pct = (minuti) => `${((minuti - da) / span) * 100}%`;
  const orizzontale = getComputedStyle(timeline).getPropertyValue('--asse').trim() === 'orizzontale';

  const scale = timeline.querySelector('.scale');
  const disponibile = Math.max(300, (timeline.parentElement?.clientHeight || 0) - 20);
  const lungoAsse = orizzontale
    ? Math.max(240, timeline.clientWidth)
    : Math.min(Math.round((span / 60) * 40), disponibile);
  scale.style.setProperty('--lungo-asse', `${lungoAsse}px`);
  if (orizzontale) {
    const alto = Math.round(timeline.getBoundingClientRect().height);
    if (alto) timeline.parentElement?.style.setProperty('--asse-alto', `${alto}px`);
  }

  // Le etichette si diradano quando lo spazio si stringe.
  const pxPerMinuto = lungoAsse / span;
  const minimo = orizzontale ? 46 : 22;
  let passo = 60;
  while (passo * pxPerMinuto < minimo && passo < 8 * 60) passo *= 2;
  let tacche = '';
  for (let m = da; m <= a; m += passo) {
    const quota = ((m - da) / span) * 100;
    const bordo = quota <= 1.5 ? ' bordo-inizio' : (quota >= 98.5 ? ' bordo-fine' : '');
    tacche += `<span class="tick${bordo}" style="--inizio:${pct(m)}">${minutesToTime(m)}</span>`;
  }
  timeline.querySelector('.ruler').innerHTML = tacche;

  // Le pause per prime, cosi' stanno sotto agli altri blocchi.
  const ordine = { pause: 0, logged: 1, meeting: 2, task: 3 };
  timeline.querySelector('.track').innerHTML = [...blocchi]
    .sort((x, y) => ordine[x.tipo] - ordine[y.tipo])
    .map((b) => `<div class="${`block ${b.tipo} ${b.serie || ''}`.trim()}" title="${esc(b.label)}"
      style="--inizio:${pct(b.from)};--durata:${((b.to - b.from) / span) * 100}%"
      ${b.rowId ? `data-row-id="${esc(b.rowId)}"` : ''}></div>`).join('');

  // Le attivita' non hanno una voce: la loro legenda e' la pastiglia accanto
  // alla riga. Qui restano le categorie fisse.
  if (legend) {
    const voci = [['meeting', t('legendMeeting')], ['logged', t('legendLogged')], ['pause', t('legendPause')]]
      .filter(([tipo]) => blocchi.some((b) => b.tipo === tipo));
    legend.hidden = !blocchi.length;
    legend.innerHTML = voci.map(([tipo, testo]) =>
      `<span class="legend-item"><i class="block ${tipo}"></i>${esc(testo)}</span>`).join('');
  }
}

/** Evidenzia nell'anteprima i blocchi di una riga. */
export function highlightRow(scope, rowId, on) {
  for (const nodo of scope.querySelectorAll('.timeline .block[data-row-id]')) {
    if (nodo.dataset.rowId === rowId) nodo.classList.toggle('hot', on);
  }
}

/** Il piede: totale, sito, Invia (rosso quando chiede conferma). */
export function renderFooter(state, { busy, sending, confirming, host }) {
  const sito = `<div class="site live"><span class="dot"></span>${esc(t('siteSession', host || '', ''))}</div>`;
  if (busy || !state.config) {
    return `<div class="foot-info"><div class="total">${esc(t('emptyAnalysing'))}</div>${sito}</div>
      <div class="actions"><button class="primary" disabled>${conIcona('send', t('btnSend'))}</button></div>`;
  }
  const s = summary(state);
  const conferma = confirming && s.needsConfirm;
  const etichetta = sending ? t('btnSending') : (conferma ? s.confirmLabel : s.sendLabel);
  return `<div class="foot-info">
      <div class="total${s.overflow ? ' over' : ''}"><strong>${esc(formatMinutes(s.total))}</strong>${esc(s.text)}</div>
      ${sito}
    </div>
    <div class="actions">
      ${conferma ? `<button class="ghost" data-act="cancel-send">${esc(t('btnCancel'))}</button>` : ''}
      <button id="submit" class="${conferma ? 'danger' : 'primary'}" data-act="send"
        ${s.sendable && !sending ? '' : 'disabled'} title="${esc(etichetta)}">${conIcona('send', etichetta)}</button>
    </div>`;
}
