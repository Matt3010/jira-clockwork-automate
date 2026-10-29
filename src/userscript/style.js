// Il foglio di stile del pannello: quello del popup dell'estensione, adattato
// allo shadow root, piu' le poche cose che il popup non ha.
//
// `popup.css` arriva com'e' (esbuild lo carica come testo). Tre ritocchi
// perche' valga dentro il pannello:
//   - `:root` diventa `:host`: le variabili del tema stanno sul pannello, non
//     sulla pagina Jira;
//   - le regole su `body` e `html[data-mode]` si tolgono: il corpo qui e' il
//     pannello, e la sua misura la decide lui;
//   - la soglia "stretto" passa da media query a container query: e' la
//     larghezza del pannello che conta, non quella della finestra.

import popupCss from '../popup.css';

function adattaPopup(css) {
  return css
    .replace(/:root\b/g, ':host')
    .replace(/(^|\n)body\s*\{[^}]*\}/, '$1')
    .replace(/html\[data-mode="panel"\][^{]*\{[^}]*\}/, '')
    .replace(/@media \(max-width: 720px\)/, '@container cw (max-width: 720px)');
}

// Le opzioni dell'estensione stanno su una pagina loro, con regole su elementi
// nudi (`section`, `button`, `input`) che qui si scontrerebbero col popup:
// gli stessi valori, ristretti a `.opts`.
const OPZIONI = `
  .opts { padding: 12px 12px 0; overflow-y: auto; flex: 1; }
  .opts h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin: 0 0 12px; }
  .opts section { background: var(--surface); border: 1px solid var(--border); border-radius: 6px;
    padding: 14px 14px; margin-bottom: 12px; }
  .opts .field { margin-bottom: 12px; }
  .opts .field > label { display: block; font-weight: 600; margin-bottom: 4px; }
  .opts .field.check { display: flex; align-items: center; gap: 8px; }
  .opts .field.check > label { margin: 0; font-weight: 400; }
  .opts .row { display: flex; gap: 12px; flex-wrap: wrap; }
  .opts .row .field { flex: 1 1 110px; }
  .opts input:not([type="checkbox"]), .opts select { width: 100%; padding: 6px 8px; }
  .opts select { font: inherit; border: 1px solid var(--border); border-radius: 4px; background: var(--bg); color: var(--text); }
  .opts .hint { color: var(--muted); font-size: 12px; margin: 4px 0 0; }
  .opts .with-button { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .opts .result { font-size: 12px; }
  .opts .result.ok { color: var(--ok); }
  .opts .result.err { color: var(--err); }
  .opts .meeting { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; align-items: end;
    padding: 12px 0; border-top: 1px solid var(--border); }
  .opts .meeting:first-child { border-top: none; }
  .opts .meeting .field { margin-bottom: 0; }
  .opts .meeting .label-field, .opts .meeting .days-field { grid-column: 1 / -1; }
  .opts .meeting > button { justify-self: start; }
  .opts .days { display: flex; gap: 3px; flex-wrap: wrap; }
  .opts .days label { font-size: 11px; border: 1px solid var(--border); border-radius: 4px; padding: 5px 6px;
    cursor: pointer; background: var(--bg); user-select: none; line-height: 1.1; font-weight: 400; }
  .opts .days input { display: none; }
  .opts .days input:checked + span { color: var(--accent); font-weight: 700; }
  .opts-foot { position: sticky; bottom: 0; display: flex; align-items: center; gap: 10px; padding: 10px 0 12px;
    background: var(--bg); border-top: 1px solid var(--border); }
`;

// Verifica: niente di simile nel popup, quindi solo le variabili del popup.
const VERIFICA = `
  .verify { padding: 12px; overflow-y: auto; flex: 1; }
  .verify h3 { font-size: 13px; margin: 0 0 4px; }
  .verify p { margin: 4px 0 8px; }
  .verify .muted { color: var(--muted); }
  .verify .warn { color: var(--warn); }
  .verify .good { color: var(--ok); font-weight: 600; }
  .verify .mid { color: var(--warn); font-weight: 600; }
  .verify .bad { color: var(--err); font-weight: 600; }
  .verify .vrow { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 8px 0; }
  .verify input.count { width: 56px; }
  .verify .vday { margin: 8px 0; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; }
  .verify .vday summary { cursor: pointer; padding: 8px 10px; display: flex; gap: 8px; align-items: baseline; }
  .verify .vday summary .muted { flex: 1; }
  .verify table.vtab { display: table; width: 100%; border-collapse: collapse; }
  .verify .vtab tbody { display: table-row-group; }
  .verify .vtab tr { display: table-row; padding: 0; background: none; border: 0; border-radius: 0; }
  .verify .vtab th, .verify .vtab td { display: table-cell; padding: 6px 8px; border-top: 1px solid var(--border);
    vertical-align: top; text-align: left; }
  .verify .vtab th { font-weight: 500; font-size: 11px; color: var(--muted); }
  .verify .vtab .num, .verify .vtab th:nth-child(n+3) { text-align: right; white-space: nowrap; }
  .verify .vtab .st { width: 20px; font-weight: 700; }
  .verify tr.ok .st { color: var(--ok); }
  .verify tr.hours .st { color: var(--warn); }
  .verify tr.missing .st, .verify tr.extra .st { color: var(--err); }
  .verify a { color: var(--accent); text-decoration: none; font-weight: 600; }
  .verify .sum { color: var(--muted); font-size: 12px; }
  .verify .why { color: var(--err); font-size: 12px; }
  .verify .tag { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; padding: 1px 5px; border-radius: 3px;
    margin-left: 4px; color: var(--warn); border: 1px solid var(--warn); background: var(--warn-bg); }
`;

// Quello che il popup non ha: la linguetta sul bordo e il pannello stesso.
const PANNELLO = `
  :host { all: initial; }
  .handle {
    position: fixed; right: 0; top: 50%; transform: translateY(-50%); z-index: 2147483000;
    writing-mode: vertical-rl; padding: 12px 6px; border: 0; border-radius: 8px 0 0 8px; cursor: pointer;
    font: 600 12px/1 -apple-system, "Segoe UI", Roboto, sans-serif;
    background: var(--accent); color: var(--accent-text); gap: 6px;
  }
  .handle .icon { transform: rotate(90deg); }
  .panel {
    position: fixed; top: 0; right: 0; bottom: 0; width: min(520px, 100vw); z-index: 2147483001;
    display: flex; flex-direction: column;
    container-type: inline-size; container-name: cw;
    font: 13px/1.45 -apple-system, "Segoe UI", Roboto, sans-serif;
    color: var(--text); background: var(--bg);
    border-left: 1px solid var(--border); box-shadow: -8px 0 24px rgba(0,0,0,.25);
  }
  .panel > main, .panel > .opts, .panel > .verify { min-height: 0; }
  /* In stretto il popup restringe il margine di \`main\` a 8px: gli avvisi lo
     seguono, o restano disallineati rispetto alle righe. */
  @container cw (max-width: 720px) {
    #messages { padding: 0 8px; }
  }
  .bar .title { font-weight: 600; }
  /* Il popup tiene le azioni a 80px: qui ci sono anche su e giu'. */
  .panel .col-actions { width: auto; }
  .move-row:disabled { opacity: .3; }
  .move-row:hover:not(:disabled) { color: var(--accent); }
  .site .dot { flex: none; }
`;

export const PANEL_CSS = adattaPopup(popupCss) + OPZIONI + VERIFICA + PANNELLO;
