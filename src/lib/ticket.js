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
  const attuale = norm(currentStatus);
  return (transitions || []).filter((tr) => tr?.id && norm(tr.to) !== attuale);
}

// ------------------------------------------------------- salti di piu' stati

/**
 * Gli stati del workflow per il tipo di issue, nell'ordine di Jira.
 *
 * Il tipo conta: in un progetto un bug e una storia possono avere workflow
 * diversi, e offrire uno stato che per quel tipo non esiste porta a un salto
 * che si ferma al primo passo. Se il tipo non si trova si usa il primo
 * elenco: meglio un ordine approssimato che nessun ordine.
 */
export function statesForType(perType, issueType) {
  const elenchi = perType || [];
  const scelto = elenchi.find((voce) => norm(voce.type) === norm(issueType)) || elenchi[0];
  return scelto?.statuses || [];
}

/**
 * Il prossimo passo per andare da `from` a `to`.
 *
 * Il workflow non ce lo da' nessuno: Jira dice solo dove puoi andare da dove
 * sei. Quindi si cammina a vista, usando l'ordine degli stati come bussola —
 * se il bersaglio sta piu' avanti si prende la transizione che avanza di piu'
 * senza superarlo, e si rilegge. Sui workflow lineari, che sono la norma,
 * arriva; su quelli che si biforcano puo' fermarsi, e allora si dice dove si
 * e' arrivati invece di far finta di niente.
 *
 * Restituisce la transizione da applicare, oppure null se non c'e' un passo
 * che avvicini — fermarsi e' meglio che girare in tondo.
 */
export function planStep({ from, to, transitions, order }) {
  const elenco = (transitions || []).filter((tr) => tr?.id);
  if (norm(from) === norm(to)) return null;

  // Se ci si arriva in un colpo non serve nessuna bussola.
  const diretta = elenco.find((tr) => norm(tr.to) === norm(to));
  if (diretta) return diretta;

  const posizioni = new Map((order || []).map((stato, i) => [norm(stato.name), i]));
  const partenza = posizioni.get(norm(from));
  const arrivo = posizioni.get(norm(to));
  // Senza sapere dove stanno i due estremi non c'e' direzione da seguire, e
  // tirare a indovinare vorrebbe dire spostare il ticket a caso.
  if (partenza === undefined || arrivo === undefined) return null;

  const avanti = arrivo > partenza;
  let migliore = null;
  let distanza = Infinity;

  for (const tr of elenco) {
    const dove = posizioni.get(norm(tr.to));
    if (dove === undefined) continue;
    // Solo passi nella direzione giusta, e che si muovano davvero.
    if (avanti ? dove <= partenza : dove >= partenza) continue;
    // E mai oltre il bersaglio: superarlo significherebbe dover tornare
    // indietro, e ogni passaggio in Jira lascia una traccia nel changelog.
    if (avanti ? dove > arrivo : dove < arrivo) continue;

    const quanto = Math.abs(arrivo - dove);
    if (quanto < distanza) {
      distanza = quanto;
      migliore = tr;
    }
  }

  return migliore;
}
