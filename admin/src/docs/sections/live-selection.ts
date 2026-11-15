import type { DocSection } from '../types.js'

export const liveSelectionDocs: DocSection = {
  id: 'live-selection',
  label: 'Live Selections & Time in Step',
  content: [
    { type: 'h1', id: 'live-selection', text: 'Live Selections & Time in Step' },
    {
      type: 'p',
      text: 'When you select rows for a bulk action, the list keeps an eye on them until you act. The bulk bar tells you, in one quiet line, if someone else has those records open or has changed them since you picked them. Everything is worked out as you: only records you can read, only people you are allowed to see, only fields you can read.'
    },
    { type: 'h3', id: 'live-selection-open', text: 'Someone has them open' },
    {
      type: 'p',
      text: '"2 of these are open by Beth right now" (or "being edited by Beth" when she holds the edit lock). Skip those takes them out of your selection; Continue keeps them and stops saying so until someone else opens one. With live updates set to Calm, who-is-here signals are quiet, so only edit locks are mentioned.'
    },
    { type: 'h3', id: 'live-selection-changed', text: 'Changed since you picked them' },
    {
      type: 'p',
      text: 'The list remembers when you picked each row. If someone else edits, moves or deletes one of them afterwards, the bar says "3 selected rows changed since you picked them". Review lists each one — "Beth changed Amount and Status · 2 min ago", "Sam moved it to Finance" — with a link to open it. Continue keeps them and counts them as seen as they are now. In collection lists the check also runs once when you open a bulk form (move, delete, message), so it works with live updates Off too.'
    },
    { type: 'h3', id: 'live-selection-sums', text: 'Selection count and sums' },
    {
      type: 'p',
      text: 'The bulk bar shows how many rows are selected and the sum of the columns the totals row sums (otherwise the money and decimal columns on screen). The figures follow the rows as they change and fade gently from the old number to the new one (no fade with Calm, Off or reduced motion). Rows you selected on another page count with the values the list last showed for them.'
    },
    { type: 'h3', id: 'live-selection-in-step', text: 'In step: time in the current step' },
    {
      type: 'table',
      head: ['Where', 'What it shows'],
      rows: [
        [
          'Collection lists — Columns → Add column → In step',
          '"Finance · 3 d 4 h": the step and how long the record has been in it. Off until you add it. Click the header to sort on the server: shortest first, then longest (records with no open step last).'
        ],
        ['Queue worklists — Customize columns → In step', 'The same column; it sorts like Aging.'],
        ['Record page — pipeline panel header', '"for 3 d 4 h" beside the step chip.']
      ]
    },
    {
      type: 'p',
      text: 'All of them count on one shared page clock (no extra reads while they tick) from the moment the record entered its step — its newest move into that step, else when its pipeline started. When someone moves the record, the step and the time reset as the list or panel picks up the move.'
    }
  ]
}
