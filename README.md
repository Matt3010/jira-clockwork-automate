# Clockwork Autofill

A Tampermonkey userscript that reconstructs your working day (or a past day)
and pre-fills the worklogs, so you don't have to enter them by hand in
Clockwork. It lives as a panel on Clockwork's **My Work** page, right next to
the calendar.

**How it ends up in Clockwork:** Clockwork worklogs are synced with Jira's
native worklogs. The script writes to `POST /rest/api/3/issue/{key}/worklog`
and the hours show up in *My Work* and in timesheets — Clockwork picks them up
a few tens of seconds later, so after a send the calendar reloads itself a
few times within the next minute.

**It only talks to Jira, from the page itself.** No tokens, no Bitbucket, no
other services: requests are same-origin and use the login you already did.
Clockwork runs in an iframe on another domain, so the panel sits in the Jira
page around it, not inside it.

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/). On recent Chrome,
   `chrome://extensions` → Tampermonkey → Details → turn on **Allow user
   scripts**.
2. Open
   [the latest release](https://github.com/Matt3010/jira-clockwork-automate/releases/latest/download/clockwork-autofill.user.js)
   and confirm **Install**.
3. Go to Clockwork → **My Work**: an **Autofill** tab appears on the right
   edge. Open it, then the gear icon for the settings — or import the
   configuration file exported from the old extension.

**Updates are automatic.** The script declares `@updateURL`/`@downloadURL`
pointing at the latest release: Tampermonkey checks once a day (or right away
with *Check for updates*) and installs any higher `@version`.

## The panel

- **Hours** — the plan of the day, editable: meetings, the tasks found, hours,
  times (split around breaks), the note that goes with each worklog. Reorder
  rows by dragging or with ▲ ▼ — order decides the times. *Send worklogs*
  writes them; it asks for confirmation when the day would overflow the
  budget or rewrite hours already logged. Rows already on Jira show a bin
  that lists that day's worklogs, each deletable on its own. *Copy from*
  starts from another day. A strip at the bottom previews the day.
- **Tickets** — your open tickets by status and last movement, a search that
  also finds other people's tickets, and *Move* to change status one step at
  a time.
- **Verify** — rebuilds the last N working days as if they were empty and
  compares them, ticket by ticket, with what you actually logged: found,
  missing (and why), extra, hours off. Read-only. It's how the analysis is
  judged.
- **Settings** (gear) — projects, comments, commits, working day, breaks,
  recurring meetings, export/import of the configuration file.

The panel re-reads by itself every minute and when you come back to the
page — only the hours already logged, or the tickets — and never while you're
typing, with a menu open, a confirmation armed or a send in progress.

## Where the tasks come from

| Source | What it looks for |
| --- | --- |
| **Jira activity** | Issues in the configured projects with changes or comments **by you** that day; on issues assigned to or reported by you, also what colleagues did (shown under the row, not counted as your work) |
| **Issues you created** | Creating a ticket is work too |
| **Commits** | The issue "Development" panel (`/rest/dev-status/1.0/issue/detail`), keeping your commits of that day |
| **Recurring meetings** | Fixed rules per weekday, at a fixed duration |

Commits are read one issue at a time, from these candidates: the issues
touched that day, the issues **you logged hours on** in the three weeks
before, and those assigned to you. The second group matters: a long task
assigned to someone else, that you work on every day without touching it in
Jira, is only visible through its commits.

The meeting ticket is proposed from a worklog already logged at that time,
then from the meeting name or the date in recent issue titles; once
confirmed it's remembered for the whole ISO week.

## How it works out the hours

```
daily budget
  − hours already logged that day   (on any issue)
  − duration of meetings that have a ticket
  = remainder, split across the tasks in rounding steps
```

The split is *equal* (default), *in proportion to activity* (commits and Jira
changes), or *in proportion to the original estimate*. With several tasks
it's a heuristic, meant to be corrected before sending: a row whose hours you
edit is locked and the others redistribute around it. Breaks don't consume
the budget, they're holes in the timeline: a block landing on one becomes
several worklogs.

## Known limits

- The day's activity search looks at the first 100 issues updated around
  that day in the configured projects.
- The Development panel returns only the **latest 100 commits** of an issue:
  on a busy ticket, older days lose their commits. Today and yesterday are
  fine; Verify on older days should be read with that in mind.
- `dev-status` is an internal Jira endpoint, not officially supported.
- Cookie authentication for the REST API is what Jira's own UI uses, but
  Atlassian doesn't document it for third parties.

## Development

```
npm install
npm test                    # all suites
npm run build:userscript    # dist/userscript/clockwork-autofill.user.js
npm run release:userscript  # build + GitHub release (needs a pushed, clean commit)
```

The build runs the test suite first and refuses to produce a script if it's
red. The version is `package.json`'s plus the build time, so it always grows.
The release attaches the file to a GitHub release marked *latest* — that's
where installed scripts update from.

For quick iterations without releasing, a local Tampermonkey script can load
the build straight from disk:

```js
// ==UserScript==
// @name         Clockwork Autofill (dev)
// @match        https://*.atlassian.net/jira/apps/*
// @grant        none
// @require      file:///path/to/jira-clockwork-automate/dist/userscript/clockwork-autofill.user.js
// ==/UserScript==
```

(It needs *Allow access to file URLs* on Tampermonkey and *Externals → update
interval: always* in its settings; disable the released script meanwhile.)

## Structure

```
src/
  lib/                pure modules, no DOM and no network of their own
    jira.js           Jira client, day activity, commits, hours already logged, tickets
    planner.js        meetings, ticket proposal, hour split, times
    dates.js          local dates, ISO week, Jira's `started` format
    storage.js        default configuration, export/import file
    ticket.js         open tickets grouping, useful transitions
    icons.js          inline Lucide icons (ISC)
  userscript/
    main.js           the panel: mount, rendering, events
    channel.js        same-origin requests from the page
    analysis.js       collect a day and build its plan
    day.js            the Hours tab state: edits, send, delete, copy, preview
    tickets.js        the Tickets tab: load, search, move
    verify.js         past days vs real worklogs
    settings.js       settings in localStorage, form validation
    *-view.js         HTML for each tab
    panel.css         the stylesheet (inherited from the extension's popup)
    messages.it.json  the texts, keyed
tools/
  build-userscript.mjs, release-userscript.mjs
```

This used to be a Chrome/Firefox extension; the userscript replaced it. The
logic in `src/lib` and its tests come from there.
