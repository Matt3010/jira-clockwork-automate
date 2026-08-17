// Costruzione del piano della giornata: riunioni a durata fissa + task di lavoro
// che si dividono le ore residue.

import {
  addMinutes,
  formatMinutes,
  isoWeekLabel,
  isoWeekday,
  minutesToTime,
  timeToMinutes
} from './dates.js';
import { meetingMemoryKey } from './storage.js';

/**
 * Divide `totalMinutes` fra `count` righe in multipli di `increment`.
 * Il resto viene distribuito sulle prime righe, cosi' la somma torna esatta.
 */
export function distributeMinutes(totalMinutes, count, increment) {
  if (count <= 0) return [];
  const inc = Math.max(1, increment);
  const units = Math.floor(Math.max(0, totalMinutes) / inc);
  const base = Math.floor(units / count);
  const remainder = units - base * count;
  return Array.from({ length: count }, (_, i) => (base + (i < remainder ? 1 : 0)) * inc);
}

/**
 * Divide `totalMinutes` in proporzione ai pesi, sempre in multipli di
 * `increment` e con la somma esatta.
 *
 * I resti non vanno "ai primi" come nella divisione in parti uguali, ma a chi
 * ha la frazione piu' alta: con pesi diversi, dare il resto per posizione
 * significherebbe premiare l'ordine invece del lavoro. A parita' di frazione
 * decide il peso, cosi' il risultato non dipende dall'ordine delle righe.
 */
export function distributeByWeight(totalMinutes, weights, increment) {
  const pesi = (weights || []).map((peso) => Math.max(0, Number(peso) || 0));
  if (!pesi.length) return [];
  const inc = Math.max(1, increment);
  const units = Math.floor(Math.max(0, totalMinutes) / inc);
  const totale = pesi.reduce((somma, peso) => somma + peso, 0);
  // Senza pesi non c'e' proporzione da rispettare: meglio parti uguali che
  // tutto alla prima riga.
  if (!totale) return distributeMinutes(totalMinutes, pesi.length, inc);

  const esatte = pesi.map((peso) => (units * peso) / totale);
  const quote = esatte.map((valore) => Math.floor(valore));
  let resto = units - quote.reduce((somma, valore) => somma + valore, 0);

  const ordine = esatte
    .map((valore, indice) => ({ indice, frazione: valore - Math.floor(valore), peso: pesi[indice] }))
    .sort((a, b) => b.frazione - a.frazione || b.peso - a.peso || a.indice - b.indice);

  for (let i = 0; resto > 0; i += 1, resto -= 1) quote[ordine[i % ordine.length].indice] += 1;
  return quote.map((unita) => unita * inc);
}

export function meetingsForDay(meetings, isoDate) {
  const weekday = isoWeekday(isoDate);
  return (meetings || [])
    .filter((meeting) => (meeting.days || []).includes(weekday))
    .sort((a, b) => timeToMinutes(a.time) - timeToMinutes(b.time));
}

const STOPWORDS = new Set(['di', 'del', 'della', 'the', 'and', 'con', 'per', 'team']);

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-zà-ù0-9]+/)
    .filter((word) => word.length > 3 && !STOPWORDS.has(word));
}

/** La data del giorno nei formati che si trovano nei titoli dei ticket cerimonie. */
export function dateVariants(isoDate) {
  const [y, m, d] = isoDate.split('-');
  return [
    `${y}-${m}-${d}`, `${y}/${m}/${d}`,
    `${d}-${m}-${y}`, `${d}/${m}/${y}`, `${d}.${m}.${y}`
  ];
}

/**
 * Il segnale piu' forte per capire su quale ticket va una riunione: un worklog
 * gia' registrato che parte alla stessa ora. Se alle 9:30 hai segnato mezz'ora
 * su EG-289, la riunione delle 9:30 e' EG-289 — nessuna euristica sui titoli
 * regge il confronto.
 */
