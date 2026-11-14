import type { DocSection } from '../types.js'

export const duplicateWarningsDocs: DocSection = {
  id: 'duplicate-warnings',
  label: 'Duplicate Warnings',
  content: [
    { type: 'h1', id: 'duplicate-warnings', text: 'Duplicate Warnings' },
    {
      type: 'p',
      text: 'Reference lists (unit types, vendors, categories, project types…) grow copies when nobody sees that “MX480” already exists while typing “mx480”. When someone creates a record, the form compares what they type in the label field with the existing records and shows the likely duplicates under the field — before they save.'
    },
    { type: 'h2', id: 'duplicate-warnings-form', text: 'On the new-record form' },
    {
      type: 'ul',
      items: [
        '**Already exists: MX480 (unit type) — Open** in amber: an existing record has the same text, ignoring case and spacing.',
        '**Similar: MX-480 B (unit type)** in quiet grey: the same letters and digits once punctuation and accents are removed, one value is the start of the other (“Acme Corp” / “Acme Corporation”), or one or two typos in a longer value.',
        'The form asks about 0.6 s after typing stops. A name opens the existing record in the drill-down sheet (the draft stays put) or, where the app has no sheet, in a new tab.',
        'Only records the person may read count, and only fields they may read are compared (row filters, User Scopes and field permissions apply exactly as on a list read). Editing an existing record never shows the notice.',
        'The notice never stops the save — unless the collection blocks exact copies (below).'
      ]
    },
    { type: 'h2', id: 'duplicate-warnings-setting', text: 'Which collections are checked' },
    {
      type: 'p',
      text: '**Table Editor → Settings → Collection Browser → Warn about duplicates**, stored as `browser_config.duplicate_check` on the collection (no migration):'
    },
    {
      type: 'table',
      head: ['Mode', 'What it does'],
      rows: [
        [
          'Auto (unset)',
          'On for a small reference list: the display template names exactly one plain text field (not computed, not a generated id) and the table holds at most 50,000 rows. Transactional tables, labels built from several fields and system tables are off.'
        ],
        [
          'On',
          'The chosen fields (else the display template’s text fields), on any table size. Above 50,000 rows only the exact check runs (it seeks an index); the near-match checks scan and are skipped.'
        ],
        ['Off', 'Never checked.'],
        [
          'Block exact copies',
          'A create whose value equals an existing record’s (case and spacing ignored) is refused with `400 DUPLICATE_RECORD` (`field`, `value`, and `existing_id` when the person may read that record). Judged against every record, so the refusal can say a copy exists that the person cannot open. Creates only — renaming an existing record is not checked.'
        ]
      ]
    },
    {
      type: 'pre',
      code: `PATCH /api/collections/unit_types
{ "browser_config": { "duplicate_check": { "mode": "on", "fields": ["name"], "block_exact": true } } }`
    },
    { type: 'h2', id: 'duplicate-warnings-api', text: 'API' },
    {
      type: 'pre',
      code: `GET /api/duplicates/unit_types
→ { data: { enabled: true, fields: ["name"], block_exact: false, close: true, source: "auto", label: "Unit Type" } }

GET /api/duplicates/unit_types/check?values={"name":"mx480"}&exclude=<id>
→ { data: { enabled: true, fields: ["name"], matches: {
      name: [ { id: "7", label: "MX480", value: "MX480", match: "exact", score: 1 },
              { id: "9", label: "MX-480 B", value: "MX-480 B", match: "close", score: 0.71 } ] } } }`
    },
    {
      type: 'p',
      text: 'Signed in; answered as the caller. Up to 5 matches per field, exact first. The lookup runs under a 1.5 s time budget; `partial: true` says a check was cut.'
    },
    { type: 'h2', id: 'duplicate-warnings-import', text: 'Collection import preview' },
    {
      type: 'p',
      text: 'The import preview (`POST /api/imports/preview`) checks every row the import would CREATE against the same fields and answers `duplicates: { fields, exact_rows, close_rows, in_file_rows, close, rows[] }` (the first 50 rows with what they copy). The confirm step shows “3 new rows would create a duplicate — 2 copy an existing record, 1 repeats an earlier row”. Choose a match field to update the existing records instead, or remove the rows from the file. Exact and punctuation-only matches are checked; the typo check does not run on imports.'
    },
    {
      type: 'note',
      text: 'The form in efp-new uses the same shared record form, so it gets the same notice with no host change.'
    }
  ]
}
