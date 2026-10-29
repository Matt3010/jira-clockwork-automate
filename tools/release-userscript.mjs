// Rilascio dello userscript su GitHub.
//
//   npm run release:userscript
//
// Fa la build (test compresi) e crea una release con il file allegato. Le
// installazioni di Tampermonkey puntano a `releases/latest/download/...`, quindi
// alla prossima verifica degli aggiornamenti prendono questa.
//
// Si rilascia solo quello che e' gia' su GitHub: con modifiche non committate,
// o con un commit che non e' stato spinto, la release descriverebbe un codice
// che nel repo non c'e'. In quei casi si ferma e lo dice, senza spingere niente
// da solo.

import { spawnSync } from 'node:child_process';
import { buildUserscript, REPO } from './build-userscript.mjs';

function git(...args) {
  const esito = spawnSync('git', args, { encoding: 'utf8' });
  return { ok: esito.status === 0, out: (esito.stdout || '').trim(), err: (esito.stderr || '').trim() };
}

function ferma(messaggio) {
  console.error(`✕ ${messaggio}`);
  process.exit(1);
}

if (git('status', '--porcelain').out) ferma('ci sono modifiche non committate.');
const head = git('rev-parse', 'HEAD').out;
const remoto = git('rev-parse', '@{u}');
if (!remoto.ok) ferma('il branch non ha un upstream: spingilo prima (git push -u origin <branch>).');
if (remoto.out !== head) ferma('il commit corrente non e\' su GitHub: fai git push prima di rilasciare.');

const { version, file } = await buildUserscript().catch((error) => ferma(error.message));
const tag = `userscript-v${version}`;
const ramo = git('rev-parse', '--abbrev-ref', 'HEAD').out;

console.log(`· release ${tag}`);
const esito = spawnSync('gh', [
  'release', 'create', tag, file,
  '--repo', REPO,
  '--target', head,
  '--title', `Userscript ${version}`,
  '--notes', `Clockwork Autofill per Tampermonkey, dal branch \`${ramo}\` (${head.slice(0, 7)}).`,
  '--latest'
], { stdio: 'inherit' });
if (esito.status !== 0) ferma('gh release create non e\' andato a buon fine.');
console.log(`✓ https://github.com/${REPO}/releases/tag/${tag}`);
