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
        'Raw SDK commands exist too: sessionRecordingEnabled, startSessionRecording(app), appendSessionRecordingEvents, endSessionRecording.'
      ]
    },
    {
      type: 'note',
      text: 'Journey Trail (page breadcrumbs) covers most debugging needs without recording anything visual — reach for replay when you need the pixels.'
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
        'Share a report with everyone or scope it to a role; clone, export and import as JSON.'
      ]
    },
    { type: 'h2', id: 'report-studio-subs', text: 'Subscriptions & alerts' },
    {
      type: 'ul',
      items: [
        'Subscribe for a daily (07:00) or weekly (Monday) email — the report renders fresh, server-side, as you, into a mail-safe HTML digest with KPIs, bars and tables, plus an in-app notification.',
        'Alerts watch a KPI or table widget: conditions on its value or row count (gt/gte/lt/lte/eq, AND), checked hourly. An alert fires ONCE when crossed and resolves when back in range — the open firing entry is the cooldown, so it never re-spams.',
        'Delivery per alert: in-app, email, or both. Toggle or delete any time; a firing badge shows live status.'
      ]
    }
  ]
}
