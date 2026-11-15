import type { DocSection } from '../types.js'

export const collabLiveLists: DocSection = {
  id: 'live-lists',
  label: 'Live Lists',
  content: [
    { type: 'h1', id: 'live-lists', text: 'Live Lists' },
    {
      type: 'p',
      text: 'Collection lists, queues and their calendar, Gantt, map and kanban views keep up with what other people do. The server only says THAT a record changed (its id, the field names and who wrote it, never values); every list then re-reads through its own permission-checked request, so nobody sees a record or value they could not already open.'
    },
    { type: 'h3', id: 'live-lists-what', text: 'What you see' },
    {
      type: 'table',
      head: ['When', 'What happens'],
      rows: [
        [
          'Someone else changes a row on your page',
          'The row briefly highlights (no highlight if you have reduced motion on). Hover it for "Changed by Beth just now".'
        ],
        [
          'A record is created, or edited so that it now matches your filters',
          'It slides in at the top of page 1, marked with a cyan dot. The server decides whether it belongs, as you — a record you cannot see never appears.'
        ],
        [
          'A visible record stops matching your filters, or is deleted',
          'The row is removed and the total drops. Changes on other pages count into the "N updates · Refresh" pill instead.'
        ],
        [
          'Someone is editing a record',
          'A lock icon appears on its row with their name on hover, from the same edit locks as the record page. Only locks on records you can read are shown.'
        ],
        [
          'Queue totals, SLA breaches and at-risk counts',
          'The stat tiles re-count shortly after records move, instead of on the next refresh. Queue rows that changed refresh and flash; the table does not reshuffle while rows are selected or a card is being dragged.'
        ],
        [
          'Kanban cards (queues)',
          'Cards move to their new state column when anyone moves a record or its state changes.'
        ],
        [
          'Saved view pills',
          'Each pill shows how many records match the view right now, counted as you, and re-counts as records change.'
        ],
        [
          'Calendar, Gantt and map views',
          'Records others add, move or reschedule appear in place without a flash.'
        ]
      ]
    },
    { type: 'h3', id: 'live-lists-focus', text: 'Focus mode' },
    {
      type: 'p',
      text: 'The focus button in a list or queue toolbar holds live updates back. While it is on, changes collect and are applied together every 1, 3, 5 or 10 minutes (click the interval to change it); a "12 updates" pill applies them at once, and switching focus mode off applies them immediately. The setting is kept in this browser. Notifications are not part of the list feed and still arrive at once.'
    },
    {
      type: 'h3',
      id: 'live-lists-results',
      text: 'Search results, fixed findings and report figures'
    },
    {
      type: 'p',
      text: 'Three more screens follow other people quietly, without moving anything under your pointer and without toasts or sounds.'
    },
    {
      type: 'table',
      head: ['Screen', 'What happens'],
      rows: [
        [
          'Search results page',
          'A result that someone changes updates in place with a short fade. A result that stops matching goes dim and stays where it is until you refresh. A record that newly matches is only counted: a quiet "2 new matches · Show" pill appears at the top, and Show runs the search again as you. Records you cannot read never appear.'
        ],
        [
          'Data Integrity findings (field checks, orphans, inactive people)',
          'When someone fixes a record, its finding turns calm and green ("Fixed by Beth", or "Fixed by you") and dims a little. It leaves the list the next time the list refreshes. If the record breaks again, the mark goes away.'
        ],
        [
          'Report and query figures',
          'A figure comes from a saved query, which may be cached. When a record the query reads changes after the figure was computed, a small "Data changed since run · Refresh" note appears next to it. Nothing shows when the page does not know what the query reads. Refresh runs it again past the cache. An "Auto-refresh" switch (on a report, or on a page widget) refreshes by itself when the data changes, at most once every 15 seconds per figure; it is off until you turn it on and is remembered in this browser only.'
        ]
      ]
    },
    { type: 'h3', id: 'live-lists-dev', text: 'For developers' },
    {
      type: 'ul',
      items: [
        '`collection:update` now also carries `by` (the writer’s user id) when a person made the change; system writes omit it. Clients still ignore their own writes.',
        '`POST /api/item-locks/:collection/active {ids}` (signed in) returns `[{item, locked_by, locked_by_name, is_mine}]` for the records in `ids` that are locked and that the caller can read through the items service. Collections with locking off, and system tables, return nothing.',
        'A lock taken or released sends a payload-free `$lock` notice on the collection feed (`LIVE_ASPECTS.lock`).',
        '`GET /api/global-search?fresh=1` skips the 20-second per-person answer cache; the live results page uses it for its quiet re-ask (still run as the caller, at most one every few seconds, none while the tab is hidden).',
        'Live results: `useLiveSearchResults` + `LiveNewMatchesPill` (a re-ask only decides for the records an event named, never by working out matching on the client). Fixed findings: `useResolvedFindings` + `FindingFixedMark` — a board passes its findings as `{key, collection, itemId}` and a `recheck(refs)` that returns the keys that no longer have a finding. Query figures: `LiveCacheStamp` / `useLiveStamp` watch the tables in the response `freshness_sources`; no tables, no chip.',
        'In `@nivaro/shared`: `useRowChanges`, `useRowLocks` / `useRowLocksByCollection`, `viewerMatches`, `useLiveQueryRefresh` (query-backed views) and `FocusModeToggle` / `deliverLive` for focus mode. `useLiveCollection(…, { focusable: true })` holds its batches while focus mode is on.'
      ]
    }
  ]
}

