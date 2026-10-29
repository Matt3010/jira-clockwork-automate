// Le Impostazioni del pannello: disegno e lettura del modulo.
//
// Stesso markup e stesse frasi della pagina Opzioni dell'estensione, meno
// quello che qui non ha senso (sito, icona, popup o pannello laterale).
//
// La validazione non sta qui: `readSettingsForm` restituisce i valori come
// sono, e `applySettingsForm` (settings.js) decide cosa diventano. Cosi' le
// regole si provano in node senza un DOM.

import { addMinutes } from '../lib/dates.js';
import { t } from './i18n.js';

const GIORNI = ['dayMon', 'dayTue', 'dayWed', 'dayThu', 'dayFri', 'daySat', 'daySun'];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

const campo = (etichetta, dentro, classe = '') =>
  `<div class="field ${classe}"><label>${esc(etichetta)}</label>${dentro}</div>`;

export function breakRow(pausa) {
  return `<div class="meeting break-row" data-kind="break" data-id="${esc(pausa.id)}">
    ${campo(t('fieldName'), `<input type="text" class="f-label" value="${esc(pausa.label)}">`, 'label-field')}
    ${campo(t('fieldFrom'), `<input type="time" class="f-start" value="${esc(pausa.start)}">`, 'small')}
    ${campo(t('fieldTo'), `<input type="time" class="f-end" value="${esc(pausa.end)}">`, 'small')}
    <button type="button" class="ghost" data-act="remove-row">${esc(t('btnRemove'))}</button>
  </div>`;
}

export function meetingRow(riunione) {
  const days = new Set(riunione.days || []);
  const giorni = GIORNI.map((chiave, i) => `<label><input type="checkbox" class="f-day" value="${i + 1}"
      ${days.has(i + 1) ? 'checked' : ''}><span>${esc(t(chiave))}</span></label>`).join('');
  return `<div class="meeting" data-kind="meeting" data-id="${esc(riunione.id)}">
    ${campo(t('fieldName'), `<input type="text" class="f-label" value="${esc(riunione.label)}">`, 'label-field')}
    ${campo(t('fieldDays'), `<div class="days">${giorni}</div>`, 'days-field')}
    ${campo(t('fieldFrom'), `<input type="time" class="f-start" value="${esc(riunione.time)}">`, 'small')}
    ${campo(t('fieldTo'), `<input type="time" class="f-end" value="${esc(addMinutes(riunione.time, riunione.minutes))}">`, 'small')}
    <button type="button" class="ghost" data-act="remove-row">${esc(t('btnRemove'))}</button>
  </div>`;
}

const check = (name, acceso, etichetta) => `<div class="field check">
    <input type="checkbox" id="opt-${name}" name="${name}" ${acceso ? 'checked' : ''}>
    <label for="opt-${name}">${esc(etichetta)}</label>
  </div>`;

