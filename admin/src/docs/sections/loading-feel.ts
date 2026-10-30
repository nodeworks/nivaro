import type { DocSection } from '../types'

/**
 * #3229 shape-matched skeletons · #3230 prefetch on hover · #3231 "taking a while" with a
 * reason. Not wired into index.ts here — the docs owner adds it to a nav group.
 */
export const loadingFeelDocs: DocSection = {
  id: 'loading-feel',
  label: 'Loading, Prefetch & Slow Reads',
  audience: 'all',
  content: [
    { type: 'h1', id: 'loading-feel', text: 'Loading, Prefetch & Slow Reads' },
    {
      type: 'p',
      text: 'Three things make pages feel faster and more honest: loading placeholders that take the shape of what is coming, links that start loading before you click, and slow pages that say what they are waiting on.'
    },
    { type: 'h2', id: 'loading-feel-skeletons', text: 'Placeholders that match the page' },
    {
      type: 'p',
      text: 'While a list loads, its placeholder rows have the list’s own columns at the real row height — dates are date-wide, numbers sit on the right, status columns show a pill. A record page whose form is already known paints that form’s tabs, section titles and field grid while the record itself loads. My Work shows its four tiles and your sections in your saved order; dashboard widgets show a figure or rows depending on the widget. Nothing moves when the data arrives.'
    },
    {
      type: 'note',
      text: 'Placeholders do not pulse when your system asks for reduced motion, and use the neutral skeleton colour in dark mode.'
    },
    { type: 'h2', id: 'loading-feel-prefetch', text: 'Prefetch on hover' },
    {
      type: 'p',
      text: 'Resting the pointer on a link or row for a moment (about 80 ms), or moving keyboard focus to it, starts loading what it opens: a record link loads the record and the form it opens with; a list link loads the list’s settings and columns; any link loads the screen’s code. Clicking then opens at once. Moving away before clicking cancels what has not been picked up.'
    },
    {
      type: 'ul',
      items: [
        'Works on record rows in lists and queues, Recently viewed, My Work, sidebar links and search results.',
        'At most two prefetches run at a time, and a tab makes at most 30 a minute — sweeping the mouse down a table never floods the server.',
        'Nothing is prefetched when the browser asks to save data or the connection is very slow (2G).',
        'Only reads are prefetched, never saves. Heavy reads — queues, custom queries, dashboard widgets — are never prefetched; they load when you open them.',
        'A list’s rows depend on your saved view, sort and filters, so only its settings are fetched ahead.'
      ]
    },
    { type: 'h2', id: 'loading-feel-slow', text: '“This is taking a while” — and why' },
    {
      type: 'p',
      text: 'When a list, record, query result, report or dashboard widget is still loading after about 3 seconds, it says what it is waiting on, in plain words, with how long it has been:'
    },
    {
      type: 'table',
      head: ['You see', 'What it means'],
      rows: [
        [
          'Waiting for a free slot — busy right now (2 ahead of you)',
          'The server limits how many heavy reads run at once so it stays responsive; yours is queued.'
        ],
        [
          'Running PUB health — not cached yet',
          'The query has no saved answer yet and is running now.'
        ],
        [
          'Someone else is running Spend too — sharing their answer',
          'Another person asked for exactly the same thing; you will get the same answer.'
        ],
        ['Waiting for Fusion', 'The server is waiting on a partner system.'],
        [
          'Reading 48,000 invoices',
          'The database is reading the rows. The count is one you have already been shown.'
        ],
        ['Checking your sign-in', 'Your session is being confirmed.']
      ]
    },
    {
      type: 'p',
      text: 'Reads that can finish on the server also offer Run in background: you can leave the page and the Jobs tray tells you when it is ready.'
    },
    { type: 'h3', text: 'For developers' },
    {
      type: 'p',
      text: '`GET /api/background-runs/waiting?method=GET&url=/items/invoices` answers what the caller’s own unfinished read to that path is waiting on: `{found, kind, subject, position, of, age_ms, statement_ms, rows_so_far, collection, table_rows}`. `kind` is `slot`, `external`, `query`, `widget`, `database`, `auth` or `working`. Only the caller’s own requests are matched; answers carry kinds, a query or widget slug, a partner name and counts — never SQL or values. `table_rows` (the table’s approximate size) is for administrators only. Nothing extra rides on normal responses: only slow paths (a read-gate queue, an uncached query or widget, an external call) note a wait. With several API replicas, replicas publish their slow requests only while someone is asking (a 2 s beat), so the first answer after a quiet spell may come from this replica alone. Off in cloud mode.'
    },
    {
      type: 'pre',
      code: "import { SlowNotice, FormSkeleton, ListSkeleton, CardSkeleton, usePrefetchIntent } from '@nivaro/react'\n\n<SlowNotice pending={isFetching} request={{ method: 'GET', url: '/items/invoices' }} noun='invoices' />\n\nconst intent = usePrefetchIntent()\n<button {...intent.record('projects', 42)} onClick={open}>Open</button>"
    }
  ]
}
