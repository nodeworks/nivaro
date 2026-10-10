import type { DocSection } from '../types.js'

export const trashDocs: DocSection = {
  id: 'trash',
  label: 'Trash & Restore',
  content: [
    { type: 'h1', id: 'trash', text: 'Trash & Restore' },
    {
      type: 'p',
      text: 'Every business-record delete through the API snapshots the full row into the trash bin. Restore it within 30 days — with its original id — or let the daily purge clean it up.'
    },
    {
      type: 'pre',
      code: `GET    /api/trash              # admin: everything; others: own deletions
POST   /api/trash/:id/restore  # re-insert with the ORIGINAL id
DELETE /api/trash/:id          # purge immediately`
    },
    {
      type: 'ul',
      items: [
        'Restore keeps the original primary key (identity insert), so surviving references still point at the record.',
        'Dependent rows removed by the original delete (cascades, SET NULL) are not resurrected — only the record itself returns.',
        'Restore needs create permission on the collection; an occupied id refuses with 409.',
        "The record's history continues: a restore writes a `restore` activity row (credited to whoever restored it, on the request's event chain) and a full revision, per the collection's audit level — the History panel reads \"restored this record from trash\". Stored rollups, the record's tasks, its integrity check, materialized queue rows and open views all catch up.",
        'A restore is not a create: creation notifications and subscriptions, pipeline auto-start, automatic transitions, webhooks and flows do not run again, so nobody is told about the record twice.',
        'UI: the Trash page in the System nav, with per-collection filter pills.'
      ]
    }
  ]
}

export const timeTravelDocs: DocSection = {
  id: 'time-travel',
  label: 'Time-Travel Restore',
  content: [
    { type: 'h1', id: 'time-travel', text: 'Time-Travel Restore' },
    {
      type: 'p',
      text: 'The revision history panel has a Time travel mode: scrub a slider through every snapshot of a record, watch fields change (differences from the current state highlight amber), and restore to any point with one confirm-gated click.'
    },
    {
      type: 'note',
      text: 'Restore applies the snapshot through POST /revisions/:id/rollback and is itself logged, so you can always travel back again.'
    }
  ]
}

export const mergeDocs: DocSection = {
  id: 'record-merge',
  label: 'Record Merge',
  content: [
    { type: 'h1', id: 'record-merge', text: 'Record Merge' },
    {
      type: 'p',
      text: 'Combine duplicate records into one survivor. Select 2–5 rows in the collection browser and hit Merge: a side-by-side sheet shows every differing field, you pick the surviving record (defaults to the most-referenced) and which value wins per field.'
    },
    {
      type: 'pre',
      code: `GET  /api/merge/preview?collection=&ids=a,b   # field values + inbound reference counts
POST /api/merge  { collection, survivor_id, loser_ids, field_choices }`
    },
    {
      type: 'ul',
      items: [
        'Every inbound reference repoints to the survivor: M2O foreign keys in bulk, M2M junction rows individually (rows that would duplicate an existing pairing are dropped).',
        'Chosen field values apply through the normal update path — hooks, validation and row security run.',
        'Losers are deleted through the items service, so they land in Trash and stay restorable.',
        'Requires update + delete permission on the collection.'
      ]
    }
  ]
}

export const spreadsheetDocs: DocSection = {
  id: 'spreadsheet-mode',
  label: 'Spreadsheet Mode',
  content: [
    { type: 'h1', id: 'spreadsheet-mode', text: 'Spreadsheet Mode' },
    {
      type: 'p',
      text: 'The Grid view turns any collection into an editable spreadsheet: navigate with arrows and tab, type to edit, select ranges with shift, copy as TSV, paste blocks straight from Excel or Sheets, and fill down with Cmd/Ctrl+D.'
    },
    {
      type: 'ul',
      items: [
        'Every cell commit is a single-field PATCH through the items API — RBAC, hooks, validation, field rules and locks all apply.',
        'Cells flash amber while saving, green on success; failures turn red with the server error in a toast.',
        'Readonly, computed, relation and FK columns render locked.',
        'Delete/Backspace clears the selected range (editable cells only).'
      ]
    }
  ]
}

