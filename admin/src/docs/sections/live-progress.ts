import type { DocSection } from '../types.js'

export const collabLiveProgress: DocSection = {
  id: 'live-progress',
  label: 'Live Progress & Jobs',
  content: [
    { type: 'h1', id: 'live-progress', text: 'Live Progress & Jobs' },
    {
      type: 'p',
      text: 'Long actions you start show their progress where you are, and pages that other people keep open hear about changes that matter to them. Every notice carries ids, counts and field names only — never values — and the page re-reads through its own permission-checked request.'
    },
    { type: 'h3', id: 'live-progress-tray', text: 'The Jobs tray' },
    {
      type: 'p',
      text: 'Bulk runs, backfills, staged imports, background exports and PDFs you started appear in a tray at the bottom of every page: a progress line while they run, then the result with a link to the details or a Download chip for the file. The tray follows you across pages and browser tabs until you dismiss an entry (Clear finished dismisses them all). It is yours alone — nobody else sees what you started, and an administrator’s tray shows their own work; the Jobs console is the place for everyone’s.'
    },
    {
      type: 'table',
      head: ['Action', 'How it gets into the tray'],
      rows: [
        [
          'Bulk write (async)',
          '`POST /items/:collection/bulk?async=1` — a job run with live done/total.'
        ],
        [
          'Staged import',
          'Queued → "3rd in line, about 4 minutes" (moves up as the runs ahead finish) → running with its stage → result.'
        ],
        [
          'Export',
          'Export menu → a preset’s Background button (`POST /export-presets/:id/run-async`). The finished file is a Download chip.'
        ],
        [
          'PDF',
          '`POST /pdf-templates/:id/render-async` — renders as the caller (record and child rows read with their access) and saves the PDF to the file library.'
        ],
        [
          'Slow query or widget',
          '"Run in background" on a custom query, report widget, page widget or dashboard widget that is known to be slow — see below.'
        ],
        [
          'Anything else started with a user',
          'Any job run started with a user and not by the scheduler.'
        ]
      ]
    },
    { type: 'h3', id: 'live-progress-background-runs', text: 'Slow reads in the background' },
    {
      type: 'p',
      text: 'When a custom query, report widget, page widget or dashboard widget has been loading for a few seconds and is known to be slow (its usual run is 4 seconds or more; anything still loading after 8 seconds counts too), the loading area offers "Run in background". The server then runs the same request as you, on its background connection pool, so your permissions and User Scopes apply exactly as they would on the page, and a cached query or widget stores the result under its usual key. The page shows how long it has been running against how long it usually takes; you can leave, and the Jobs tray says when it is ready and links back. Back on the page, the result appears without asking again. Anyone can use it, not only administrators; each person may have 3 runs going at once, and asking the same question twice joins the first run.'
    },
    {
      type: 'pre',
      code: `GET  /api/background-runs/estimate?method=POST&url=/custom-queries/:slug/execute
POST /api/background-runs   {method, url, body?, label?, href?}  → 202 {data: run}
GET  /api/background-runs/:id          → your run (another person's id is 404)
GET  /api/background-runs/:id/result   → the response, kept 30 minutes`
    },
    { type: 'h3', id: 'live-progress-import-queue', text: 'Import queue position' },
    {
      type: 'p',
      text: 'A queued staged import waits for the running import of its lock group (its staging table) and for the runs queued before it. The estimate adds each run ahead’s typical time — the median of that definition’s last 10 completed runs; a running one counts what is left. `GET /staged-imports/queue` returns it (administrators see all queued runs, anyone else the ones they queued); the Import Console shows it in the Status column and the live banner.'
    },
    { type: 'h3', id: 'live-progress-import-banner', text: 'Import in progress on a record' },
    {
      type: 'p',
      text: 'While a staged import writes a record through the items service, its change events carry `source: "import"`. A form open on that record shows "An import is updating this record" and refreshes the changed fields; the notice lapses 8 seconds after the last import write. Imports that run a stored procedure write outside the items service and are announced when they finish instead.'
    },
    { type: 'h3', id: 'live-progress-bulk', text: 'Bulk action progress on rows' },
    {
      type: 'p',
      text: 'The bulk bar, registry bulk actions and queue bulk actions send `?progress=<id>`; each selected row shows a spinner while the run is on it, then a tick, a dash (already there) or the reason it was refused — in the list and in queues — instead of one toast at the end. The events go only to the person who ran the action.'
    },
    { type: 'h3', id: 'live-progress-tenant', text: 'Announcements, flags and form changes' },
    {
      type: 'ul',
      items: [
        '**Announcements** — a banner or broadcast that goes live, is edited, ends or is deleted reaches open tabs at once (`announcements:changed`); the viewer’s audience rules are still applied when the tab re-reads `/announcements/active`. The 1-minute poll remains the fallback while the socket is down (and catches a window that simply elapsed).',
        '**Feature flags** — toggling a flag sends `flags:changed`; open tabs re-read `/feature-flags/mine` immediately, so a flag turned off for a misbehaving feature takes effect within seconds.',
        '**Form definitions** — editing a layout, field, field rule or pipeline sends `config:update` (naming the collection when the edit does). An open record form on that collection says "This form was changed. Reload to see the new version"; what was typed is kept by the draft store and offered back after the reload.',
        '**Stored roll-ups** — recalculating a stored roll-up announces the parent record’s changed field, so open forms, lists and queues refresh the figure.'
      ]
    },
    { type: 'h3', id: 'live-progress-flow-step', text: 'The "Tell open pages" flow step' },
    {
      type: 'p',
      text: 'A flow step (`refresh-pages`) that announces records changed — collection, ids, changed field names — after the flow wrote them raw or through a partner. It uses the same broadcast as items-service writes (coalesced; over 100 ids become one "some records changed" event). Options: `collection`, `items` (comma list or `{{ids}}`; blank = some records changed), `changed_fields`, `action`. System collections are refused.'
    },
    {
      type: 'note',
      text: 'Hosts that mount the shared components wire the socket in with `relayLiveEvent(event, payload)` for `job:progress`, `bulk:rows`, `announcements:changed` and `flags:changed` (admin does this in `lib/socket.ts`) and mount `<JobsTray />` once inside a client + navigation provider.'
    }
  ]
}
