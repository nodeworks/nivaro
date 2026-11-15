import type { DocSection } from '../types.js'

export const pickerBadgesDocs: DocSection = {
  id: 'picker-badges',
  label: 'Picker Badges & Editing Lists Together',
  content: [
    { type: 'h1', id: 'picker-badges', text: 'Picker Badges & Editing Lists Together' },
    { type: 'h3', id: 'picker-badges-what', text: 'Status badges in pickers' },
    {
      type: 'p',
      text: 'A dropdown that offers records — and a field or chip that already holds one — can show short marks beside a record: On hold, Closed, Over budget, Inactive, Hidden from pickers. They help people avoid picking a closed project or an inactive vendor by mistake. Each person sees only marks worked out from what they may read: a mark that depends on a field they cannot see is left out, and records they cannot open say nothing.'
    },
    {
      type: 'table',
      head: ['Setting', 'What shows'],
      rows: [
        [
          'Automatic (default)',
          'Closed for a record in a final pipeline step; On hold for a step named hold, paused or suspended; Inactive (or Archived) from a yes/no field such as is_active or archived; Over budget from a yes/no field named over_budget; Hidden from pickers on a value already picked that an admin has hidden.'
        ],
        [
          'Custom',
          'Your own marks: badge text, a colour, and when it shows — a pipeline step, a final step, a yes/no field, a field equal to / more than a value, one field more than another (spent more than budget), or hidden from pickers.'
        ],
        ['Off', 'No marks for this collection.']
      ]
    },
    {
      type: 'p',
      text: 'Set it per collection in Data Model → the collection → Settings → Status badges in pickers. At most two marks show on one record. Marks on a picked value follow changes live; an open dropdown never shifts under you — its marks are read again the next time it opens.'
    },
    { type: 'h3', id: 'picker-badges-lists', text: 'Editing a list with other people' },
    {
      type: 'p',
      text: 'When editing in the list is turned on (Data Model → the collection → Settings → Collection Browser → Edit in the list, or a queue’s own setting; off by default), several people can edit the same list at once. While you edit a cell, everyone else sees your name on that cell and cannot open it until you finish. If you leave without finishing, the cell frees itself within 30 seconds.'
    },
    {
      type: 'p',
      text: 'When you save a cell, its value is checked first. If someone else changed it after you started editing, the cell asks instead of overwriting: "Beth Lee changed this to “42” at 10:42 AM · Keep mine · Take theirs". Keep mine saves your value; Take theirs keeps theirs and shows it. Rows still update live as others save.'
    },
    {
      type: 'note',
      text: 'The cell mark is a courtesy, not a lock on the data: it never refuses a save made from a record form or an integration. The record lock, field rights and the check above protect the data.'
    }
  ]
}
