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
    { type: 'h3', id: 'live-saves-scheduled', text: 'Scheduled changes apply themselves' },
    {
      type: 'p',
      text: 'A record with a scheduled change shows it in its header — "Status changes to Closed · Applies at 5:00 PM (in 2 h 14 m)" — counting down. When the time comes the change is applied by itself, within a minute, AS THE PERSON WHO SCHEDULED IT: their permissions, scopes and the record’s locks are checked again at that moment, exactly as if they pressed Save. The header then says "Applied: Status changes to Closed" (or "Failed — <reason>") for a day, and the person who scheduled it gets a notification either way.'
    },
    {
      type: 'ul',
      items: [
        'Nothing is ever applied in part. If the person may no longer change the record, the change is marked failed with the reason and nothing on the record changes.',
        'If someone else changed one of the scheduled fields after it was scheduled, the change fails instead of overwriting their edit ("Status was changed by someone else after this was scheduled").',
        'If someone has the record open for editing, it tries again every minute for up to an hour.',
        'After a change is applied, the person who scheduled it (or an administrator) can Undo it from the record for 24 hours. Undo puts back the values it replaced, and is refused if one of those fields was changed again since.',
        'Click the header chip to see every change: Move… or Cancel a waiting one, Undo an applied one.'
      ]
    },
    {
      type: 'p',
      text: 'Administrators can still apply a change early from Deadlines → Scheduled changes (Execute); it is applied the same way, as the person who scheduled it. A collection can turn automatic applying off (Data Model → the collection → Browser settings → Apply scheduled changes on time); its changes then wait for an administrator. You only see changes to fields you can read.'
    },
    {
      type: 'note',
      text: 'The job that applies them (`scheduled-changes-apply`, every minute) runs on deployed instances only, like every scheduled job; development runs it with Run now on the Jobs page.'
    },
    {
      type: 'table',
      head: ['Method', 'Path', 'What it does'],
      rows: [
        [
          'GET',
          '/api/scheduled-changes/:collection/:id?status=recent',
          'Waiting changes plus the last day of applied / failed / undone ones on one record, values cut to the fields you can read, with `created_by_name`, `can_manage`, `auto_apply`, `can_undo` and `undo_until` (`?status=pending`: waiting only).'
        ],
        [
          'PATCH',
          '/api/scheduled-changes/:id',
          'Move a pending change: `{ scheduled_at }`. Its scheduler (who must still be able to update the record) or an administrator.'
        ],
        [
          'POST',
          '/api/scheduled-changes/:id/undo',
          'Within 24 h of it being applied: put back the values it replaced. Its scheduler or an administrator; 409 when a field moved again since.'
        ]
      ]
    }
  ]
}
