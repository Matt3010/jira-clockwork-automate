# Clockwork Autofill

Chrome and Firefox extension that reconstructs your day (or a past day) and
pre-fills the worklogs, so you don't have to enter them by hand in Clockwork.

**How it ends up in Clockwork:** Clockwork worklogs are synced with Jira's native
worklogs. The extension writes to `POST /rest/api/3/issue/{key}/worklog` and the
hours show up in *My Work* and in timesheets. Clockwork's public API isn't needed —
it's read-only on worklogs.

**It only talks to Jira.** No tokens, no Bitbucket, no other services.

## Authentication: the browser session

No credentials stored anywhere. Requests run **inside a tab that's already open**
on the Jira site: they're same-origin and use the cookie from the login you already
did.

**On the domain:** if the site URL is configured, **only** tabs on that host count.
A tab on a different `*.atlassian.net` is ignored — hours don't get written to the
wrong site just because it happened to be open. The popup shows at the bottom which
host it's reading from (🟢 active session, 🔴 no usable tab), and if the tab is
missing the message carries an **Open and retry** button.

Note: Atlassian has deprecated cookie auth for the REST APIs. In-browser it works —
that's how Jira's own UI calls itself — but it's unsupported ground.

## Where the tasks come from

| Source | What it looks for |
| --- | --- |
| **Jira activity** | Issues in the configured projects modified that day, filtered on the changelog and on comments written **by you** |
| **Commits** | The issue "Development" panel, via `/rest/dev-status/1.0/issue/detail` — the same one Jira's UI uses to draw that box. Keeps the day's commits signed by you |
| **Recurring meetings** | Fixed rules per weekday, at a fixed duration |

### How commits work without Bitbucket

The Development panel is queried **one issue at a time**, so you need to know which
issues to look at. The candidates are:

1. the issues you touched in Jira that day;
2. plus your assigned issues updated in the last three weeks (default 25,
   configurable) — these are there to find commits on tickets you didn't open in
   Jira that day.

Calls go out 6 at a time to keep the analysis from dragging. A commit on a ticket
outside both lists won't be seen: if that happens, raise the candidate count in the
options.

Commits are yours if the author's name or email matches your Jira identity (accents
and case don't matter). If you sign your git commits with a different name, declare
it in the options: commits discarded as "someone else's" are **counted and
reported**, so you notice when the match isn't working.

The `dev-status` endpoint is internal and undocumented by Atlassian: it can change
without notice. If it stops responding, the analysis carries on with Jira activity
alone and tells you so.

## How it works out the hours

```
daily budget
  − hours already logged that day   (on any issue, not just the ones in the plan)
  − duration of meetings that have a ticket
  = remainder, split evenly across the tasks in 15-minute steps
```

Subtracting the hours already logged is essential: without it, a day with 7h30m
already logged would distribute another 8 on top.

The maths is **live**: hours already logged hold space only until you start redoing
them. Switch a row back on via its *already Xh* badge and those minutes return to
the pool — it's an explicit choice, and the total warns you in red about where the
day would land.

A row that won't be written shows **0 hours** and takes no part in the split: that
covers both rows switched off and rows **without a ticket** — a meeting not yet
matched, a row just added. Displaying hours that will go nowhere, or reserving time
for a row that can't send it, is the most direct way to make the numbers wrong. A
value you corrected by hand isn't lost: it comes back as soon as the row is sendable
again.

**Breaks** (as many as you need, not just lunch) don't consume the daily budget:
they're holes in the timeline. A block of work landing on one gets split and several
worklogs reach Jira — `09:00–13:00 + 14:00–18:00` — the way the day actually looks
on the calendar. Meetings stay at the time you configured — they're appointments,
not blocks to be slotted in — but the breaks apply to them too: a meeting that
straddles one gets split like anything else. Splitting doesn't remove minutes, it
only moves the timestamps; not splitting would write a worklog claiming you were in
a meeting during a break you declared.

The remainder of the split goes to the rows with the most activity. Nothing is
written without confirmation: the popup shows the plan, you correct it and hit
*Send*.

## Installation

On Chrome (and Edge, Brave, Opera):

