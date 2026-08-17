// Helper di date. Tutto lavora in fuso orario locale: e' quello che Jira e
// Clockwork mostrano all'utente, quindi e' quello che deve quadrare.

const pad = (n) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' della data odierna locale. */
export function todayIso() {
  return toIsoDate(new Date());
}

export function toIsoDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Da 'YYYY-MM-DD' + 'HH:mm' a Date locale. */
export function localDateTime(isoDate, time = '00:00') {
  const [y, m, d] = isoDate.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm, 0, 0);
}

/** Estremi della giornata in epoch ms (locale). */
export function dayBounds(isoDate) {
  const start = localDateTime(isoDate, '00:00');
  const end = new Date(start.getTime());
  end.setDate(end.getDate() + 1);
  return { start: start.getTime(), end: end.getTime() };
}

export function isSameLocalDay(timestamp, isoDate) {
  const { start, end } = dayBounds(isoDate);
  const t = typeof timestamp === 'number' ? timestamp : Date.parse(timestamp);
  return Number.isFinite(t) && t >= start && t < end;
}

/** 1 = lunedi ... 7 = domenica */
export function isoWeekday(isoDate) {
  const day = localDateTime(isoDate).getDay();
  return day === 0 ? 7 : day;
}

/** Etichetta settimana ISO, es. '2026-W33'. Usata per ricordare il ticket cerimonie. */
export function isoWeekLabel(isoDate) {
  const d = localDateTime(isoDate);
  d.setDate(d.getDate() + 4 - (d.getDay() || 7)); // giovedi della stessa settimana ISO
  const yearStart = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getFullYear()}-W${pad(week)}`;
}

/**
 * Timestamp nel formato che Jira pretende per `started`:
 * yyyy-MM-dd'T'HH:mm:ss.SSSZ con offset senza due punti.
 */
export function jiraStarted(isoDate, time) {
  const dt = localDateTime(isoDate, time);
  const offsetMinutes = -dt.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const [hh, mm] = time.split(':');
  return `${isoDate}T${pad(Number(hh))}:${pad(Number(mm))}:00.000` +
    `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
}

/** 'HH:mm' + minuti -> 'HH:mm' (senza superare la mezzanotte). */
export function addMinutes(time, minutes) {
  const [hh, mm] = time.split(':').map(Number);
  const total = Math.min(hh * 60 + mm + minutes, 23 * 60 + 59);
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

export function timeToMinutes(time) {
  const [hh, mm] = time.split(':').map(Number);
  return hh * 60 + mm;
}

/** 570 -> '09:30' */
export function minutesToTime(minutes) {
  const clamped = Math.max(0, Math.min(minutes, 23 * 60 + 59));
  return `${pad(Math.floor(clamped / 60))}:${pad(clamped % 60)}`;
}

/** 90 -> '1h30'. Compatto per il badge dell'icona, che tiene 4 caratteri. */
export function shortMinutes(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h${pad(m)}` : `${h}h`;
}

/** 90 -> '1h 30m' */
export function formatMinutes(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

/** JQL vuole "yyyy-MM-dd HH:mm" fra virgolette. */
export function jqlDayRange(isoDate, giorni = 1) {
  const next = localDateTime(isoDate);
  next.setDate(next.getDate() + Math.max(1, giorni));
  return { from: `${isoDate} 00:00`, to: `${toIsoDate(next)} 00:00` };
}
