import type { DocSection } from '../types.js'

export const fieldDisplaySettingsGuide: DocSection = {
  id: 'field-display-settings',
  label: 'Field Display Settings',
  content: [
    { type: 'h1', id: 'field-display-settings', text: 'Field Display Settings' },
    {
      type: 'p',
      text: 'Every field in a registered collection has per-field display settings that control how it is labelled and rendered in the item editor — without changing the underlying database column. Open Data Model → select a collection → hover a field chip in the Table Editor and click the gear icon to open the Display Settings popover. A cyan gear indicates the field already has overrides.'
    },
    { type: 'h3', text: 'Available settings' },
    {
      type: 'table',
      head: ['Setting', 'Applies to', 'Behavior'],
      rows: [
        [
          'Label',
          'All fields',
          'Overrides the auto-generated label (title-cased field name). Leave blank to fall back to the default.'
        ],
        [
          'Interface',
          'All fields',
          'Overrides which input component renders the field. Options depend on the field\'s abstract type; choose "Default" to reset to auto-detection.'
        ],
        ['Note', 'All fields', 'Helper text shown below the input in the item editor.'],
        ['Required', 'All fields', 'Marks the field as required in the editor.'],
        ['Hidden', 'All fields', 'Hides the field from the item editor entirely.'],
        ['Read-only', 'All fields', 'Renders the field as non-editable.'],
        [
          'Inline edit',
          'M2O relations',
          'On by default. When enabled, the related record can be opened and edited inline next to the relation picker; when disabled, the field is a plain pick-only combobox.'
        ],
        [
          'Max values',
          'M2M relations',
          'Integer limit on how many related records can be linked. Leave blank for unlimited. Setting it to 1 switches the field to a single-select combobox.'
        ]
      ]
    },
    { type: 'h3', text: 'Storage and API' },
    {
      type: 'ul',
      items: [
        'Settings are stored on the nivaro_fields row for the collection + field — label, note, interface, required, hidden and readonly are real columns; max_values and inline_relation are merged into the options JSON column.',
        'Updates go through PATCH /api/field-config/:collection/:field (admin only). Send only the keys you want to change.',
        'GET /api/field-config/:collection (any authenticated user) returns the full per-field config, including label, note, interface and the parsed options object.',
        'In the SDK, use readFieldConfig(collection) and updateFieldConfig(collection, field, patch) — the FieldConfig type includes label.'
      ]
    },
    {
      type: 'pre',
      code: `// PATCH /api/field-config/orders/customer
{
  "label": "Customer Account",
  "note": "The billing account this order is invoiced to",
  "required": true,
  "inline_relation": false
}

// PATCH /api/field-config/orders/tags  (M2M)
{ "max_values": 1 }   // single-select combobox
{ "max_values": null } // back to unlimited`
    },
    {
      type: 'note',
      text: 'Display settings are presentation-layer only — Hidden and Read-only affect the admin item editor, not API access. Use roles/policies (field-level permissions) to actually restrict reads and writes, and Validation Rules for server-side enforcement of required values.'
    }
  ]
}
