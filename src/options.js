import { loadConfig, saveConfig, exportData, importData, replaceAll } from './lib/storage.js';
import { addMinutes, timeToMinutes, todayIso } from './lib/dates.js';
import { t, applyI18n } from './lib/i18n.js';
import { send } from './lib/comandi.js';

// L'indice nell'elenco più uno dà il giorno ISO: 1 = lunedì.
const DAY_KEYS = ['dayMon', 'dayTue', 'dayWed', 'dayThu', 'dayFri', 'daySat', 'daySun'];

const $ = (id) => document.getElementById(id);
let config = null;

function setResult(node, text, kind) {
  node.className = `result ${kind}`;
  node.textContent = text;
}

function renderMeeting(meeting) {
  const wrapper = document.createElement('div');
  wrapper.className = 'meeting';
  wrapper.dataset.id = meeting.id;

  const labelField = document.createElement('div');
  labelField.className = 'field label-field';
  const labelTitle = document.createElement('label');
  labelTitle.textContent = t('fieldName');
  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.className = 'm-label';
  labelInput.value = meeting.label;
  labelField.append(labelTitle, labelInput);

  const daysField = document.createElement('div');
  daysField.className = 'field';
  const daysTitle = document.createElement('label');
  daysTitle.textContent = t('fieldDays');
  const days = document.createElement('div');
  days.className = 'days';
  for (const [indice, chiave] of DAY_KEYS.entries()) {
    const value = indice + 1;
    const dayLabel = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'm-day';
    input.value = String(value);
    input.checked = (meeting.days || []).includes(value);
    const span = document.createElement('span');
    span.textContent = t(chiave);
    dayLabel.append(input, span);
    days.appendChild(dayLabel);
  }
  daysField.append(daysTitle, days);

  const timeField = document.createElement('div');
  timeField.className = 'field small';
  const timeTitle = document.createElement('label');
  timeTitle.textContent = t('fieldFrom');
  const timeInput = document.createElement('input');
  timeInput.type = 'time';
  timeInput.className = 'm-time';
  timeInput.value = meeting.time;
  timeField.append(timeTitle, timeInput);

  // Internamente resta la durata (e' quello che Jira vuole), ma si inserisce
  // l'orario di fine: e' come la riunione sta scritta sul calendario.
  const endField = document.createElement('div');
  endField.className = 'field small';
  const endTitle = document.createElement('label');
  endTitle.textContent = t('fieldTo');
  const endInput = document.createElement('input');
  endInput.type = 'time';
  endInput.className = 'm-end';
  endInput.value = addMinutes(meeting.time, meeting.minutes);
  endField.append(endTitle, endInput);

  // Spostando l'inizio la riunione trasla, mantenendo la sua durata.
  timeInput.addEventListener('change', () => {
    const durata = timeToMinutes(endInput.value) - timeToMinutes(timeInput.dataset.previous || meeting.time);
    if (durata > 0) endInput.value = addMinutes(timeInput.value, durata);
    timeInput.dataset.previous = timeInput.value;
  });
  timeInput.dataset.previous = meeting.time;

  const remove = document.createElement('button');
  remove.className = 'ghost';
  remove.textContent = t('btnRemove');
  remove.addEventListener('click', () => wrapper.remove());

  wrapper.append(labelField, daysField, timeField, endField, remove);
  return wrapper;
}

/**
 * @returns {{meetings: Array, invalid: string[]}} `invalid` elenca le riunioni
 * con fine non successiva all'inizio: meglio dirlo che salvare una durata finta.
 */
function readMeetings() {
  const meetings = [];
  const invalid = [];

  // Ristretto al proprio contenitore: le pause riusano la classe `.meeting`
  // per la griglia, ma non hanno gli stessi campi.
  for (const node of document.querySelectorAll('#meetings .meeting')) {
    const label = node.querySelector('.m-label').value.trim() || t('defaultMeetingName');
    const days = [...node.querySelectorAll('.m-day')].filter((i) => i.checked).map((i) => Number(i.value));
    if (!days.length) continue;

    const start = node.querySelector('.m-time').value || '09:30';
    const end = node.querySelector('.m-end').value || '';
    const minutes = end ? timeToMinutes(end) - timeToMinutes(start) : 0;
    if (minutes <= 0) {
      invalid.push(label);
      continue;
    }
    meetings.push({ id: node.dataset.id, label, days, time: start, minutes });
  }
  return { meetings, invalid };
}