export function matchMeetingByTime(meeting, loggedEntries, { taken = new Set(), tolerance = 30 } = {}) {
  const target = timeToMinutes(meeting.time);
  let best = null;
  let bestDiff = Infinity;
  let bestDuration = Infinity;

  for (const entry of loggedEntries || []) {
    if (taken.has(entry.key)) continue;
    const diff = Math.abs(entry.startMinutes - target);
    if (diff > tolerance) continue;
    const durationDiff = Math.abs(entry.minutes - meeting.minutes);
    // A parita' di scarto sull'orario vince la durata piu' simile.
    if (diff < bestDiff || (diff === bestDiff && durationDiff < bestDuration)) {
      best = entry;
      bestDiff = diff;
      bestDuration = durationDiff;
    }
  }
  return best ? { key: best.key, summary: best.summary, reason: 'orario' } : null;
}

/**
 * Ripiego quando l'orario non basta. Due segnali:
 *
 *  1. le parole del nome della riunione nel titolo ("Standup di progetto" ->
 *     "Standup - Team Sprint 8");
 *  2. la data del giorno nel titolo ("Weekly Meet 2026-08-10"), perche' molti
 *     ticket delle cerimonie vengono creati con la data dentro.
 *
 * Il primo pesa dieci volte il secondo: cosi' la data fa da ripiego quando il
 * nome non combacia, senza pero' rubare il ticket a una riunione che invece
 * combacia per nome. Le issue arrivano ordinate per ultimo aggiornamento,
 * quindi a parita' di punteggio vince la piu' fresca.
 */
export function guessMeetingIssue(label, recentIssues, { isoDate, taken = new Set() } = {}) {
  const wanted = tokenize(label);
  const dates = isoDate ? dateVariants(isoDate) : [];
  if (!wanted.length && !dates.length) return null;

  let best = null;
  let bestScore = 0;
  for (const issue of recentIssues || []) {
    if (taken.has(issue.key)) continue;
    const summary = String(issue.summary || '');
    const words = new Set(tokenize(summary));
    const byName = wanted.filter((word) => words.has(word)).length;
    const byDate = dates.some((variant) => summary.includes(variant)) ? 1 : 0;
    const score = byName * 10 + byDate;
    if (score > bestScore) {
      bestScore = score;
      best = issue;
    }
  }
  if (!best) return null;
  return {
    key: best.key,
    summary: best.summary,
    score: bestScore,
    reason: bestScore >= 10 ? 'nome' : 'data'
  };
}

/** Le modifiche fatte da altri su una issue tua: non sono lavoro tuo. */
const ESTRANEO = new Set(['foreign', 'foreignComment']);

/**
 * Da cosa nasce la riga, in numeri. La frase la compone chi disegna: il planner
 * non deve produrre prosa, o non si puo' tradurre.
 */
function countActivity(jiraEvents, gitCommits) {
  const eventi = jiraEvents || [];
  const comments = eventi.filter((e) => e.kind === 'comment').length;
  // La creazione si conta a parte: dire "1 modifica" di un ticket che hai
  // aperto tu e' sbagliato, e nasconde il fatto che scriverlo e' stato
  // lavoro suo.
  const created = eventi.filter((e) => e.kind === 'created').length;
  // Contarle fra le modifiche direbbe "2 modifiche Jira" di una giornata in
  // cui non hai toccato niente, e peserebbe nella divisione delle ore.
  const foreign = eventi.filter((e) => ESTRANEO.has(e.kind)).length;
  return {
    changes: eventi.length - comments - created - foreign,
    created,
    comments,
    foreign,
    commits: (gitCommits || []).length
  };
}

/**
 * L'evento ti ha assegnato la task.
 *
 * Lo decide chi legge da Jira, che vede l'accountId del nuovo assegnatario:
 * qui arriverebbe solo il nome del campo cambiato, e "assegnata a un terzo"
 * e' indistinguibile da "assegnata a te".
 */
const touchesAssignee = (evento) => Boolean(evento?.assignsYou);

