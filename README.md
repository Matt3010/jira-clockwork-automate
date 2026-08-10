# Clockwork Autofill

Estensione Chrome che ricostruisce la tua giornata (o una giornata passata) e
precompila i worklog, per non doverli inserire a mano in Clockwork.

**Come fa a finire in Clockwork:** i worklog di Clockwork sono sincronizzati con
i worklog nativi di Jira. L'estensione scrive su `POST /rest/api/3/issue/{key}/worklog`
e le ore compaiono in *My Work* e nei timesheet. L'API pubblica di Clockwork non
serve — è read-only sui worklog.

**Parla solo con Jira.** Niente token, niente Bitbucket, niente altri servizi.

## Autenticazione: la sessione del browser

Nessuna credenziale salvata da nessuna parte. Le richieste vengono eseguite
**dentro una scheda già aperta** sul sito Jira: sono same-origin e usano il cookie
del login che hai già fatto.

**Sul dominio:** se l'URL del sito è configurato, **solo** le schede su quell'host
valgono. Una scheda su un altro `*.atlassian.net` viene ignorata — non si scrivono
ore sul sito sbagliato perché era aperto. Il popup mostra in basso da che host sta
leggendo (🟢 sessione attiva, 🔴 nessuna scheda utilizzabile), e se manca la scheda
il messaggio ha un pulsante **Apri e riprova**.

Nota: Atlassian ha deprecato l'auth via cookie per le REST API. In-browser funziona
— è così che la UI di Jira chiama sé stessa — ma è terreno non supportato.

## Da dove prende le task

| Fonte | Cosa cerca |
| --- | --- |
| **Attività Jira** | Issue dei progetti configurati modificate quel giorno, filtrate sul changelog e sui commenti scritti **da te** |
| **Commit** | Il pannello «Sviluppo» delle issue, via `/rest/dev-status/1.0/issue/detail` — lo stesso che la UI di Jira usa per disegnare quel riquadro. Tiene i commit della giornata firmati da te |
| **Riunioni ricorrenti** | Regole fisse per giorno della settimana, a durata fissa |

### Come funzionano i commit senza Bitbucket

Il pannello Sviluppo si interroga **una issue alla volta**, quindi bisogna sapere
quali issue guardare. Le candidate sono:

1. le issue toccate da te in Jira quel giorno;
2. più le tue issue assegnate e aggiornate nelle ultime tre settimane (default 25,
   configurabile) — servono a trovare i commit su ticket che quel giorno non hai
   aperto in Jira.

Le chiamate partono 6 alla volta per non rendere l'analisi lenta. Un commit su un
ticket fuori da entrambe le liste non viene visto: se capita, alza il numero di
candidate nelle opzioni.

I commit sono tuoi se il nome o l'email dell'autore combaciano con la tua identità
Jira (accenti e maiuscole non contano). Se firmi i git commit con un altro nome,
dichiaralo nelle opzioni: i commit scartati perché "di altri" vengono **contati e
segnalati**, così ti accorgi se il match non funziona.

L'endpoint `dev-status` è interno e non documentato da Atlassian: può cambiare senza
preavviso. Se smette di rispondere, l'analisi prosegue con la sola attività Jira e
te lo dice.

## Come calcola le ore

```
monte ore giornaliero
  − ore già registrate quel giorno   (su qualunque issue, non solo quelle nel piano)
  − durata delle riunioni con un ticket
  = resto, diviso equamente fra le task a scatti di 15 minuti
```

Sottrarre le ore già registrate è essenziale: senza, una giornata con 7h30m già
loggate ne distribuirebbe altre 8 sopra.

Il conto è **vivo**: le ore già registrate bloccano spazio solo finché non le
stai rifacendo. Riaccendi una riga con il badge *già Xh* e quei minuti tornano
disponibili — è una scelta esplicita, e il totale ti avverte in rosso a quanto
arriverebbe la giornata.

