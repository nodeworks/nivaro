import type { DocSection } from '../types.js'

export const lineSplitDocs: DocSection = {
  id: 'line-split',
  label: 'Move Lines to a New Record',
  content: [
    { type: 'h1', id: 'line-split', text: 'Move Lines to a New Record' },
    {
      type: 'p',
      text: 'Sometimes part of a request ships now and the rest later, or some lines need a different warehouse. Instead of deleting lines and typing a second request by hand, people tick the lines and move them to a new record. The details are copied, the ticked lines move (they keep their history), and both records say where the lines went.'
    },
    { type: 'h2', id: 'line-split-use', text: 'On a record' },
    {
      type: 'ul',
      items: [
        'In the line grid, press **Select rows**, tick the lines to move, then **Move N to a new …**. A short panel says what will happen; **Move N lines** does it.',
        'The new record gets this record’s details and starts at the first step of its pipeline, like any new record. The ticked lines move onto it; the others stay.',
        'Both records get a note in their Notes thread — “Moved 3 lines to a new record” and “Created from another record — 3 lines moved here” — with a link to the other one. History shows the same.',
        'A message offers **Open the new …**. The record you were on stays open, without the moved lines.',
        'At least one line must stay and one must move. To take every line, use More → Duplicate instead.',
        'Only saved lines can move: save new lines and line changes first.'
      ]
    },
    { type: 'h2', id: 'line-split-who', text: 'Who may do it' },
    {
      type: 'p',
      text: 'The person must be able to change the record and its lines, and to create records of that kind. A record someone else is editing, or one locked while it waits on approvers (or locked for administrators after approval), refuses the move with the reason in plain words. Nothing is changed when any line is refused: the new record and every moved line are put back.'
    },
    { type: 'h2', id: 'line-split-copy', text: 'What is copied' },
    {
      type: 'p',
      text: 'The same fields More → Duplicate copies: what people see and type on the form. Never copied: the id, created/updated stamps, generated ids (they get a new number), calculated values, hidden fields (integration ids and status mirrors), read-only fields, fields marked “do not duplicate”, the pipeline state, and the record’s files. Many-to-many lists (zones, years, people) are copied unless the setting is off.'
    },
    { type: 'h2', id: 'line-split-setup', text: 'Turning it on (administrators)' },
    {
      type: 'p',
      text: '**Data Model → a collection → Settings → Move lines to a new record.** Off by default. Switch it on, pick which line lists can move, and click any detail that should stay behind (a partner’s status, an order number). Optionally pick a “Split from” link field that points back to the original record. The setting is stored as `browser_config.line_split` on the collection: `{enabled, relations: ["<line collection>.<link field>"], skip_fields?, link_field?, copy_links?}`.'
    },
    { type: 'h2', id: 'line-split-api', text: 'API' },
    {
      type: 'p',
      text: '`POST /api/record-split/:collection/:id` with `{relation: "<line collection>.<link field>", line_ids: [...], values?: {...}}` answers `201 {data: {id, readable, moved, relation, field, link_failures}}`. `values` sets details of the new record that differ (only fields the copy itself could carry). Refusals answer a plain `error` and a `code`: `SPLIT_OFF`, `SPLIT_RELATION`, `SPLIT_NO_LINES`, `SPLIT_KEEP_ONE`, `SPLIT_LINE_NOT_ON_RECORD`, `EDIT_LOCKED`, `RECORD_LOCKED`. It is one write: the record is created with `{<lines field>: {move: [ids]}}`, the nested one-to-many shape any create or update can use to move existing rows onto a record.'
    }
  ]
}
