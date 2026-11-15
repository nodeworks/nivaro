import type { DocSection } from '../types.js'

export const liveRecordMovesDocs: DocSection = {
  id: 'live-record-moves',
  label: 'Records That Move While Open',
  content: [
    { type: 'h1', id: 'live-record-moves', text: 'Records That Move While Open' },
    {
      type: 'p',
      text: 'A record you have open keeps up when someone moves it, sends it back or changes its lines and files. Nothing reloads under you and nothing you are typing is replaced. With live updates set to Calm or Off (Profile → Display) the movement below is left out; the information is not.'
    },
    {
      type: 'h3',
      id: 'live-record-moves-resubmission',
      text: 'What changed since you sent it back'
    },
    {
      type: 'p',
      text: 'When a record that was sent back comes back to the same step, the top of the record says what changed in between: fields with their old and new values, lines added, changed or removed, and files added, removed or replaced — each with who and when. The same list shows in the approve dialog, above what changed since the record entered the step. You only see fields, lines and files you are allowed to read; a removed line hidden from you by a row rule is counted but not named. If nothing changed, it says so.'
    },
    { type: 'h3', id: 'live-record-moves-track', text: 'The progress track follows a move' },
    {
      type: 'p',
      text: 'When someone else moves the record, the progress track draws the hop from the old step to the new one (right to left for a send back) instead of jumping. It takes under a second. Your own moves, Calm and Off, and your device’s reduced-motion setting show the new step straight away.'
    },
    { type: 'h3', id: 'live-record-moves-form', text: 'The form changes with the record' },
    {
      type: 'p',
      text: 'A collection can give records a different form depending on their values (Data Model → Layouts → record rules). When a move or a change to one of those values makes another form apply, the page switches to it in place and says "Form updated for <step>". The field at the top of your view stays where it was, and the field you were typing in keeps focus if the new form has it.'
    },
    {
      type: 'p',
      text: 'Unsaved values carry over for fields the new form shows and lets you edit. A value for a field the new form hides, makes read-only or does not have is taken out of your save and kept in a chip — "1 unsaved change not on this form" — where you can copy it, put it back if a later form lets you edit that field again, or let it go. A form opened by its link name (?layout=) never switches.'
    },
    { type: 'h3', id: 'live-record-moves-files', text: 'A newer version of a file' },
    {
      type: 'p',
      text: 'If a file you are previewing is replaced or renamed on the record while it is open, the preview says "A newer version of this file exists" (or "Renamed to …") with Show newer. The preview never swaps by itself. A file removed from the record says so.'
    },
    { type: 'h3', id: 'live-record-moves-lines', text: 'Line counts on folded sections' },
    {
      type: 'p',
      text: 'A folded section that holds lines shows how many it has next to its name. When someone adds or removes a line while it is folded, it reads "12 → 13" for a few seconds and then settles on the new count.'
    }
  ]
}
