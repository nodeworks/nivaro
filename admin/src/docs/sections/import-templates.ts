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
      text: "One rule per target field on the collection: a source column name and an ordered list of steps. Steps run in array order, and every resolved value is added to a `$resolved.*` context so a later rule can reference an earlier one's result (e.g. a unit lookup scoped by an already-resolved region)."
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
          "Wraps a plain string into the rich-text editor's portable JSON block shape."
        ],
        ['const', 'Ignores the incoming value and sets a fixed literal.']
      ]
    },
    { type: 'h3', text: 'Lookup step and on_miss policies' },
    {
      type: 'p',
      text: "A lookup step names a target collection, a match field, optional scope filters (AND-ed, each `{{token}}`-substitutable), and `take` — what to pull off the matched record once it's found. What happens when nothing matches is the `on_miss` policy:"
    },
    {
      type: 'p',
      text: 'Line rules run in order and each result lands in a per-row `{{$line.*}}` context, so a later rule can chain off earlier ones — in expressions and in scope-filter values. Composite lookups fall out of this: resolve `category_type` and `core_category` first, then a `category` rule with an expression `{{$line.core_category}}` and a scope filter `sub_category = {{$line.category_type}}` picks the exact record matching both, per row. Row-varying scope filters are applied in memory after the single batched query, so lookups stay one query per rule.'
    },
    {
      type: 'table',
      head: ['take', 'Behavior'],
      rows: [
        ['id (default)', "Resolves to the matched record's id — the typical FK-fill case."],
        [
          'record',
          'Resolves to the full matched record, so a later step (e.g. wrap_richtext) can read any of its fields.'
        ],
        [
          'field',
          'Resolves to one named column off the matched record via `take_field`, validated against live schema at save time. Chain it with an earlier `expression` step reading `{{$resolved.*}}` to look a record up by one key and pull a different column into a later rule. If the column is later dropped or renamed, the runtime degrades to a warn issue instead of failing the row.'
        ]
      ]
    },
    {
      type: 'table',
      head: ['on_miss', 'Behavior'],
      rows: [
        ['leave_blank', 'Leaves the field empty and records a warn-severity issue.'],
        ['error', 'Records an error-severity issue — blocks direct execute until resolved.'],
        [
          'create_stub',
          'Flags the miss as a warn issue and an `{ is_new: true, name }` `stubs` sidecar on the parse response; no record is created and nothing extra is persisted (v1). A header-level create_stub is warn-only (no sidecar slot exists for header values, only for line values), and nested disperse-member stubs surface as warn issues only — never written into the stored row.'
        ],
        [
          'create',
          'Like `create_stub` at parse time (warn issue + `stubs` sidecar, nothing persisted) — but direct execute additionally bulk-creates the missing records. Requires a `create: { defaults, dedupe_by }` block on the step; not available on `$users` lookups. See below.'
        ]
      ]
    },
    { type: 'h3', text: "on_miss: 'create' — bulk-creating missing lookup records" },
    {
      type: 'p',
      text: "A lookup step with `on_miss: 'create'` carries a `create: { defaults, dedupe_by }` block. `defaults` is a list of header-rule-shaped entries (`{ target, steps }`, lookup steps excluded) that build the payload for the record to create; `dedupe_by` is the tuple of created-field names that determines whether two misses collapse into a single created record."
    },
    {
      type: 'warn',
      text: "Parse NEVER creates anything, even with `on_miss: 'create'` configured — a miss is a warn issue and a stub, same as `create_stub`, so the pipeline stays read-only through prefill and the test panel. Only `POST /:id/execute` (direct mode) performs the create. Prefill-mode templates leave the stub for a human to resolve in the form; there is no client-side create-and-link path outside execute."
    },
    {
      type: 'p',
      text: "At execute time, every submitted line's `stubs` sidecar is matched back to the line_map column whose lookup step declared `on_miss: 'create'`. Misses are deduped per lookup step by their normalized `dedupe_by` tuple (`.trim().toLowerCase()` on each field's resolved value — the same normalization the lookup match itself uses, so a miss that WOULD have matched case/whitespace-insensitively never creates a duplicate), then bulk-created via the items service (full RBAC/validation/RLS/hooks, same as `POST /items`) BEFORE the parent record, so the new ids are ready to substitute into `values`/`line.values` before the parent and children are created."
    },
    {
      type: 'p',
      text: "Every created record's payload is seeded with the searched-for value in `match_field` (the exact miss name, trimmed) before `defaults` is applied — so the record that gets created always carries the value that failed to match, and the next import of the same name matches it instead of creating a duplicate. A `defaults` rule that explicitly targets `match_field` still wins over the seed."
    },
    {
      type: 'p',
      text: "Defaults resolve per miss against the LINE's mapped values — the keys already produced by that line's other header rules — not the raw sheet columns (the sheet is gone by execute time; only the parsed/edited `values`/`lines` payload is submitted). A default's `expression` step can also reach `{{$resolved.*}}` to pull in an already-resolved header value (e.g. a region resolved once for the whole import, reused as a scope default on every created record)."
    },
    {
      type: 'p',
      text: "Example — a Unit Name column with no matching `units` row: `system_id`/`name` default to `{{Unit Name}}` (the line's own mapped Unit Name value), a `scope`/`region` field defaults to `{{$resolved.region}}` (an already-resolved header value shared across the whole import), and `dedupe_by: ['name', 'unit_type']` collapses two sheet rows naming the same unit and type into one created `units` record, whose id is then substituted into every line that missed on it."
    },
    { type: 'h3', text: '$users — looking up system users' },
    {
      type: 'p',
      text: "`$users` is a sentinel lookup collection — not a real `nivaro_collections` row — for matching a sheet column against system users. It's the only system-collection lookup a template is permitted to reference (every other `nivaro_*` collection is blocked, both at save time and at fetch time). The server resolves it directly against `nivaro_users`, selecting only `id` and `email` and filtering to `is_redacted = 0` — redacted users never match. `match_field` is restricted to `email` (enforced by the config normalizer at save time) and `take` is forced to `id` regardless of what's configured. Typical use: an 'Assigned To' column matched by email, resolving straight to a user id for an M2O owner field."
    },
    {
      type: 'warn',
      text: "A `$users` lookup may not use `on_miss: 'create'` — rejected at save time. There's no sanctioned path for a template to provision system user accounts; the builder hides the 'create' radio option entirely once a lookup step's collection is switched to `$users`, and clears any `create` block already configured."
    },
    { type: 'h3', text: 'M2M alias targets' },
    {
      type: 'p',
      text: "A header rule's `target` can name an M2M alias field (a virtual `one_field` on a junction relation) instead of a physical column — the builder's field target picker lists them alongside plain columns. Because an M2M field has no single scalar slot on the parent row, resolved ids for these targets never land in `values` — they come back in a separate top-level `m2m` section of the parse response: `{ [field]: [ids] }`."
    },
    {
      type: 'note',
      text: "Prefill stages M2M ids into the form's existing M2M picker via the same M2MStagingContext the picker itself uses — junction row writes are still the ordinary per-field fire-and-forget POSTs the picker already fires on save; nothing new was added to the save path. Direct execute creates junction rows itself: AFTER the parent record (so the FK exists) but BEFORE the line items, inside the same all-or-nothing compensation as everything else. Junction row counts add to the line count against the shared IMPORT_ROW_CAP (5,000 rows); see Relation-mode nested targets below for the full compensation order once relation-mode grandchildren and `on_miss: 'create'` records are also in play."
    },
    { type: 'h3', text: 'Line mapping (child rows)' },
    {
      type: 'p',
      text: 'A template can map spreadsheet rows to child records through an existing one-to-many relation on the collection: pick the target O2M field, an optional row filter (skip rows where a column is null/equals/not-equals a value), and per-column header rules the same shape as above. "Apply field rules to each line" runs the collection\'s existing Field Rules engine per generated line, so line defaults come from the same mechanism as manual entry.'
    },
    {
      type: 'note',
      text: 'The O2M field\'s layout row_rules (client-side rules configured on the inline grid field itself) and the "Apply field rules to each line" checkbox above are two different mechanisms. Prefill applies BOTH: staged lines also run through the O2M field\'s layout row_rules via POST /field-rules/evaluate, with a `$parent.*` context built from the already-imported header draft — so a staged line looks the way it would if a user had just typed it into the inline grid. Direct execute applies only the persisted Field Rules ("Apply field rules to each line"); layout row_rules are layout-scoped UI curation, not something the server-side execute path evaluates. Either way, any grid column driven by a client write-computed formula only shows its computed value after the row\'s first edit or save — never at staging time, since nothing has triggered the client compute yet.'
    },
    { type: 'h3', text: 'Disperse — splitting an amount across grouped rows' },
    {
      type: 'p',
      text: "An optional step on line mapping for sheets where one row carries a total that must be split across several other rows into a nested repeater/JSON field on each line (e.g. a supplier-unit-type breakdown). It looks up a driving key column against a map collection, groups the sheet's other rows by a group-by column, splits the amount column evenly across the groups, and resolves one more level of per-member lookup rules — the only nested level the pipeline supports."
    },
    {
      type: 'warn',
      text: "Disperse map values only resolve off a scalar/array column on the map record (`map_values_path` reads a column, re-parsed as a JSON array when MSSQL returns nvarchar-JSON as a plain string) — a relation-valued disperse map, where the values list should come from a related collection's records rather than a JSON array column, isn't supported. Workaround: denormalize a plain JSON-array column onto the map collection holding the values you'd otherwise pull through a relation; the fetcher already re-parses JSON-string array columns, so no code change is needed to read it."
    },
    { type: 'h3', text: 'Per-line nested rows' },
    {
      type: 'p',
      text: "`line_map.nested` is a simpler alternative to disperse for building one nested repeater/JSON member per line, instead of splitting one trigger row's amount across several grouped rows: an optional `when` gate (a column null/eq/neq a value) and a set of member `columns` (same header-rule shape, lookups included) resolved once per gated row into a single `{ field, rows: [member] }` nested block on that line's draft."
    },
    {
      type: 'note',
      text: 'If both disperse and per-line nested are configured on the same line_map, disperse wins: per-line nested processing runs after disperse and skips any line whose draft already carries a `.nested` block from a disperse trigger row.'
    },
    {
      type: 'note',
      text: 'Every lookup in the pipeline — header, line, disperse member, and per-line nested member — is batched: candidate values across all rows for one rule are deduped and resolved with a single query, never one query per row.'
    },
    { type: 'h3', text: 'Relation-mode nested targets' },
    {
      type: 'p',
      text: "The nested/disperse target field (`line_map.nested.target_field` or `disperse.nested_target`) may name EITHER a physical JSON/repeater column on the line's child collection (JSON mode — members are written as a plain JSON array on the line row, as above) OR an O2M relation field on the child collection (relation mode — members become REAL rows in the related collection, one row per member, FK'd to the line). Nested and disperse must agree on target once either resolves as a relation (a save-time check), since two configs pointed at different relations racing to own the same generated rows would be ambiguous."
    },
    {
      type: 'p',
      text: 'Parse and test-panel responses carry a `nested_relation` field: `{ collection, fk_field } | null`, resolved once per request against the line child collection. `null` means JSON mode (or no nested/disperse config at all); a populated object means relation mode, and callers use it to decide how to stage and how to submit.'
    },
    {
      type: 'note',
      text: "Prefill staging (relation mode): instead of the ordinary `line.nested.field` key on the queued O2M row draft, the client stages members under `__o2m_<field>` — a reserved prefix meaning \"these are grandchild rows to flush after this row is created,\" not a value for the row itself. Both `ItemEditForm`'s bulk O2M flush and the inline grid's per-row save (`InlineTableField`) recognize the prefix: they strip `__o2m_*` keys before POSTing the row, then — once the row's real id comes back — POST each staged member to the resolved grandchild relation's `many_collection`, setting its `many_field` to the new row's id. A row create that fails to yield an id (e.g. an RLS filter hiding the just-created row) never posts members with an undefined FK: `ItemEditForm` counts them into a visible step error, while `InlineTableField` skips them under the grid's existing silent save-catch. The nested relation editor (`NestedRelationEditor`, used for grandchild rows already saved under a real parent) now surfaces its own save/delete failures inline instead of swallowing them — the `InlineTableField` row-save catch itself is unchanged and still silent."
    },
    {
      type: 'p',
      text: "Direct execute (relation mode): after each line/child row is created, its `nested.rows` members are created as real grandchild rows via the items service (`createOne` — full RBAC/validation/RLS/hooks), FK'd to the line's new id — the `nested` key is excluded from the child row's own payload entirely. This is inside the same all-or-nothing flow as everything else; on a later failure, compensation deletes in reverse-create order: grandchildren first (grouped by collection), then M2M junction rows, then child lines, then the parent, then any records created for `on_miss: 'create'` lookup misses last (they may be FK'd from rows created above). Relation-mode member rows join the shared `IMPORT_ROW_CAP` (5,000) total alongside line items, M2M linked-record ids, and `on_miss: 'create'` records-to-create; JSON-mode nested rows never count, since they ride along as a column value rather than a separate row."
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
          "Same button, driven by whether the queue's first collection-type source has active templates."
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
          'Template supports either — on Collection Browser it opens the same direct-create confirm dialog, with a "Review in form instead" button that closes the dialog and hands the parsed result to the create form for review; on the create form and Queue entry points it behaves as prefill.'
        ]
      ]
    },
    { type: 'h3', text: 'Caps and resilience' },
    {
      type: 'ul',
      items: [
        'Files are capped at 25MB and 5,000 data rows per sheet; a sheet over the row cap is truncated to the first 5,000 rows, reported as a warn-severity issue (never a silent drop).',
        'The pipeline never throws for data problems — every miss or coercion failure becomes an issue (warn or error). Only structural failures (unreadable file, no matching sheet, empty sheet) abort the parse.',
        'Direct execute is blocked while any error-severity issue remains: the error-issue block validates the SUBMITTED issues array as an advisory UX guard. Actual enforcement is the items service (RBAC, validation rules, RLS, hooks) applied to every created row — the same guarantees as POST /items.',
        "Direct execute is all-or-nothing: records created for `on_miss: 'create'` lookup misses, then the parent record, M2M junction rows, every child row, and any relation-mode nested/disperse grandchild rows are created in that sequence. Any failure compensates by deleting everything already created for that import (raw deletes, not through trash), in reverse order — grandchildren, then junctions, then children, then the parent, then created-lookup-records last — rather than leaving a partial record behind.",
        "The same IMPORT_ROW_CAP (5,000) governs both the parse-time sheet truncation and the execute-time submission — at execute, line items, M2M linked-record ids, relation-mode nested/disperse member rows, and records created for `on_miss: 'create'` misses all share one combined cap.",
        'Every created row goes through the normal items service, so a large direct-mode import into a collection that contributes to a stored rollup or carries a `sum_cap` rule pays the same per-row recalc and validation queries as an interactive create — expect a noticeably slower import as row count climbs toward the cap.'
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
          "Multipart file upload; runs the saved template's pipeline and returns `{ values, lines, issues, file_id, line_target_field, nested_relation, m2m }`. The only side effect is uploading the file when an attach field is configured — it never writes business data."
        ],
        [
          'POST /import-templates/:id/execute',
          'authenticated + create permission + mode allows direct',
          'Body is the (possibly client-edited) parse result, including `m2m`; creates the parent, M2M junction rows, and child rows transactionally and returns the created ids.'
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
      text: "Parse copies the uploaded file's id into `values[attach_file_field]` automatically — a client integrating the SDK directly needs no attach-field logic of its own."
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
// → { values, lines, issues, file_id, line_target_field, nested_relation, m2m }

// Direct-mode templates: create the parent + lines from a (possibly edited) parse result
const { data: created } = await cms.request(
  executeImportTemplate(templates[0].id, {
    values: parsed.values,
    lines: parsed.lines,
    issues: parsed.issues,
    file_id: parsed.file_id,
    m2m: parsed.m2m
  })
)
// → { id, line_ids }`
    },
    {
      type: 'warn',
      text: 'Lookup collections are never `nivaro_*` system tables, with exactly one deliberate exception — the `$users` sentinel (see above) — the fetcher otherwise blocks them the same way the Data Import Queue blocks system collections as import targets. Parse and test panel resolve lookups without a per-viewer read check on the lookup collection itself, since templates are admin-authored — the same curation-not-security precedent as picker_filter and widget feeds.'
    }
  ]
}