export const dashboardLinkDocs: DocSection = {
  id: 'dashboard-links',
  label: 'Public Dashboard Links',
  content: [
    { type: 'h1', id: 'dashboard-links', text: 'Public Dashboard Links' },
    {
      type: 'p',
      text: 'Share a live dashboard with anyone — no account needed. The Public link popover on a dashboard mints a token URL (/d/…) rendering a read-only view that refreshes every minute.'
    },
    {
      type: 'ul',
      items: [
        'Optional expiry (7/30 days or never); revoke any time; per-link view counts.',
        'Widget data resolves server-side with no viewer to permission-check — the same creator-configured model as widget feeds. Share accordingly.',
        'Only the dashboard owner (or an admin) can mint or revoke links.'
      ]
    }
  ]
}

export const bugReporterDocs: DocSection = {
  id: 'bug-reporter',
  label: 'Bug Reporter',
  content: [
    { type: 'h1', id: 'bug-reporter', text: 'Built-in Bug Reporter' },
    {
      type: 'p',
      text: 'The floating bug button (bottom-right on every admin page) files reports straight into the issue log: your description and severity, an automatic screenshot of the page, the last console errors/warnings, and your route + browser details.'
    },
    {
      type: 'note',
      text: 'Screenshots are downscaled JPEGs capped at 2MB, stored on the issue and shown in the expanded issue detail. The list view never carries the blob.'
    }
  ]
}

export const schemaGraphDocs: DocSection = {
  id: 'schema-graph',
  label: 'Schema Graph',
  content: [
    { type: 'h1', id: 'schema-graph', text: 'Schema Graph Explorer' },
    {
      type: 'p',
      text: 'Beyond the static ERD, /data-model/graph renders your whole schema as a live force-directed graph: collections sized by row count, relation edges heat-mapped by the last 7 days of write activity (M2M dashed amber). Drag nodes, zoom with the wheel, hover to isolate a neighborhood, click to open the table editor.'
    }
  ]
}

export const journeyTrailDocs: DocSection = {
  id: 'journey-trail',
  label: 'Journey Trail',
  content: [
    { type: 'h1', id: 'journey-trail', text: 'Journey Trail' },
    {
      type: 'p',
      text: 'A session-by-session breadcrumb of every admin page a user visited, with time spent on each — session-replay insight without recording anything on screen. Built from the same presence pings that power the live map, persisted with 30-day retention.'
    },
    {
      type: 'pre',
      code: `GET /api/journeys/user/:id?date=YYYY-MM-DD   # sessions + steps for one day
GET /api/journeys/days/:id                   # which of the last 30 days have data`
    },
    {
      type: 'ul',
      items: [
        'Admin-only — this is user tracking; the API refuses non-admins.',
        'Durations stamp when the user moves to the next page or disconnects (capped at 8h against dangling sessions).',
        'UI: the Journey Trail card on a user profile (admin view), with a day picker of active days.',
        'Rows purge automatically after 30 days in the daily retention pass.'
      ]
    }
  ]
}