/**
 * Chi altro ha messo mano a questa issue oggi, e quanto.
 *
 * Vale su tutte le righe, non solo su quelle dove non hai fatto niente: sapere
 * che sulla tua task ha committato un collega e' meta' del daily, e prima non
 * si vedeva da nessuna parte — i suoi commit erano un numero in un avviso in
 * cima, staccato dalla task a cui appartengono.
 */
function othersOn(jiraEvents, foreignCommits) {
  const per = new Map();
  const voce = (nome) => {
    const chiave = nome || '';
    if (!per.has(chiave)) {
      // `commitUrls` serve a chi disegna: da «2 commit» si deve poter arrivare
      // ai commit, non alla issue e poi cercarli a mano. `firstAt`/`lastAt`
      // servono a dire *quando*: «3 modifiche» senza un orario non si colloca
      // nella giornata, e chi legge non sa se e' successo prima o dopo il suo
      // lavoro.
      per.set(chiave, {
        name: chiave, assigned: false, changes: 0, commits: 0, commitUrls: [],
        firstAt: null, lastAt: null
      });
    }
    return per.get(chiave);
  };

  /** Gli istanti arrivano sia in millisecondi sia come testo ISO. */
  const quando = (chi, at) => {
    const ms = typeof at === 'number' ? at : Date.parse(at);
    if (!Number.isFinite(ms)) return;
    if (chi.firstAt === null || ms < chi.firstAt) chi.firstAt = ms;
    if (chi.lastAt === null || ms > chi.lastAt) chi.lastAt = ms;
  };

  for (const evento of jiraEvents || []) {
    if (!ESTRANEO.has(evento.kind)) continue;
    const chi = voce(evento.by);
    chi.changes += 1;
    quando(chi, evento.at);
    if (touchesAssignee(evento)) {
      chi.assigned = true;
      chi.assignedAt = typeof evento.at === 'number' ? evento.at : Date.parse(evento.at);
    }
  }
  for (const commit of foreignCommits || []) {
    const chi = voce(commit.author);
    chi.commits += 1;
    quando(chi, commit.at);
    if (commit.url) chi.commitUrls.push(commit.url);
  }

  return [...per.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Nota precompilata del worklog. I soggetti dei commit sono la traccia migliore
 * e vanno usati cosi' come sono; altrimenti si rimanda a una frase tradotta.
 *
 * Ci vanno tutti, uno per riga: sono la lista di quello che hai fatto, e
 * tenerne tre su sette vorrebbe dire scegliere per conto tuo quali pezzi della
 * giornata valgono. In riga unica separati da un punto si leggevano come una
 * frase sola, e con piu' di due commit diventava illeggibile. I doppioni si
 * tolgono: lo stesso soggetto su due commit e' un rebase, non due lavori.
 */
function defaultComment(jira, commits) {
  if (commits?.length) {
    const subjects = [...new Set(commits.map((c) => c.subject).filter(Boolean))];
    if (subjects.length) return { text: subjects.join('\n') };
  }
  const kinds = new Set((jira?.events || []).map((e) => e.kind));
  if (kinds.has('comment') && kinds.has('changelog')) return { key: 'commentProgressAndComments' };
  if (kinds.has('comment')) return { key: 'commentAnalysis' };
  return { key: 'commentProgress' };
}

/**
 * @param {object} input
 * @param {string} input.isoDate
 * @param {object} input.config
 * @param {Map<string, {key,summary,events}>} input.jiraActivity
 * @param {Map<string, Array>} input.gitByIssue
 * @param {Map<string, Array>} input.foreignGitByIssue  commit dei colleghi, per issue
 * @param {Record<string,string>} input.summaries      fallback key -> summary
 * @param {Array<{key,summary}>} input.recentIssues    per indovinare i ticket riunione
 * @param {number} input.alreadyLoggedMinutes          ore gia' registrate quel giorno
 */
export function buildPlan({
  isoDate,
  config,
  jiraActivity,
  gitByIssue,
  foreignGitByIssue = new Map(),
  summaries = {},
  recentIssues = [],
  loggedEntries = [],
  loggedByIssue = {},
  alreadyLoggedMinutes = 0
}) {
  const warnings = [];
  const weekLabel = isoWeekLabel(isoDate);
  const memory = config.weeklyMeetingIssues || {};

  // Due riunioni dello stesso giorno non devono ricevere lo stesso ticket.
  const takenByMeeting = new Set(
    meetingsForDay(config.meetings, isoDate)
      .map((meeting) => memory[meetingMemoryKey(weekLabel, meeting.label)])
      .filter(Boolean)
  );

  const meetingRows = meetingsForDay(config.meetings, isoDate).map((meeting) => {
    const memoryKey = meetingMemoryKey(weekLabel, meeting.label);
    const remembered = memory[memoryKey] || '';
    // In ordine di affidabilita': la scelta della settimana, poi un worklog
    // gia' registrato a quell'ora, e solo in ultimo i titoli delle issue.
    const guess = remembered
      ? null
      : matchMeetingByTime(meeting, loggedEntries, { taken: takenByMeeting })
        || guessMeetingIssue(meeting.label, recentIssues, { isoDate, taken: takenByMeeting });
    if (guess) takenByMeeting.add(guess.key);
    return {
      id: `meeting:${meeting.id}`,
      kind: 'meeting',
      label: meeting.label,
      memoryKey,
      issueKey: remembered || guess?.key || '',
      summary: guess?.summary || '',
      guessed: Boolean(guess),
      guessReason: guess?.reason || null,
      // `defaultMinutes` e' la durata configurata, `minutes` e' quanto verra'
      // scritto: sono due cose diverse appena la riga viene spenta.
      defaultMinutes: meeting.minutes,
      minutes: meeting.minutes,
      time: meeting.time,
      comment: meeting.label,
      enabled: true,
      existingMinutes: 0
    };
  });

  // Una issue assegnata a una riunione non deve comparire anche fra le task:
  // l'attivita' Jira sul ticket delle cerimonie e' la riunione stessa.
  const meetingKeys = new Set(meetingRows.map((row) => row.issueKey).filter(Boolean));

  // Anche le issue su cui le ore ci sono gia': le hai messe a mano da
  // Clockwork, o da qui in un invio precedente. Senza, una giornata segnata
  // altrove risultava vuota qui — e la riga che manca e' proprio quella che
  // spiega dove sono finite le ore.
  const taskKeys = [...new Set([
    ...jiraActivity.keys(), ...gitByIssue.keys(), ...Object.keys(loggedByIssue)
  ])].filter((key) => !meetingKeys.has(key));

  const taskRows = taskKeys.map((key) => {
    const jira = jiraActivity.get(key);
    const commits = gitByIssue.get(key) || [];
    const altrui = foreignGitByIssue.get(key) || [];
    // Il titolo di una issue vista solo dalle ore gia' registrate arriva dal
    // worklog: la ricerca del giorno non la restituisce, perche' registrare
    // ore non e' un'attivita'.
    const daWorklog = loggedEntries.find((entry) => entry.key === key);
    const activity = countActivity(jira?.events, commits);
    // Il marchio "jira" vuol dire "ci hai lavorato dentro Jira": una issue che
    // porta solo la mossa di un collega non lo merita, nemmeno quando hai
    // commit che la riguardano.
    const tuoSuJira = Boolean(activity.changes || activity.created || activity.comments);
    const soloAltrui = Boolean(activity.foreign) && !tuoSuJira && !commits.length;
    const sources = [];
    if (tuoSuJira) sources.push('jira');
    if (commits.length) sources.push('git');
    if (soloAltrui) sources.push('foreign');
    const nota = defaultComment(jira, commits);
    return {
      id: `task:${key}`,
      kind: 'task',
      issueKey: key,
      summary: jira?.summary || summaries[key] || daWorklog?.summary || '',
      label: '',
      minutes: 0,
      time: '',
      sources,
      activity,
      // Chi altro ci ha messo mano oggi, su ogni riga: e' la domanda
      // "in quali delle mie task hanno lavorato altri", e la risposta sta
      // accanto alla task, non in un avviso in cima.
      others: othersOn(jira?.events, altrui),
      // Peso per l'ordinamento: piu' fonti e piu' eventi vuol dire piu'
      // probabilmente il lavoro principale della giornata. Una issue mossa
      // solo da altri pesa zero: finisce in fondo e non prende mai il resto
      // della divisione.
      weight: soloAltrui ? 0 : sources.length * 100 +
        activity.changes + activity.created + activity.comments + activity.commits,
      comment: nota.text || '',
      commentKey: nota.key || null,
      // E parte spenta. Farsi assegnare un ticket alle 17:00 non e' averci
      // lavorato: se ci hai lavorato lo accendi tu, ma le ore della giornata
      // non devono finirci sopra da sole.
      enabled: !soloAltrui,
      // Il motivo per cui e' spenta, scritto: `autoDisabled` da solo non lo
      // distingue da "spenta perche' le ore c'erano gia'", e quel motivo li'
      // scade — questo no.
      notYours: soloAltrui,
      existingMinutes: 0
    };
  });

  // Chi ha piu' peso finisce in cima e prende l'eventuale resto della divisione.
  taskRows.sort((a, b) => b.weight - a.weight || a.issueKey.localeCompare(b.issueKey));

  const rows = [...meetingRows, ...taskRows];

  // Una riga che ha gia' un worklog quel giorno parte spenta: riaccenderla
  // significa volerla registrare una seconda volta.
  for (const row of rows) {
    row.existingMinutes = loggedByIssue[row.issueKey] || 0;
    // `autoDisabled` distingue "spenta dal controllo duplicati" da "spenta da
    // te": se le ore spariscono da Jira, la prima va riaccesa, la seconda no.
    if (row.existingMinutes) {
      row.enabled = false;
      // Ma non su una riga che e' spenta perche' non ci hai lavorato tu:
      // marcarla `autoDisabled` seppellirebbe quel motivo sotto questo, e alla
      // sparizione del worklog la rilettura la riaccenderebbe — mettendola a
      // prendersi le ore di una giornata in cui non l'hai toccata.
      if (!row.notYours) row.autoDisabled = true;
    }
  }

  const dayBudgetMinutes = Math.round((config.work.dailyHours || 8) * 60);
  const contesto = { dayBudgetMinutes, alreadyLoggedMinutes, loggedEntries };

  // Quali righe restano accese va deciso prima di distribuire: altrimenti le
  // riunioni si terrebbero la loro durata pur non dovendo scrivere nulla.
  if (budgetFor(rows, dayBudgetMinutes, alreadyLoggedMinutes) <= 0 && dayBudgetMinutes > 0) {
    // Aggiungere ore sopra una giornata gia' piena e' quasi sempre un errore:
    // le righe partono spente e si riaccendono a mano se serve davvero.
    rows.forEach((row) => { row.enabled = false; });
    warnings.push({
      level: 'info',
      key: 'planDayAlreadyFull',
      params: [formatMinutes(alreadyLoggedMinutes), formatMinutes(dayBudgetMinutes)]
    });
  } else if (!taskRows.length) {
    warnings.push({ level: 'info', key: 'planNoTasks', params: [] });
  }

  const { budgetMinutes, endOfDay } = reflow(rows, config, contesto, warnings);

  if (endOfPlan(rows) > 24 * 60) {
    warnings.push({ level: 'action', key: 'planPastMidnight', params: [] });
  }

  return {
    rows,
    budgetMinutes,
    dayBudgetMinutes,
    alreadyLoggedMinutes,
    endOfDay,
    loggedEntries,
    warnings
  };
}

/**
 * Monte ore ancora da distribuire.
 *
 * Le ore gia' registrate riducono lo spazio disponibile, ma solo quelle che
 * NON stai rifacendo: riaccendere una riga che ha gia' un worklog e' una scelta
 * esplicita ("questa la rimetto"), e allora quelle ore tornano a disposizione.
 * Senza questo, riaccendere una riga la lasciava a zero senza spiegazione.
 */
export function budgetFor(rows, dayBudgetMinutes, alreadyLoggedMinutes) {
  const rifatte = rows
    .filter((row) => row.enabled && row.existingMinutes)
    .reduce((sum, row) => sum + row.existingMinutes, 0);
  const bloccate = Math.max(0, alreadyLoggedMinutes - rifatte);
  return Math.max(0, dayBudgetMinutes - bloccate);
}

/**
 * Minuti riservati dalle riunioni. Una riunione senza ticket non e' inviabile,
 * quindi non riserva niente: altrimenti il suo tempo sparirebbe dalla giornata
 * invece di tornare alle task.
 */
export function reservedByMeetings(rows) {
  return rows
    .filter((row) => row.kind === 'meeting' && row.enabled && row.issueKey)
    .reduce((sum, row) => sum + row.minutes, 0);
}

/** L'ultimo minuto occupato dai blocchi pianificati. */
export function endOfPlan(rows) {
  let end = 0;
  for (const row of rows) {
    for (const segment of row.segments || []) {
      end = Math.max(end, timeToMinutes(segment.time) + segment.minutes);
    }
  }
  return end;
}

/**
 * Distribuisce il tempo residuo fra le task attive. Le righe con `locked` sono
 * state corrette a mano: tengono il loro valore e riducono il resto.
 *
 * Unica implementazione, usata sia alla costruzione del piano sia a ogni
 * modifica nel popup: due copie divergerebbero al primo ritocco.
 */
/** Quanto risulta fatto su una riga: e' la misura della divisione a proporzione. */
function effortOf(row) {
  const { changes = 0, created = 0, comments = 0, commits = 0 } = row.activity || {};
  return Math.max(1, changes + created + comments + commits);
}

export function allocate(rows, config, budgetMinutes, warnings = []) {
  const increment = config.work.roundingMinutes || 15;

  // Una riga che non verra' scritta mostra zero: spenta, oppure senza ticket.
  // Esibire ore che non finiranno da nessuna parte e' la cosa piu' confondente
  // che si possa fare. Il valore corretto a mano non va perso: resta in
  // `lockedMinutes` e torna appena la riga torna inviabile.
  for (const row of rows) {
    if (!row.enabled || !row.issueKey) {
      row.minutes = 0;
    } else if (row.locked) {
      row.minutes = row.lockedMinutes ?? row.minutes;
    } else if (row.kind === 'meeting') {
      row.minutes = row.defaultMinutes ?? row.minutes;
    }
  }

  const reserved = reservedByMeetings(rows);
  // Senza ticket una task non e' inviabile: non partecipa alla divisione,
  // altrimenti si prende una fetta di giornata che nessuno scrivera'.
  const tasks = rows.filter((row) => row.kind === 'task' && row.enabled && row.issueKey);
  const free = tasks.filter((row) => !row.locked);
  const lockedMinutes = tasks
    .filter((row) => row.locked)
    .reduce((sum, row) => sum + row.minutes, 0);

  if (budgetMinutes <= 0) {
    // Monte ore gia' esaurito: la causa non sono le riunioni, e il messaggio
    // lo scrive buildPlan, che sa quante ore erano gia' registrate.
    free.forEach((row) => { row.minutes = 0; });
    return rows;
  }

  const remaining = budgetMinutes - reserved - lockedMinutes;
  if (remaining <= 0) {
    free.forEach((row) => { row.minutes = 0; });
    if (free.length && reserved >= budgetMinutes) {
      warnings.push({
        level: 'info',
        key: 'planMeetingsCoverAll',
        params: [formatMinutes(reserved), formatMinutes(budgetMinutes)]
      });
    }
    return rows;
  }

  // In proporzione al lavoro, se lo hai scelto: una task con sei commit non ha
  // preso lo stesso tempo di una con un cambio di stato. Il minimo di uno
  // tiene dentro le righe senza tracce — aggiunte a mano, o lavorate senza
  // lasciare niente in Jira — che altrimenti prenderebbero zero.
  const slices = config.work.split === 'activity'
    ? distributeByWeight(remaining, free.map(effortOf), increment)
    : distributeMinutes(remaining, free.length, increment);
  free.forEach((row, index) => { row.minutes = slices[index]; });

  if (free.length && slices.some((fetta) => fetta === 0)) {
    warnings.push({
      level: 'action',
      key: 'planTooManyTasks',
      params: [free.length, formatMinutes(remaining), increment]
    });
  }
  return rows;
}

/**
 * Le pause configurate, in minuti dalla mezzanotte, ordinate e fuse quando si
 * sovrappongono. Le righe incomplete o a rovescio vengono scartate.
 */
export function breakRanges(config) {
  return mergeIntervals(
    (config.work?.breaks || [])
      .map((pausa) => ({ from: timeToMinutes(pausa.start || ''), to: timeToMinutes(pausa.end || '') }))
      .filter((r) => Number.isFinite(r.from) && Number.isFinite(r.to) && r.to > r.from)
  );
}

/**
 * Le issue che stai rimettendo: righe accese che hanno gia' un worklog quel
 * giorno. I loro worklog esistenti non bloccano ne' monte ore ne' orari.
 * Serve al planner e all'anteprima: una definizione sola, o i due divergono e
 * il grafico mostra una giornata diversa da quella che verra' scritta.
 */
export function redoneKeys(rows) {
  return new Set(
    rows
      .filter((row) => row.enabled && row.existingMinutes && row.issueKey)
      .map((row) => row.issueKey)
  );
}

/** Fonde intervalli sovrapposti o adiacenti. */
function mergeIntervals(intervals) {
  const sorted = [...intervals].sort((a, b) => a.from - b.from);
  const merged = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.from <= last.to) last.to = Math.max(last.to, range.to);
    else merged.push({ ...range });
  }
  return merged;
}

