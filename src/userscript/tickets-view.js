// La scheda Ticket: lo stesso markup del popup, quindi lo stesso aspetto.

import { t } from './i18n.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

/** La data per esteso: "04 ago 2026". */
function ticketDay(day) {
  if (!day) return t('ticketsNoDate');
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Il cartellino di uno stato, coi colori per categoria che ha Jira. */
const statusBadge = (name, category) =>
  `<span class="stato cat-${esc(category || 'unknown')}">${esc(name)}</span>`;

function movesMenu(state, issue) {
  if (state.openMenu !== issue.key) return '';
  let dentro;
  if (state.moving === issue.key) dentro = `<span class="moves-hint">${esc(state.movingLabel || '')}</span>`;
  else if (state.menuError) dentro = `<span class="moves-hint">${esc(state.menuError)}</span>`;
  else if (!state.transitions.has(issue.key)) dentro = `<span class="moves-hint">${esc(t('ticketsLoadingMoves'))}</span>`;
  else {
    const transizioni = state.transitions.get(issue.key);
    dentro = transizioni.length
      ? transizioni.map((tr) => `<button type="button" class="move-to cat-${esc(tr.category || 'unknown')}"
          data-act="move-to" data-key="${esc(issue.key)}" data-transition="${esc(tr.id)}"
          data-to="${esc(tr.to || tr.name)}">${esc(tr.to || tr.name)}</button>`).join('')
      : `<span class="moves-hint">${esc(t('ticketsNoMoves'))}</span>`;
  }
  return `<div class="moves">${dentro}</div>`;
}

/**
 * Una riga di ticket. Fra i risultati di ricerca anche stato e assegnatario:
 * sono ticket sparsi, e possono essere di chiunque.
 */
function ticketRow(state, issue, { conStato = false } = {}) {
  const meta = conStato
    ? `<div class="ticket-meta">${statusBadge(issue.status || t('ticketsNoStatus'), issue.category)}
        <span class="assegnato">${esc(issue.assignee || t('ticketsUnassigned'))}</span></div>`
    : '';
  return `<li class="ticket${state.justMoved === issue.key ? ' appena-spostato' : ''}" data-key="${esc(issue.key)}">
    <div class="ticket-line">
      <a class="chiave" href="/browse/${encodeURIComponent(issue.key)}" target="_blank"
        title="${esc(t('titleOpenInJira', issue.key))}">${esc(issue.key)}</a>
      <span class="cosa" title="${esc(issue.summary)}">${esc(issue.summary)}</span>
      <button type="button" class="ghost move" data-act="move" data-key="${esc(issue.key)}"
        ${state.moving || (state.openMenu === issue.key && !state.transitions.has(issue.key) && !state.menuError) ? 'disabled' : ''}>${esc(t('btnMove'))}</button>
    </div>
    ${meta}
    ${movesMenu(state, issue)}
  </li>`;
}

function ticketGroup(state, gruppo) {
  return `<section class="ticket-group">
    <div class="group-head">${statusBadge(gruppo.status || t('ticketsNoStatus'), gruppo.category)}
      <span class="group-count">${gruppo.count}</span></div>
    ${gruppo.days.map((giorno) => `<div class="day-head">${esc(t('ticketsOpenedOn', ticketDay(giorno.day)))}</div>
      <ul class="ticket-list">${giorno.issues.map((issue) => ticketRow(state, issue)).join('')}</ul>`).join('')}
  </section>`;
}

/** La scheda intera. Il campo di ricerca si ridisegna col valore che ha. */
export function renderTickets(state) {
  let conto = '';
  let elenco = '';
  let vuoto = '';
  if (state.loading || state.searching) conto = t('emptyAnalysing');
  else if (state.error) vuoto = state.error;
  else if (state.query) {
    conto = state.results.length ? t('searchCount', state.results.length) : '';
    elenco = `<ul class="ticket-list piatta">${state.results.map((issue) => ticketRow(state, issue, { conStato: true })).join('')}</ul>`;
    if (!state.results.length) vuoto = t('searchEmpty', state.query);
  } else {
    conto = state.total ? t('ticketsCount', state.total) : '';
    elenco = state.groups.map((gruppo) => ticketGroup(state, gruppo)).join('');
    if (!state.groups.length && state.at) vuoto = t('ticketsEmpty');
  }
  return `<section class="tickets-view">
    <div class="search-row">
      <input type="search" class="search" data-act="search" value="${esc(state.query)}"
        placeholder="${esc(t('placeholderSearch'))}">
    </div>
    <div class="log-head"><span class="log-count">${esc(conto)}</span></div>
    <div class="tickets">${elenco}</div>
    <p class="empty"${vuoto ? '' : ' hidden'}>${esc(vuoto)}</p>
  </section>`;
}
