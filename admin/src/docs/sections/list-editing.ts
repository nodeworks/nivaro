import type { DocSection } from '../types.js'

/** #3224 Edit in the list + #3233 Share this list. */
export const listEditing: DocSection = {
  id: 'list-editing',
  label: 'Edit in the List & Share a List',
  audience: 'all',
  content: [
    { type: 'h1', id: 'list-editing', text: 'Edit in the List & Share a List' },
    {
      type: 'p',
      text: 'Two list tools that work the same on a collection list and on a queue worklist: change a value straight in a row without opening the record, and copy a link that opens the list exactly as you see it.'
    },

    { type: 'h2', id: 'list-editing-edit', text: 'Edit in the list' },
    {
      type: 'p',
      text: 'On a list where an administrator turned it on, the columns they chose show a pencil when you point at a cell. Click the cell (or focus it and press Enter or F2), change the value, then press Enter to save or Tab to save and move to the next editable column in the row. Escape cancels. Clicking somewhere else keeps what you typed.'
    },
    {
      type: 'table',
      head: ['Field', 'Editor'],
      rows: [
        ['Text', 'A one-line box (long text: a small box, Shift+Enter for a new line)'],
        ['Number / whole number', 'A box that accepts 1,200 or $1,234.50; a wrong entry says why'],
        ['Date / date & time', 'The browser date picker, in your own time zone'],
        ['Yes / no', 'A short list: Yes, No, Clear'],
        ['Choice', 'A searchable list of the field’s choices'],
        [
          'Link to another record',
          'The same record picker as the form: it leaves out records hidden from pickers and applies the target’s picker filter'
        ]
      ]
    },
    {
      type: 'p',
      text: 'Calculated, read-only and system fields, files, and fields that hold several records are never editable in a row — open the record for those.'
    },
    { type: 'h3', id: 'list-editing-rules', text: 'The record’s rules still decide' },
    {
      type: 'p',
      text: 'A change in a row is saved exactly like a change on the form: one `PATCH /items/:collection/:id` through the items service. Your field rights, User Scopes and row filters, validation rules, edit locks, hooks, activity history and revisions all apply. The new value shows at once; when the server refuses it, the old value comes back and the cell says why in the server’s own words (for example "Kim is editing this record"). A row someone else is editing offers no editor.'
    },
    {
      type: 'note',
      text: 'Other people looking at the list see the change the way they see any other edit — through the list’s normal live refresh.'
    },

    { type: 'h3', id: 'list-editing-setup', text: 'Turning it on (administrators)' },
    {
      type: 'ul',
      items: [
        'Collection lists: Data Model → the collection → Settings → Collection Browser → Edit in the list. Switch it on and tick the columns people may change. Stored as `browser_config.inline_edit` = `{enabled, fields}` (also settable with `PATCH /collections/:collection`).',
        'Queues: Queues → the queue → Settings → Edit in the queue. The columns offered are the queue’s own extra fields on its source collections (not dotted paths through a relation). Stored as `display_config.inline_edit`; only administrators can change it — a queue owner’s save keeps what is stored.',
        'Off by default everywhere. Switching it on ticks every eligible column; untick the ones that should stay form-only.'
      ]
    },

    { type: 'h2', id: 'list-editing-share', text: 'Share this list' },
    {
      type: 'p',
      text: 'The link button on a list or queue toolbar copies a link to the view as you see it: search, filter chips, quick filters, column filters, sort, visible columns (with their labels, widths and pins), grouping, page size and page. On a queue it also carries the tab (Mine / Unowned / All), the view (table, board, workload) and grouping. A toast says "Link copied".'
    },
    {
      type: 'p',
      text: 'Opening the link restores that view in place of your default view. It is only the view’s settings: whoever opens it reads the list with their own access, so they see only the records and columns they could already see. Once applied, the link’s `lv` parameter leaves the address bar, so a reload goes back to your own defaults.'
    },
    {
      type: 'note',
      text: 'A very large view (dozens of filters) may be too long for a link — the button says so. Save it as a shared view instead.'
    }
  ]
}
