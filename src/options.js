import { loadConfig, saveConfig } from './lib/storage.js';
import { addMinutes, timeToMinutes } from './lib/dates.js';

const DAY_LABELS = [
  [1, 'Lun'], [2, 'Mar'], [3, 'Mer'], [4, 'Gio'], [5, 'Ven'], [6, 'Sab'], [7, 'Dom']
];

const $ = (id) => document.getElementById(id);
let config = null;

function send(type) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type }, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response?.ok) return reject(new Error(response?.error || 'Errore sconosciuto'));
      resolve(response.data);
    });
  });
}

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
  labelTitle.textContent = 'Nome';
  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.className = 'm-label';
  labelInput.value = meeting.label;
  labelField.append(labelTitle, labelInput);

  const daysField = document.createElement('div');
  daysField.className = 'field';
  const daysTitle = document.createElement('label');
  daysTitle.textContent = 'Giorni';
  const days = document.createElement('div');
  days.className = 'days';
  for (const [value, text] of DAY_LABELS) {
    const dayLabel = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'm-day';
    input.value = String(value);
    input.checked = (meeting.days || []).includes(value);
    const span = document.createElement('span');
    span.textContent = text;
    dayLabel.append(input, span);
    days.appendChild(dayLabel);
  }
  daysField.append(daysTitle, days);

  const timeField = document.createElement('div');
  timeField.className = 'field small';
  const timeTitle = document.createElement('label');
  timeTitle.textContent = 'Dalle';
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
  endTitle.textContent = 'Alle';
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
  remove.textContent = 'Rimuovi';
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
    const label = node.querySelector('.m-label').value.trim() || 'Riunione';
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
  labelTitle.textContent = 'Nome';
  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.className = 'b-label';
  labelInput.value = pausa.label || '';
  labelField.append(labelTitle, labelInput);

  const fromField = document.createElement('div');
  fromField.className = 'field small';
  const fromTitle = document.createElement('label');
  fromTitle.textContent = 'Dalle';
  const fromInput = document.createElement('input');
  fromInput.type = 'time';
  fromInput.className = 'b-start';
  fromInput.value = pausa.start;
  fromField.append(fromTitle, fromInput);

  const toField = document.createElement('div');
  toField.className = 'field small';
  const toTitle = document.createElement('label');
  toTitle.textContent = 'Alle';
  const toInput = document.createElement('input');
  toInput.type = 'time';
  toInput.className = 'b-end';
  toInput.value = pausa.end;
  toField.append(toTitle, toInput);

  const remove = document.createElement('button');
  remove.className = 'ghost';
  remove.textContent = 'Rimuovi';
  remove.addEventListener('click', () => wrapper.remove());

  wrapper.append(labelField, fromField, toField, remove);
  return wrapper;
}

/** @returns {{breaks: Array, invalid: string[]}} */
function readBreaks() {
  const breaks = [];
  const invalid = [];

  for (const node of document.querySelectorAll('#breaks .meeting')) {
    const label = node.querySelector('.b-label').value.trim() || 'Pausa';
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

  $('dev-panel').checked = config.jira.devPanel;
  $('dev-candidates').value = config.jira.devCandidates;
  $('authors').value = (config.identity.extraAuthors || []).join(', ');

  $('work-hours').value = config.work.dailyHours;
  $('work-rounding').value = config.work.roundingMinutes;
  $('work-start').value = config.work.startTime;

  $('meetings').replaceChildren(...(config.meetings || []).map(renderMeeting));
  $('breaks').replaceChildren(...(config.work.breaks || []).map(renderBreak));
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
      `Non salvato: in ${rotte.join(', ')} l'orario di fine non è successivo a quello di inizio.`,
      'err'
    );
    throw new Error('Orari non validi.');
  }

  const patch = {
    jira: {
      baseUrl,
      projects: parseList($('jira-projects').value).map((p) => p.toUpperCase()),
      scanComments: $('jira-comments').checked,
      devPanel: $('dev-panel').checked,
      devCandidates: Math.max(0, Number($('dev-candidates').value) || 0)
    },
    identity: {
      extraAuthors: parseList($('authors').value)
    },
    work: {
      dailyHours: Math.max(0.5, Number($('work-hours').value) || 8),
      roundingMinutes: Math.max(1, Number($('work-rounding').value) || 15),
      startTime: $('work-start').value || '09:00',
      breaks
    },
    meetings
  };

  // Cambiare sito invalida l'accountId in cache.
  if (urlChanged) patch.cache = { accountId: null };

  config = await saveConfig(patch);
  setResult($('save-result'), 'Salvato.', 'ok');
  setTimeout(() => setResult($('save-result'), '', ''), 2500);
}

$('add-break').addEventListener('click', () => {
  $('breaks').appendChild(renderBreak({
    id: `break-${Date.now()}`,
    label: 'Pausa',
    start: '13:00',
    end: '14:00'
  }));
});

$('add-meeting').addEventListener('click', () => {
  $('meetings').appendChild(renderMeeting({
    id: `meeting-${Date.now()}`,
    label: 'Nuova riunione',
    days: [1, 2, 3, 4, 5],
    time: '09:30',
    minutes: 30
  }));
});

// L'errore di validazione e' gia' mostrato accanto al pulsante.
$('save').addEventListener('click', () => { save().catch(() => {}); });

$('detect-site').addEventListener('click', async () => {
  setResult($('jira-result'), 'Cerco…', '');
  try {
    const { hosts } = await send('detectSite');
    $('jira-url').value = normalizeSite(hosts[0]);
    const altri = hosts.slice(1);
    setResult(
      $('jira-result'),
      `Trovato ${hosts[0]}${altri.length ? ` (aperti anche: ${altri.join(', ')})` : ''}. Controlla e salva.`,
      'ok'
    );
  } catch (error) {
    setResult($('jira-result'), error.message, 'err');
  }
});

$('test-jira').addEventListener('click', async () => {
  setResult($('jira-result'), 'Verifico…', '');
  try {
    await save();
    const me = await send('testJira');
    setResult($('jira-result'), `Connesso come ${me.displayName} su ${me.host}.`, 'ok');
  } catch (error) {
    setResult($('jira-result'), error.message, 'err');
  }
});

loadConfig().then((loaded) => {
  config = loaded;
  fill();
});
