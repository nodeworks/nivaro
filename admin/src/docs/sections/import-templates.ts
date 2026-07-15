import type { DocSection } from '../types.js'

export const importTemplatesGuide: DocSection = {
  id: 'import-templates',
  label: 'Import Templates',
  content: [
    { type: 'h1', id: 'import-templates', text: 'Import Templates' },
    {
      type: 'p',
      text: 'An Import Template is an admin-configured, declarative mapping from a spreadsheet (xlsx or csv) to a single record on a target collection, optionally with child rows. An end user uploads a file against a template; the server parses it, resolves sheet columns into field values (including relation lookups), and either pre-fills a create form for review or creates the record directly. Nothing is hardcoded per template — every rule (trim, remap, expression, lookup, rich-text wrap, constant) is data stored on the template row.'
    },
    {
      type: 'note',
      text: 'This is distinct from the Data Import Queue (Monitoring → Imports) — that feature bulk-inserts many rows per record with duplicate-strategy upserts and background processing. Import Templates is an interactive, single-record, parent-plus-children file-to-form import, reviewed (or previewed) before anything is written.'
    },
    { type: 'h3', text: 'Building a template' },
    {
      type: 'p',
      text: 'Open Data Model → select a collection → Table Editor → the "Imports" tab. The left panel lists templates for the collection (name, mode, active toggle); the right panel is the editor: basics (name, mode, sheet match rule, header row, attach-file field, sharing), header rules, line mapping, and disperse.'
    },
    { type: 'h3', text: 'Header rules' },
    {
      type: 'p',
      text: 'One rule per target field on the collection: a source column name and an ordered list of steps. Steps run in array order, and every resolved value is added to a `$resolved.*` context so a later rule can reference an earlier one\'s result (e.g. a unit lookup scoped by an already-resolved region).'
    },
    {
      type: 'table',
      head: ['Step', 'Behavior'],
      rows: [
        ['trim', 'Trims surrounding whitespace from a string value.'],
        [
          'remap',
          'Looks the value up in a fixed map (e.g. region codes); `passthrough` controls whether an unmapped value is kept as-is or cleared.'
        ],
        [
          'expression',
          'Renders a `{{Column}}` / `{{$resolved.field}}` template string against the row and the resolved context so far.'
        ],
        [
          'lookup',
          'Matches the value against a field on another collection (case-insensitive), with optional scope filters; see on_miss policies below.'
        ],
        [
          'wrap_richtext',
          'Wraps a plain string into the rich-text editor\'s portable JSON block shape.'
        ],
        ['const', 'Ignores the incoming value and sets a fixed literal.']
      ]
    },
    { type: 'h3', text: 'Lookup step and on_miss policies' },
    {
      type: 'p',
      text: 'A lookup step names a target collection, a match field, optional scope filters (AND-ed, each `{{token}}`-substitutable), and `take` (id or the full record). What happens when nothing matches is the `on_miss` policy:'
    },
    {
      type: 'table',
      head: ['on_miss', 'Behavior'],
      rows: [
        ['leave_blank', 'Leaves the field empty and records a warn-severity issue.'],
        ['error', 'Records an error-severity issue — blocks direct execute until resolved.'],
        [
          'create_stub',
          'Leaves the field empty and attaches an `{ is_new: true, name }` sidecar the UI renders as a "will create" badge; a header-level create_stub is warn-only (no sidecar slot exists for header values, only for line values).'
        ]
      ]
    },
    { type: 'h3', text: 'Line mapping (child rows)' },
    {
      type: 'p',
      text: 'A template can map spreadsheet rows to child records through an existing one-to-many relation on the collection: pick the target O2M field, an optional row filter (skip rows where a column is null/equals/not-equals a value), and per-column header rules the same shape as above. "Apply field rules to each line" runs the collection\'s existing Field Rules engine per generated line, so line defaults come from the same mechanism as manual entry.'
    },
    { type: 'h3', text: 'Disperse — splitting an amount across grouped rows' },
    {
      type: 'p',
      text: 'An optional step on line mapping for sheets where one row carries a total that must be split across several other rows into a nested repeater/JSON field on each line (e.g. a supplier-unit-type breakdown). It looks up a driving key column against a map collection, groups the sheet\'s other rows by a group-by column, splits the amount column evenly across the groups, and resolves one more level of per-member lookup rules — the only nested level the pipeline supports.'
    },
    {
      type: 'note',
      text: 'Every lookup in the pipeline — header, line, and disperse member — is batched: candidate values across all rows for one rule are deduped and resolved with a single query, never one query per row.'
    },
    { type: 'h3', text: 'Test panel' },
    {
      type: 'p',
      text: 'The builder has a live test panel at the bottom of the editor: upload a sample file and it runs the pipeline against the CURRENT (possibly unsaved) editor config, showing the resolved header values, a line preview grid, and a color-coded issues list. Nothing is saved or persisted by the test panel — it exists purely so an admin can iterate config against a real file before switching the template on.'
    },
    { type: 'h3', text: 'Entry points' },
    {
      type: 'table',
      head: ['Surface', 'Behavior'],
      rows: [
        [
          'Create form (Item Edit, and any headless @nivaro/react host)',
          '"Import from file" header button when active, visible templates exist for the collection. Parsed values merge into the draft, lines stage into the inline grid, and the uploaded file id stages into the attach field — review and save through the normal path.'
        ],
        [
          'Collection Browser',
          '"New from file" toolbar button. A prefill-mode template navigates to a pre-filled create form; a direct-mode template shows a confirm preview dialog and creates the record (and lines) server-side, all-or-nothing.'
        ],
        [
          'Queue worklist toolbar',
          'Same button, driven by whether the queue\'s first collection-type source has active templates.'
        ]
      ]
    },
    { type: 'h3', text: 'Modes' },
    {
      type: 'table',
      head: ['Mode', 'Behavior'],
      rows: [
        ['prefill', 'Parse result only fills a form for the user to review and save normally.'],
        [
          'direct',
          'Parse result is confirmed in a preview dialog, then created server-side in one transactional call.'
        ],
        [
          'both',
          'Template supports either — on the create form it always behaves as prefill (a form context is prefill by definition); on Collection Browser/Queue entry points it behaves as direct.'
        ]
      ]
    },
    { type: 'h3', text: 'Caps and resilience' },
    {
      type: 'ul',
      items: [
        'Files are capped at 25MB and 5,000 data rows per sheet; a sheet over the row cap is truncated to the first 5,000 rows, reported as a warn-severity issue (never a silent drop).',
        'The pipeline never throws for data problems — every miss or coercion failure becomes an issue (warn or error). Only structural failures (unreadable file, no matching sheet, empty sheet) abort the parse.',
        'Direct execute is blocked while any error-severity issue remains, and the server re-checks the submitted issues itself — a client cannot smuggle an error-severity issue past the block.',
        'Direct execute is all-or-nothing: the parent record and every child row are created in sequence, and any failure compensates by deleting everything already created for that import (raw deletes, not through trash) rather than leaving a partial record behind.'
      ]
    },
    { type: 'h3', text: 'REST API' },
    {
      type: 'table',
      head: ['Route', 'Auth', 'Purpose'],
      rows: [
        [
          'GET /import-templates?collection=',
          'authenticated',
          'Lists templates visible to the caller (own, or shared and role-matched) for the given collection — powers every entry-point button.'
        ],
        [
          'POST /import-templates',
          'admin',
          'Creates a template; config is normalized and validated against live schema (unknown target fields, lookup collections, or relation targets are rejected with the offending path).'
        ],
        ['PATCH /import-templates/:id', 'admin', 'Updates a template; same validation as create.'],
        ['DELETE /import-templates/:id', 'admin', 'Deletes a template.'],
        [
          'POST /import-templates/:id/parse',
          'authenticated + create permission on the target collection',
          'Multipart file upload; runs the saved template\'s pipeline and returns `{ values, lines, issues, file_id, line_target_field }`. The only side effect is uploading the file when an attach field is configured — it never writes business data.'
        ],
        [
          'POST /import-templates/:id/execute',
          'authenticated + create permission + mode allows direct',
          'Body is the (possibly client-edited) parse result; creates the parent and child rows transactionally and returns the created ids.'
        ],
        [
          'POST /import-templates/test',
          'admin',
          'Multipart file plus a `config` field carrying the (possibly unsaved) builder config as JSON; runs the same pipeline and returns the same shape as parse, but never persists the uploaded file.'
        ]
      ]
    },
    {
      type: 'note',
      text: 'Parse copies the uploaded file\'s id into `values[attach_file_field]` automatically — a client integrating the SDK directly needs no attach-field logic of its own.'
    },
    { type: 'h3', text: 'SDK' },
    {
      type: 'pre',
      code: `import { createNivaro, listImportTemplates, executeImportTemplate } from '@nivaro/sdk'

const cms = createNivaro({ url, token })

// List templates available for a collection
const { data: templates } = await cms.request(listImportTemplates('purchase_orders'))

// Parse a file against a saved template (multipart upload, not a Command)
const parsed = await cms.importParse(templates[0].id, file)
// → { values, lines, issues, file_id, line_target_field }

// Direct-mode templates: create the parent + lines from a (possibly edited) parse result
const { data: created } = await cms.request(
  executeImportTemplate(templates[0].id, {
    values: parsed.values,
    lines: parsed.lines,
    issues: parsed.issues,
    file_id: parsed.file_id
  })
)
// → { id, line_ids }`
    },
    {
      type: 'warn',
      text: 'Lookup collections are never `nivaro_*` system tables — the fetcher blocks them the same way the Data Import Queue blocks system collections as import targets. Parse and test panel resolve lookups without a per-viewer read check on the lookup collection itself, since templates are admin-authored — the same curation-not-security precedent as picker_filter and widget feeds.'
    }
  ]
}
