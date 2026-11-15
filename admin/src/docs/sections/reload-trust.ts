import type { DocSection } from '../types.js'

export const collabReloadTrust: DocSection = {
  id: 'reload-trust',
  label: 'Refresh Without Reloading',
  content: [
    { type: 'h1', id: 'reload-trust', text: 'Refresh Without Reloading' },
    {
      type: 'p',
      text: 'Pages keep themselves current, so you should never need to reload one or leave and come back. When you want to be sure, refresh the data instead of the page: nothing you typed, scrolled to or opened is lost.'
    },
    { type: 'h3', id: 'reload-trust-button', text: 'Refresh this page’s data' },
    {
      type: 'ul',
      items: [
        'Click the ↻ button: beside a record’s header actions, in the admin sidebar footer, or in the portal’s top bar. Or press Cmd-K (Ctrl-K) and choose “Refresh this page’s data”.',
        'Everything the page shows is read again in place. The button spins while it works, then shows a quiet ✓. A small amber dot means some part could not refresh; that part shows its own message.',
        'Unsaved edits stay. A field you changed keeps your value; if someone else changed it too, you get the usual “Take theirs / Keep mine” choice.',
        'Scroll position, open panels, sheets and selections stay as they were.'
      ]
    },
    { type: 'h3', id: 'reload-trust-idle', text: 'Coming back to an old tab' },
    {
      type: 'ul',
      items: [
        'A tab reloads by itself only for a new version of the app (when idle and with nothing unsaved).',
        'A tab that was hidden or asleep longer than the server can replay live changes (24 hours), lost changes while it was away, or was not used for 4 hours refreshes its data when you return — no reload. `IDLE_RESYNC_HOURS` (1–48) changes the 4 hours.'
      ]
    },
    { type: 'h3', id: 'reload-trust-missed', text: 'Missed live updates (administrators)' },
    {
      type: 'p',
      text: 'When someone reloads a record or list anyway, the page checks whether what it showed before the reload was out of date. It compares a short fingerprint of each field, never the value; only record ids and field names reach the server. Realtime → Missed updates shows where updates go missing and why:'
    },
    {
      type: 'table',
      head: ['Why', 'Meaning', 'Fix'],
      rows: [
        [
          'Not delivered',
          'The change was saved through the app (or announced) but the open page never got the event.',
          'Look at Realtime → Socket health for that time.'
        ],
        [
          'Procedure, no announce',
          'A stored procedure or trigger writes the field and never tells open pages. The procedure is named.',
          'Add `EXEC nivaro_announce_writes @Collection, @Ids` after its update.'
        ],
        [
          'Direct write',
          'Nothing logged or announced, and no procedure found that writes the field (a script, an import, a rollup).',
          'Announce from the writer, or run it through the app.'
        ]
      ]
    },
    {
      type: 'p',
      text: 'Reloads where nothing had changed are counted too: people reloading pages that were already right. The daily operations report has “Missed live updates” and “Most reloaded screens”; API analytics shows the most reloaded screens and back-and-forth visits (A → B → back to A) per release.'
    },
    {
      type: 'pre',
      code: `GET /api/realtime/missed-updates?days=7   // admin
GET /api/rum/reloads?days=7               // admin; days 1-14
POST /api/realtime/missed-updates          // signed in; sent by the page after a reload`
    }
  ]
}
