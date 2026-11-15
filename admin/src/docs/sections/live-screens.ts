import type { DocSection } from '../types.js'

export const liveScreensDocs: DocSection = {
  id: 'live-screens',
  label: 'Live Screens',
  content: [
    { type: 'h1', id: 'live-screens', text: 'Screens that stay current' },
    {
      type: 'p',
      text: 'Dashboards, approval lists, exports, notifications and budget figures update on their own when someone else saves, an import lands or a record moves on. You never need to reload the page or go away and back. Changes land quietly: no pop-ups, no sounds, nothing jumps.'
    },
    { type: 'h3', id: 'live-screens-rules', text: 'What you will notice' },
    {
      type: 'ul',
      items: [
        'A figure that changed fades in where it is. With reduced motion turned on in your system settings, it simply changes.',
        'Hover over (or tab into) a dashboard tile to see when it was last updated, for example "Updated 10 s ago".',
        'Nothing moves under your pointer or keyboard. While your pointer or focus is in a list, rows keep their order; new rows are added at the end.',
        'A row someone else dealt with stays where it was, greyed, saying what happened ("Approved by Beth Smith"). It leaves the next time you click or type somewhere else — never while your pointer is on it or its confirm is open.',
        'On the notifications page, new notifications slide in at the top when you are at the top. When you have scrolled down, a small "3 new" button waits instead; press it to go to the top and see them.',
        'A value you are typing is never replaced. Grids and editors keep your unsaved edits; the saved value from someone else shows once you are done.',
        'The dashboard keeps its layout while it updates. A section never folds away (or opens up) under you because its figures changed.',
        'The support desk (My requests and Desk) shows new requests, replies, claims and status changes in place, and an open request shows new replies without touching the reply you are writing. A request someone else picked up stays in the list, greyed, until you move on.',
        'A count on a dashboard tile shows how far it moved, quietly beside the number: "+3 since this morning", or, when nothing moved today, "−2 since yesterday". It compares with the first number this browser saw today (and the last number it saw the day before), so it appears on whole-number tiles only and starts from your first visit.',
        'A project’s Activity stream (Project 360) lists every change on the project and its workflows, requests, invoices and purchase orders, newest first, as sentences you can open. You only ever see changes to records you can open yourself. Pick a type to narrow it. New changes slide in at the top while you are at the top; scroll down and a "3 new" button waits instead. "Show earlier" loads older changes.',
        'In the pipeline editor, every step shows how many records are in it right now and how long the longest-waiting one has been there ("7 records · oldest 12 d"). The numbers follow moves as they happen; click one to open the list of exactly those records.',
        'Calendars, the workflow timeline and the Jobs pages (Runs & schedules, Timeline, Calendar, Repair tasks) follow the data the same way: an entry another person moves, or a run that starts or finishes, shows up in place once things settle, and entries keep their place while your pointer is on them.'
      ]
    },
    { type: 'h3', id: 'live-screens-cost', text: 'How it stays light' },
    {
      type: 'ul',
      items: [
        'The server only says that something changed (which records and which field names), never the values. Each screen reads the new figures through its normal route, as you, with your permissions.',
        'Bursts are folded together: a 500-row import refreshes a screen once, not 500 times. Each figure refreshes at most every 10 to 60 seconds, and open screens are spread over a few seconds so they do not all ask at once.',
        'Figures the server keeps in a cache (budget pages) wait a few seconds after the change, until the cache is cleared, before they read again.',
        'When the live connection is down, screens fall back to their old timed refresh until it is back.'
      ]
    },
    { type: 'h3', id: 'live-screens-build', text: 'For developers' },
    {
      type: 'p',
      text: 'Hosts built on `@nivaro/react` get the same behaviour from a few pieces. A query says what it reads with `meta: liveQueryMeta({ reads, minGapMs, jitterMs, delayMs })`; the live-query bridge refetches it.'
    },
    {
      type: 'table',
      head: ['Piece', 'What it does'],
      rows: [
        [
          '`useSettledRows(rows, keyOf, { held, resetKey })`',
          'A list that never moves under the pointer or focus. Rows that left stay as `departed` until the next interaction away from them; `held` keys never leave; `release(keys)` lets the person’s own decision go at once; `resetKey` is the person’s own filter or sort.'
        ],
        [
          '`useTopInserts(rows, keyOf)` + `slideIn`',
          'A newest-first feed: new rows slide in only while scrolled to the top, otherwise `held` counts them for a "N new" pill and `reveal()` shows them.'
        ],
        [
          '`useLiveFade(armKey)`',
          'Returns a ref. Text that changed around a background refresh (pass its time as `armKey`) fades in; inputs, `data-live-nofade` areas and the focused element never do.'
        ],
        ['`useUpdatedAgo(at, active)`', '"Updated 10 s ago", ticking only while shown.'],
        [
          '`useLiveCalendar({ collection, keys, items, keyOf, resetKey, updatedAt })`',
          'A month or week grid over a collection: one quiet re-read per burst of other people’s writes, entries that left stay greyed until the person moves on, changed entries fade in. Put the returned `ref` on the grid.'
        ],
        [
          '`useLiveJobs({ keys, onProgress })`',
          'Run lists and run timelines: joins the admin `jobs` room and re-reads `keys` once per quiet window after a run starts or finishes. Progress reports go to `onProgress` and never refetch.'
        ],
        [
          '`useBackgroundArm(dataUpdatedAt, viewKey)`',
          'The `armKey` for `useLiveFade`: 0 on a view’s first answer, the refresh time after it. A month, filter or window change never fades.'
        ],
        [
          '`PageRenderer liveReads={[…]}`',
          'A page-builder page whose query and widget figures follow those collections.'
        ],
        [
          '`useChangeChip(storeKey, value)`',
          'The "+3 since this morning" chip for a whole-number figure. Baseline kept in localStorage per person and figure (`<user id>:<figure key>`); pass `null` while loading. No read of its own.'
        ],
        [
          '`<RecordActivityStream sources records typeLabels />`',
          'The live activity stream over related records. `sources` are `{ collection, filter }` ("the workflows of project 12"), resolved as the viewer by `POST /api/activity/feed` (body `{ sources, records, collections, before, limit }`; answer `{ data, next, types }`). A scoped API key or connected app gets 403.'
        ],
        [
          '`useStateCensus(templateId, collections)`',
          'Records per pipeline step with the longest wait (`GET /api/pipelines/:id/instance-distribution`, administrators), live on the bound collections’ moves.'
        ]
      ]
    }
  ]
}
