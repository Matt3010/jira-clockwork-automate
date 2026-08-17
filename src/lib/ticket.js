// I ticket che hai ancora aperti, messi in ordine leggibile.
//
// Sta fuori dal popup per lo stesso motivo di registro.js: raggruppare e
// ordinare non ha bisogno del DOM, e dentro il popup non sarebbe verificabile.

import { toIsoDate } from './dates.js';

/** Gli stati si confrontano per nome, e i nomi arrivano come capita. */
const norm = (testo) => String(testo || '').trim().toLowerCase();

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

/**
 * Il giorno dell'ultimo movimento, come 'YYYY-MM-DD', o '' se Jira non l'ha
 * dato.
 *
 * Era il giorno di apertura, e rispondeva alla domanda sbagliata: guardando
 * l'elenco dei ticket aperti si vuole sapere cosa si e' mosso di recente e
 * cosa e' fermo da tre settimane, non chi e' nato prima. Un ticket aperto a
 * marzo e ripreso ieri sta in mano adesso, e stava in fondo all'elenco.
 */
export function movedOn(issue) {
  const quando = issue?.updated ? new Date(issue.updated) : null;
  return quando && Number.isFinite(quando.getTime()) ? toIsoDate(quando) : '';
}

/**
 * I ticket divisi per stato e, dentro ogni stato, per giorno dell'ultimo
 * movimento.
 *
 * Due livelli perche' rispondono a due domande diverse: lo stato dice a che
 * punto sei, la data dice da quanto quel ticket e' fermo li'. Un ticket
 * "da fare" che non si muove da tre settimane si vede solo se le date restano
 * separate.
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

    const day = movedOn(issue);
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
        // Dentro la giornata, l'ultimo mosso per primo; a parita' di istante
        // decide la chiave, o l'ordine cambierebbe a ogni rilettura.
        issues: elenco.slice().sort((a, b) => {
          const qa = Date.parse(a.updated) || 0;
          const qb = Date.parse(b.updated) || 0;
          return qb - qa || byKey(a, b);
        })
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
  const attuale = norm(currentStatus);
  return (transitions || []).filter((tr) => tr?.id && norm(tr.to) !== attuale);
}

// Nota su cosa NON c'e' qui: un modo per saltare a uno stato lontano.
//
// C'e' stato, e camminava il workflow a vista usando l'ordine degli stati come
// bussola. Funzionava sui workflow lineari e indovinava su quelli che si
// biforcano — cioe' spostava il ticket dove pareva a lui. Le transizioni che
// Jira restituisce sono invece corrette per costruzione, e incatenarne
// diverse costa un click ciascuna ma non sbaglia mai.
//
// Il salto vero torna possibile il giorno in cui si ha il grafo del workflow
// (`/rest/api/3/workflow/search?expand=transitions`, che vuole i permessi di
// amministrazione). Allora sara' un cammino su archi reali, non una stima.