1. `chrome://extensions` → turn on **Developer mode**
2. **Load unpacked** → select this folder
3. Open the **Options** and fill in:

On Firefox the manifest is a different one, so the folder to load is the one the
build produces:

1. `npm run build`
2. `about:debugging` → **This Firefox** → **Load Temporary Add-on…**
3. pick `dist/firefox/unpacked/manifest.json`, then open the **Options**

A temporary add-on is gone at the next restart — for something that stays, the
zip in `dist/firefox/` has to be signed by AMO. The side panel is Firefox's
sidebar: the toolbar icon opens it, and it's also under *View → Sidebar*.

What goes in the Options is the same on both:

**Jira** — the site URL, or **Detect from browser** if you already have a tab open,
and under *Projects* the keys you work on. There is no site and no project hardcoded
anywhere: with no projects the extension says so and invites you to set them,
because the activity search would otherwise run across every issue on the site. Hit
**Test connection**.

**Commits** — the defaults are usually fine. Raise *Issues to check* if you work
across many tickets, set it to `0` to stick to today's issues.

**Meetings** — entered as **from / to**, the way they sit on the calendar
(internally they become a duration, which is what Jira wants). Moving the start time
shifts the meeting while keeping its duration. If the end time isn't after the start
time, saving is blocked and says so.

| Name | Days | From | To |
| --- | --- | --- | --- |
| Daily | Mon | 09:30 | 10:00 |
| Project standup | Mon | 10:00 | 10:30 |
| Project standup | Tue–Fri | 09:30 | 10:00 |

## Daily use

1. Click the icon: it starts on **today** by itself, without pressing anything
2. With `‹` `›` or the date field you move to another day — the analysis restarts on
   its own. Holding `‹` down coalesces the requests and discards superseded results,
   so the wrong day never lands in the table.
   The **Refresh** button is only for redoing the analysis on the same date
3. The ceremony ticket is **proposed automatically** by looking for the words of the
   meeting name in the titles of recent issues (e.g. *Project standup* →
   `Standup - Team Sprint 8`). It arrives with a **proposed** badge: check it, it
   changes every sprint. Once confirmed, it's remembered for the whole ISO week
4. Correct hours and notes. Editing a row's hours "locks" it (blue border) and the
   others redistribute around it. With **Add a row** you put in what detection
   missed — an unplanned meeting, a ticket you worked on without leaving traces
5. **Send worklogs** — written rows disappear from the plan straight away, then the
   **table re-reads itself from Jira**: *already Xh* badges, remaining budget and
   times line back up with the server. Only the table refreshes, the Jira page
   underneath isn't touched

### Missing hours on the icon

A red number on the extension icon when today isn't covered yet — refreshed every
15 minutes and after every write. The way hours get lost isn't getting them wrong,
it's forgetting: a number you see without opening anything is the cheapest fix.

It needs a Jira tab open to read from. Without one the badge is **cleared** rather
than left showing a stale figure: a wrong number is worse than none. Switch it off
in the options if you'd rather not have it.

### Copying a day

`Copy from [date] [Copy]` under the table pulls in what you logged on another day —
one row per issue, hours and notes included. It defaults to the previous **working**
day, so on a Monday it offers Friday.

The copied hours arrive **locked**: they're your choice, not an estimate, and don't
get redistributed. Issues that already have hours today stay switched off — copying
doesn't bypass the duplicate protection.

### Preview of the day

Above the table there's a strip with the time axis: it shows where the blocks will
land **before** they're written. Blue = to be written, amber = meetings, hatched =
hours already logged that you aren't touching, light = break. Hovering a row
highlights its blocks, so you see at once which piece is which.

It's the exact preview: it's built from the same segments that get sent, not from a
parallel calculation.

### Undoing a send

Rows that already have hours on Jira show a **bin** icon: it opens, under the row,
the list of that day's individual worklogs, each deletable on its own.

```
2 worklogs already on Jira for ABC-123 — delete them one by one:
  10:00–10:30 · 30m     [Delete]
  13:00–13:30 · 30m     [Delete]
  Delete all 2
```

Picking a specific entry *is* the confirmation: with a duplicate you remove only
what you need, instead of wiping the whole day on that issue. It only touches your
worklogs and only that date.

