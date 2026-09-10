import type { DocSection } from '../types.js'

export const fieldRulesGuide: DocSection = {
  id: 'field-rules',
  label: 'Field Rules',
  content: [
    { type: 'h1', id: 'field-rules', text: 'Field Rules' },
    {
      type: 'p',
      text: 'Field Rules are lightweight, per-collection automations that set or clear the value of one field based on the value of another. When a trigger field matches a condition, a target field is automatically set to a literal value or cleared. Rules run both server-side on save and in real time inside the item editor.'
    },
    {
      type: 'note',
      text: 'Field Rules are distinct from the global Rules engine (nivaro_rules). The Rules engine drives broader automation such as webhooks and notifications on create/update triggers. Field Rules are simple inline field defaults scoped to a single collection and stored in nivaro_field_rules.'
    },
    { type: 'h3', text: 'How it works' },
    {
      type: 'ul',
      items: [
        'Each rule belongs to one collection and has a trigger (field + operator + optional value) and a target (field + action + optional value).',
        'On save, applyFieldRules() runs inside createItem/updateItem before the row is written, evaluating every active rule whose trigger field is present in the payload.',
        'In the item editor, changing a field calls POST /api/field-rules/evaluate, which returns only the fields the rules would change — those are merged into the draft immediately, with no save required.',
        'Rules are evaluated in ascending sort order, so a later rule can override an earlier one.'
      ]
    },
    { type: 'h3', text: 'Operators' },
    {
      type: 'table',
      head: ['Operator', 'Meaning', 'Uses value'],
      rows: [
        ['eq', 'Trigger field equals the value', 'yes'],
        ['neq', 'Trigger field does not equal the value', 'yes'],
        ['null', 'Trigger field is empty (null/undefined)', 'no'],
        ['nnull', 'Trigger field is not empty', 'no'],
        ['contains', 'Trigger field (as text) contains the value', 'yes'],
        ['in', 'Trigger field equals one of a comma-separated list', 'yes (comma-separated)']
      ]
    },
    { type: 'h3', text: 'Target actions' },
    {
      type: 'ul',
      items: [
        'set — assign a literal value to the target field.',
        'clear — set the target field to null.'
      ]
    },
    { type: 'h3', text: 'Configuring rules' },
    {
      type: 'p',
      text: 'Open Data Model → select a registered collection → the "Field Rules" section in the right panel. Click Add Rule, then choose the trigger field, condition, target field, and action. Use the Active toggle to enable/disable a rule without deleting it, and the up/down arrows to reorder evaluation priority.'
    },
    { type: 'h3', text: 'Example' },
    {
      type: 'p',
      text: 'On an "orders" collection: when status equals "cancelled", clear the assigned_to field; when priority is one of "high, urgent", set the queue field to "expedited".'
    },
    {
      type: 'pre',
      code: `// POST /api/field-rules
{
  "collection": "orders",
  "trigger_field": "status",
  "trigger_op": "eq",
  "trigger_value": "cancelled",
  "target_field": "assigned_to",
  "target_type": "clear"
}

// Evaluate without saving (used by the item editor):
// POST /api/field-rules/evaluate
{
  "collection": "orders",
  "data": { "status": "cancelled", "assigned_to": 42 },
  "changed_field": "status"
}
// → { "updates": { "assigned_to": null } }`
    },
    { type: 'h2', id: 'field-rules-grid-row-rules', text: 'Grid row rules (inline tables)' },
    {
      type: 'p',
      text: 'An inline-table field on a layout can carry its own per-row auto-fill rules (Table Editor → grid field settings → "Row auto-fill rules"): derive a line\'s category type from the picked category, its task from a project-type-filtered lookup, a lock on price for labor lines, and so on. The row editor evaluates them live as you edit, and the API runs the same rules when a child row is created directly.'
    },
    { type: 'h3', text: 'Auto vs overridden' },
    {
      type: 'p',
      text: 'In the row editor every rule target shows a small chip: "auto" when the value is exactly what the rules would derive, "overridden" when you (or an import) hold a different value. Fields the rules would leave empty show no chip. "↺ reset" beside an overridden value re-derives that one field from its rules. A value you change never gets flipped back by a slower rule response that was already in flight.'
    },
    { type: 'h3', text: 'Re-running on API updates' },
    {
      type: 'p',
      text: 'Row rules run on API creates and, by default, on API updates too: a PATCH that changes one of a rule\'s trigger fields re-derives its target, the same way the form does when you edit. A target the caller sends explicitly in the same request always wins. Untick "Re-run on API updates when a trigger field changes" on a rule to run it on creates only.'
    },
    { type: 'h3', text: 'Why is this cell locked?' },
    {
      type: 'p',
      text: 'A cell a `lock` rule holds is read-only in both the inline editor and the row panel, and hovering it says which trigger locked it, using the row\'s own value: "Locked — Category is Installation - Labor". The evaluate call returns `lock_reasons` (trigger field, operator, value) beside `locks`.'
    },
    { type: 'h3', text: 'Seed-only rules, conditional sources and pinned picker defaults' },
    {
      type: 'p',
      text: 'A rule flagged **seed only** (Table Editor → rule footer) treats its target as an INPUT it merely fills when empty — a project\'s default category or default CIFA for a new line. "Re-run rules" never blanks a seed-only target to re-derive it, Data Integrity never reports it as drift, and the row-input check still flags the line when it stays empty. Without the flag, a "default" rule would turn a hand-picked input into a target the re-run wipes. A seed-only value still equal to one of the rule family\'s own defaults counts as auto and FOLLOWS its trigger (switch a line from materials to equipment and the default CIFA swaps); any other value is a hand pick and stays, and the row editor labels it overridden. When the new state derives nothing, the seeded value is left in place.'
    },
    {
      type: 'p',
      text: 'A precedence source may carry `when: {field, op, value, related_field?}` — the source only yields a candidate when the row (or the parent, via a `$parent.<field>` field) matches, with the same related-field hops as a trigger. One chain can therefore hold "P2 default when the workflow source is P2, services default for labor lines, goods default otherwise" in front of the legacy fallback. A source whose row field is empty is closed unless the op is about emptiness.'
    },
    {
      type: 'p',
      text: "An M2O picker column can float a context-dependent default to the top of its list: `options.pinned_options: [{when:{field,op,value}, parent_field, parent_collection, source_field, tag}]` — when the ROW matches `when` (a materials line), the value the parent's linked record holds in `source_field` (workflow → project → default materials CIFA) is pinned first with a tag, above search results and sort. Nothing is pinned without a match or a value. Entries are tried in order (project first, then the project type, say); `when.field` may name a `$parent.<field>` to key on the parent record (a P2 workflow gets the P2 default). Works on the plain and the grouped picker alike."
    },
    { type: 'h3', text: 'Re-running rules over existing lines' },
    {
      type: 'p',
      text: "A rule added or changed after lines were created never touched them. The grid toolbar's \"re-run rules…\" opens a panel with two modes: **Fill blanks only** writes rule targets that are empty today — plus any target a rule LOCKS on that line, since nobody could have typed those — **Re-derive everything** treats every rule target as blank first so set rules win over hand-typed values (a rule that derives nothing never erases what a line had). Preview lists which fields would change on how many lines and writes nothing. On a staged grid (save mode pending — workflow lines) the re-derived values are queued as row edits: lines show as Edited and land with the record's Save, so they can still be cancelled. Lines not yet saved — a new record's lines, staged additions — are planned alongside the saved ones (sent as `rows` with a client key; the server never writes them) and their patches are written back into the staged rows; staged edits on saved lines are overlaid first so the plan judges what the grid shows. On an immediate-mode grid Apply goes through the normal update path right away, so each line gets a revision attributed to you and the lines timeline shows the batch. The same call is `POST /field-rules/apply` with `{collection, fk_field, parent_id, parent_context, row_rules, mode, dry_run}` — update permission on the child collection is required for a real run, read permission for a preview."
    },
    { type: 'h3', text: 'Testing rules against a record' },
    {
      type: 'p',
      text: 'Below the rule list, "Test rules against a record" runs the rules exactly as edited (unsaved) against one real child record and lists what every rule did: the resolved trigger value, whether it fired, was not triggered or was skipped (and why), the value it wrote, per-rule time, and the pass\'s query count. Nothing is written. Optionally name a changed field to simulate a live edit instead of the create-time pass.'
    },
    {
      type: 'pre',
      code: `// Live edit from a grid editor (probe returns what the rules WOULD derive):
// POST /api/field-rules/evaluate
{
  "collection": "workflow_line_items",
  "data": { "category": 67, "task": 42 },
  "changed_field": "category",
  "probe": true,
  "parent_context": { "workflow_type": 1, "project_type": 2 },
  "row_rules": [ /* the grid's row_rules */ ]
}
// → { "updates": { "oracle_category": 720, ... }, "locks": [], "expected": { "task": 1, ... } }

// Reset one field to its rule-derived value:
// { ..., "target_fields": ["task"], "probe": true }

// Dry run against a real row (admin):
// POST /api/field-rules/explain
{
  "collection": "workflow_line_items",
  "record_id": 465323,
  "parent_collection": "workflows",
  "fk_field": "workflow",
  "parent_context_fields": ["workflow_type", "project_type"],
  "row_rules": [ /* ... */ ]
}
// → { "data": { "trace": [{ "index": 0, "target_field": "oracle_category", "outcome": "wrote", ... }], "changes": {...}, "queries": 4, "ms": 260 } }

// Rule evaluation cost per collection (admin; also on the API Analytics page):
// GET /api/field-rules/stats`
    },
    {
      type: 'note',
      text: 'CRUD endpoints (POST/PATCH/DELETE), POST /api/field-rules/explain and GET /api/field-rules/stats require admin access. GET /api/field-rules?collection=… and POST /api/field-rules/evaluate require any authenticated user.'
    }
  ]
}
