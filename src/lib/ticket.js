// I ticket che hai ancora aperti, messi in ordine leggibile.
//
// Sta fuori dal popup per lo stesso motivo di registro.js: raggruppare e
// ordinare non ha bisogno del DOM, e dentro il popup non sarebbe verificabile.

import { toIsoDate } from './dates.js';

/**
 * L'ordine dei gruppi segue la categoria, non l'alfabeto: quello che stai
 * facendo adesso sta sopra a quello che devi ancora cominciare. La categoria e'
 * il dato canonico di Jira — i nomi degli stati cambiano da progetto a
 * progetto, "In Progress"/"In corso"/"Doing" sono tutti `indeterminate`.
 */
const ORDINE_CATEGORIA = { indeterminate: 0, new: 1, done: 3 };

function pesoCategoria(category) {
  const peso = ORDINE_CATEGORIA[category];
  // Una categoria che non conosciamo finisce in mezzo, non in cima: non
  // sappiamo se e' urgente, ma nemmeno che non lo sia.
  return peso === undefined ? 2 : peso;
}

/** La data di apertura come 'YYYY-MM-DD', o '' se Jira non l'ha data. */
export function openedOn(issue) {
  const quando = issue?.created ? new Date(issue.created) : null;
  return quando && Number.isFinite(quando.getTime()) ? toIsoDate(quando) : '';
}

/**
 * I ticket divisi per stato e, dentro ogni stato, per giorno di apertura.
 *
 * Due livelli perche' rispondono a due domande diverse: lo stato dice a che
 * punto sei, la data dice da quanto quel ticket e' li'. Un ticket aperto tre
 * settimane fa e ancora "da fare" si vede solo se le date restano separate.
 *
 * Il piu' recente sta in cima a entrambi i livelli.
 */
export function groupOpenIssues(issues) {
  const perStato = new Map();

  for (const issue of issues || []) {
    if (!issue?.key) continue;
    const status = issue.status || '';
    if (!perStato.has(status)) {
      perStato.set(status, { status, category: issue.category || '', count: 0, days: new Map() });
    }
    const gruppo = perStato.get(status);
    gruppo.count += 1;

    const day = openedOn(issue);
    if (!gruppo.days.has(day)) gruppo.days.set(day, []);
    gruppo.days.get(day).push(issue);
  }

  const gruppi = [...perStato.values()].map((gruppo) => ({
    status: gruppo.status,
    category: gruppo.category,
    count: gruppo.count,
    days: [...gruppo.days.entries()]
      .map(([day, elenco]) => ({
        day,
        issues: elenco.slice().sort(byKey)
      }))
      // Senza data in fondo: e' un dato mancante, non un ticket vecchissimo.
      .sort((a, b) => (a.day && b.day ? b.day.localeCompare(a.day) : (a.day ? -1 : 1)))
  }));

  return gruppi.sort((a, b) =>
    pesoCategoria(a.category) - pesoCategoria(b.category) ||
    a.status.localeCompare(b.status));
}

/** A parita' di giorno l'ordine dev'essere stabile: la chiave lo e'. */
function byKey(a, b) {
  return String(a.key).localeCompare(String(b.key), undefined, { numeric: true });
}

/**
 * Le transizioni che vale la pena mostrare.
 *
 * Jira elenca anche quella che riporta allo stato in cui sei gia': sceglierla
 * non fa niente, quindi non deve occupare spazio.
 */
export function usefulTransitions(transitions, currentStatus) {
  const attuale = String(currentStatus || '').toLowerCase();
  return (transitions || []).filter((tr) => tr?.id && String(tr.to || '').toLowerCase() !== attuale);
}
