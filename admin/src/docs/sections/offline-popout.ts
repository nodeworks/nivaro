import type { DocSection } from '../types.js'

export const collabOfflinePopout: DocSection = {
  id: 'offline-popout',
  label: 'Offline Saves & Pop-out',
  content: [
    { type: 'h1', id: 'offline-popout', text: 'Offline Saves & Pop-out Records' },
    { type: 'h3', id: 'offline-saves', text: 'Saving while the network is down' },
    {
      type: 'p',
      text: 'When you press Save on a record and the request never reaches the server (no connection, or the gateway says the server is unreachable), the change is kept in an outbox on this browser and the record shows "Will save when you are back online". When the connection returns it is sent against the version of the record you were editing. A refusal from the server (a validation error, missing permission) is never queued — it shows as it always does.'
    },
    {
      type: 'table',
      head: ['Situation', 'What happens'],
      rows: [
        [
          'Nobody else changed those fields meanwhile',
          'The change saves on its own and a toast says so. Other tabs showing the record refresh.'
        ],
        [
          'Someone else changed one of the same fields',
          'Nothing is overwritten. The record opens the merge dialog (their value or yours, per field); if the record was closed, a toast offers Review and the dialog opens when you open the record.'
        ],
        [
          'The record form is still open',
          'It sends the whole save again — lines and links included — when the connection returns.'
        ],
        [
          'You sign out',
          'Every pending offline save on the browser is cleared.'
        ],
        [
          'Someone else signs in on the same browser',
          'Every pending offline save that is not theirs is deleted at once — a shared device never keeps your values for the next person, and nobody else ever sees or sends them.'
        ],
        [
          'A save waits more than a week',
          'It is dropped, and you get a one-time note: "an unsaved change from <date> was discarded".'
        ],
        [
          'You are in a "View as" tab',
          'Nothing is queued: a save that cannot reach the server shows the normal error. Leaving View as also clears anything stored under the person being viewed.'
        ]
      ]
    },
    {
      type: 'note',
      text: 'New records are not queued: if the answer to a create was lost the record may already exist, and sending it again would create a second one.'
    },
    { type: 'h3', id: 'popout-records', text: 'Pop out a record' },
    {
      type: 'p',
      text: 'The pop-out button in a record’s header tools opens the record in its own window, without the navigation sidebar, for side-by-side work on two screens. Popping the same record out again brings its window forward. The window is an ordinary signed-in page: nothing secret is put in its address.'
    },
    {
      type: 'ul',
      items: [
        'It stays live like any open record: who else is viewing, other people’s changes, moves, comments and the edit lock.',
        'It stays in step with your main window: a save in either one refreshes the other, and unsaved edits in one are flagged in the other.',
        'The edit lock follows you: closing the record in one window does not leave the other editing unlocked — it takes the lock straight back.',
        'From a "View as" tab, the pop-out opens as the same person being viewed; your own tabs are never mixed with it.'
      ]
    },
    {
      type: 'p',
      text: 'Headless hosts: `openRecordPopout(href, collection, id)` and `isRecordPopout()` from `@nivaro/shared` (the URL gains `?popout=1` so the host can hide its chrome), and `<RecordOutboxHost userId onOpenRecord />` mounted once so offline saves replay from any page. Call `clearRecordOutbox()` on sign-out.'
    }
  ]
}
