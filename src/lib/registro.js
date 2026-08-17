// L'ora di un evento Jira, in minuti e in parole.
//
// Sta fuori dal popup perché non ha bisogno del DOM — e perché lì dentro non
// era verificabile.

import { minutesToTime } from './dates.js';

/** L'ora dell'evento, in minuti dalla mezzanotte locale. */
export function eventMinutes(at) {
  const quando = new Date(at);
  return quando.getHours() * 60 + quando.getMinutes();
}

/** L'ora dell'evento come "09:41". */
export function eventTime(at) {
  return minutesToTime(eventMinutes(at));
}
