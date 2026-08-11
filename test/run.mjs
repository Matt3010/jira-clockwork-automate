// Esegue tutte le suite in sequenza. Ogni file usa `node:assert` e stampa una
// riga di riepilogo: se un'asserzione salta, il processo esce con codice != 0.
//
//   npm test
//
// I moduli sotto src/lib sono puri (niente API di Chrome), quindi girano in node
// cosi' come sono. Le parti che parlano con Chrome sono simulate nei test.

const SUITES = [
  'base.test.mjs',
  'configurazione.test.mjs',
  'jira-lettura.test.mjs',
  'jira-client.test.mjs',
  'dates-planner.test.mjs',
  'messaggi.test.mjs',
  'riunioni-nome-data.test.mjs',
  'riunioni-orario.test.mjs',
  'pause.test.mjs',
  'riunioni-lunghe.test.mjs',
  'flusso.test.mjs',
  'anteprima.test.mjs',
  'colori-attivita.test.mjs',
  'registro.test.mjs',
  'attivita-raccolta.test.mjs',
  'ticket-aperti.test.mjs',
  'modifica-manuale.test.mjs',
  'righe-senza-ticket.test.mjs',
  'aggiornamento-leggero.test.mjs',
  'cambio-giorno.test.mjs',
  'copia-badge.test.mjs',
  'conferma-invio.test.mjs',
  'stato-occupato.test.mjs',
  'avvisi.test.mjs',
  'transport.test.mjs',
  'devpanel.test.mjs',
  'opzioni.test.mjs',
  'pannello.test.mjs',
  'traduzioni.test.mjs',
  'coerenza.test.mjs'
];

let failed = 0;
for (const suite of SUITES) {
  try {
    await import(`./${suite}`);
  } catch (error) {
    failed += 1;
    console.error(`\n✕ ${suite}\n${error?.message || error}\n`);
  }
}

if (failed) {
  console.error(`${failed} suite fallite.`);
  process.exit(1);
}
console.log('\nTutte le suite passate.');
