// Build dei pacchetti distribuibili.
//
//   npm run build
//
// Un comando solo, e rifa' sempre tutti e due i pacchetti: rifarne uno e
// lasciare indietro l'altro e' il modo in cui si sfasano, con quello vecchio
// li' accanto pronto da caricare per sbaglio.
// La versione la scrivi tu in manifest.json, quando pubblichi.
//
// Produce `dist/<browser>/clockwork-autofill-<versione>-<browser>.zip`, pronto
// da caricare sullo store o da dare a mano, piu' `dist/<browser>/unpacked/` per
// il "carica estensione non pacchettizzata".
//
// I due pacchetti escono dagli stessi sorgenti: cambia il manifest, che per
// Firefox si calcola da quello di Chrome (vedi manifest-firefox.mjs), e cambia
// il bersaglio di esbuild. Il codice e' lo stesso file per entrambi.
//
// Prima di impacchettare passa da due cancelli, e se uno non passa non scrive
// niente: uno zip con i test rossi e' peggio che nessuno zip, perche' il
// difetto lo scopre chi lo installa.
//
//   1. la suite di test, tutta — traduzioni comprese, ci pensa
//      test/traduzioni.test.mjs: chiavi allineate fra le lingue, segnaposto
//      dichiarati, niente chiavi orfane, niente prosa rimasta nel codice
//   2. i file citati dal manifest esistono davvero nel pacchetto costruito —
//      e il manifest controllato e' quello del pacchetto, non l'originale:
//      su Firefox i nomi delle chiavi sono altri
//
// Il codice viene minificato — non offuscato. Il Chrome Web Store vieta
// esplicitamente l'offuscamento ("Developers must not obfuscate code or conceal
// functionality of their extension") mentre permette la minificazione, inclusi
// l'accorciamento dei nomi e l'unione dei file: e' esattamente quello che fa
// esbuild qui. AMO dice la stessa cosa e in piu' vuole poter rifare la build.
// Un pacchetto offuscato verrebbe rifiutato in revisione da entrambi.
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
import { manifestFirefox } from './manifest-firefox.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

// I tre moduli che il browser carica: ognuno diventa un file solo, con dentro
// le sue dipendenze da `src/lib`. Il resto della cartella non serve piu'.
const ENTRY_JS = ['src/background.js', 'src/popup.js', 'src/options.js'];
const ENTRY_CSS = ['src/popup.css', 'src/options.css'];
// Copiati cosi' come sono. L'HTML non si tocca: i nodi di testo sono contenuto
// tradotto, e collassare gli spazi qui cambierebbe quello che si legge a video.
// Il manifest non e' in elenco: viene scritto, non copiato, perche' per Firefox
// e' un altro.
const COPIA = ['src/popup.html', 'src/options.html', 'icons', '_locales'];

// I due bersagli. `esbuild` e' la versione minima su cui il codice deve girare:
// per Firefox e' la stessa che dichiara `strict_min_version`.
const BERSAGLI = {
  chromium: { esbuild: 'chrome120', manifest: (m) => m },
  firefox: { esbuild: 'firefox128', manifest: manifestFirefox }
};

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

async function costruisci(nome, bersaglio, manifest, stage) {
  console.log(`· ${nome}: minificazione`);
  mkdirSync(stage, { recursive: true });

  const primaJs = peso(ROOT, [...ENTRY_JS, ...elenca(join(ROOT, 'src/lib')).map((f) => `src/lib/${f}`)]);
  const primaCss = peso(ROOT, ENTRY_CSS);

  // `bundle` tira dentro src/lib e lascia tre file soli; `format: esm` perche'
  // il fondo e' dichiarato "type": "module" in tutti e due i manifest.
  await esbuild({
    entryPoints: ENTRY_JS.map((f) => join(ROOT, f)),
    outdir: join(stage, 'src'),
    bundle: true,
    format: 'esm',
    target: bersaglio.esbuild,
    minify: true,
    legalComments: 'none',
    logLevel: 'warning'
  });

  await esbuild({
    entryPoints: ENTRY_CSS.map((f) => join(ROOT, f)),
    outdir: join(stage, 'src'),
    minify: true,
    logLevel: 'warning'
  });

  for (const voce of COPIA) {
    cpSync(join(ROOT, voce), join(stage, voce), { recursive: true });
  }
  writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const dopoJs = peso(stage, ENTRY_JS);
  const dopoCss = peso(stage, ENTRY_CSS);
  const taglio = (a, b) => `${kb(a)} → ${kb(b)} (−${Math.round((1 - b / a) * 100)}%)`;
  console.log(`  js  ${taglio(primaJs, dopoJs)}`);
  console.log(`  css ${taglio(primaCss, dopoCss)}`);
}

