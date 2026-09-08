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
