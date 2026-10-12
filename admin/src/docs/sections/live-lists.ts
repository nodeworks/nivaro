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
    { type: 'h3', id: 'live-lists-dev', text: 'For developers' },
    {
      type: 'ul',
      items: [
        '`collection:update` now also carries `by` (the writer’s user id) when a person made the change; system writes omit it. Clients still ignore their own writes.',
        '`POST /api/item-locks/:collection/active {ids}` (signed in) returns `[{item, locked_by, locked_by_name, is_mine}]` for the records in `ids` that are locked and that the caller can read through the items service. Collections with locking off, and system tables, return nothing.',
        'A lock taken or released sends a payload-free `$lock` notice on the collection feed (`LIVE_ASPECTS.lock`).',
        'In `@nivaro/shared`: `useRowChanges`, `useRowLocks` / `useRowLocksByCollection`, `viewerMatches`, `useLiveQueryRefresh` (query-backed views) and `FocusModeToggle` / `deliverLive` for focus mode. `useLiveCollection(…, { focusable: true })` holds its batches while focus mode is on.'
      ]
    }
  ]
}