### The page underneath

Clockwork draws the calendar once and doesn't notice what we write. So after a send
or a delete the Jira tab is **reloaded** — after the plan has been re-read, because
the analysis goes through that very tab.

In the same way the plan is a snapshot of the moment it was read: if you move a
worklog from Clockwork, the extension re-reads it by itself as soon as the popup
comes back to the foreground.

That return uses a **light path**: it re-reads only the hours already logged, which
are the only thing that can have changed underneath. A full analysis would redo
activity, commits and recent issues — dozens of requests to update one badge. Rows
switched off by the duplicate check come back on if those hours disappear from Jira;
the ones **you** switched on or off stay as you left them.

### Two safeguards

- **Duplicates.** If an issue already has a worklog of yours on that date, the row
  carries the *already Xh* badge and starts switched off.
- **Meeting ticket ≠ task.** The ceremony ticket doesn't also show up among the work
  tasks: the Jira activity on that ticket *is* the meeting. If you assign it to a
  meeting by hand, the corresponding task row is removed.

## Keeping the settings

Uninstalling wipes `storage.local` on both browsers, and on Firefox a *temporary
add-on* loses everything at the next restart. So there are two copies, and they are
not the same kind of promise.

**The file.** *Options → Configuration file → Export* writes the settings to
`clockwork-autofill-<date>.json`; *Import* puts them back — on another machine, or
on the other browser, since the file has nothing browser-specific in it. Importing
**replaces**, it doesn't merge: what the file doesn't mention goes back to the
default, so you don't end up with last month's meetings sitting next to the new
ones. A file that isn't ours is refused with a reason rather than swallowed. What
stays out of the file: the cached Jira identity (accountId, name, email) — a config
file gets passed to a colleague or committed to a repository, and that has no
business travelling with it.

**The account copy.** Settings are also mirrored into `storage.sync`, so they follow
your profile across devices and come back on their own after a reinstall. Treat it
as a convenience, not a guarantee: neither browser promises to keep synced data
across an uninstall, and it needs a signed-in account. If it isn't there, the load
falls back to the defaults without complaining — the file is the copy that always
survives.

That split is why the cached meeting tickets live in their own storage key rather
than inside the config: `storage.sync` allows 8 kB per item, and one entry per
recurring meeting per week reaches that within a year. The cache stays local and
keeps the last eight weeks; it rebuilds itself as you use the extension. The
identity cache is local too, for the same reason as above.

## Languages

English and Italian. The language follows the browser's UI language; English is the
fallback (`default_locale`), so a browser in German sees English.

```
_locales/
  en/messages.json
  it/messages.json
```

Static markup declares its keys with `data-i18n`, `data-i18n-title`,
`data-i18n-placeholder`, and the English text stays written in the HTML as readable
source. **Planner and background produce no prose**: they emit `{ level, key,
params }` and the popup composes the sentence, in the right language — singular and
plural included, which differ from language to language.

A test suite keeps the two languages aligned: same keys, same placeholders, no key
used and not defined, none defined and never used, and no sentence left written in
the code.

## Structure

```
manifest.json
icons/                extension icon, 16/32/48/128
_locales/             en, it
src/
  background.js       service worker: every network call
  popup.html/js/css   the day's plan, editable
  options.html/js/css configuration
  lib/
    icons.js          inline Lucide icons (ISC), no external dependency
    i18n.js           `t()` and markup translation via `data-i18n`
    transport.js      session channel, domain detection and enforcement
    jira.js           activity, commits from the Development panel, hours already logged
    planner.js        meetings, ticket proposal, hour distribution, times
    dates.js          local dates, ISO week, Jira's `started` format
    storage.js        configuration, defaults, sync copy, export/import file
tools/
  build.mjs           distributable packages, one per browser
  manifest-firefox.mjs  Firefox's manifest, computed from Chrome's
```

The channel validates itself **once only** per analysis, with a probe request. After
that there's no fallback: if a write could be retried on another channel, it would
create a duplicate worklog.

Hour distribution (`allocate`) has **one implementation only**, used both when
building the plan and on every edit in the popup: two copies would diverge at the
first tweak.