/**
 * Tutto cio' che occupa la giornata e non e' lavoro da distribuire: le pause,
 * le riunioni che verranno scritte, e i worklog gia' registrati che NON stai
 * rifacendo.
 */
export function busyIntervals(rows, config, loggedEntries = []) {
  const busy = breakRanges(config).map((p) => ({ ...p }));

  for (const row of rows) {
    if (row.kind !== 'meeting' || !row.enabled || !row.issueKey || !row.minutes) continue;
    // Se la riunione e' gia' stata spezzata dalle pause valgono i suoi segmenti:
    // sommare durata e orario di inizio occuperebbe anche la pausa in mezzo, e
    // libererebbe la coda in cui la riunione invece prosegue.
    const blocchi = row.segments?.length
      ? row.segments
      : [{ time: row.time, minutes: row.minutes }];
    for (const blocco of blocchi) {
      const from = timeToMinutes(blocco.time);
      busy.push({ from, to: from + blocco.minutes });
    }
  }

  const rifatte = redoneKeys(rows);
  for (const entry of loggedEntries) {
    if (rifatte.has(entry.key)) continue;
    busy.push({ from: entry.startMinutes, to: entry.startMinutes + entry.minutes });
  }

  return mergeIntervals(busy);
}

/** Le finestre libere dalla partenza in poi; l'ultima e' aperta. */
export function freeSlots(busy, fromMinutes) {
  const slots = [];
  let cursor = fromMinutes;
  for (const range of busy) {
    if (range.to <= cursor) continue;
    if (range.from > cursor) slots.push({ from: cursor, to: range.from });
    cursor = Math.max(cursor, range.to);
  }
  slots.push({ from: cursor, to: Infinity });
  return slots;
}

