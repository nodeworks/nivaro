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
    },

    {
      type: 'h2',
      id: 'list-editing-quick-filters',
      text: 'Edit the quick filters from the list (administrators)'
    },
    {
      type: 'p',
      text: 'The quick filters — the dropdowns above a list such as Funding Year, Zone and Region — can be changed right on the list. Administrators see **Edit filters** at the end of the bar (or **Add quick filters** beside Save view when the list has none). Everyone else sees no change.'
    },
    {
      type: 'ul',
      items: [
        '**Add filter** lists what the records link to. Pick one (Funding Years), or open one with › to filter by something on it (Workflow › Project › Project Type). The options and the column they show are filled in for you.',
        '**Rename or change** a filter by clicking it: its name on the bar, the field it filters by, the column its options show, their order, and under More options the options source, value column, key and a second field to match.',
        '**Reorder** by dragging the grip, with Alt+Left / Alt+Right on a filter, or with Move left / Move right in its settings.',
        '**Remove** with its ✕. Nothing changes for anyone until you press **Save**; Cancel puts the bar back.'
      ]
    },
    {
      type: 'p',
      text: 'Save writes the same setting as Data Model → the collection → Settings → Collection Browser → Quick filters (`browser_config.quick_filters`, `PATCH /collections/:collection`), and both use one editor — Edit as JSON stays on the Settings page. The bar shows the new filters at once; when the save is refused, the old bar comes back and the editor reopens with your changes and the reason.'
    },
    {
      type: 'note',
      text: 'People’s picks follow a filter’s key. A rename or a move keeps them (including the YOUR DEFAULT picks from Profile → Default filters); removing a filter, or pointing it at another field, clears its picks. A list whose page passes its own quick filters cannot be edited this way.'
    },
    { type: 'h2', id: 'list-editing-totals', text: 'Totals row' },
    {
      type: 'p',
      text: 'Any number column can show a figure in a totals row pinned to the bottom of the list: open the column header’s menu (the arrow beside its name) and pick Sum, Average, Minimum, Maximum or Count (records with the column filled in) under Σ Totals row, or Off. Sum is also one click on the column’s Σ in the Columns panel.'
    },
    {
      type: 'p',
      text: 'The figure covers every record the list matches, not just the page you see, and is worked out by the server as you: your search, filters and column filters, your role’s row filters and User Scopes all apply, and a field you cannot read is never totalled. It reads in the column’s own format (a currency column shows currency); Count is always a whole number. Each column asks once and asks again only when the filters settle after a change. Grouped lists and AI search results show no totals row.'
    },
    {
      type: 'p',
      text: 'A saved view can state totals of its own. What you pick yourself is laid over them and remembered for you on this list in this browser: a view that totals one column never switches off the others you turned on, and switching views or going back to Default keeps your choices. Saving or updating a view gives it exactly the totals on screen (a reload brings them all back); from then on the choices it now holds follow the view.'
    },
    {
      type: 'p',
      text: 'A calculated field that only adds and subtracts stored number columns (for example Left to Forecast = Requisition Amount − Forecast Total) offers Sum alone, worked out from those columns’ sums. A field that is worked out from linked records each time the list is read, or by any other formula, has no total: its menu says so and why, instead of offering one.'
    },
    {
      type: 'note',
      text: 'Each figure is one `GET /api/items/:collection/aggregate?sum=<field>` (or avg / min / max / count) with the list’s `search` and `conditions`, the same gated read a list uses.'
    },
    { type: 'h3', id: 'list-editing-queue-totals', text: 'Totals on a queue worklist' },
    {
      type: 'p',
      text: 'A queue’s table has the same totals row: the same header menu on every number column (Sum, Average, Minimum, Maximum, Count or Off), the same sticky footer, remembered for you per queue in this browser and saved with the queue’s saved views and shared links. The figures cover every row of the tab you are on (My Items, No Owners, Claimed by me or All Items) under your column filters, not just the page, read as you — the same rows the worklist would page through.'
    },
    {
      type: 'p',
      text: 'A queue can mix sources from different collections. Each row adds its own source’s value for the column, and a source that has no such column adds nothing. The sums and counts of the sources add up, Minimum and Maximum take the least and greatest, and Average is the whole sum over the whole count (never an average of the sources’ averages). When a column’s rows come from more than one source, the figure’s tooltip gives the same figure per source.'
    },
    {
      type: 'p',
      text: 'A number column is a number field reached through many-to-one links, a per-row aggregate the queue works out (sum / average / count of linked rows) or an addendum’s cost impact; a column that lists several values per row has no totals entry. A calculated field worked out when the record is read (never stored) says it has no total. A formula column that only adds and subtracts number columns offers Sum alone, worked out from those columns’ sums; any other formula says why it has none. Grouped tables (their headers carry their own sums) and the board and workload views show no totals row.'
    },
    {
      type: 'note',
      text: 'The worklist asks for the figures on its own rows read — `GET /api/queues/:id/items?totals=extra.amount,extra.qty` adds `totals` (per column: sum, count, min, max, avg and `by_collection`) and `totals_partial` (a live read past its 20,000-row ceiling covers the rows it read) — so turning totals on costs no second read of the sources. `GET /api/queues/:id/totals?scope=&filters=&totals=` answers the same figures alone. Both are gated by the queue’s read access, read every source as you through the heavy-read gate, and read a materialized queue from its cache.'
    }
  ]
}