Una riga che non verrà scritta mostra **0 ore** e non partecipa alla divisione:
vale sia per le righe spente sia per quelle **senza ticket** — una riunione non
ancora agganciata, una riga appena aggiunta. Esibire ore che non finiranno da
nessuna parte, o riservare tempo per una riga che non può inviarlo, è il modo più
diretto per far tornare i conti sbagliati. Il valore che hai corretto a mano non
si perde: torna appena la riga ridiventa inviabile.

**Le pause** (quante ne servono, non solo il pranzo) non consumano monte ore:
sono buchi nella linea del tempo. Un blocco di lavoro che ci finisce sopra viene
spezzato e in Jira arrivano più worklog — `09:00–13:00 + 14:00–18:00` — come la
giornata appare davvero sul calendario. Le riunioni restano all'orario che hai
configurato: sono appuntamenti, non blocchi da incastrare.

Il resto della divisione va alle righe con più attività. Niente viene scritto senza
conferma: il popup mostra il piano, tu lo correggi e premi *Invia*.

## Installazione

1. `chrome://extensions` → attiva **Modalità sviluppatore**
2. **Carica estensione non pacchettizzata** → seleziona questa cartella
3. Apri le **Opzioni** e compila:

**Jira** — URL del sito, oppure **Rileva dal browser** se hai già una scheda
aperta, e in *Progetti* le chiavi su cui lavori. Non c'è nessun sito né progetto
cablato nel codice: senza progetti l'estensione lo dice e ti invita a impostarli,
perché la ricerca attività girerebbe su tutte le issue del sito. Premi
**Verifica connessione**.

**Commit** — di norma va bene così com'è. Alza *Issue da controllare* se lavori su
molti ticket, mettilo a `0` per limitarsi alle issue di oggi.

**Riunioni** — si inseriscono con **dalle / alle**, come stanno sul calendario
(internamente diventano una durata, che è quello che Jira vuole). Spostando
l'orario di inizio la riunione trasla mantenendo la sua durata. Se l'ora di fine
non è successiva a quella di inizio, il salvataggio si blocca e lo dice.

| Nome | Giorni | Dalle | Alle |
| --- | --- | --- | --- |
| Giornaliero | lun | 09:30 | 10:00 |
| Standup di progetto | lun | 10:00 | 10:30 |
| Standup di progetto | mar–ven | 09:30 | 10:00 |

## Uso quotidiano

1. Clicca l'icona: parte da sola sulla giornata di **oggi**, senza premere niente
2. Con `‹` `›` o dal campo data vai a un altro giorno — l'analisi riparte da sé.
   Tenendo premuto `‹` le richieste vengono accorpate e i risultati sorpassati
   scartati, così in tabella non finisce mai il giorno sbagliato.
   Il pulsante **Aggiorna** serve solo per rifare l'analisi a parità di data
3. Il ticket delle cerimonie viene **proposto in automatico** cercando le parole del
   nome della riunione nei titoli delle issue recenti (es. *Standup di progetto* →
   `Standup - Team Sprint 8`). Arriva col badge **proposto**: controllalo,
   cambia ogni sprint. Confermato una volta, viene ricordato per tutta la settimana ISO
4. Correggi ore e note. Modificare le ore di una riga la "blocca" (bordo blu) e le
   altre si ridistribuiscono attorno. Con **Aggiungi una riga** metti quello che il
   rilevamento non ha visto — una riunione fuori programma, un ticket su cui hai
   lavorato senza lasciare tracce
5. **Invia worklog** — le righe scritte spariscono subito dal piano, poi la
   **tabella si rilegge da Jira**: badge *già Xh*, monte ore residuo e orari
   tornano allineati al server. Si aggiorna solo la tabella, la pagina Jira
   sotto non viene toccata

### Anteprima della giornata

Sopra la tabella c'è una striscia con l'asse dei tempi: mostra dove cadranno i
blocchi **prima** di scriverli. Blu = da scrivere, ambra = riunioni, tratteggio =
ore già registrate che non stai toccando, chiaro = pausa. Passando il mouse su
una riga i suoi blocchi si evidenziano, così si vede subito quale pezzo è quale.

È l'anteprima esatta: nasce dagli stessi segmenti che vengono inviati, non da un
calcolo parallelo.

### Disfare un invio

