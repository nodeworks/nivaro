import type { DocSection } from '../types.js'

export const duplicateWarningsDocs: DocSection = {
  id: 'duplicate-warnings',
  label: 'Duplicate Warnings',
  content: [
    { type: 'h1', id: 'duplicate-warnings', text: 'Duplicate Warnings' },
    {
      type: 'p',
      text: 'Lists grow copies when nobody sees that “MX480” already exists while typing “mx480”. When someone creates a record, the form compares what they enter with the existing records and shows the likely duplicates — before they save. It is on for every collection unless an administrator turns it off.'
    },
    { type: 'h2', id: 'duplicate-warnings-form', text: 'On the new-record form' },
    {
      type: 'ul',
      items: [
        '**Already exists: MX480 (unit type) — Open** in amber: an existing record matches exactly.',
        '**Similar: MX-480 B (unit type)** in quiet grey: a near match — punctuation, accents, a typo or two, a value within the allowed range.',
        'The form asks about 0.6 s after typing stops; a newer value cancels the older question. A name opens the existing record in the drill-down sheet (the draft stays put) or, where the app has no sheet, in a new tab.',
        'While the form is open, a matching record someone else creates appears in the notice on its own — the form asks again, as you, within a second or so.',
        'Only records the person may read count, and a check that compares a field they may not read is skipped for them (row filters, User Scopes and field permissions apply exactly as on a list read). Editing an existing record never shows the notice.',
        'The notice never stops the save — unless the collection blocks exact duplicates (below).'
      ]
    },
    { type: 'h2', id: 'duplicate-warnings-setting', text: 'Setting it up per collection' },
    {
      type: 'p',
      text: '**Data Model → a collection → Settings → Duplicate warnings.** Stored as `browser_config.duplicate_check` on the collection (no migration). Changes are a draft until you press Save.'
    },
    {
      type: 'ul',
      items: [
        '**On / Off** — on by default for every registered collection (system tables are never checked).',
        '**Label fields** (default) — each text field of the display template is checked on its own: the same text ignoring case, spacing and punctuation, or a typo or two.',
        '**Custom rules** — rules combined with AND. Each rule is a field and how it matches (table below).',
        '**Only records created in the last N days** — older records never count (needs a created-date field).',
        '**Ignore records in** — pipeline states whose records never count (e.g. Canceled).',
        '**Block exact duplicates** — off = warn only. On = a create that matches an existing record exactly on every rule is refused with `400 DUPLICATE_RECORD` (`field`, `value`, and `existing_id` when the person may read that record). Judged against every record, so the refusal can say a copy exists that the person cannot open. Creates only; a set of rules that compares lines never blocks.',
        '**Test with a record** — pick any record: the card shows which other records would be flagged if it were being created now, with the rules as they stand (saved or not).'
      ]
    },
    {
      type: 'table',
      head: ['Field kind', 'How it can match'],
      rows: [
        ['Text', 'Exact (ignoring case and spaces) · Close (allows typos) · Contains'],
        ['Number / currency', 'Equal · Within ± X % · Within ± X'],
        ['Date', 'Same day · Within N days'],
        ['Link to one record', 'Same record'],
        [
          'Lines (one-to-many)',
          'Share at least N values of a line field — e.g. two orders with 3 of the same catalog items'
        ]
      ]
    },
    { type: 'h2', id: 'duplicate-warnings-big', text: 'Big tables are never scanned' },
    {
      type: 'p',
      text: 'On a table with more than 50,000 records a set of rules runs only when one of its rules can use an index (exact text, numbers, dates and links on an indexed column; shared line values on an indexed line column). The other rules then only filter the records that one finds. Near matches (folded and typo passes) and Contains never drive a big table. The settings card says, rule by rule, what is skipped and why — “No index on Vendor Name — exact match skipped”. Everything runs under a 1.5 s time budget; a cut check answers `partial`.'
    },
    {
      type: 'pre',
      code: `PATCH /api/collections/purchase_orders
{ "browser_config": { "duplicate_check": {
    "rules": [
      { "field": "vendor", "match": "same" },
      { "field": "total", "match": "percent", "amount": 5 },
      { "field": "lines", "match": "shared", "line_field": "catalog_item", "amount": 2 }
    ],
    "within_days": 90,
    "ignore_states": ["canceled"],
    "block_exact": false } } }

{ "duplicate_check": { "mode": "off" } }            // never checked
{ "duplicate_check": { "fields": ["name"] } }       // older setting: still read as before`
    },
    { type: 'h2', id: 'duplicate-warnings-api', text: 'API' },
    {
      type: 'pre',
      code: `GET /api/duplicates/unit_types
→ { data: { enabled: true, fields: ["name"], watch: [{ field: "name", kind: "text" }],
            sets: [{ anchor: "name", fields: ["name"] }], block_exact: false, source: "default" } }

GET /api/duplicates/unit_types/check?values={"name":"mx480"}&exclude=<id>
→ { data: { enabled: true, matches: {
      name: [ { id: "7", label: "MX480", value: "MX480", match: "exact", score: 1 },
              { id: "9", label: "MX-480 B", value: "MX-480 B", match: "close", score: 0.71 } ] } } }

GET /api/duplicates/unit_types/plan?config=<duplicate_check JSON>     (administrators)
GET /api/duplicates/unit_types/test?record=<id>&config=<JSON>          (administrators)`
    },
    {
      type: 'p',
      text: 'Signed in; answered as the caller. Matches are keyed by the set’s first field (where the form shows the notice). Up to 5 per set, exact first. Values for links are ids, for lines a list of line-field ids.'
    },
    { type: 'h2', id: 'duplicate-warnings-import', text: 'Collection import preview' },
    {
      type: 'p',
      text: 'The import preview (`POST /api/imports/preview`) checks every row the import would CREATE with the same settings and answers `duplicates: { fields, exact_rows, close_rows, in_file_rows, close, rows[], skipped? }` (the first 50 rows with what they copy). Existing records are looked up by a text, number or link rule; the other rules are checked per row. Rules on lines, and sets with nothing to look records up by, are listed under `skipped`. The typo check does not run on imports.'
    },
    {
      type: 'note',
      text: 'The form in efp-new uses the same shared record form, so it gets the same notice with no host change. To turn the check off for several collections at once on an environment, use `node scripts/duplicate-check-mode.mjs --off <collections> [--like <text>] [--execute]`.'
    }
  ]
}