export function renderSettings(config) {
  const { jira, work, identity } = config;
  const split = (valore, chiave) => `<option value="${valore}" ${work.split === valore ? 'selected' : ''}>${esc(t(chiave))}</option>`;
  return `<div class="opts settings">
    <section>
      <h2>${esc(t('secJira'))}</h2>
      ${campo(t('fieldProjects'), `<input type="text" name="projects" value="${esc((jira.projects || []).join(', '))}" placeholder="ABC, XYZ">
        <p class="hint">${esc(t('hintProjects'))}</p>`)}
      ${check('scanComments', jira.scanComments, t('checkComments'))}
      <div class="with-button">
        <button type="button" class="ghost" data-act="test">${esc(t('btnTestConnection'))}</button>
        <span class="result test-result"></span>
      </div>
    </section>
    <section>
      <h2>${esc(t('secCommits'))}</h2>
      <p class="hint">${esc(t('hintDevPanel'))}</p>
      ${check('countMerges', jira.countMerges !== false, t('checkCountMerges'))}
      <p class="hint">${esc(t('hintCountMerges'))}</p>
      ${campo(t('fieldDevCandidates'), `<input type="number" name="devCandidates" min="0" max="100" value="${esc(jira.devCandidates)}">
        <p class="hint">${esc(t('hintDevCandidates'))}</p>`)}
      ${campo(t('fieldAuthors'), `<input type="text" name="authors" value="${esc((identity.extraAuthors || []).join(', '))}"
          placeholder="${esc(t('authorsPlaceholder'))}">
        <p class="hint">${esc(t('hintAuthors'))}</p>`)}
    </section>
    <section>
      <h2>${esc(t('secDay'))}</h2>
      <div class="row">
        ${campo(t('fieldDailyHours'), `<input type="number" name="dailyHours" min="1" max="24" step="0.5" value="${esc(work.dailyHours)}">`)}
        ${campo(t('fieldRounding'), `<input type="number" name="roundingMinutes" min="1" max="60" step="1" value="${esc(work.roundingMinutes)}">`)}
        ${campo(t('fieldStartTime'), `<input type="time" name="startTime" value="${esc(work.startTime)}">`)}
      </div>
      ${campo(t('fieldSplit'), `<select name="split">${split('equal', 'splitEqual')}${split('activity', 'splitActivity')}${split('estimate', 'splitEstimate')}</select>
        <p class="hint">${esc(t('hintSplit'))}</p>`)}
      ${check('sendComments', work.sendComments !== false, t('checkSendComments'))}
      <p class="hint">${esc(t('hintSendComments'))}</p>
    </section>
    <section>
      <h2>${esc(t('secBreaks'))}</h2>
      <p class="hint">${esc(t('hintBreaks'))}</p>
      <div class="list breaks">${(work.breaks || []).map(breakRow).join('')}</div>
      <button type="button" class="ghost" data-act="add-break">${esc(t('btnAddBreak'))}</button>
    </section>
    <section>
      <h2>${esc(t('secMeetings'))}</h2>
      <p class="hint">${esc(t('hintMeetings'))}</p>
      <div class="list meetings">${(config.meetings || []).map(meetingRow).join('')}</div>
      <button type="button" class="ghost" data-act="add-meeting">${esc(t('btnAddMeeting'))}</button>
    </section>
    <section>
      <h2>${esc(t('secBackup'))}</h2>
      <p class="hint">${esc(t('hintBackup'))}</p>
      <div class="with-button">
        <button type="button" class="ghost" data-act="export">${esc(t('btnExport'))}</button>
        <button type="button" class="ghost" data-act="import-open">${esc(t('btnImport'))}</button>
        <input type="file" accept="application/json,.json" data-act="import" hidden>
      </div>
    </section>
    <div class="opts-foot">
      <button type="button" class="primary" data-act="save">${esc(t('btnSave'))}</button>
      <span class="result save-result"></span>
    </div>
  </div>`;
}

/** I valori del modulo, cosi' come sono: li valida `applySettingsForm`. */
export function readSettingsForm(form) {
  const val = (name) => form.querySelector(`[name="${name}"]`);
  const righe = (kind) => [...form.querySelectorAll(`[data-kind="${kind}"]`)];
  return {
    projects: val('projects').value,
    scanComments: val('scanComments').checked,
    countMerges: val('countMerges').checked,
    devCandidates: val('devCandidates').value,
    authors: val('authors').value,
    dailyHours: val('dailyHours').value,
    roundingMinutes: val('roundingMinutes').value,
    startTime: val('startTime').value,
    split: val('split').value,
    sendComments: val('sendComments').checked,
    breaks: righe('break').map((el) => ({
      id: el.dataset.id,
      label: el.querySelector('.f-label').value,
      start: el.querySelector('.f-start').value,
      end: el.querySelector('.f-end').value
    })),
    meetings: righe('meeting').map((el) => ({
      id: el.dataset.id,
      label: el.querySelector('.f-label').value,
      days: [...el.querySelectorAll('.f-day:checked')].map((i) => Number(i.value)),
      start: el.querySelector('.f-start').value,
      end: el.querySelector('.f-end').value
    }))
  };
}
