// Verifica sui giorni passati: il piano ricostruito contro i worklog veri.
//
// Per un giorno gia' registrato la risposta giusta c'e': e' quello che hai
// segnato tu. Ricostruire il piano come se la giornata fosse vuota e metterlo
// accanto ai worklog dice, ticket per ticket, cosa l'analisi trova, cosa le
// sfugge e quanto sbaglia sulle ore.

import { isoWeekday, localDateTime, toIsoDate } from '../lib/dates.js';

/** Gli ultimi `count` giorni lavorativi (lun-ven) prima di `fromIsoDate`. */
export function lastWorkingDays(count, fromIsoDate) {
  const out = [];
  const d = localDateTime(fromIsoDate);
  while (out.length < count) {
    d.setDate(d.getDate() - 1);
    const iso = toIsoDate(d);
    if (isoWeekday(iso) <= 5) out.push(iso);
  }
  return out;
}

/**
 * Perche' un ticket registrato non e' nel piano, per quanto si puo' dire da
 * qui. Codici, non frasi: il testo lo sceglie chi disegna.
 */
function missingReason(day, key, row) {
  if (row && !row.enabled) return 'disabled';
  if (row && !row.minutes) return 'zeroMinutes';
  const events = day.jiraActivity.get(key)?.events || [];
  if (events.length && events.every((e) => e.kind === 'foreign' || e.kind === 'foreignComment')) {
    return 'onlyOthers';
  }
  if (day.foreignGitByIssue.has(key) && !day.gitByIssue.has(key)) return 'onlyOthersCommits';
  return 'noTrace';
}

/**
 * Confronta il piano ricostruito con i worklog del giorno.
 *
 * @returns {{
 *   isoDate: string, loggedTotal: number, plannedTotal: number,
 *   matchedTickets: number, loggedTickets: number, overlapMinutes: number,
 *   rows: Array<{key, summary, kind, logged, planned, status, reason}>
 * }}
 */
export function compareDay(day, plan) {
  const planned = new Map();
  const rowByKey = new Map();
  for (const row of plan.rows) {
    if (!row.issueKey) continue;
    if (!rowByKey.has(row.issueKey)) rowByKey.set(row.issueKey, row);
    if (row.enabled && row.minutes > 0) {
      planned.set(row.issueKey, (planned.get(row.issueKey) || 0) + row.minutes);
    }
  }
  const logged = new Map(Object.entries(day.logged.byIssue || {}));

  const summaryOf = (key) => rowByKey.get(key)?.summary
    || day.logged.entries.find((e) => e.key === key)?.summary
    || day.jiraActivity.get(key)?.summary
    || '';

  const keys = [...new Set([...logged.keys(), ...planned.keys()])];
  const rows = keys.map((key) => {
    const l = logged.get(key) || 0;
    const p = planned.get(key) || 0;
    const row = rowByKey.get(key);
    let status;
    if (l && p) status = l === p ? 'ok' : 'hours';
    else if (l) status = 'missing';
    else status = 'extra';
    return {
      key,
      summary: summaryOf(key),
      kind: row?.kind || null,
      logged: l,
      planned: p,
      status,
      reason: status === 'missing' ? missingReason(day, key, row) : null
    };
  });

  // Prima quello che non torna, poi il resto; dentro, per ore registrate.
  const peso = { missing: 0, extra: 1, hours: 2, ok: 3 };
  rows.sort((a, b) => peso[a.status] - peso[b.status] || b.logged - a.logged || a.key.localeCompare(b.key));

  const sum = (map) => [...map.values()].reduce((s, m) => s + m, 0);
  return {
    isoDate: day.isoDate,
    loggedTotal: sum(logged),
    plannedTotal: sum(planned),
    loggedTickets: logged.size,
    matchedTickets: rows.filter((r) => r.logged && r.planned).length,
    overlapMinutes: rows.reduce((s, r) => s + Math.min(r.logged, r.planned), 0),
    rows
  };
}