export const sessionReplayDocs: DocSection = {
  id: 'session-replay',
  label: 'Session Replay',
  content: [
    { type: 'h1', id: 'session-replay', text: 'Session Replay' },
    {
      type: 'p',
      text: 'Full rrweb screen recording of admin sessions: watch exactly what a user saw and did, scrubbed like video. Off by default — flip the switch on the Session Replays page and every admin session starts recording.'
    },
    {
      type: 'ul',
      items: [
        'Privacy: every input is masked client-side before events leave the browser; add the nvr-no-record class to block any element entirely.',
        'Events batch every 10 seconds; a full DOM snapshot every 60 seconds keeps replays seekable.',
        'Recordings cap at 15MB (then mark truncated) and purge after 7 days.',
        'Watching, listing and deleting are admin-only; a recording can only be appended to by its own user.',
        'Tell your team before enabling — this records their screens.'
      ]
    },
    { type: 'h2', id: 'session-replay-uploads', text: 'Uploads that survive bad networks' },
    {
      type: 'p',
      text: 'A chunk that cannot be sent — the browser is offline, the request fails or the server answers 5xx — waits in the browser (IndexedDB, at most about 20MB per tab, oldest dropped first) and is retried with backoff from 2 seconds up to a minute, and as soon as the browser comes back online. Reloading the tab within 10 minutes continues the same recording instead of starting a new one, and whatever the previous page had not sent goes first. When a page is closed or reloaded, the last few seconds are sent with the request that outlives the page (fetch keepalive); anything that does not fit goes on the next load. A recording that is closed or has reached its size cap still stops for good, and the next page load starts a new one. The headless hook in @nivaro/react does the same.'
    },
    { type: 'h2', id: 'session-replay-headless', text: 'Recording your own frontends' },
    {
      type: 'p',
      text: 'Apps built on the headless API record themselves with one hook from @nivaro/react (rrweb is an optional peer dependency — install it in the host app):'
    },
    {
      type: 'pre',
      code: `import { NivaroProvider, useSessionRecorder } from '@nivaro/react'

function App() {
  useSessionRecorder({ app: 'customer-portal' })
  return <Routes />
}`
    },
    {
      type: 'ul',
      items: [
        'The hook no-ops unless the instance toggle is on AND rrweb is installed — safe to ship always-on.',
        'Recordings attribute to the authenticated SDK identity (usually your service token user); the app label tells frontends apart in the replay list.',
        'Raw SDK commands exist too: sessionRecordingEnabled, startSessionRecording(app), appendSessionRecordingEvents, endSessionRecording.',
        'The hook keeps the same console and network log as the admin recorder (below), from your app’s own fetch and XMLHttpRequest calls.'
      ]
    },
    {
      type: 'note',
      text: 'Journey Trail (page breadcrumbs) covers most debugging needs without recording anything visual — reach for replay when you need the pixels.'
    },
    { type: 'h2', id: 'session-replay-markers', text: 'Timeline markers, console and network' },
    {
      type: 'p',
      text: 'Recordings capture context alongside the pixels: every route change, every console warning and error the page emitted, and a light log of the page’s requests. console.log and console.info are skipped as noise (recordings made before this also kept info lines, and still show them).'
    },
    {
      type: 'ul',
      items: [
        'Console lines are cut to 200 characters, at most 500 per page load. Anything that looks like a credential is replaced with [redacted] before it is kept: JWTs, Bearer and Basic credentials, long hex or base64 strings, and the value of anything named token, secret, password, API key, authorization or cookie.',
        'Requests keep the method, the route with ids replaced by :id, the status and how long it took, at most 1,000 per page load. No query strings, bodies or headers; a call to another site keeps its host. A request that never got an answer shows as failed. The recorder’s own uploads are left out.',
        'The page’s address in a route marker gets the same redaction, so a reset or invite link’s token is not kept.'
      ]
    },
    {
      type: 'ul',
      items: [
        'The player’s scrubber shows the markers as colored ticks — blue for route changes, red for console errors, amber for warnings. Clicking a tick seeks the replay to just before that moment. Info-level console lines are kept out of the scrubber to avoid clutter.',
        'Beside the player, a Console / Network panel lists the console lines and requests. The line at the playhead is highlighted, later lines are dimmed, and the list scrolls itself to follow the replay unless your pointer is over it or you have just scrolled it. Clicking a line seeks the replay to it. Console has a filter per level with counts.',
        'On a narrow window, and in the Traffic Map’s Recording level, the panel sits under the player instead.',
        'This makes "what was the user doing when that error fired" a one-click question — find the red tick, click it, watch.'
      ]
    },
    { type: 'h2', id: 'session-replay-rail', text: 'The event rail' },
    {
      type: 'p',
      text: 'Under the scrubber, a second row of markers shows what the same person did on the server while the recording ran, from the API log, the issue log, the page trail and workflow history: their requests, client errors they reported, admin pages they entered and workflow transitions they made.'
    },
    {
      type: 'ul',
      items: [
        'Colours: requests grey when they succeeded, amber for a 4xx and red for a 5xx; client errors red; page changes blue; transitions violet.',
        'Hover a marker for what it was (method, path, status and time for a request). Markers a few pixels apart merge into one that lists what it holds, so a busy recording stays clickable.',
        'Click a marker to seek to just before it. Ctrl-click (⌘-click on a Mac) an error or a transition to open the issue or the record.',
        'Requests show method, path, status and duration only, never bodies or query strings. The recorder’s own uploads are left out.',
        'A long recording shows at most the first 500 requests, 100 errors, 300 page changes and 200 transitions; hovering the rail says when a kind was cut.',
        'Times come from the server’s clock and the recording from the browser’s, so a marker can sit a second or two off the moment on screen.'
      ]
    },
    { type: 'h2', id: 'session-replay-skip', text: 'Skipping inactivity' },
    {
      type: 'p',
      text: 'Stretches longer than 5 seconds with no input (mouse, keys, scroll, touch) and no change on the page play at 8×; a stretch that would still take more than a few seconds at 8× is jumped over to its last 2 seconds. The scrubber shades each one with how long it was ("skipped 2m 10s") and a badge over the replay says when it is skipping. The Skip idle / Real time button beside the speeds turns it off; the choice is remembered in this browser.'
    },
    {
      type: 'ul',
      items: [
        'Each recording’s active time — the time between input or page changes, every idle stretch counted as at most 5 seconds — is worked out as its chunks upload and shown on the list ("4m 12s active"). Sort a person’s recordings by Most active to find the sessions where something actually happened.',
        'Recordings made before active time was measured show no figure and sort last.'
      ]
    },
    { type: 'h2', id: 'session-replay-chapters', text: 'Chapters' },
    {
      type: 'p',
      text: 'A recording splits into chapters at every page change — from the recorder’s own route markers and the server’s page trail, merged when both saw the same navigation. A change of query string alone (a filter, a tab) stays in the same chapter, and a page left within a moment (a redirect) is folded into where it landed. Under the scrubber the chapters are listed with their page and length, the current one highlighted; click one to jump to it, or press , (back) and . (next) while watching.'
    },
    {
      type: 'p',
      text: 'The list shows how many chapters each recording has, counted from the route markers as the recording uploads (recordings made before this show no count).'
    }
  ]
}

