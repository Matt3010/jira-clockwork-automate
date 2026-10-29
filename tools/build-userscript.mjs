// Build dello userscript per Tampermonkey.
//
//   npm run build:userscript
//
// Produce `dist/userscript/clockwork-autofill.user.js`: un file solo, con
// dentro `src/userscript` e le sue dipendenze da `src/lib`, e l'intestazione
// che Tampermonkey legge. Non minificato: uno userscript lo si apre
// nell'editor di Tampermonkey, e deve restare leggibile.
//
// Come la build dell'estensione, prima passa dalla suite di test: uno script
// con i test rossi e' peggio che nessuno script.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist', 'userscript', 'clockwork-autofill.user.js');
const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const HEADER = `// ==UserScript==
// @name         Clockwork Autofill
// @namespace    clockwork-autofill
// @version      ${version}
// @description  Ricostruisce la giornata e precompila i worklog di Clockwork, dalla pagina My Work
// @match        https://*.atlassian.net/jira/apps/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
`;

console.log('· test');
const esito = spawnSync(process.execPath, [join('test', 'run.mjs')], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8'
});
if (esito.status !== 0) {
  process.stdout.write(esito.stdout || '');
  process.stderr.write(esito.stderr || '');
  console.error('✕ la suite di test non passa: niente userscript.');
  process.exit(1);
}

console.log('· bundle');
mkdirSync(dirname(OUT), { recursive: true });
await build({
  entryPoints: [join(ROOT, 'src/userscript/main.js')],
  outfile: OUT,
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  minify: false,
  legalComments: 'none',
  banner: { js: HEADER },
  logLevel: 'warning'
});
console.log(`✓ ${OUT}`);
