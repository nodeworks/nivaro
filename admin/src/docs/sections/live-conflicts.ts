import type { DocSection } from '../types.js'

export const collabLiveConflicts: DocSection = {
  id: 'live-conflicts',
  label: 'Working on the same record',
  content: [
    { type: 'h1', id: 'live-conflicts', text: 'Working on the same record' },
    {
      type: 'p',
      text: 'When someone else saves a record you have open, their changes land in your form without a reload. What you see depends on whether you were changing the same field.'
    },
    { type: 'h3', id: 'live-conflicts-quiet', text: 'Fields you have not touched' },
    {
      type: 'p',
      text: 'The field takes their saved value quietly: a short fade on the field and a small dot beside its label. Point at the dot (or tab to it) to read who changed it, when, and what it was before — for example “Beth changed this 2m ago: Draft → Approved”. Click the dot to clear it.'
    },
    { type: 'h3', id: 'live-conflicts-yours', text: 'Fields you are changing' },
    {
      type: 'p',
      text: 'Your value stays. One line under the field says what the other person saved, with three choices:'
    },
    {
      type: 'ul',
      items: [
        '**Keep mine** — your value wins when you save. You are not asked about this field again.',
        '**Take theirs** — your change to this field is dropped and their value stays.',
        '**Merge** — only for fields that can be combined (below). Opens under the field; nothing changes until you press **Use merged**.'
      ]
    },
    {
      type: 'table',
      head: ['Field', 'How Merge works'],
      rows: [
        [
          'Long text (text area, markdown, code)',
          'Line by line. Lines only one of you changed are taken from that person; lines you both changed show both versions and you pick Yours, Theirs or Both. The result stays editable before you use it.'
        ],
        ['Rich text', 'Paragraph by paragraph, the same way.'],
        [
          'Tags and multi-select',
          'Everything either of you added is kept. Anything one of you removed is shown crossed out — click it to keep it after all.'
        ],
        [
          'Numbers, dates, single choices, links, yes/no',
          'No merge — one value has to win: Keep mine or Take theirs.'
        ]
      ]
    },
    {
      type: 'note',
      text: 'Many-to-many pickers (zones, linked records) never conflict: your form saves only the links you added or removed, so the other person’s changes stay.'
    },
    { type: 'h3', id: 'live-conflicts-see-changes', text: 'See changes' },
    {
      type: 'p',
      text: 'Once anyone else has changed the record since you opened it, a **See changes** button appears beside Save. It lists every field others changed — who, when, old → new — and offers Keep mine / Take theirs on any field you are also changing. If you save while a choice is still open, Save asks once, plainly, which value wins.'
    },
    {
      type: 'p',
      text: 'Values shown here come from your own read of the record, so a field you are not allowed to see never appears. A locked field only offers Take theirs.'
    },
    { type: 'h3', id: 'live-conflicts-lines', text: 'Lines: one person per line' },
    {
      type: 'p',
      text: 'An administrator can turn on **Lock lines one at a time** for a collection (Data Model → the collection → Settings, beside Item locking). Then:'
    },
    {
      type: 'ul',
      items: [
        'Editing a record’s own fields locks the record as before; editing a line locks only that line.',
        'Two people can edit different lines of the same record at the same time — even while someone holds the record’s lock.',
        'A line someone else is editing is shaded and read-only for you; point at it to see who. It opens for you as soon as they leave it (or within half a minute if their browser closes).',
        'If someone saved a line after you loaded it, your save stops on that line and offers Theirs / Mine / Merge per field, using the same rules as above.'
      ]
    },
    { type: 'h3', id: 'live-conflicts-cursors', text: 'Cursors in grids' },
    {
      type: 'p',
      text: 'In line grids and plan grids, the cell another person is in has a thin outline in their colour; point at it to see their name. Moving quickly across cells only shows the cell they stop on.'
    }
  ]
}
