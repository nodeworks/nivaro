import type { DocSection } from '../types.js'

export const collabWatchList: DocSection = {
  id: 'watch-list',
  label: 'Watch List',
  content: [
    { type: 'h1', id: 'watch-list', text: 'Watch List' },
    {
      type: 'p',
      text: 'The watch list keeps the records you care about in view on every page, a little like a stock watch list. Each row stays current on its own: you never reload a page to see where a record stands.'
    },
    { type: 'h3', id: 'watch-list-pin', text: 'Pin a record' },
    {
      type: 'ul',
      items: [
        'Click the pin beside a record’s title (on the record page or in the record sheet).',
        'Or choose “Add to watch list” from a list row’s ⋯ menu or its right-click menu.',
        'Or press W while a record is open. Press W again to unpin it.',
        'You can pin up to 50 records. Unpin from the row’s × (hover the row), from the pin again, or from the row menu.'
      ]
    },
    { type: 'h3', id: 'watch-list-rows', text: 'What a row shows' },
    {
      type: 'ul',
      items: [
        'The record’s name and its main figure (an amount, when the record has one).',
        'Its current step, how long it has been there, and a thin line comparing that with the usual time records spend on that step (amber once it has been there longer than usual). Hover it for the words.',
        'Who owns the current step.',
        'What changed last, who did it and when, for example “Moved to Approved · Beth Lee · 2 m”.',
        'A countdown when the step has a deadline, turning amber and red at the deadline’s own lines.',
        'Hover a row for its card (step, owners, key amounts). Click it to look at the record in the side sheet; Cmd / Ctrl-click opens it in a new tab.'
      ]
    },
    {
      type: 'p',
      text: 'When someone else changes a pinned record, its row gets a soft tint and a small dot until you look at it: open it, or use “Mark all as seen” (the double tick). Your own changes never light a row. A record you can no longer open shows as “No longer available” with a Remove button, and nothing else about it.'
    },
    { type: 'h3', id: 'watch-list-dock', text: 'Open, minimized or closed' },
    {
      type: 'ul',
      items: [
        'Open: a column at the right edge of the page. It takes its own space and never covers the page. Drag its left edge to make it wider or narrower (or focus the edge and use the arrow keys).',
        'Minimized (the – button): a slim strip showing how many records you pin and how many changed. Click it to open the list again.',
        'Closed (the × button): only the binoculars icon stays, in the sidebar (admin) or the top bar. A small dot on it means a pinned record changed, or a mention is waiting, while the list was closed.',
        'Shift W opens or closes the list from anywhere.',
        'On narrow windows and phones the list never takes a column: the binoculars icon opens it as a panel over the page.',
        'Whether it is open, its width, the tab and the sort are remembered for you on every device.'
      ]
    },
    { type: 'h3', id: 'watch-list-sort', text: 'Order' },
    {
      type: 'p',
      text: '“My order” keeps the order you choose: drag a row by the grip on its left edge. “Last change” puts the most recently changed records first; “Due soonest” puts the nearest deadlines first.'
    },
    { type: 'h3', id: 'watch-list-waiting', text: 'Waiting on others' },
    {
      type: 'p',
      text: 'The Waiting tab lists records you raised that are sitting on a step someone else owns: who it is with and how long it has waited, longest first. “Raised” means you created the record (in the last 180 days), or the record’s “created by” field names you. It updates on its own as records move.'
    },
    { type: 'h3', id: 'watch-list-mentions', text: 'Mentions & replies' },
    {
      type: 'ul',
      items: [
        'Mentions: every time someone @mentioned you in the last 30 days. These are your mention notifications, so reading one here also marks it read in the bell, and the other way round.',
        'Replies: comments other people left after your own last comment on the same record (or the same field’s thread).',
        'Click one to look at the record and mark it read. “Mark all read” clears the tab.'
      ]
    },
    {
      type: 'note',
      text: 'Everything in the list is read as you: only records, fields and comments you may see. Nothing in it polls; it follows the records over the live connection and refreshes at most once a second, however many changes arrive.'
    }
  ]
}
