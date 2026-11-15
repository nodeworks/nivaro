import type { DocSection } from '../types.js'

export const liveSavesDocs: DocSection = {
  id: 'live-saves',
  label: 'Big Saves, Totals & Scheduled Changes',
  content: [
    { type: 'h1', id: 'live-saves', text: 'Big Saves, Totals & Scheduled Changes' },
    {
      type: 'p',
      text: 'Three things on a record page say what is happening while it happens, instead of leaving you to guess or reload.'
    },
    { type: 'h3', id: 'live-saves-progress', text: 'Progress on a big save' },
    {
      type: 'p',
      text: 'When you create a record with many lines (20 or more), the save window counts them as they are saved: "Saving 320 of 500 lines…", then "Updating totals…" while the totals are worked out. The count comes over your own live connection and only to you. If the live connection is down the save works exactly the same; the window shows "Saving 500 lines…" with a spinner until it is done.'
    },
    {
      type: 'p',
      text: 'Integrations can ask for the same count: add `?save_progress=<id>` (8–64 letters, digits, `-` or `_`) to a create or update that carries nested child rows, and the signed-in person receives `save:progress { save, done, total, phase, finished? }` on their own socket. Counts only — never values.'
    },
    { type: 'h3', id: 'live-saves-totals', text: '"Updating…" on totals' },
    {
      type: 'p',
      text: 'A total that adds up a record’s lines is recalculated by the server after the lines change. Until the new figure arrives, the old one stays where it is, greyed, with "Updating…" beside it, so it is never mistaken for the final number. When the new figure lands it fades in once. This shows after your own line edits and while someone else’s large save on the same record is running. It never moves the page or touches what you are typing.'
    },
    {
      type: 'note',
      text: 'With Live updates set to Calm the dot does not pulse and the new figure does not fade; with Off, someone else’s save does not show it (your own still does).'
    },
    { type: 'h3', id: 'live-saves-scheduled', text: 'Countdown to a scheduled change' },
    {
      type: 'p',
      text: 'A record with a scheduled change shows it in its header — "Status changes to Closed · in 2 h 14 m" — counting down. Hover it for the full sentence, "Status changes to Closed at 5:00 PM (scheduled by Mark Li)"; click it to see every pending change on the record. The person who scheduled a change, and administrators, can move it to another time or cancel it from there. The header follows any change to the schedule at once, from anyone.'
    },
    {
      type: 'p',
      text: 'You only see changes to fields you can read. Scheduled changes are not yet applied automatically at their time: once the time has passed the header says "due 12 m ago — waiting to be applied" until an administrator applies it from Deadlines → Scheduled changes.'
    },
    {
      type: 'table',
      head: ['Method', 'Path', 'What it does'],
      rows: [
        [
          'GET',
          '/api/scheduled-changes/:collection/:id?status=pending',
          'Pending changes on one record, values cut to the fields you can read, with `created_by_name` and `can_manage`.'
        ],
        [
          'PATCH',
          '/api/scheduled-changes/:id',
          'Move a pending change: `{ scheduled_at }`. Its scheduler (who must still be able to update the record) or an administrator.'
        ]
      ]
    }
  ]
}