export const collabLiveCounts: DocSection = {
  id: 'live-counts',
  label: 'Live Counts & Admin Screens',
  content: [
    { type: 'h1', id: 'live-counts', text: 'Live Counts & Admin Screens' },
    {
      type: 'p',
      text: 'Numbers on a screen (queue totals, saved-view pills, the notification badge, the support desk tabs, the Collections directory) and the admin console screens follow the data without a reload. A live change says only THAT something moved; the number is then read again through its normal request, as you, so permissions always apply.'
    },
    { type: 'h3', id: 'live-counts-what', text: 'What follows live' },
    {
      type: 'table',
      head: ['Screen', 'What updates'],
      rows: [
        [
          'Collections directory (admins)',
          'Record counts and last-change times refresh a few seconds after data is written. The order of rows (Most records, Recently changed) holds still while your pointer is over the page.'
        ],
        [
          'Integrations console',
          'Firefight signals and tab count, Partners and Events refresh when a signal, a partner call, a submission or an obligation is written.'
        ],
        [
          'Queue tiles and saved-view pills',
          'Total, Unowned, At risk and each view pill re-count once the burst of changes settles.'
        ],
        [
          'Notification badge, Support desk tabs, Approvals, import counts',
          'Re-read when a notification, ticket, approval or import run changes.'
        ],
        [
          'Collection browser (lookup tables)',
          'Changes announced by the server appear in place. A quiet safety re-read every two minutes catches writes nothing announces; it never runs while you have rows selected, a field focused or the pointer over the table.'
        ]
      ]
    },
    { type: 'h3', id: 'live-counts-feel', text: 'How it behaves' },
    {
      type: 'ul',
      items: [
        'Nothing pops up: no toast, banner or sound. A changed number cross-fades in the same spot (no movement, no bounce); with reduced motion it just swaps.',
        'A burst of changes is one re-read: counts wait until changes have been quiet for 2 seconds or more, and never longer than 15 seconds into a steady stream. A hidden tab re-reads once when you come back.',
        'Rows never move under your pointer or keyboard focus.'
      ]
    },
    { type: 'h3', id: 'live-counts-dev', text: 'For developers' },
    {
      type: 'ul',
      items: [
        'In `@nivaro/shared`: `createCoalescer(fn, { quietMs, maxWaitMs })`, `useLiveRefresh({ topic, keys })` (one shared re-read per client + key set, 2 s floor) and `<LiveCount value format />`.',
        'New admin-only ops topics for `useLiveOps` / `useLiveRefresh`: `collections` (poked by data writes, coalesced), `integrations` (signal, partner-call, submission and obligation tables) and `access-requests`. Pokes carry no rows, people or values.',
        'Writes that bypass the items service (procedures, scripts, extensions) should call `announceRawWrites(collection)` so lists and counts on that collection update; the safety re-read is only a net.'
      ]
    }
  ]
}