export const reportStudioDocs: DocSection = {
  id: 'report-studio',
  label: 'Report Studio',
  content: [
    { type: 'h1', id: 'report-studio', text: 'Report Studio' },
    {
      type: 'p',
      text: 'Compose reports as a drag-and-drop grid of widgets — KPIs, bar/line/donut charts, tables and section dividers — each defined by you over any collection: pick an aggregate (count, sum, avg, min, max), an optional group-by (a field, or a date bucketed by day/week/month), filters, and a date field the report-level date range applies to. Widgets preview live as you configure; layout saves automatically.'
    },
    { type: 'h2', id: 'report-studio-model', text: 'How widgets resolve' },
    {
      type: 'ul',
      items: [
        'Everything resolves server-side as the viewer — collection read permissions apply per widget, field names validate against the physical schema.',
        'Group-by on a relation (M2O) field resolves display labels from the related collection automatically.',
        'The report date range (this month, last 30 days, last N months, YTD) applies to each widget through its configured date field; widgets without one ignore it.',
        'Share a report with everyone or scope it to a role; clone, export and import as JSON.',
        'KPI Group widgets pack up to 6 stat tiles (each its own collection + aggregate) into one card; charts and KPIs can compare against the previous period or the same window last year (delta chips, dashed prior series).',
        'The global filter bar holds entity filters — pick fields onto the bar, then multi-select live values (FK values resolve to labels); filters apply to every widget whose collection has the field.',
        'Build with AI composes a whole layout from a prompt; the Ask-AI filter input turns prose like "last 6 months" into filters. Every widget shows its freshness and a one-click refresh.'
      ]
    },
    { type: 'h2', id: 'report-studio-subs', text: 'Subscriptions & alerts' },
    {
      type: 'ul',
      items: [
        'Subscribe for a daily (07:00) or weekly (Monday) email — the report renders fresh, server-side, as you, into a mail-safe HTML digest with KPIs, bars and tables, plus an in-app notification.',
        "Only when something changed: a subscription can skip the send when every number matches the last delivered digest (the fingerprint covers each widget's value, row count and every series point — never the HTML, so a relabel is not a change). Turning it on delivers once to establish the baseline; the popover shows when a send was last skipped.",
        'Explain the trend: the sparkle on any chart (or a KPI with a compare window or sparkline) asks the AI why the series moved. The sentence is grounded in the resolved series and a sample of the rows behind the two points that moved — read as you, so the sample never shows a record your own drill-through would not — and the movers it names render as +/− chips under the text.',
        'Alerts watch a KPI or table widget: conditions on its value or row count (gt/gte/lt/lte/eq, AND), checked hourly. An alert fires ONCE when crossed and resolves when back in range — the open firing entry is the cooldown, so it never re-spams.',
        'Delivery per alert: in-app, email, or both. Toggle or delete any time; a firing badge shows live status.'
      ]
    }
  ]
}