// ------------------------------------------------------------ 2. il manifest

function cancelloManifest(nome, manifest, file) {
  console.log(`· ${nome}: manifest`);
  const attesi = new Set();
  const raccogli = (valore) => {
    if (typeof valore === 'string') attesi.add(valore);
    else if (valore) Object.values(valore).forEach(raccogli);
  };
  raccogli(manifest.icons);
  raccogli(manifest.action?.default_icon);
  raccogli(manifest.sidebar_action?.default_icon);
  if (manifest.action?.default_popup) attesi.add(manifest.action.default_popup);
  if (manifest.options_page) attesi.add(manifest.options_page);
  if (manifest.options_ui?.page) attesi.add(manifest.options_ui.page);
  // Il pannello laterale porta la sua pagina con un parametro appeso
  // (`?panel=1`): a esistere dev'essere il file, non la stringa intera. Su
  // Chrome la chiave e' `side_panel`, su Firefox `sidebar_action`.
  for (const pagina of [manifest.side_panel?.default_path, manifest.sidebar_action?.default_panel]) {
    if (pagina) attesi.add(pagina.split('?')[0]);
  }
  if (manifest.background?.service_worker) attesi.add(manifest.background.service_worker);
  for (const script of manifest.background?.scripts || []) attesi.add(script);

  for (const percorso of [...attesi].sort()) {
    if (!file.includes(percorso)) fail(`${nome}: manifest.json cita ${percorso}, che non finisce nel pacchetto`);
  }

  // Il default_locale deve avere la sua cartella, o il browser rifiuta di
  // caricare.
  if (manifest.default_locale && !file.includes(`_locales/${manifest.default_locale}/messages.json`)) {
    fail(`${nome}: default_locale "${manifest.default_locale}" senza _locales/${manifest.default_locale}/messages.json`);
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

const sorgente = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));

cancelloTest();

// Si riparte da zero: cosi' `dist/` non si porta dietro i pacchetti di una
// versione precedente, che finirebbero caricati per buoni.
rmSync(DIST, { recursive: true, force: true });

const fatti = [];
for (const nome of Object.keys(BERSAGLI)) {
  if (problemi.length) break;

  const bersaglio = BERSAGLI[nome];
  const manifest = bersaglio.manifest(sorgente);
  const cartella = join(DIST, nome);
  const stage = join(cartella, 'unpacked');

  await costruisci(nome, bersaglio, manifest, stage);

  const file = elenca(stage);
  cancelloManifest(nome, manifest, file);
  if (problemi.length) break;

  const nomeZip = `clockwork-autofill-${manifest.version}-${nome}.zip`;
  const pacchetto = zip(stage, file);
  writeFileSync(join(cartella, nomeZip), pacchetto);
  fatti.push({ nome, zip: `${nome}/${nomeZip}`, file: file.length, peso: pacchetto.length });
}

if (problemi.length) {
  // Niente mezze build in giro: se qualcosa non torna, `dist/` sparisce.
  rmSync(DIST, { recursive: true, force: true });
  console.error(`\nBuild annullata — ${problemi.length} problem${problemi.length === 1 ? 'a' : 'i'}:\n`);
  for (const p of problemi) console.error(`  ✗ ${p}`);
  console.error('');
  process.exit(1);
}

console.log('');
for (const f of fatti) {
  console.log(`✓ dist/${f.zip} — ${f.file} file, ${kb(f.peso)}`);
  console.log(`  dist/${f.nome}/unpacked/ — per «carica estensione non pacchettizzata»`);
}
