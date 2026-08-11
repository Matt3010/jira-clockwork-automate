// Build del pacchetto distribuibile.
//
//   npm run build
//
// Produce `dist/clockwork-autofill-<versione>.zip`, pronto da caricare sul
// Chrome Web Store o da dare a mano, piu' `dist/unpacked/` per il "carica
// estensione non pacchettizzata".
//
// Prima di impacchettare passa da due cancelli, e se uno non passa non scrive
// niente: uno zip con i test rossi e' peggio che nessuno zip, perche' il
// difetto lo scopre chi lo installa.
//
//   1. la suite di test, tutta — traduzioni comprese, ci pensa
//      test/traduzioni.test.mjs: chiavi allineate fra le lingue, segnaposto
//      dichiarati, niente chiavi orfane, niente prosa rimasta nel codice
//   2. i file citati dal manifest esistono davvero nel pacchetto costruito
//
// Il codice viene minificato — non offuscato. Il Chrome Web Store vieta
// esplicitamente l'offuscamento ("Developers must not obfuscate code or conceal
// functionality of their extension") mentre permette la minificazione, inclusi
// l'accorciamento dei nomi e l'unione dei file: e' esattamente quello che fa
// esbuild qui. Un pacchetto offuscato verrebbe rifiutato in revisione.
//
// esbuild e' una devDependency: serve a costruire, non finisce nel pacchetto.
// Lo zip invece resta scritto a mano con `node:zlib`.

import { spawnSync } from 'node:child_process';
import { deflateRawSync } from 'node:zlib';
import {
  cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const STAGE = join(DIST, 'unpacked');

// I tre moduli che Chrome carica: ognuno diventa un file solo, con dentro le
// sue dipendenze da `src/lib`. Il resto della cartella non serve piu'.
const ENTRY_JS = ['src/background.js', 'src/popup.js', 'src/options.js'];
const ENTRY_CSS = ['src/popup.css', 'src/options.css'];
// Copiati cosi' come sono. L'HTML non si tocca: i nodi di testo sono contenuto
// tradotto, e collassare gli spazi qui cambierebbe quello che si legge a video.
const COPIA = ['manifest.json', 'src/popup.html', 'src/options.html', 'icons', '_locales'];

const problemi = [];
const fail = (messaggio) => problemi.push(messaggio);

// I percorsi girano sempre con lo slash, come li scrive il manifest e come li
// vuole lo zip: su Windows `join` darebbe backslash e i confronti fallirebbero.
function elenca(base, percorso = '', dentro = []) {
  const assoluto = percorso ? join(base, percorso) : base;
  if (!statSync(assoluto).isDirectory()) return [...dentro, percorso];
  let out = dentro;
  for (const voce of readdirSync(assoluto).sort()) {
    out = elenca(base, percorso ? `${percorso}/${voce}` : voce, out);
  }
  return out;
}

const peso = (base, file) => file.reduce((somma, f) => somma + statSync(join(base, f)).size, 0);
const kb = (n) => `${(n / 1024).toFixed(1)} kB`;

// ---------------------------------------------------------------- 1. i test

function cancelloTest() {
  console.log('· test');
  const esito = spawnSync(process.execPath, [join('test', 'run.mjs')], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8'
  });
  if (esito.status !== 0) {
    process.stdout.write(esito.stdout || '');
    process.stderr.write(esito.stderr || '');
    fail('la suite di test non passa (vedi sopra)');
    return;
  }
  const suite = (esito.stdout.match(/controlli passati/g) || []).length;
  console.log(`  ${suite} suite passate`);
}

// ------------------------------------------------------------ la costruzione

async function costruisci() {
  console.log('· minificazione');
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(STAGE, { recursive: true });

  const primaJs = peso(ROOT, [...ENTRY_JS, ...elenca(join(ROOT, 'src/lib')).map((f) => `src/lib/${f}`)]);
  const primaCss = peso(ROOT, ENTRY_CSS);

  // `bundle` tira dentro src/lib e lascia tre file soli; `format: esm` perche'
  // il service worker e' dichiarato "type": "module" nel manifest.
  await esbuild({
    entryPoints: ENTRY_JS.map((f) => join(ROOT, f)),
    outdir: join(STAGE, 'src'),
    bundle: true,
    format: 'esm',
    target: 'chrome120',
    minify: true,
    legalComments: 'none',
    logLevel: 'warning'
  });

  await esbuild({
    entryPoints: ENTRY_CSS.map((f) => join(ROOT, f)),
    outdir: join(STAGE, 'src'),
    minify: true,
    logLevel: 'warning'
  });

  for (const voce of COPIA) {
    cpSync(join(ROOT, voce), join(STAGE, voce), { recursive: true });
  }

  const dopoJs = peso(STAGE, ENTRY_JS);
  const dopoCss = peso(STAGE, ENTRY_CSS);
  const taglio = (a, b) => `${kb(a)} → ${kb(b)} (−${Math.round((1 - b / a) * 100)}%)`;
  console.log(`  js  ${taglio(primaJs, dopoJs)}`);
  console.log(`  css ${taglio(primaCss, dopoCss)}`);
}