function renderBreak(pausa) {
  const wrapper = document.createElement('div');
  wrapper.className = 'meeting break-row';
  wrapper.dataset.id = pausa.id;

  const labelField = document.createElement('div');
  labelField.className = 'field label-field';
  const labelTitle = document.createElement('label');
  labelTitle.textContent = t('fieldName');
  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.className = 'b-label';
  labelInput.value = pausa.label || '';
  labelField.append(labelTitle, labelInput);

  const fromField = document.createElement('div');
  fromField.className = 'field small';
  const fromTitle = document.createElement('label');
  fromTitle.textContent = t('fieldFrom');
  const fromInput = document.createElement('input');
  fromInput.type = 'time';
  fromInput.className = 'b-start';
  fromInput.value = pausa.start;
  fromField.append(fromTitle, fromInput);

  const toField = document.createElement('div');
  toField.className = 'field small';
  const toTitle = document.createElement('label');
  toTitle.textContent = t('fieldTo');
  const toInput = document.createElement('input');
  toInput.type = 'time';
  toInput.className = 'b-end';
  toInput.value = pausa.end;
  toField.append(toTitle, toInput);

  const remove = document.createElement('button');
  remove.className = 'ghost';
  remove.textContent = t('btnRemove');
  remove.addEventListener('click', () => wrapper.remove());

  wrapper.append(labelField, fromField, toField, remove);
  return wrapper;
}

/** @returns {{breaks: Array, invalid: string[]}} */
function readBreaks() {
  const breaks = [];
  const invalid = [];

  for (const node of document.querySelectorAll('#breaks .meeting')) {
    const label = node.querySelector('.b-label').value.trim() || t('defaultBreakName');
    const start = node.querySelector('.b-start').value;
    const end = node.querySelector('.b-end').value;
    if (!start || !end || timeToMinutes(end) <= timeToMinutes(start)) {
      invalid.push(label);
      continue;
    }
    breaks.push({ id: node.dataset.id, label, start, end });
  }
  return { breaks, invalid };
}

const SUFFISSO = '.atlassian.net';

/**
 * Dal campo si vuole solo il prefisso, ma incollare l'URL intero deve
 * funzionare lo stesso: protocollo, dominio e percorso vengono ripuliti.
 */
function normalizeSite(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .split('/')[0]
    .replace(/\.atlassian\.net$/, '')
    .replace(/[^a-z0-9-]/g, '');
}

const baseUrlDa = (site) => (site ? `https://${site}${SUFFISSO}` : '');

function parseList(value) {
  return value.split(',').map((part) => part.trim()).filter(Boolean);
}

function fill() {
  $('jira-url').value = normalizeSite(config.jira.baseUrl);
  $('jira-projects').value = (config.jira.projects || []).join(', ');
  $('jira-comments').checked = config.jira.scanComments;

  $('dev-candidates').value = config.jira.devCandidates;
  $('count-merges').checked = config.jira.countMerges !== false;
  $('authors').value = (config.identity.extraAuthors || []).join(', ');

  $('work-hours').value = config.work.dailyHours;
  $('work-rounding').value = config.work.roundingMinutes;
  $('work-start').value = config.work.startTime;
  $('work-split').value = config.work.split || 'equal';
  $('show-badge').checked = config.work.showBadge;
  $('send-comments').checked = config.work.sendComments !== false;
  $('side-panel').checked = config.ui.sidePanel;

  $('meetings').replaceChildren(...(config.meetings || []).map(renderMeeting));
  $('breaks').replaceChildren(...(config.work.breaks || []).map(renderBreak));
}

/**
 * Quello che va rifatto appena la configurazione cambia — sia che la si salvi
 * dal modulo, sia che arrivi da un file. Il badge dipende da monte ore e
 * interruttore; pannello o popup va applicato adesso, non al prossimo avvio
 * del browser.
 */
function applicaSubito() {
  send('refreshBadge').catch(() => {});
  send('refreshUiMode').catch(() => {});
}