/**
 * Ricalcola tutto il piano nell'ordine giusto: monte ore, cursore di partenza,
 * distribuzione, orari.
 *
 * Esiste come funzione unica perche' serve in due momenti — quando il piano
 * viene costruito e a ogni modifica nel popup — e i quattro passi vanno sempre
 * fatti insieme e in quest'ordine: il budget dipende da quali righe sono
 * accese, gli orari dipendono dal budget.
 *
 * @param {object} contesto  { dayBudgetMinutes, alreadyLoggedMinutes, loggedEntries }
 */
export function reflow(rows, config, contesto, warnings = []) {
  const { dayBudgetMinutes, alreadyLoggedMinutes = 0, loggedEntries = [] } = contesto;
  const budgetMinutes = budgetFor(rows, dayBudgetMinutes, alreadyLoggedMinutes);
  allocate(rows, config, budgetMinutes, warnings);
  layoutTimes(rows, config, { loggedEntries });
  return { budgetMinutes, endOfDay: minutesToTime(Math.min(endOfPlan(rows), 24 * 60 - 1)) };
}

/**
 * Assegna gli orari: riunioni all'ora loro, task a seguire, mai prima della
 * fine di quello che era gia' registrato e mai dentro la pausa.
 */
/**
 * Sistema `minutes` nelle finestre libere a partire da dove eravamo rimasti.
 * Ritorna anche il punto raggiunto, perche' le task si mettono in fila una
 * dopo l'altra e devono riprendere da li'.
 */
