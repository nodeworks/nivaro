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
    {
      type: 'note',
      text: 'CRUD endpoints (POST/PATCH/DELETE) require admin access. GET /api/field-rules?collection=… and POST /api/field-rules/evaluate require any authenticated user.'
    }
  ]
}
