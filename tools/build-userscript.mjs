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
//
// Aggiornamenti: l'intestazione punta all'ultima release su GitHub
// (`@updateURL`/`@downloadURL`), e Tampermonkey si aggiorna da solo quando ci
// trova una `@version` piu' alta. La versione e' quella di package.json piu'
// l'istante della build — sempre crescente, senza doverla ricordare a mano.
// La release la crea `npm run release:userscript`.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const OUT = join(ROOT, 'dist', 'userscript', 'clockwork-autofill.user.js');
export const FILE = 'clockwork-autofill.user.js';
export const REPO = 'Matt3010/jira-clockwork-automate';
const LATEST = `https://github.com/${REPO}/releases/latest/download/${FILE}`;

const pad = (n) => String(n).padStart(2, '0');

/** "1.0.0" + 29/10/2026 11:42 -> "1.0.0.202610291142". */
export function userscriptVersion(base, quando = new Date()) {
  const istante = `${quando.getFullYear()}${pad(quando.getMonth() + 1)}${pad(quando.getDate())}`
    + `${pad(quando.getHours())}${pad(quando.getMinutes())}`;
  return `${base}.${istante}`;
}

export function header(version) {
  return `// ==UserScript==
// @name         Clockwork Autofill
// @namespace    clockwork-autofill
// @version      ${version}
// @description  Ricostruisce la giornata e precompila i worklog di Clockwork, dalla pagina My Work
// @match        https://*.atlassian.net/jira/apps/*
// @homepageURL  https://github.com/${REPO}
// @updateURL    ${LATEST}
// @downloadURL  ${LATEST}
// @grant        none
// @run-at       document-idle
// ==/UserScript==
`;
}

export async function buildUserscript() {
  console.log('· test');
  const esito = spawnSync(process.execPath, [join('test', 'run.mjs')], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8'
  });
  if (esito.status !== 0) {
    process.stdout.write(esito.stdout || '');
    process.stderr.write(esito.stderr || '');
    throw new Error('la suite di test non passa: niente userscript.');
  }

  const { version: base } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const version = userscriptVersion(base);

  console.log(`· bundle ${version}`);
  mkdirSync(dirname(OUT), { recursive: true });
  await build({
    entryPoints: [join(ROOT, 'src/userscript/main.js')],
    outfile: OUT,
    bundle: true,
    format: 'iife',
    target: 'chrome120',
    minify: false,
    legalComments: 'none',
    banner: { js: header(version) },
    // I fogli di stile dell'estensione entrano come testo: il pannello li mette
    // nel suo shadow root, cosi' ha lo stesso aspetto del popup senza copiarlo.
    loader: { '.css': 'text' },
    logLevel: 'warning'
  });
  console.log(`✓ ${OUT}`);
  return { version, file: OUT };
}

// Lanciato direttamente: build e basta.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildUserscript().catch((error) => {
    console.error(`✕ ${error.message}`);
    process.exit(1);
  });
}
