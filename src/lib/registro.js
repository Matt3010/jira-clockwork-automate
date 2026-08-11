// Il registro delle attività: come si legge un evento e come diventa testo.
//
// Sta fuori dal popup perché non ha bisogno del DOM — e perché lì dentro non
// era verificabile. Il popup si occupa solo di disegnare quello che esce da qui.

import { minutesToTime } from './dates.js';
import { t } from './i18n.js';

/** L'ora dell'evento, in minuti dalla mezzanotte locale. */
export function eventMinutes(at) {
  const quando = new Date(at);
  return quando.getHours() * 60 + quando.getMinutes();
}

/** L'ora dell'evento come "09:41". */
export function eventTime(at) {
  return minutesToTime(eventMinutes(at));
}

/**
 * I nomi dei campi come li chiama Jira internamente, tradotti in parole.
 * Quelli che non stanno qui si mostrano come sono: meglio un nome tecnico che
 * una riga vuota, e capita coi campi personalizzati di ogni installazione.
 */
const CAMPI = {
  assignee: 'fieldAssignee',
  summary: 'fieldSummary',
  description: 'fieldDescription',
  priority: 'fieldPriority',
  labels: 'fieldLabels',
  sprint: 'fieldSprint',
  resolution: 'fieldResolution',
  attachment: 'fieldAttachment',
  issuetype: 'fieldIssueType',
  duedate: 'fieldDueDate',
  parent: 'fieldParent',
  'epic link': 'fieldParent',
  link: 'fieldLink',
  reporter: 'fieldReporter'
};

function fieldName(field) {
  const chiave = CAMPI[String(field || '').toLowerCase()];
  return chiave ? t(chiave) : String(field || '');
}

/**
 * Un evento in parole: cosa è successo e su cosa.
 * `verbo` è la parte che conta, `dettaglio` il contorno.
 */
export function describeEvent(evento) {
  switch (evento.tipo) {
    case 'created':
      return { verbo: t('logCreated'), dettaglio: evento.summary || '' };
    case 'status':
      // La direzione va detta per intero: "passata a In corso · Da fare"
      // lasciava indovinare quale dei due fosse il punto di partenza.
      return {
        verbo: t('logStatus', evento.to || '?'),
        dettaglio: evento.from ? t('logStatusFrom', evento.from) : ''
      };
    case 'comment':
      return { verbo: t('logComment'), dettaglio: evento.summary || '' };
    case 'commit':
      return { verbo: t('logCommit'), dettaglio: evento.subject || '' };
    default:
      return { verbo: t('logField', fieldName(evento.field)), dettaglio: evento.to || '' };
  }
}

/** Una riga pronta da incollare nel daily. */
export function logLine(evento) {
  const { verbo, dettaglio } = describeEvent(evento);
  return `- ${eventTime(evento.at)} ${evento.key} — ${verbo}${dettaglio ? ` · ${dettaglio}` : ''}`;
}

/** Il registro intero come testo. */
export function logAsText(eventi) {
  return (eventi || []).map(logLine).join('\n');
}
