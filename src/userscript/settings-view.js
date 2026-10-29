// La scheda Impostazioni del pannello: disegno e lettura del modulo.
//
// La validazione non sta qui: `readSettingsForm` restituisce i valori come
// sono, e `applySettingsForm` (settings.js) decide cosa diventano. Cosi' le
// regole si provano in node senza un DOM.

import { addMinutes } from '../lib/dates.js';

const GIORNI = ['L', 'M', 'M', 'G', 'V', 'S', 'D'];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

export function breakRow(pausa) {
  return `<div class="item" data-kind="break" data-id="${esc(pausa.id)}">
    <input type="text" class="f-label" value="${esc(pausa.label)}" placeholder="Nome">
    <input type="time" class="f-start" value="${esc(pausa.start)}">
    <span class="muted">→</span>
    <input type="time" class="f-end" value="${esc(pausa.end)}">
    <button class="icon" data-act="remove-row" title="Rimuovi">✕</button>
  </div>`;
}

export function meetingRow(riunione) {
  const days = new Set(riunione.days || []);
  const giorni = GIORNI.map((g, i) => `<label class="day-box" title="${g}">
      <input type="checkbox" class="f-day" value="${i + 1}" ${days.has(i + 1) ? 'checked' : ''}>${g}</label>`).join('');
  return `<div class="item meeting" data-kind="meeting" data-id="${esc(riunione.id)}">
    <input type="text" class="f-label" value="${esc(riunione.label)}" placeholder="Nome">
    <div class="days">${giorni}</div>
    <input type="time" class="f-start" value="${esc(riunione.time)}">
    <span class="muted">→</span>
    <input type="time" class="f-end" value="${esc(addMinutes(riunione.time, riunione.minutes))}">
    <button class="icon" data-act="remove-row" title="Rimuovi">✕</button>
  </div>`;
}

export function renderSettings(config) {
  const { jira, work, identity } = config;
  return `<div class="settings">
    <section>
      <h3>Jira</h3>
      <label class="field">Progetti da analizzare
        <input type="text" name="projects" value="${esc((jira.projects || []).join(', '))}" placeholder="ABC, XYZ">
        <span class="hint">Chiavi separate da virgola.</span></label>
      <label class="check"><input type="checkbox" name="scanComments" ${jira.scanComments ? 'checked' : ''}>
        Conta anche i miei commenti come attività</label>
      <div class="row"><button type="button" data-act="test">Prova connessione</button>
        <span class="test-result muted"></span></div>
    </section>
    <section>
      <h3>Commit</h3>
      <label class="check"><input type="checkbox" name="countMerges" ${jira.countMerges !== false ? 'checked' : ''}>
        Conta anche i commit di merge</label>
      <label class="field">Ticket da controllare oltre a quelli del giorno
        <input type="number" name="devCandidates" min="0" max="100" value="${esc(jira.devCandidates)}">
        <span class="hint">Quelli su cui hai registrato ore e quelli assegnati a te, nelle tre settimane prima.
          0 = solo quelli del giorno.</span></label>
      <label class="field">Nomi o email con cui firmi i commit
        <input type="text" name="authors" value="${esc((identity.extraAuthors || []).join(', '))}"
          placeholder="di solito si lascia vuoto">
        <span class="hint">Il tuo nome e la tua email Jira valgono già.</span></label>
    </section>
    <section>
      <h3>Giornata</h3>
      <div class="row">
        <label class="field">Ore<input type="number" name="dailyHours" min="1" max="24" step="0.5" value="${esc(work.dailyHours)}"></label>
        <label class="field">Arrotondamento (min)<input type="number" name="roundingMinutes" min="1" max="60" value="${esc(work.roundingMinutes)}"></label>
        <label class="field">Inizio<input type="time" name="startTime" value="${esc(work.startTime)}"></label>
      </div>
      <label class="field">Come dividere le ore
        <select name="split">
          <option value="equal" ${work.split === 'equal' ? 'selected' : ''}>In parti uguali</option>
          <option value="activity" ${work.split === 'activity' ? 'selected' : ''}>In proporzione a commit e modifiche</option>
          <option value="estimate" ${work.split === 'estimate' ? 'selected' : ''}>In proporzione alla stima</option>
        </select></label>
      <label class="check"><input type="checkbox" name="sendComments" ${work.sendComments !== false ? 'checked' : ''}>
        Invia la nota con ogni worklog</label>
    </section>
    <section>
      <h3>Pause</h3>
      <p class="hint">Non consumano ore: sono buchi nella giornata, e il lavoro che ci cade sopra viene spezzato.</p>
      <div class="list breaks">${(work.breaks || []).map(breakRow).join('')}</div>
      <button type="button" data-act="add-break">Aggiungi pausa</button>
    </section>
    <section>
      <h3>Riunioni ricorrenti</h3>
      <p class="hint">Durata fissa, tolta dalla giornata prima di dividere il resto.</p>
      <div class="list meetings">${(config.meetings || []).map(meetingRow).join('')}</div>
      <button type="button" data-act="add-meeting">Aggiungi riunione</button>
    </section>
    <section>
      <h3>File di configurazione</h3>
      <div class="row">
        <button type="button" data-act="export">Esporta</button>
        <label class="file">Importa…<input type="file" accept="application/json,.json" data-act="import" hidden></label>
      </div>
    </section>
    <div class="footer">
      <button type="button" class="primary" data-act="save">Salva</button>
      <span class="save-result muted"></span>
    </div>
  </div>`;
}

/** I valori del modulo, cosi' come sono: li valida `applySettingsForm`. */
export function readSettingsForm(form) {
  const val = (name) => form.querySelector(`[name="${name}"]`);
  const righe = (kind) => [...form.querySelectorAll(`.item[data-kind="${kind}"]`)];
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