Le righe che hanno già ore su Jira mostrano un'icona **cestino**: apre sotto la
riga l'elenco dei singoli worklog di quel giorno, ciascuno cancellabile da solo.

```
2 worklog già su Jira per ABC-123 — cancellali singolarmente:
  10:00–10:30 · 30m     [Cancella]
  13:00–13:30 · 30m     [Cancella]
  Cancella tutti e 2
```

Scegliere una voce precisa *è* la conferma: con un doppione togli solo quello che
serve, invece di azzerare tutta la giornata su quella issue. Tocca solo i tuoi
worklog e solo quella data.

### La pagina sotto

Clockwork disegna il calendario una volta sola e non si accorge di quello che
scriviamo. Dopo un invio o una cancellazione la scheda Jira viene quindi
**ricaricata** — dopo aver riletto il piano, perché l'analisi passa proprio da lì.

Allo stesso modo il piano è una fotografia del momento in cui è stato letto: se
sposti un worklog da Clockwork, l'estensione lo rilegge da sé appena il popup
torna in primo piano.

Quel rientro usa un **percorso leggero**: rilegge solo le ore già registrate, che
sono l'unica cosa che può essere cambiata sotto. Un'analisi completa rifarebbe
attività, commit e issue recenti — decine di richieste per aggiornare un badge.
Le righe spente dal controllo duplicati si riaccendono se quelle ore spariscono
da Jira; quelle che hai acceso o spento **tu** restano come le hai lasciate.

### Due protezioni

- **Duplicati.** Se su una issue hai già un worklog tuo in quella data, la riga ha il
  badge *già Xh* e parte disattivata.
- **Ticket riunione ≠ task.** Il ticket delle cerimonie non compare anche fra le task
  di lavoro: l'attività Jira su quel ticket *è* la riunione. Se lo assegni a mano a una
  riunione, l'eventuale riga task corrispondente viene tolta.

## Struttura

```
manifest.json
src/
  background.js       service worker: tutte le chiamate di rete
  popup.html/js/css   piano della giornata, editabile
  options.html/js/css configurazione
  lib/
    icons.js          icone Lucide inline (ISC), nessuna dipendenza esterna
    transport.js      canale di sessione, rilevamento e vincolo del dominio
    jira.js           attività, commit dal pannello Sviluppo, ore già registrate
    planner.js        riunioni, proposta ticket, distribuzione ore, orari
    dates.js          date locali, settimana ISO, formato `started` di Jira
    storage.js        configurazione e default
```

Il canale si valida **una volta sola** per analisi, con una richiesta di prova. Dopo
non c'è nessun ripiego: se una scrittura potesse essere ritentata su un altro canale
si creerebbe un worklog doppio.

La distribuzione delle ore (`allocate`) ha **una sola implementazione**, usata sia
alla costruzione del piano sia a ogni modifica nel popup: due copie divergerebbero
al primo ritocco.

## Test

```
npm test
```

Sette suite su `src/lib`, che sono moduli puri e girano in node così come sono; le
parti che parlano con Chrome sono simulate. Coprono: date e settimana ISO, divisione
delle ore, livelli dei messaggi, le tre strategie di aggancio del ticket riunione,
il canale di sessione (incluso il rifiuto di una scheda sul dominio sbagliato e il
divieto di riprovare una scrittura), i commit dal pannello Sviluppo, e il flusso
completo in quattro scenari: giornata vuota, giornata già registrata a mano,
giornata a metà, correzioni manuali.

Permessi: `storage`, `scripting` e `https://*.atlassian.net/*`. Non serve `tabs` —
gli host_permissions bastano a trovare le schede del sito e non danno visibilità
sugli altri.

## Limiti noti

- La ricerca attività guarda le prime 100 issue aggiornate quel giorno nei progetti
  configurati.
- I commit si vedono solo sulle issue candidate (vedi sopra), e solo se il pannello
  Sviluppo è collegato al repository.
- `dev-status` è un endpoint interno di Jira, non supportato ufficialmente.
- La divisione delle ore è un'euristica, non una misurazione: è fatta per essere
  corretta a mano prima dell'invio.
