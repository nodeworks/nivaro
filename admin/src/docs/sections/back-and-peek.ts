import type { DocSection } from '../types.js'

export const collabBackAndPeek: DocSection = {
  id: 'back-and-peek',
  label: 'Back to the List & Peek',
  content: [
    { type: 'h1', id: 'back-and-peek', text: 'Back to the List & Peek' },
    {
      type: 'p',
      text: 'Going from a list to a record and back should never cost you your place, and looking at a record should not mean leaving the page you are on.'
    },
    { type: 'h3', id: 'back-and-peek-back', text: 'Back to the list keeps your place' },
    {
      type: 'ul',
      items: [
        'Back (the browser button, the record’s back arrow or a breadcrumb) shows the list exactly as you left it: same filters, sort, page and scroll, straight away from what was already on screen.',
        'While you were on the record, the list kept listening for changes. If nothing changed, nothing is read again. If a few rows changed, only those rows are re-read, as you, and fade briefly. If it cannot be sure (the connection dropped and could not catch up, a bulk change, a long time away), it reads the page once while the old rows stay on screen.',
        'The row you came back to gets a short, quiet highlight so your eye lands on it.',
        'Collection lists and worklists both work this way.'
      ]
    },
    { type: 'h3', id: 'back-and-peek-next', text: 'Previous / Next in list' },
    {
      type: 'p',
      text: 'A record opened from a list or worklist shows “3 of 25” with up and down arrows in its header. They step through the records the list showed, in its order, without going back to it. Back still returns to the list, which then marks the record you ended on. Cmd / Ctrl-click an arrow to open that record in a new tab.'
    },
    { type: 'h3', id: 'back-and-peek-peek', text: 'Peek from anywhere' },
    {
      type: 'table',
      head: ['Where', 'A click on a record'],
      rows: [
        [
          'My Work, home page worklists and tiles',
          'Opens the record in a side sheet. ↑ / ↓ move through the same list.'
        ],
        [
          'Notification bell and Notifications page',
          'A notification about a record opens it in the side sheet (and marks it read). One that points into the record (a comment, a tab) still opens the full page. The row’s Open record button always goes to the full page.'
        ],
        ['Search results page', 'Opens the record in the side sheet; ↑ / ↓ walk the results.'],
        ['Cmd-K', 'Enter goes to the record as before; Alt+Enter peeks at it in the side sheet.'],
        [
          'A record link inside a comment',
          'Opens the linked record in the side sheet, so the thread stays where it is.'
        ]
      ]
    },
    {
      type: 'ul',
      items: [
        'The sheet is the same one lists and queues use: the record’s own form, updating live, with Open record to go to the full page.',
        'Esc closes it. ↑ / ↓ only move when the cursor is not in a field or menu.',
        'Cmd / Ctrl / Shift or middle click always opens the record in a new browser tab instead.'
      ]
    }
  ]
}
