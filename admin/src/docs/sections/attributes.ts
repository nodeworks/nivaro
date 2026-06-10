import type { DocSection } from '../types.js'

export const attributesGuide: DocSection = {
  id: 'dynamic-attributes',
  label: 'Dynamic Attributes',
  content: [
    { type: 'h1', id: 'dynamic-attributes', text: 'Dynamic Attributes (EAV)' },
    {
      type: 'p',
      text: 'Dynamic Attributes let admins add custom fields to a collection without a database migration or schema change. Definitions describe the attribute (key, label, type), and values are stored separately as key/value rows keyed by collection + item id. The item editor renders the matching inputs automatically.'
    },
    {
      type: 'note',
      text: 'This is an Entity-Attribute-Value (EAV) model. It complements — does not replace — real columns. Use real columns (Data Model → Fields) for data you query or filter heavily; use Dynamic Attributes for sparse, optional, or frequently-changing metadata where a migration would be overkill.'
    },
    { type: 'h3', text: 'How it works' },
    {
      type: 'ul',
      items: [
        'nivaro_attribute_definitions holds one row per custom field: collection, key (slug), label, type, options (for select), required, sort, is_active. UNIQUE(collection, key).',
        'nivaro_attribute_values holds one row per item value: collection, item_id (varchar, supports both UUID and integer PKs), attribute_key, value. UNIQUE(collection, item_id, attribute_key).',
        'All values are stored as nvarchar(max) text regardless of type; the frontend parses them by the definition type on render.',
        'The item editor shows a "Custom Attributes" card only when at least one active definition exists for the collection.'
      ]
    },
    { type: 'h3', text: 'Attribute types' },
    {
      type: 'table',
      head: ['Type', 'Editor input', 'Stored as'],
      rows: [
        ['text', 'Text input', 'string'],
        ['number', 'Numeric input', 'string (numeric)'],
        ['boolean', 'Switch', '"true" / "false"'],
        ['date', 'Date input', 'ISO date string'],
        ['select', 'Combobox of options', 'one of the option strings']
      ]
    },
    { type: 'h3', text: 'Defining attributes' },
    {
      type: 'p',
      text: 'Open Data Model → select a collection → the "Attributes" tab. Click Add attribute, then set the key (slug, fixed after creation), label, type, and — for select types — a comma-separated list of options. Toggle Required and Active per definition, and delete a definition to remove it (which also cleans up its stored values).'
    },
    { type: 'h3', text: 'Editing values' },
    {
      type: 'p',
      text: 'On any existing item, the Custom Attributes card lists every active attribute for the collection. Each field saves independently — on blur for text/number/date, immediately for boolean and select — via PATCH /api/attributes/:collection/:itemId.'
    },
    { type: 'h3', text: 'API' },
    {
      type: 'pre',
      code: `// Definitions — admin only
// GET    /api/attribute-definitions?collection=orders
// POST   /api/attribute-definitions
{
  "collection": "orders",
  "key": "priority_score",
  "label": "Priority Score",
  "type": "select",
  "options": ["low", "medium", "high"],
  "required": false
}
// PATCH  /api/attribute-definitions/:id   (label, type, options, required, sort, is_active)
// DELETE /api/attribute-definitions/:id   (also removes orphaned values)

// Values — any authenticated user
// GET   /api/attributes/orders/42
// → { data: [ { id, key, label, type, options, required, value }, ... ] }

// PATCH /api/attributes/orders/42
{ "priority_score": "high" }   // upserts; keys without an active definition are ignored`
    },
    {
      type: 'note',
      text: 'Definition CRUD requires admin access. Reading and writing values requires any authenticated user. A value PATCH silently ignores keys that have no active definition for that collection, so stale client payloads cannot create orphaned rows.'
    }
  ]
}