// ------------------------------------------------------------ 2. il manifest

function cancelloManifest(manifest, file) {
  console.log('· manifest');
  const attesi = new Set();
  const raccogli = (valore) => {
    if (typeof valore === 'string') attesi.add(valore);
    else if (valore) Object.values(valore).forEach(raccogli);
  };
  raccogli(manifest.icons);
  raccogli(manifest.action?.default_icon);
  if (manifest.action?.default_popup) attesi.add(manifest.action.default_popup);
  if (manifest.options_page) attesi.add(manifest.options_page);
  // Il pannello laterale porta la sua pagina con un parametro appeso
  // (`?panel=1`): a esistere dev'essere il file, non la stringa intera.
  if (manifest.side_panel?.default_path) {
    attesi.add(manifest.side_panel.default_path.split('?')[0]);
  }
  if (manifest.background?.service_worker) attesi.add(manifest.background.service_worker);

  for (const percorso of [...attesi].sort()) {
    if (!file.includes(percorso)) fail(`manifest.json cita ${percorso}, che non finisce nel pacchetto`);
  }

  // Il default_locale deve avere la sua cartella, o Chrome rifiuta di caricare.
  if (manifest.default_locale && !file.includes(`_locales/${manifest.default_locale}/messages.json`)) {
    fail(`default_locale "${manifest.default_locale}" senza _locales/${manifest.default_locale}/messages.json`);
  }

  console.log(`  ${attesi.size} riferimenti verificati`);
}

// ------------------------------------------------------------------- lo zip

const CRC = (() => {
  const tabella = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    tabella[i] = c;
  }
  return tabella;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const oraDos = (d) => ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
const dataDos = (d) => (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;

function zip(base, file) {
  const pezzi = [];
  const centrale = [];
  let offset = 0;

  for (const percorso of file) {
    const assoluto = join(base, percorso);
    const dati = readFileSync(assoluto);
    const nome = Buffer.from(percorso, 'utf8');
    const compresso = deflateRawSync(dati, { level: 9 });
    const mtime = statSync(assoluto).mtime;
    const crc = crc32(dati);

    const locale = Buffer.alloc(30);
    locale.writeUInt32LE(0x04034b50, 0);
    locale.writeUInt16LE(20, 4);
    locale.writeUInt16LE(0, 6);
    locale.writeUInt16LE(8, 8);
    locale.writeUInt16LE(oraDos(mtime), 10);
    locale.writeUInt16LE(dataDos(mtime), 12);
    locale.writeUInt32LE(crc, 14);
    locale.writeUInt32LE(compresso.length, 18);
    locale.writeUInt32LE(dati.length, 22);
    locale.writeUInt16LE(nome.length, 26);
    pezzi.push(locale, nome, compresso);

    const voce = Buffer.alloc(46);
    voce.writeUInt32LE(0x02014b50, 0);
    voce.writeUInt16LE(20, 4);
    voce.writeUInt16LE(20, 6);
    voce.writeUInt16LE(0, 8);
    voce.writeUInt16LE(8, 10);
    voce.writeUInt16LE(oraDos(mtime), 12);
    voce.writeUInt16LE(dataDos(mtime), 14);
    voce.writeUInt32LE(crc, 16);
    voce.writeUInt32LE(compresso.length, 20);
    voce.writeUInt32LE(dati.length, 24);
    voce.writeUInt16LE(nome.length, 28);
    voce.writeUInt32LE(0o644 << 16, 38);
    voce.writeUInt32LE(offset, 42);
    centrale.push(voce, nome);

    offset += locale.length + nome.length + compresso.length;
  }

  const corpo = Buffer.concat(pezzi);
  const indice = Buffer.concat(centrale);
  const coda = Buffer.alloc(22);
  coda.writeUInt32LE(0x06054b50, 0);
  coda.writeUInt16LE(file.length, 8);
  coda.writeUInt16LE(file.length, 10);
  coda.writeUInt32LE(indice.length, 12);
  coda.writeUInt32LE(corpo.length, 16);

  return Buffer.concat([corpo, indice, coda]);
}

// ------------------------------------------------------------------- il giro

const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));

cancelloTest();
if (!problemi.length) await costruisci();

const file = problemi.length ? [] : elenca(STAGE);
if (!problemi.length) cancelloManifest(manifest, file);

if (problemi.length) {
  // Niente mezze build in giro: se qualcosa non torna, `dist/` sparisce.
  rmSync(DIST, { recursive: true, force: true });
  console.error(`\nBuild annullata — ${problemi.length} problem${problemi.length === 1 ? 'a' : 'i'}:\n`);
  for (const p of problemi) console.error(`  ✗ ${p}`);
  console.error('');
  process.exit(1);
}

const nomeZip = `clockwork-autofill-${manifest.version}.zip`;
const pacchetto = zip(STAGE, file);
writeFileSync(join(DIST, nomeZip), pacchetto);

console.log(`\n✓ dist/${nomeZip} — ${file.length} file, ${kb(pacchetto.length)}`);
console.log('  dist/unpacked/ — per «carica estensione non pacchettizzata»');