## Tests

```
npm test
```

Thirty-six suites. Most run over `src/lib`, which is pure modules that work in node
as they are; the parts that talk to the browser are simulated. They cover: dates and ISO
week, the hour split, message levels, the three strategies for matching the meeting
ticket, the session channel (including refusing a tab on the wrong domain and the
ban on retrying a write), commits from the Development panel, translations, the
Firefox manifest computed from Chrome's, the configuration file and the sync copy
(including the files that must be refused), and the full flow across four scenarios:
empty day, day already logged by hand, half-filled day, manual corrections.

Two of them run the **pages themselves**. `popup.html` and `options.html` are loaded
into jsdom with a fake `chrome` that answers what the test tells it to, and then the
test clicks: the plan is rendered, a row is switched off and the hours redistribute,
a day that overruns asks for confirmation before sending, an error carries its
remedy button, the options round-trip through the disk and through the config file.
The plan they feed comes out of the real planner, so the shapes can't drift from what
the background would send. It's the half the other suites can't see — they read the
source, these execute it. jsdom is a devDependency: like esbuild, it builds and tests,
it doesn't ship (the package only carries `src`, `icons` and `_locales`).

Permissions: `storage`, `scripting` and `https://*.atlassian.net/*`. `tabs` isn't
needed — host_permissions are enough to find the site's tabs and grant no visibility
over the others.

## Build

```
npm install     # once: esbuild
npm run build
```

One command, and it always rebuilds everything: both packages come out of the same
sources, and rebuilding one alone is how they drift apart — the other one left at an
older version, ready to be uploaded by mistake.

Produces `dist/<browser>/clockwork-autofill-<version>-<browser>.zip`, to upload to
the Chrome Web Store or to AMO — or to hand over directly — and
`dist/<browser>/unpacked/` for "Load unpacked". Tests and tooling stay out of the
package.

**One manifest, not two.** `manifest.json` is Chrome's; Firefox's is computed from
it at every build by `tools/manifest-firefox.mjs`. Two hand-written manifests would
be two files to keep in step, and the second would fall behind at the first change —
a permission added on one side and not the other doesn't raise an error, it makes an
extension that stops working on one browser. Four things differ, all of them names
for the same thing: the background is `scripts` instead of `service_worker`, the
side panel is `sidebar_action` instead of `side_panel` (and needs no permission, so
`sidePanel` is dropped), the options page is `options_ui` — the only one
`runtime.openOptionsPage()` opens on Firefox — and `browser_specific_settings.gecko`
carries the add-on id, without which the configuration is lost at every reload.
`strict_min_version` is 128: `world` in `scripting.executeScript` doesn't exist
below that, and every request would fail. The JavaScript is the same file on both,
with `chrome.sidePanel` and `sidebarAction` checked at runtime.

**The build won't run if the suite isn't green** — translations included, which are
exactly the ones that break silently. It also checks that every file the manifest
names actually ends up in the zip, and that `default_locale` has its folder. If
anything fails, `dist/` is removed rather than left half-built: a zip with a defect
inside gets discovered by whoever installs it, and by then it's late.

`background.js`, `popup.js` and `options.js` are each bundled with their `src/lib`
dependencies into one file and **minified** — roughly halving the JavaScript. CSS is
minified too. The HTML is copied untouched: its text nodes are translated content,
and collapsing whitespace there would change what you read on screen.

**Minified, not obfuscated.** The Chrome Web Store forbids obfuscation outright —
*"Developers must not obfuscate code or conceal functionality of their extension"* —
while explicitly allowing minification, including shortening names and collapsing
files together. An obfuscated package gets rejected at review. It would also buy
nothing: an extension is installed on the user's machine, so anyone can read it
regardless.

esbuild is a devDependency — it builds the package, it isn't in it. The zip itself
is still written by hand with `node:zlib`.

## Known limits

- The activity search looks at the first 100 issues updated that day in the
  configured projects.
- Commits are only visible on candidate issues (see above), and only if the
  Development panel is linked to the repository.
- `dev-status` is an internal Jira endpoint, not officially supported.
- The hour split is a heuristic, not a measurement: it's built to be corrected by
  hand before sending.