export const auditLevelDocs: DocSection = {
  id: 'audit-levels',
  label: 'Audit Levels',
  content: [
    { type: 'h1', id: 'audit-levels', text: 'Audit Levels' },
    {
      type: 'p',
      text: 'Every write to a business collection logs an activity entry and a full revision snapshot. That is the right default for records people care about, and the wrong one for high-frequency ephemeral tables — presence heartbeats, read markers, last-seen timestamps — which bury real audit history and bloat the revision table.'
    },
    {
      type: 'p',
      text: 'Each collection carries an accountability level that controls how deeply its writes are recorded. Set it in Data Model → collection settings, or via the API.'
    },
    {
      type: 'table',
      head: ['Level', 'Activity entry', 'Revision snapshot', 'Use for'],
      rows: [
        ['all (default)', 'Yes', 'Yes', 'Normal records — full history and time-travel restore'],
        [
          'activity',
          'Yes',
          'No',
          'Chatty but audit-relevant writes (chat messages, log-style rows)'
        ],
        ['(empty)', 'No', 'No', 'Ephemeral state — presence, read markers, heartbeats']
      ]
    },
    {
      type: 'pre',
      code: `PATCH /api/collections/user_presence
{ "accountability": "" }          # stop auditing entirely

PATCH /api/collections/chat_messages
{ "accountability": "activity" }  # keep the trail, drop snapshots`
    },
    {
      type: 'note',
      text: 'Webhooks fire at every level — delivery is a separate contract from auditing. Turning a collection down never affects integrations.'
    },
    {
      type: 'warn',
      text: 'Levels below "all" disable time-travel restore for that collection: with no revision snapshots there is nothing to roll back to. Trash-based restore of a deleted row still works.'
    },
    {
      type: 'ul',
      items: [
        'A change takes effect on the next write — the level is cached for 60 seconds and busted immediately when you PATCH the collection.',
        'Unregistered collections default to full auditing, so a lookup miss never silently loses coverage.',
        'Extensions can write their own audit entries with ctx.logActivity() — entries are namespaced with the extension id.'
      ]
    }
  ]
}
