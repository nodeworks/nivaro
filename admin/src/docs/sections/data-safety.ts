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
      code: `GET /api/journeys/user/:id?date=YYYY-MM-DD&app=   # sessions + steps for one day
GET /api/journeys/days/:id?app=                     # which of the last 30 days have data, + apps seen`
    },
    {
      type: 'ul',
      items: [
        'Admin-only — this is user tracking; the API refuses non-admins.',
        'Durations stamp when the user moves to the next page or disconnects (capped at 8h against dangling sessions).',
        'UI: the Journey Trail card on a user profile (admin view), with a day picker of active days.',
        'Rows purge automatically after 30 days in the daily retention pass.',
        "Portals too: a front end built on @nivaro/react calls usePageAt({ app: 'efp', path }) inside its realtime provider and its pages land in the same trail, labelled with the app. ?app= narrows either route to one front end ('admin' includes rows from before the label existed); the card shows an app filter and a per-session app chip once a person has used more than one. Portal pages are listed, not linked."
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
        'Privacy: every input and every record field value is masked client-side before events leave the browser (see Masking rules below); add the nvr-no-record class to block any element entirely.',
        'Events batch every 10 seconds; a full DOM snapshot every 60 seconds keeps replays seekable.',
        'Recordings cap at 15MB (then mark truncated) and purge after the retention period (7 days unless changed on the Session Replays page); after 3 days they move from the database to file storage.',
        'Watching, listing and deleting are admin-only; a recording can only be appended to by its own user.',
        'Tell your team before enabling — this records their screens.'
      ]
    },
    { type: 'h2', id: 'session-replay-uploads', text: 'Uploads that survive bad networks' },
    {
      type: 'p',
      text: 'A chunk that cannot be sent — the browser is offline, the request fails or the server answers 5xx — waits in the browser (IndexedDB, at most about 20MB per tab, oldest dropped first) and is retried with backoff from 2 seconds up to a minute, and as soon as the browser comes back online. Reloading the tab within 10 minutes continues the same recording instead of starting a new one, and whatever the previous page had not sent goes first. When a page is closed or reloaded, the last few seconds are sent with the request that outlives the page (fetch keepalive); anything that does not fit goes on the next load. A recording that is closed or has reached its size cap still stops for good, and the next page load starts a new one. The headless hook in @nivaro/react does the same.'
    },
    { type: 'h2', id: 'session-replay-masking', text: 'Masking rules' },
    {
      type: 'p',
      text: 'Besides every input, the recorders mask the value of every field on a record — in the edit form and the read view — so a replay shows the layout and what the person did, not the data. Settings → Session replay → Masking lists fields that are safe to watch (a status, a code) as collection.field, or *.field for any collection; those show in replays and everything else stays masked. Field labels always show.'
    },
    {
      type: 'ul',
      items: [
        'Mask rich text (on by default): editors such as notes and descriptions show as asterisks wherever they appear, even in an allowed field.',
        'Mask file names (on by default): file names are masked and file thumbnails blocked, in file fields and the file library, even in an allowed field.',
        'Passwords are never shown. Text in attributes (a tooltip, an image’s alt text) is not masked; keep sensitive values out of them or mark the element nvr-no-record.',
        'The rules apply to the admin app and to frontends using useSessionRecorder from @nivaro/react; a changed rule reaches a recorder on its next page load. Recordings already made are not changed.'
      ]
    },
    { type: 'h2', id: 'session-replay-cost', text: 'Recording cost' },
    {
      type: 'p',
      text: 'Every uploaded chunk names the page (route pattern) it was recorded on and the frontend build that recorded it. DB Health → Session replay shows what recording stored per page and per build over the last 7 days, day by day, and the recordings’ share of the storage runway.'
    },
    {
      type: 'ul',
      items: [
        'Daily cap (Settings → Session replay → Recording cost): megabytes the whole instance may store per UTC day. Once reached, recorders stop and no new recording starts until the next day. Replicas see each other’s uploads within about 30 seconds, so the cap can be passed by that much.',
        'Sampling: the share of sessions recorded, as a default and per page — an exact pattern such as /content/orders/:id, or a prefix such as /reports/* (the most specific rule wins; 0% never records the page). Each tab decides once per visit, so a page is either recorded or not for that person throughout; while a tab is on a page that is not recorded nothing is kept, and the replay picks up again on the next recorded page.',
        'Clips attached to errors are not sampled, but they count toward the cap and stop when it is reached.',
        'With @nivaro/react, pass useSessionRecorder({ build }) to name your app’s build; it defaults to the @nivaro/react version.'
      ]
    },
    { type: 'h2', id: 'session-replay-storage', text: 'Older recordings move to storage' },
    {
      type: 'p',
      text: 'Recordings older than 3 days (Settings → Session replay → Storage) leave the database: each one is compressed into a single file in the file storage driver — local disk, S3 or Azure Blob, as set under Settings → File storage — and its rows in the database are removed. An hourly job does the moving; a recording still receiving events is left until it has been quiet for an hour.'
    },
    {
      type: 'ul',
      items: [
        'Opening an older recording loads it back first; the player says “Loading from storage…” for the few seconds that takes. It then stays loaded for 24 hours before the copy in the database is dropped again (the file stays).',
        'When the retention period ends, or a recording is deleted, its file in storage is deleted too.',
        'DB Health → Session replay shows how much sits in the database (hot) and in storage (cold), and the storage runway counts both.',
        'Switching the storage driver does not move recordings already in storage: they are read from the active driver, then from local disk. Moving from one cloud driver to another leaves older recordings unreadable until they are purged.'
      ]
    },
    { type: 'h2', id: 'session-replay-health', text: 'Health check' },
    {
      type: 'p',
      text: 'While recording or error clips are on, the readiness scorecard runs a Session recording is healthy check. It warns, with the figure and the likely cause, when:'
    },
    {
      type: 'ul',
      items: [
        'more than 5% of chunk uploads failed since yesterday (at least 20 uploads) — refusals the server saw (too large, recording closed or at its size cap) plus failed attempts the recorders report on their next successful upload. A browser that never gets through again cannot report, so the real figure can be higher;',
        'no recording started in the last 24 hours while people were signed in (the recorder is blocked, starts are failing, or sampling records nobody);',
        'the daily recording cap was reached, naming the page that stored the most that day;',
        'the oldest recording is more than a day past the retention period (the daily purge is not running).'
      ]
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
      type: 'p',
      text: 'Error clips work the same in your own frontend: with Error clips on, the hook keeps the last 30–60 seconds in memory and uploads nothing until something breaks. Call reportClientCrash from your error boundary and the issue it files links to the clip (or, with full recording on, to the moment in the live recording):'
    },
    {
      type: 'pre',
      code: `import { reportClientCrash } from '@nivaro/react'

componentDidCatch(error, info) {
  void reportClientCrash(client, error, info) // POST /issues/client + replay link
}`
    },
    {
      type: 'p',
      text: "Support clips: with Error clips on, a support request (Get help, Request a change) cuts the same in-memory buffer into an app='support-clip' recording, taken when the dialog opens and uploaded only if the request is sent; the requester can untick it. POST /session-recordings/start takes clip_kind ('error' | 'support') from an allowlist, so a clip's label is never free text."
    },
    { type: 'h2', id: 'session-replay-auto', text: 'Auto-record on a signal' },
    {
      type: 'p',
      text: 'With "Auto-record on signals" on (Session Replays header; nivaro_settings.replay_auto_signals, off by default), trouble starts a short recording even while recording is off: the next three minutes of the people affected, labelled auto:<signal>, inputs masked as always.'
    },
    {
      type: 'ul',
      items: [
        'rage-click — three clicks on one element within 600ms; dead-click — three clicks on buttons or links that changed nothing (no DOM change, no navigation within a second) inside ten seconds. Both arrive with the RUM beacon, sent at once, and record the person who clicked.',
        'monitor — an ops monitor flips to failing; breaker — an operator opens a Traffic Map breaker on an entity. Both record the people currently on the pages that show it (/collections/<c>…, /records/<c>…), as seen by the API process that noticed (the page pings of the admin and of portals using usePageAt).',
        'The server sends replay:record { signal, minutes: 3, token } over the socket; the token is single-use, minted for that person and that signal, and lives two minutes. POST /session-recordings/start honours an auto start only with it, so a page cannot start one itself.',
        'Capped at 12 auto recordings per hour for the instance (counted in Redis across API processes) and one per person per ten minutes; at most ten people per signal.',
        'With full recording already on, the signal is only marked on the live recording (a signal tick). With error clips on, the auto recording rides the clip buffer instead of starting a second rrweb stream.'
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
        'Beside the player, a Console / Network panel lists the console lines and requests. The line at the playhead is highlighted, later lines are dimmed, and the list scrolls itself to follow the replay unless your pointer is over it or you have just scrolled it. Clicking a line seeks the replay to it. Console has a filter per level with counts. While you follow a session live, the panel stays open and new lines arrive as the person works; clicking a line then leaves live mode and opens the recording at that moment.',
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
    { type: 'h2', id: 'session-replay-clips', text: 'Clips: select a range' },
    {
      type: 'p',
      text: 'Drag along the thin track under the scrubber to select a range; drag either handle, or focus it and use the arrow keys (Shift for 5 seconds), to adjust it, and Escape to clear it. The strip under the player shows the range and can move either end to the playhead.'
    },
    {
      type: 'ul',
      items: [
        'Raise an issue cuts the range into a replay of its own (labelled clip in the list) and opens a new issue linked to it. The issue says which page the clip opens on, lists the console errors in it and the person’s requests in its window (from the event rail), and adds your note.',
        'A clip starts from the last full page snapshot before the range, so it plays exactly what was on screen at its first second. Its events are copied as they were stored: masked inputs stay masked.',
        'A clip raised as an issue is kept for the same number of days as any recording.'
      ]
    },
    { type: 'h2', id: 'session-replay-library', text: 'Clip library' },
    {
      type: 'p',
      text: 'Save clip keeps the selected range in the library with a name, an optional description and tags. Session Replays → Library lists saved clips newest first: search by name, description or tag, filter by a tag, play a clip in place and delete it.'
    },
    {
      type: 'ul',
      items: [
        'A saved clip is a replay of its own, cut from the recording the same way as a clip raised as an issue, with the masking it was recorded with.',
        'Retention skips recordings the library holds: the clip stays until someone deletes it, while the rest of the recording it came from expires as usual. Delete clips you no longer need — the library is the one place recordings are kept indefinitely.',
        'Saving and deleting clips is recorded in the activity log.'
      ]
    },
    { type: 'h2', id: 'session-replay-share', text: 'Sharing a replay with one person' },
    {
      type: 'p',
      text: 'Share… on a selected range creates a link for one person you pick, valid for 1 hour to 30 days (3 days by default). They get a notification with the link; you see it once, to copy.'
    },
    {
      type: 'ul',
      items: [
        'Never public: the link opens only for the person it names, signed in as themselves — they do not need to be an administrator. Anyone else signed in gets a refusal, and so does a masquerade session.',
        'They see only the shared window, with the masking it was recorded with — not the rest of the recording, its event rail or any other session. The page says who shared it and when the link expires.',
        'Every open is recorded in the activity log, and so is every refused attempt. The share dialog lists the links made from a recording: who shared it with whom, the window, the expiry and how often it was opened.',
        'Revoke deletes the link at once. A link also stops working when it expires or when its recording is purged by retention — save the range as a clip first if it must outlive the recording.',
        'Only a fingerprint of the link is stored, so the link itself cannot be read back from the database.'
      ]
    },
    { type: 'h2', id: 'session-replay-search', text: 'Search by record or field' },
    {
      type: 'p',
      text: 'As each recording uploads, the server indexes what it touched: the pages visited (with ids replaced by :id), the records opened (collection and id), the names of the fields focused or typed into, and the elements clicked, as selectors. The Search tab on the Session Replays page finds recordings by collection and record id, by field name or by selector, and opens each one at the moment it matched. A record’s Timeline (the History button) links to Replays of this record.'
    },
    {
      type: 'ul',
      items: [
        'Only field names (the data-field a form row carries) are indexed, never what was typed: inputs are masked before they leave the browser, and the index never reads values or page text.',
        'Selectors are built from stable hooks only (data-testid, data-field, data-cbv-* and fixed ids), so the same element matches across recordings.',
        'Indexing runs after the upload has been answered and never slows it down. Recordings uploaded before the index existed are not searchable.',
        'Index rows are deleted with their recording, by retention or by Delete.'
      ]
    },
    {
      type: 'p',
      text: 'Following one record: search by collection and record id, then Play all. Every recording that opened the record plays as one timeline, oldest first, each cut to the time the person was on the record plus a minute either side. The strip above the player names the person and time of each part; under it, Record as they found it links to the revision in effect when they arrived, and Saved here to any revision saved during that part. When a part ends the next one starts, unless you turn that off; click a part in the strip to jump to it.'
    },
    { type: 'h2', id: 'session-replay-inspector', text: 'Inspecting an element' },
    {
      type: 'p',
      text: 'Pause a replay and click anything in it: the inspector outlines the element and shows its selector (with a Copy button), its data-* attributes, and the nearest data-field and data-cbv-* hooks on it or above it. Find in other recordings lists the other recordings in which someone clicked or typed into the same element, from the replay index; Open in Search shows them all with a Watch button that opens each one at that moment. An element with no stable hook on it or above it gets a plain selector such as button, which cannot be searched for. The inspector reads attributes only, never text or what was typed.'
    },
    { type: 'h2', id: 'session-replay-heat', text: 'Heatmaps' },
    {
      type: 'p',
      text: 'The Heat tab shows where people click on a route and how far down they scroll, summed over every recording of that route in a date range. Pick a route on the left; the route is drawn as it was last recorded, with the clicks over it, the most-clicked elements and the share of visits that reached each screen beside it.'
    },
    {
      type: 'ul',
      items: [
        'Heat is aggregate-only. A nightly job (session-replay-heat, 02:05 UTC) folds finished recordings into counts per app, route pattern, day and screen size: click positions as 2% squares of the viewport, the element clicked, and the deepest point of each visit. No person, recording or session is stored with the counts, and nothing in them can be traced back to who clicked.',
        'Routes are patterns (/collections/workflows/:id), never record ids. Element names prefer test hooks, labels and short button text, and leave out text with digits or addresses, so a record’s data does not become an element name.',
        'Each run takes at most 300 recordings (about 250MB stored), oldest first, and marks them folded; a backlog drains over the following nights. Error clips are left out. Run it now from Background Jobs.',
        'The drawing of the route comes from the newest recording that showed it. When that recording has expired with retention, the heat is drawn on a blank viewport instead; the counts themselves are kept for 180 days.',
        'Positions are relative to the viewport, so a phone and a wide monitor put the same button in different places. Pick one screen size to sharpen the map.'
      ]
    },
    { type: 'h2', id: 'session-replay-frustration', text: 'Frustration score and Worst sessions' },
    {
      type: 'p',
      text: 'Every working session gets a frustration score from 0 to 100. A session is one browser tab’s run of admin pages on one day (the page trail’s session). The Worst sessions tab lists the highest scores in a date range with the person, the route they spent most time on, what made the score and a Watch button when a recording overlaps the session. The People page’s Day view shows the day’s worst score beside its summary; it links to that session’s replay when there is one. Unlike heat, a score is about one person, so every read is admin-only.'
    },
    {
      type: 'ul',
      items: [
        'Rage clicks: three or more clicks on one element within 600 ms (real-user monitoring).',
        'Dead clicks: clicks that changed nothing, when the page reports them to real-user monitoring.',
        'Client errors: errors the page reported to the issue log during the session.',
        'Back-and-forth: page A, then B, then A, then B again within two minutes (the same exact pages; browsing a list and different records is not counted).',
        'Slow calls: requests slower than that route’s 95th percentile for the same window (at least 20 calls to judge by) and slower than one second.',
        'Abandoned forms: a new record held at least 10 seconds, or an existing record held at least a minute, and left with no save to that collection or record while it was open. A page whose length is unknown never counts.',
        'Each signal adds its weight, at most ten of a kind, and the score is 100 × (1 − e^(−sum ÷ scale)), so it levels off toward 100. Defaults: rage 6, dead 3, client error 8, back-and-forth 3, slow call 2, abandoned form 5, scale 25 (one client error scores 27). Change them under Weights on the Worst sessions tab; a weight of 0 turns a signal off. They are stored in settings as frustration_weights.',
        'A nightly job (session-frustration, 02:25 UTC) rescores the last two days, so a session that ran past midnight or a late report is picked up. Scores are kept 90 days and are deleted with the person. Run it now from Background Jobs.'
      ]
    },
    { type: 'h2', id: 'session-replay-notes', text: 'Notes on a recording' },
    {
      type: 'p',
      text: 'Under the player, the Notes list pins a remark to a moment of the replay. A note is pinned to the playhead at the moment you start typing it (click the time chip to re-pin it to where the playhead is now), and shows as a violet flag in a row under the event rail. Click a flag or a note’s time to seek to it.'
    },
    {
      type: 'ul',
      items: [
        'Notes are admin-only, like the recordings themselves, and are shown as plain text. Only the author can edit a note; any admin can delete one. Notes go when the recording goes.',
        'Copy a note onto an issue linked to the recording (it lands as a comment on the issue, shown in the issue’s detail) or onto an open investigation notebook from the Traffic Map (appended to its notes). Either way the copy carries a link that opens the recording at that second.',
        'Adding, deleting and copying a note are recorded in the activity log.'
      ]
    },
    { type: 'h2', id: 'session-replay-export', text: 'Exporting a recording' },
    {
      type: 'p',
      text: 'Export (top right of the player) saves a recording outside the admin. Leave From and To empty for the whole recording, or give a window in m:ss.'
    },
    {
      type: 'ul',
      items: [
        'HTML replay: one file with the player and the events inside. It opens offline in any browser and plays like the admin’s player. The events are exactly as stored, so inputs that were masked when recorded stay masked.',
        'WebM video: the server plays the recording in a headless browser and captures it in real time, so a video takes as long to make as the window lasts (at most 30 minutes). When it is ready you get a notification with a link to the file; if it cannot be made, the notification says why. The server needs ffmpeg for this.',
        'A window starts at the last full snapshot before From, because a replay needs the page as it was; playback still begins at From.',
        'Every export is recorded in the activity log. The video is stored as a file owned by you; treat both files like the recording itself, since they show someone’s session.'
      ]
    },
    { type: 'h2', id: 'session-replay-spec', text: 'A Playwright spec from a recording' },
    {
      type: 'p',
      text: 'Export → Playwright spec turns the clicks, typing and page changes in a window of the recording into the E2E recorder’s steps and opens them in the E2E recorder, where you can remove steps, add assertions, type in the values and save the spec into an extension’s tests folder (on a development machine) or download it.'
    },
    {
      type: 'ul',
      items: [
        'Selectors prefer a `data-*` hook on the element (or the nearest one above it), then role and accessible name, then id, label, name, placeholder and a short CSS path.',
        'Typed values were masked when recorded, so they never reach the spec: each one is a placeholder such as `<value for data-field="po_number">`.',
        'A click on an element the recording never captured is left out and counted. Making a spec is recorded in the activity log.'
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
    },
    { type: 'h2', id: 'session-replay-float', text: 'Floating player' },
    {
      type: 'p',
      text: 'Float (beside the speeds) detaches the replay into a small window in a corner of the admin, so it keeps playing while you open the record it is about, a drill-down or anything else — moving between admin pages does not stop it. Drag the window by its title bar; it settles into the nearest corner, and that corner is remembered in this browser. A pinned chat panel moves it over instead of covering it. Closing the window takes you back to Session Replays with the replay open at the moment it had reached; the square button stops it without going anywhere. Opening another replay on the Session Replays page closes the floating one.'
    },
    { type: 'h2', id: 'session-replay-together', text: 'Watching together' },
    {
      type: 'p',
      text: 'Watch together (under the player) starts a shared viewing and copies its link. Every admin who opens the link follows your playhead: when you play, pause, seek, jump a chapter or change speed, their replay does the same, and a small roster shows who is watching (you lead, with a crown). Copy watch link copies it again; Stop ends it, and closing the replay leaves. A follower can still scrub on their own, but your next move brings them back. If you close the replay while others watch, they can carry on, and one of them can take the lead.'
    },
    {
      type: 'ul',
      items: [
        'Only admins can join, and only on a recording that exists for them; a watch link opens that recording and no other.',
        'Discuss posts a link to the current moment — and the shared viewing, when there is one — into one of your chat rooms with an optional note, then opens the room. Copy link in the same menu copies it instead. The link opens Session Replays at that moment (a few seconds before it).',
        'It runs over the admin’s live connection: nothing about the viewing is stored.'
      ]
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