function fillSlots(slots, minutes, { index = 0, cursor = slots[0]?.from ?? 0 } = {}) {
  const segments = [];
  let left = minutes;
  let i = index;
  let at = cursor;

  while (left > 0 && i < slots.length) {
    const slot = slots[i];
    if (at < slot.from) at = slot.from;
    const space = slot.to - at;
    if (space <= 0) {
      i += 1;
      if (i < slots.length) at = slots[i].from;
      continue;
    }
    const chunk = Math.min(left, space);
    segments.push({ time: minutesToTime(at), minutes: chunk });
    at += chunk;
    left -= chunk;
    if (at >= slot.to) {
      i += 1;
      if (i < slots.length) at = slots[i].from;
    }
  }
  return { segments, index: i, cursor: at };
}

export function layoutTimes(rows, config, { loggedEntries = [] } = {}) {
  const pause = breakRanges(config);

  // Le riunioni restano all'orario che hai configurato — sono appuntamenti, non
  // blocchi da incastrare — ma vengono spezzate dalle pause come tutto il resto.
  // Spezzare non toglie minuti, sposta solo i timestamp: non farlo produrrebbe
  // un worklog che dice che eri in riunione durante una pausa che hai dichiarato.
  for (const meeting of rows.filter((row) => row.kind === 'meeting')) {
    if (!meeting.enabled || !meeting.issueKey || !meeting.minutes) {
      meeting.segments = [];
      continue;
    }
    const inizio = timeToMinutes(meeting.time);
    meeting.segments = fillSlots(freeSlots(pause, inizio), meeting.minutes).segments;
  }

  // Il lavoro riempie gli spazi liberi nell'ordine in cui si presentano —
  // compresa la finestra prima della prima riunione, che altrimenti andrebbe
  // sprecata allungando la giornata.
  const slots = freeSlots(
    busyIntervals(rows, config, loggedEntries),
    timeToMinutes(config.work.startTime || '09:00')
  );

  let posizione = { index: 0, cursor: slots[0].from };
  for (const row of rows) {
    if (row.kind !== 'task') continue;
    if (!row.enabled || !row.minutes) {
      row.time = '';
      row.segments = [];
      continue;
    }
    const esito = fillSlots(slots, row.minutes, posizione);
    posizione = { index: esito.index, cursor: esito.cursor };
    row.segments = esito.segments;
    row.time = esito.segments[0]?.time || '';
  }
  return rows;
}