async function save() {
  const site = normalizeSite($('jira-url').value);
  $('jira-url').value = site; // mostra subito quello che verrà salvato
  const baseUrl = baseUrlDa(site);
  const urlChanged = baseUrl !== config.jira.baseUrl;
  const { meetings, invalid } = readMeetings();
  const { breaks, invalid: pauseInvalide } = readBreaks();
  const rotte = [...invalid, ...pauseInvalide];

  if (rotte.length) {
    setResult(
      $('save-result'),
      t('msgNotSavedTimes', rotte.join(', ')),
      'err'
    );
    throw new Error('Orari non validi.');
  }

  const patch = {
    jira: {
      baseUrl,
      projects: parseList($('jira-projects').value).map((p) => p.toUpperCase()),
      scanComments: $('jira-comments').checked,
      devCandidates: Math.max(0, Number($('dev-candidates').value) || 0),
      countMerges: $('count-merges').checked
    },
    identity: {
      extraAuthors: parseList($('authors').value)
    },
    work: {
      dailyHours: Math.max(0.5, Number($('work-hours').value) || 8),
      roundingMinutes: Math.max(1, Number($('work-rounding').value) || 15),
      startTime: $('work-start').value || '09:00',
      // Un valore che non conosciamo vale come "parti uguali": e' il modo di
      // dividere che non sorprende nessuno.
      split: $('work-split').value === 'activity' ? 'activity' : 'equal',
      showBadge: $('show-badge').checked,
      sendComments: $('send-comments').checked,
      breaks
    },
    ui: { sidePanel: $('side-panel').checked },
    meetings
  };

  // Cambiare sito invalida l'accountId in cache.
  if (urlChanged) patch.cache = { accountId: null };

  config = await saveConfig(patch);
  applicaSubito();
  setResult($('save-result'), t('msgSaved'), 'ok');
  setTimeout(() => setResult($('save-result'), '', ''), 2500);
}

$('add-break').addEventListener('click', () => {
  $('breaks').appendChild(renderBreak({
    id: `break-${Date.now()}`,
    label: t('defaultBreakName'),
    start: '13:00',
    end: '14:00'
  }));
});

$('add-meeting').addEventListener('click', () => {
  $('meetings').appendChild(renderMeeting({
    id: `meeting-${Date.now()}`,
    label: t('defaultMeetingName'),
    days: [1, 2, 3, 4, 5],
    time: '09:30',
    minutes: 30
  }));
});

// L'errore di validazione e' gia' mostrato accanto al pulsante.
$('save').addEventListener('click', () => { save().catch(() => {}); });

$('detect-site').addEventListener('click', async () => {
  setResult($('jira-result'), t('btnAnalysing'), '');
  try {
    const { hosts } = await send('detectSite');
    $('jira-url').value = normalizeSite(hosts[0]);
    const altri = hosts.slice(1);
    setResult(
      $('jira-result'),
      altri.length ? t('msgSiteFoundOthers', hosts[0], altri.join(', ')) : t('msgSiteFound', hosts[0]),
      'ok'
    );
  } catch (error) {
    setResult($('jira-result'), error.message, 'err');
  }
});

$('test-jira').addEventListener('click', async () => {
  setResult($('jira-result'), t('btnAnalysing'), '');
  try {
    await save();
    const me = await send('testJira');
    setResult($('jira-result'), t('msgConnectedAs', me.displayName, me.host), 'ok');
  } catch (error) {
    setResult($('jira-result'), error.message, 'err');
  }
});

// ------------------------------------------------------- il file di configurazione

// I motivi per cui un file viene rifiutato. Sono codici, non frasi: la frase
// la sceglie `t`, e cosi' resta una sola per lingua.
const ERRORI_IMPORT = {
  NOT_OURS: 'msgImportNotOurs',
  TOO_NEW: 'msgImportTooNew',
  BROKEN: 'msgImportBroken'
};

// Si salva prima di esportare: il file deve contenere quello che si vede a
// schermo, non quello che era stato salvato l'ultima volta.
$('export-config').addEventListener('click', async () => {
  try {
    await save();
  } catch {
    return; // orari non validi: l'errore e' gia' accanto al pulsante Salva
  }
  const testo = JSON.stringify(exportData(config), null, 2);
  const url = URL.createObjectURL(new Blob([testo], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `clockwork-autofill-${todayIso()}.json`;
  link.click();
  URL.revokeObjectURL(url);
  setResult($('backup-result'), t('msgExported'), 'ok');
});

$('import-config').addEventListener('click', () => $('import-file').click());

$('import-file').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  // Azzerato subito: senza, riscegliere lo stesso file non solleverebbe
  // nessun evento e sembrerebbe che il pulsante non funzioni.
  event.target.value = '';
  if (!file) return;

  try {
    config = await replaceAll(importData(JSON.parse(await file.text())));
    fill();
    applicaSubito();
    setResult($('backup-result'), t('msgImported'), 'ok');
  } catch (error) {
    setResult($('backup-result'), t(ERRORI_IMPORT[error.code] || 'msgImportUnreadable'), 'err');
  }
});

// Prima il markup statico, poi i campi: le righe di riunioni e pause vengono
// costruite da JS e si traducono da sole con `t`.
applyI18n();

loadConfig().then((loaded) => {
  config = loaded;
  fill();
});
