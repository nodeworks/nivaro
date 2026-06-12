import type { DocSection } from '../types.js'

export const contentOpsDraftPublish: DocSection = {
  id: 'content-ops-draft-publish',
  label: 'Draft / Publish',
  content: [
    { type: 'h1', id: 'content-ops-draft-publish', text: 'Draft / Publish Workflow' },
    {
      type: 'p',
      text: 'Collections can opt into a draft/publish model that adds a virtual `_status` column (draft, review, published) to every item. The status is enforced at the API layer — it is not stored as a separate database column but is tracked in the `nivaro_draft_publish_state` table keyed by collection + item ID.'
    },
    { type: 'h3', text: 'Managing in the admin UI' },
    {
      type: 'p',
      text: 'Enable draft/publish from Data Model → select the table → Content tab → "Draft / Publish" toggle. Once enabled, the item editor header shows the current status badge plus status actions (Submit for review, Publish, Unpublish) — day-to-day publishing happens entirely from there. The API below is the programmatic equivalent.'
    },
    { type: 'h3', text: 'Enabling via API' },
    {
      type: 'pre',
      code: `PATCH /api/draft-publish/:collection/config
Authorization: Bearer <admin-token>

{ "enabled": true }

// Response:
{ "data": { "collection": "articles", "draft_publish_enabled": true } }`
    },
    { type: 'h3', text: 'Item status' },
    {
      type: 'table',
      head: ['Status', 'Description'],
      rows: [
        [
          'draft',
          'Work in progress — not visible to public API consumers unless they explicitly include draft items.'
        ],
        [
          'review',
          'Submitted for editorial review. Cannot be edited without transitioning back to draft.'
        ],
        ['published', 'Live. Included in default list/read responses for authenticated users.']
      ]
    },
    { type: 'h3', text: 'Actions' },
    {
      type: 'table',
      head: ['Method', 'Path', 'Description'],
      rows: [
        [
          'GET',
          '/api/draft-publish/:collection/config',
          'Get draft/publish config for the collection.'
        ],
        [
          'PATCH',
          '/api/draft-publish/:collection/config',
          'Enable or disable draft/publish. Body: { enabled }.'
        ],
        ['POST', '/api/draft-publish/:collection/:id/publish', 'Transition item to published.'],
        ['POST', '/api/draft-publish/:collection/:id/unpublish', 'Revert published item to draft.'],
        ['POST', '/api/draft-publish/:collection/:id/submit-review', 'Submit draft for review.']
      ]
    },
    {
      type: 'note',
      text: "Cloning an item (POST /items/:collection/:id/clone) automatically sets _status=draft on the new copy regardless of the source item's status."
    }
  ]
}

export const contentOpsScheduledChanges: DocSection = {
  id: 'content-ops-scheduled-changes',
  label: 'Content Scheduling',
  content: [
    { type: 'h1', id: 'content-ops-scheduled-changes', text: 'Content Scheduling' },
    {
      type: 'p',
      text: 'Scheduled changes let you queue a field update, workflow transition, or publish/unpublish action to execute at a future date and time. Changes are stored in `nivaro_scheduled_changes` with a `pending` status and can be executed manually or via Inngest automation.'
    },
    { type: 'h3', text: 'Managing in the admin UI' },
    {
      type: 'p',
      text: 'On any item edit page, the Schedule button in the header opens a dialog to queue a change for that record — pick the change type, the values, and the date/time. All pending and past changes across collections are managed on the /scheduled-changes page, where each change can be edited, cancelled, or executed immediately.'
    },
    { type: 'h3', text: 'Creating a scheduled change via API' },
    {
      type: 'pre',
      code: `POST /api/scheduled-changes
Authorization: Bearer <admin-token>

{
  "collection": "articles",
  "item_id": "uuid-or-int",
  "scheduled_at": "2026-01-15T09:00:00Z",
  "change_type": "field_update",       // field_update | workflow_transition | publish | unpublish
  "payload": {
    "field": "status",
    "value": "live"
  }
}

// Response:
{ "data": { "id": "uuid", "status": "pending", ... } }`
    },
    { type: 'h3', text: 'Status lifecycle' },
    {
      type: 'table',
      head: ['Status', 'Description'],
      rows: [
        ['pending', 'Queued — awaiting execution time.'],
        ['executed', 'Successfully applied.'],
        ['failed', 'Execution error — check the error_message field.'],
        ['cancelled', 'Manually cancelled before execution.']
      ]
    },
    { type: 'h3', text: 'Endpoints' },
    {
      type: 'table',
      head: ['Method', 'Path', 'Description'],
      rows: [
        [
          'GET',
          '/api/scheduled-changes',
          'List all scheduled changes. ?collection= ?item_id= ?status= filters.'
        ],
        ['POST', '/api/scheduled-changes', 'Create a new scheduled change.'],
        ['GET', '/api/scheduled-changes/:id', 'Single scheduled change.'],
        ['PATCH', '/api/scheduled-changes/:id', 'Update scheduled_at or payload (pending only).'],
        ['DELETE', '/api/scheduled-changes/:id', 'Cancel and delete a pending change.'],
        [
          'POST',
          '/api/scheduled-changes/:id/execute',
          'Manually execute a pending change immediately.'
        ]
      ]
    },
    {
      type: 'note',
      text: 'Automatic Inngest-based execution runs at the scheduled_at time. Manual execution via POST /:id/execute is available regardless of schedule.'
    }
  ]
}

export const contentOpsDataExport: DocSection = {
  id: 'content-ops-export',
  label: 'Data Export',
  content: [
    { type: 'h1', id: 'content-ops-export', text: 'Data Export' },
    {
      type: 'p',
      text: 'Any collection can be exported to CSV, JSON, or XLSX via a single POST endpoint. All active filters, sort, and field selections are respected. The export bypasses pagination and returns the full result set.'
    },
    { type: 'h3', text: 'Exporting from the admin UI' },
    {
      type: 'p',
      text: 'In the collection browser, the Export popover in the toolbar exports exactly what you see: the current filters, sort, and visible columns carry over, and you pick the format (CSV, JSON, or XLSX) before downloading. The endpoint below is the programmatic path for scripts and integrations.'
    },
    { type: 'h3', text: 'Export endpoint' },
    {
      type: 'pre',
      code: `POST /api/content-export/:collection
Authorization: Bearer <token>
Content-Type: application/json

{
  "format": "csv",          // csv | json | xlsx
  "fields": ["id", "title", "status", "created_at"],  // omit for all fields
  "filter": {               // optional — same filter DSL as items API
    "status": { "_eq": "active" }
  },
  "sort": ["-created_at"]   // optional sort array
}

// Response headers for csv/xlsx:
Content-Disposition: attachment; filename="articles_2026-06-09.csv"
Content-Type: text/csv

// Response for json format:
{ "data": [...] }`
    },
    {
      type: 'note',
      text: "Export respects the current user's RBAC field permissions. Fields the user cannot read are excluded from the export regardless of what is specified in the fields array."
    }
  ]
}

export const contentOpsFieldGroups: DocSection = {
  id: 'content-ops-field-groups',
  label: 'Field Groups / Tabs',
  content: [
    { type: 'h1', id: 'content-ops-field-groups', text: 'Field Groups and Tabs' },
    {
      type: 'p',
      text: 'Field groups organize fields into collapsible sections or named tabs on the item edit page. Groups are defined per collection in `nivaro_field_groups` and referenced from `nivaro_fields.group_key`.'
    },
    { type: 'h3', text: 'Group types' },
    {
      type: 'table',
      head: ['Type', 'Behaviour in item editor'],
      rows: [
        [
          'section',
          'Collapsible card with a label and optional icon. Fields stack vertically inside.'
        ],
        [
          'tab',
          'Named tab in a tabbed interface at the top of the form. All tab-type groups for a collection appear as tabs together.'
        ],
        [
          'metadata',
          'Read-only display group. Fields inside render as a definition list (label: value) rather than editable inputs — ideal for display-only reference data on the record.'
        ]
      ]
    },
    { type: 'h3', text: 'Tab group behaviour' },
    {
      type: 'p',
      text: 'When a collection has at least one group of `type: "tab"`, the item editor renders a tab strip at the top of the form. Fields without a group_key appear in an implicit "General" tab alongside any section-type groups. The active tab is persisted per collection in localStorage, so editors return to the same tab on revisit.'
    },
    {
      type: 'p',
      text: 'Fields with validation errors cause a red dot indicator to appear on their tab, making it easy to spot which tab contains a problem without switching manually.'
    },
    { type: 'h3', text: 'Managing groups' },
    {
      type: 'p',
      text: "Go to Data Model → select a table → click the Groups tab in the right panel. Create groups with a key (slug), label, type, optional icon, and sort order. Assign a field to a group by setting its group_key to the group's key. To toggle a group between section and tab types, click the type badge on the group row."
    },
    { type: 'h3', text: 'Field Groups API' },
    {
      type: 'table',
      head: ['Method', 'Path', 'Description'],
      rows: [
        [
          'GET',
          '/api/field-groups?collection=:col',
          'List all groups for a collection, ordered by sort.'
        ],
        [
          'POST',
          '/api/field-groups',
          'Create a group. Body: { collection, key, label, type, icon?, sort?, is_collapsed? }.'
        ],
        ['PATCH', '/api/field-groups/:id', 'Update a group.'],
        ['DELETE', '/api/field-groups/:id', 'Delete a group (fields are unassigned, not deleted).'],
        ['POST', '/api/field-groups/reorder', 'Bulk reorder. Body: [{ id, sort }].']
      ]
    },
    {
      type: 'note',
      text: 'Fields with no group_key appear above any grouped sections in the item editor (or in the implicit "General" tab when tabs are active). The is_collapsed flag sets the initial open/closed state for section-type groups.'
    }
  ]
}

export const contentOpsFieldVisibility: DocSection = {
  id: 'content-ops-field-visibility',
  label: 'Field Visibility Rules',
  content: [
    { type: 'h1', id: 'content-ops-field-visibility', text: 'Conditional Field Visibility' },
    {
      type: 'p',
      text: 'Fields can be shown or hidden based on the value of another field in the same record. Visibility rules are evaluated in real time in the item editor as the user changes values — no save required.'
    },
    { type: 'h3', text: 'Managing in the admin UI' },
    {
      type: 'p',
      text: 'Visibility rules are edited in Data Model → select the table → Behavior tab. Pick a field, add conditions with the field/operator/value builder, and the rule is saved to the field config — no JSON editing required. The format and API below are for programmatic setups.'
    },
    { type: 'h3', text: 'Rule format' },
    {
      type: 'p',
      text: 'The `visibility_rules` column on `nivaro_fields` holds a JSON object with a `conditions` array. All conditions must pass for the field to be visible (AND logic). Use an `_or` array inside conditions for OR logic.'
    },
    {
      type: 'pre',
      code: `// Show this field only when type = "external" AND priority is not null
{
  "conditions": [
    { "field": "type",     "operator": "_eq",   "value": "external" },
    { "field": "priority", "operator": "_nnull", "value": null }
  ]
}

// Operators: _eq | _neq | _null | _nnull | _in | _contains`
    },
    { type: 'h3', text: 'Configuring via API' },
    {
      type: 'pre',
      code: `PATCH /api/field-config/:collection/:field
Authorization: Bearer <admin-token>

{
  "visibility_rules": {
    "conditions": [
      { "field": "type", "operator": "_eq", "value": "external" }
    ]
  }
}`
    },
    { type: 'h3', text: 'Evaluate endpoint' },
    {
      type: 'pre',
      code: `POST /api/field-config/:collection/:field/evaluate-visibility

{ "record": { "type": "external", "priority": 2 } }

→ { "data": { "visible": true } }`
    }
  ]
}

export const contentOpsFieldLocking: DocSection = {
  id: 'content-ops-field-locking',
  label: 'Field Locking',
  content: [
    { type: 'h1', id: 'content-ops-field-locking', text: 'Field Locking Rules' },
    {
      type: 'p',
      text: 'A field can be made read-only (locked) when a condition on the record is met. Locked fields render as disabled inputs in the item editor. The lock is also enforced server-side — PATCH requests that attempt to change a locked field are silently ignored.'
    },
    { type: 'h3', text: 'Managing in the admin UI' },
    {
      type: 'p',
      text: 'Lock conditions are configured in Data Model → select the table → Behavior tab, using the same condition builder as visibility rules. Choose the field to lock and the condition under which it becomes read-only.'
    },
    { type: 'h3', text: 'Lock condition format' },
    {
      type: 'p',
      text: 'The `lock_condition` column on `nivaro_fields` uses the same condition format as visibility rules.'
    },
    {
      type: 'pre',
      code: `// Lock the field when the record's status is "approved"
{
  "conditions": [
    { "field": "status", "operator": "_eq", "value": "approved" }
  ]
}`
    },
    { type: 'h3', text: 'API' },
    {
      type: 'pre',
      code: `PATCH /api/field-config/:collection/:field
{ "lock_condition": { "conditions": [{ "field": "status", "operator": "_eq", "value": "approved" }] } }

// Evaluate lock state for a given record:
POST /api/field-config/:collection/:field/evaluate-lock
{ "record": { "status": "approved" } }
→ { "data": { "locked": true } }`
    }
  ]
}

export const contentOpsFieldDependencies: DocSection = {
  id: 'content-ops-field-dependencies',
  label: 'Field Dependencies',
  content: [
    {
      type: 'h1',
      id: 'content-ops-field-dependencies',
      text: 'Field Dependencies and Cascading Values'
    },
    {
      type: 'p',
      text: 'Field dependencies describe relationships between fields where changing one field should clear or recalculate dependent fields. When a trigger field changes, the item editor calls the cascade endpoint to get updated values for dependent fields.'
    },
    { type: 'h3', text: 'Managing in the admin UI' },
    {
      type: 'p',
      text: 'Dependencies are configured in Data Model → select the table → Behavior tab: pick the dependent field, choose its trigger fields, and select the cascade behaviour (clear or recalculate). The JSON below is what the builder stores.'
    },
    { type: 'h3', text: 'Dependency config format' },
    {
      type: 'pre',
      code: `// dependency_config on a dependent field:
{
  "depends_on": ["category", "region"],   // trigger fields
  "cascade": "clear"                      // clear | recalculate
}`
    },
    { type: 'h3', text: 'Cascade endpoint' },
    {
      type: 'pre',
      code: `POST /api/field-config/:collection/:field/cascade
Authorization: Bearer <token>

{
  "record": { "category": "hardware", "region": "EMEA", "sub_category": "servers" },
  "changed_field": "category"
}

→ {
  "data": {
    "updates": {
      "sub_category": null    // cleared because depends_on category changed
    }
  }
}`
    },
    {
      type: 'note',
      text: 'The cascade endpoint returns only the fields that should be updated. The item editor merges these updates into the current form state without triggering a full reload.'
    }
  ]
}

export const contentOpsCascadeFilters: DocSection = {
  id: 'content-ops-cascade-filters',
  label: 'Cascade Filters',
  content: [
    { type: 'h1', id: 'content-ops-cascade-filters', text: 'Cascade Filters' },
    {
      type: 'p',
      text: 'M2O fields support cascading option filtering via `cascade_filters` in `dependency_config`. When a parent field value is selected, the child M2O field\'s option list is automatically narrowed to only records matching that parent value. Multi-level chains (e.g. Division → Region → Site) are fully supported.'
    },
    { type: 'h3', text: 'How it works' },
    {
      type: 'p',
      text: 'When the item editor loads or a field changes, `RelationPicker` checks for active `cascade_filters` rules. For each rule whose `parent_field` has a value, it appends a `?filter` parameter to the options fetch (`WHERE filter_column = parentValue`). If `clear_on_parent_change` is true, changing the parent field nulls this field automatically with an amber flash animation.'
    },
    { type: 'h3', text: 'Config format' },
    {
      type: 'pre',
      code: `// dependency_config on the child M2O field:
{
  "cascade_filters": [
    {
      "parent_field": "division_id",
      "filter_column": "division_id",
      "clear_on_parent_change": true
    }
  ]
}`
    },
    { type: 'h3', text: 'Properties' },
    {
      type: 'table',
      head: ['Property', 'Type', 'Description'],
      rows: [
        ['parent_field', 'string', 'Field name in the same collection whose selected value drives the filter.'],
        ['filter_column', 'string', 'Column on the M2O related table to filter by (WHERE filter_column = parent_value).'],
        ['clear_on_parent_change', 'boolean?', 'If true, nulls this field whenever the parent value changes. Defaults to false.'],
        ['clear_on_unavailable', 'boolean?', 'If true, the editor checks whether the current value is still within the filtered option set whenever the filter changes. If the selected value is not in the new options, it is automatically cleared.'],
        ['parent_field', 'string', 'Works with both M2O and M2M parent fields. M2M parent: uses the first staged selection as the filter value.']
      ]
    },
    { type: 'h3', text: 'M2M-to-M2M cascades' },
    {
      type: 'p',
      text: 'Cascade filters now work correctly when both the parent and child are M2M fields. When the parent is M2M, the child option fetch uses the `_some` filter operator so that child records are matched against any of the parent\'s staged selections, rather than a single value. No extra configuration is required — set `parent_field` to the M2M parent and the editor picks the right operator automatically.'
    },
    { type: 'h3', text: 'Editing existing rules' },
    {
      type: 'p',
      text: 'In the Cascade Filters section of the ⚙ field settings popover, each saved rule shows a pencil icon — click it to edit the rule inline. Every option is editable: parent field, filter column, clear on change, and clear if unavailable. Save field settings to persist the change.'
    },
    { type: 'h3', text: 'Multi-level chain example' },
    {
      type: 'pre',
      code: `// Region field — filtered by Division:
{
  "cascade_filters": [
    { "parent_field": "division_id", "filter_column": "division_id", "clear_on_parent_change": true }
  ]
}

// Site field — filtered by Region:
{
  "cascade_filters": [
    { "parent_field": "region_id", "filter_column": "region_id", "clear_on_parent_change": true }
  ]
}

// Selecting a Division auto-filters Regions.
// Selecting a Region auto-filters Sites.
// Changing Division clears Region (and Region clearing clears Site via its own rule).`
    },
    { type: 'h3', text: 'Configuring in the admin UI' },
    {
      type: 'p',
      text: 'Open Data Model → select the collection → click the ⚙ icon on an M2O field → scroll to the Cascade Filters section. Add a rule by picking the parent field and the filter column on the related table. Save field settings to persist.'
    },
    {
      type: 'note',
      text: 'Cascade filters are evaluated client-side only at edit time. They do not affect API list queries or server-side filtering — they are a UX convenience for narrowing picker options during data entry.'
    }
  ]
}

export const contentOpsValidationRules: DocSection = {
  id: 'content-ops-validation',
  label: 'Validation Rules',
  content: [
    { type: 'h1', id: 'content-ops-validation', text: 'Field Validation Rules' },
    {
      type: 'p',
      text: 'Validation rules go beyond the basic required/type checks and let you define custom conditions that must pass before an item can be saved. Rules are stored in `nivaro_fields.validation_rules` as a JSON array and enforced server-side on every create and update.'
    },
    { type: 'h3', text: 'Managing in the admin UI' },
    {
      type: 'p',
      text: 'Validation rules are managed in Data Model → select the table → Behavior tab. Add rules per field by picking a rule type, filling in its parameters, and writing the error message shown to editors. The raw format and API below cover programmatic configuration.'
    },
    { type: 'h3', text: 'Rule format' },
    {
      type: 'pre',
      code: `[
  {
    "type": "min_length",
    "params": { "length": 10 },
    "message": "Title must be at least 10 characters"
  },
  {
    "type": "regex",
    "params": { "pattern": "^[A-Z]{2}-\\\\d{4}$" },
    "message": "Code must match format XX-0000"
  },
  {
    "type": "max_value",
    "params": { "value": 100 },
    "message": "Percentage cannot exceed 100"
  }
]`
    },
    { type: 'h3', text: 'Built-in rule types' },
    {
      type: 'table',
      head: ['type', 'params', 'Description'],
      rows: [
        ['min_length', '{ length: N }', 'String must be at least N characters.'],
        ['max_length', '{ length: N }', 'String cannot exceed N characters.'],
        ['min_value', '{ value: N }', 'Numeric value must be >= N.'],
        ['max_value', '{ value: N }', 'Numeric value must be <= N.'],
        ['regex', '{ pattern: string }', 'Value must match the regular expression.'],
        ['unique', '{}', 'Value must be unique across the collection (server-side check).'],
        ['email', '{}', 'Value must be a valid email address.'],
        ['url', '{}', 'Value must be a valid URL.'],
        ['date_after', '{ date: ISO }', 'Date must be after the given ISO date.'],
        ['date_before', '{ date: ISO }', 'Date must be before the given ISO date.']
      ]
    },
    { type: 'h3', text: 'Configuring via API' },
    {
      type: 'pre',
      code: `PATCH /api/field-config/:collection/:field

{
  "validation_rules": [
    { "type": "min_length", "params": { "length": 5 }, "message": "Too short" },
    { "type": "regex", "params": { "pattern": "^[A-Z]" }, "message": "Must start with uppercase" }
  ]
}`
    }
  ]
}

export const contentOpsComputedDefaults: DocSection = {
  id: 'content-ops-defaults',
  label: 'Computed Defaults',
  content: [
    { type: 'h1', id: 'content-ops-defaults', text: 'Computed Default Values' },
    {
      type: 'p',
      text: 'Fields can have a `default_formula` expression that is evaluated when a new item is created and the field has no value provided. Formulas are evaluated server-side using the same expr-eval engine as computed fields.'
    },
    { type: 'h3', text: 'Managing in the admin UI' },
    {
      type: 'p',
      text: 'Default formulas are set in Data Model → select the table → Behavior tab: choose a field and enter (or build with the formula builder) the expression that should populate it on create.'
    },
    { type: 'h3', text: 'Formula examples' },
    {
      type: 'pre',
      code: `// Date functions
TODAY()               // current date as ISO string
NOW()                 // current datetime as ISO string
TODAY_PLUS(7)         // 7 days from today

// String transformations
UPPER(item.name)
LOWER(item.email)
CONCAT(item.first_name, " ", item.last_name)

// Numeric defaults
item.quantity * item.unit_price
0                     // explicit zero default`
    },
    { type: 'h3', text: 'Configuring via API' },
    {
      type: 'pre',
      code: `PATCH /api/field-config/:collection/:field

{ "default_formula": "TODAY_PLUS(30)" }

// Evaluate what the default would produce for a given record:
POST /api/field-config/:collection/:field/evaluate-defaults
{ "record": { "first_name": "Jane", "last_name": "Smith" } }
→ { "data": { "default": "Jane Smith" } }`
    },
    {
      type: 'note',
      text: 'default_formula is only evaluated when the field value is absent on create. It does not override explicit values provided in the payload, and it does not run on updates.'
    }
  ]
}

export const contentOpsCrossRecordDefaults: DocSection = {
  id: 'content-ops-cross-record-defaults',
  label: 'Cross-Record Defaults',
  content: [
    { type: 'h1', id: 'content-ops-cross-record-defaults', text: 'Cross-Record Defaults' },
    {
      type: 'p',
      text: 'Cross-record defaults copy field values from a related record when a new item is created. The config specifies which FK field identifies the related record, which collection it points to, and a mapping of source → target fields.'
    },
    { type: 'h3', text: 'Managing in the admin UI' },
    {
      type: 'p',
      text: 'Cross-record defaults are configured in Data Model → select the table → Behavior tab: pick the target field, the FK field that identifies the source record, and map source fields to target fields with comboboxes.'
    },
    { type: 'h3', text: 'Config format' },
    {
      type: 'pre',
      code: `// On the orders collection, when customer_id is set,
// copy billing_address and payment_terms from the customer record:
{
  "source_collection": "customers",
  "source_fk_field": "customer_id",
  "field_map": {
    "billing_address": "billing_address",
    "payment_terms":   "default_payment_terms"
  }
}
// field_map: { target_field_on_orders: source_field_on_customers }`
    },
    { type: 'h3', text: 'Configuring via API' },
    {
      type: 'pre',
      code: `PATCH /api/field-config/orders/billing_address

{
  "cross_record_defaults": {
    "source_collection": "customers",
    "source_fk_field": "customer_id",
    "field_map": { "billing_address": "billing_address" }
  }
}`
    }
  ]
}

export const contentOpsRemoteOptions: DocSection = {
  id: 'content-ops-remote-options',
  label: 'Remote Option Sources',
  content: [
    { type: 'h1', id: 'content-ops-remote-options', text: 'Remote Option Sources' },
    {
      type: 'p',
      text: 'Dropdown and select fields can load their options from an External API instead of a static list. The `remote_options_config` on a field points to a configured External API, a JSON path into the response, and label/value field mappings.'
    },
    { type: 'h3', text: 'Managing in the admin UI' },
    {
      type: 'p',
      text: 'Remote options are configured in Data Model → select the table → Behavior tab: pick the select field, choose one of your configured External APIs, set the endpoint and data path, and map the label/value fields. A test button previews the options the editor will show.'
    },
    { type: 'h3', text: 'Config format' },
    {
      type: 'pre',
      code: `{
  "externalApiId": 5,           // ID from nivaro_external_apis
  "endpoint": "/products",      // path appended to the API's base_url
  "method": "GET",              // optional, defaults to GET
  "dataPath": "data.items",     // dot-path into the response JSON to the array
  "labelField": "name",         // field in each item to display as the label
  "valueField": "id",           // field in each item to store as the value
  "searchParam": "q",           // optional — query param name for search-as-you-type
  "cacheSeconds": 300           // optional — cache the response for N seconds
}`
    },
    { type: 'h3', text: 'Configuring via API' },
    {
      type: 'pre',
      code: `PATCH /api/field-config/:collection/:field

{
  "remote_options_config": {
    "externalApiId": 5,
    "endpoint": "/products",
    "dataPath": "data",
    "labelField": "title",
    "valueField": "sku"
  }
}`
    },
    {
      type: 'note',
      text: 'The item editor fetches remote options via the External APIs proxy so credentials never leave the server. The user only sees the label/value pairs.'
    }
  ]
}

export const contentOpsRepeaterFields: DocSection = {
  id: 'content-ops-repeater',
  label: 'Repeater Fields',
  content: [
    { type: 'h1', id: 'content-ops-repeater', text: 'Repeater Fields' },
    {
      type: 'p',
      text: 'A repeater field stores an ordered array of structured sub-objects in a single JSON column. Each sub-object follows a schema defined in `repeater_schema` on the field. In the item editor, repeaters render as a dynamic list of sub-forms with add/remove/reorder controls.'
    },
    { type: 'h3', text: 'Schema format' },
    {
      type: 'pre',
      code: `// repeater_schema — array of column definitions:
[
  { "key": "title",    "label": "Title",    "type": "string",  "required": true },
  { "key": "url",      "label": "URL",      "type": "string" },
  { "key": "weight",   "label": "Weight",   "type": "number" },
  { "key": "is_active","label": "Active",   "type": "boolean" }
]

// Supported sub-field types: string | number | boolean | date | select
// For select, add "options": [{ "label": "...", "value": "..." }]`
    },
    { type: 'h3', text: 'Stored value format' },
    {
      type: 'pre',
      code: `// The field stores a JSON array in the database column:
[
  { "title": "Homepage", "url": "https://example.com", "weight": 1, "is_active": true },
  { "title": "Blog",     "url": "https://example.com/blog", "weight": 2, "is_active": true }
]`
    },
    { type: 'h3', text: 'Configuring via API' },
    {
      type: 'pre',
      code: `// When creating or updating a field in the schema editor:
POST /api/collections/:collection/fields
{
  "field": "links",
  "type": "json",
  "interface": "repeater",
  "repeater_schema": [
    { "key": "title", "label": "Title",  "type": "string", "required": true },
    { "key": "url",   "label": "URL",    "type": "string" }
  ]
}`
    }
  ]
}

export const contentOpsRichText: DocSection = {
  id: 'content-ops-rich-text',
  label: 'Rich Text Fields',
  content: [
    { type: 'h1', id: 'content-ops-rich-text', text: 'Rich Text / WYSIWYG Fields' },
    {
      type: 'p',
      text: 'Rich text fields support two interfaces: `"input-rich-text-html"` (WYSIWYG, stores HTML) and `"input-rich-text-md"` (Markdown editor, stores a Markdown string). Both render an enhanced editor in the item edit page — choose based on how the content will be consumed downstream.'
    },
    { type: 'h3', text: 'Interface options' },
    {
      type: 'table',
      head: ['interface', 'Editor', 'Stored format', 'Best for'],
      rows: [
        [
          'input-rich-text-html',
          'TipTap WYSIWYG',
          'HTML string (nvarchar(max))',
          'Content rendered directly in a browser; design systems that consume HTML.'
        ],
        [
          'input-rich-text-md',
          'Markdown editor',
          'Markdown string (nvarchar(max))',
          'Documentation, developer-facing content, or pipelines that compile Markdown.'
        ]
      ]
    },
    { type: 'h3', text: 'Toolbar (WYSIWYG)' },
    {
      type: 'p',
      text: 'The `input-rich-text-html` editor exposes: Bold, Italic, Underline, Strikethrough, H1–H3, Ordered list, Unordered list, Blockquote, Code block, Horizontal rule, and Link.'
    },
    { type: 'h3', text: 'Field definition' },
    {
      type: 'pre',
      code: `// WYSIWYG — stores HTML:
POST /api/collections/:collection/fields
{
  "field": "body",
  "type": "text",
  "interface": "input-rich-text-html"
}

// Markdown editor — stores Markdown:
POST /api/collections/:collection/fields
{
  "field": "notes",
  "type": "text",
  "interface": "input-rich-text-md"
}`
    },
    { type: 'h3', text: 'Stored format' },
    {
      type: 'p',
      text: "The WYSIWYG editor stores a plain HTML string — the API returns it as-is. Render it directly with your front-end framework's HTML output. The Markdown editor stores a plain Markdown string."
    },
    {
      type: 'pre',
      code: `// input-rich-text-html stored value:
"<h2>Introduction</h2><p>Body content here.</p>"

// input-rich-text-md stored value:
"## Introduction\\n\\nBody content here."`
    }
  ]
}

export const contentOpsDatetimeAuto: DocSection = {
  id: 'content-ops-datetime-auto',
  label: 'Datetime Auto-fields',
  content: [
    { type: 'h1', id: 'content-ops-datetime-auto', text: 'Datetime Auto-fields' },
    {
      type: 'p',
      text: 'Datetime and timestamp fields can be configured to automatically stamp the current server date/time on record create, update, or both. The value is always the server timestamp (ISO 8601 UTC) — not the client clock.'
    },
    { type: 'h3', text: 'Configuring in the admin UI' },
    {
      type: 'p',
      text: 'In Data Model → select a table → click a datetime field\'s config → set "On Create" and/or "On Update" to "Save Current Date/Time". The setting is stored in the field\'s options JSON.'
    },
    { type: 'h3', text: 'Options format' },
    {
      type: 'pre',
      code: `// On create only (e.g. created_at):
{ "on_create": "now" }

// On update only (e.g. updated_at):
{ "on_update": "now" }

// On both (e.g. last_touched):
{ "on_create": "now", "on_update": "now" }`
    },
    { type: 'h3', text: 'Execution order' },
    {
      type: 'p',
      text: 'Auto-stamping is applied server-side in the items service before the write — after field rules, before computed fields. The auto value always wins over any client-supplied value for the same field.'
    },
    { type: 'h3', text: 'Common use cases' },
    {
      type: 'table',
      head: ['Field name', 'on_create', 'on_update', 'Purpose'],
      rows: [
        ['created_at', 'now', '—', 'Immutable creation timestamp.'],
        ['updated_at', '—', 'now', 'Last-modified timestamp, updated on every save.'],
        ['last_touched', 'now', 'now', 'Tracks first and last interaction time in one field.']
      ]
    },
    { type: 'h3', text: 'Configuring via API' },
    {
      type: 'pre',
      code: `POST /api/collections/:collection/fields
Authorization: Bearer <admin-token>

{
  "field": "updated_at",
  "type": "datetime",
  "interface": "datetime",
  "options": "{\\"on_update\\":\\"now\\"}"
}

// Or update an existing field:
PATCH /api/collections/:collection/fields/updated_at
{ "options": "{\\"on_update\\":\\"now\\"}" }`
    },
    {
      type: 'note',
      text: 'The options column is stored as a JSON string (nvarchar). Always stringify when writing via the API.'
    }
  ]
}

export const contentOpsSubRows: DocSection = {
  id: 'content-ops-sub-rows',
  label: 'Sub-rows',
  content: [
    { type: 'h1', id: 'content-ops-sub-rows', text: 'Sub-rows' },
    {
      type: 'p',
      text: 'Sub-rows are ordered child rows attached to a parent record. Unlike repeater fields (JSON in a single column), sub-rows are stored in the `nivaro_sub_rows` table as proper rows, making them queryable and suitable for rollup aggregation. They are ideal for bills of material, ingredient lists, task lists, and similar structured sub-records.'
    },
    { type: 'h3', text: 'Managing in the admin UI' },
    {
      type: 'p',
      text: 'Sub-rows are edited inline on the item edit page as an editable grid with add/remove/reorder controls. The Templates dropdown on each sub-rows field saves the current rows as a reusable template or applies an existing one.'
    },
    { type: 'h3', text: 'API' },
    {
      type: 'table',
      head: ['Method', 'Path', 'Description'],
      rows: [
        [
          'GET',
          '/api/sub-rows/:collection/:itemId/:field',
          'List all sub-rows for a parent record + field, ordered by sort.'
        ],
        [
          'PATCH',
          '/api/sub-rows/:collection/:itemId/:field',
          'Bulk replace all sub-rows for the parent+field combo. Body: { items: [...] }.'
        ],
        [
          'POST',
          '/api/sub-rows/reorder',
          'Reorder. Body: { collection, item_id, field, order: [{ id, sort }] }.'
        ]
      ]
    },
    { type: 'h3', text: 'Row format' },
    {
      type: 'pre',
      code: `GET /api/sub-rows/purchase_orders/uuid/components
→ {
  "data": [
    { "id": 1, "sort": 1,
      "data": { "sku": "WIDGET-A", "qty": 10, "unit_price": 4.99 } }
  ]
}

// PATCH body — replaces ALL rows for this parent+field:
{
  "items": [
    { "sort": 1, "data": { "sku": "WIDGET-A", "qty": 10, "unit_price": 4.99 } },
    { "sort": 2, "data": { "sku": "WIDGET-B", "qty": 5,  "unit_price": 9.99 } }
  ]
}`
    },
    { type: 'h3', text: 'Sub-row templates' },
    {
      type: 'p',
      text: 'Reusable sets of sub-rows can be saved as templates in `nivaro_sub_row_templates` and applied to any compatible parent record.'
    },
    {
      type: 'table',
      head: ['Method', 'Path', 'Description'],
      rows: [
        [
          'GET',
          '/api/sub-rows/templates/:collection/:field',
          'List available templates for this collection+field.'
        ],
        [
          'POST',
          '/api/sub-rows/templates',
          'Save current rows as a named template. Body: { collection, field, name, items }.'
        ],
        [
          'POST',
          '/api/sub-rows/templates/:templateId/apply',
          'Apply a template — returns rows for merging into the editor.'
        ],
        ['DELETE', '/api/sub-rows/templates/:templateId', 'Delete a template.']
      ]
    },
    {
      type: 'note',
      text: 'PATCH /sub-rows bulk-replaces all rows for the given parent+field combination. There is no partial update — always send the full desired list.'
    }
  ]
}

export const contentOpsTranslations: DocSection = {
  id: 'content-ops-translations',
  label: 'Field Translations (i18n)',
  content: [
    { type: 'h1', id: 'content-ops-translations', text: 'Multi-Language Field Values (i18n)' },
    {
      type: 'p',
      text: 'Fields marked `is_translatable: true` can have separate values per locale. Translation values are stored in `nivaro_field_translations` and returned as a `_translations` map on the field when requested.'
    },
    { type: 'h3', text: 'Managing in the admin UI' },
    {
      type: 'ul',
      items: [
        'Translating values: in the item editor, every translatable field shows a globe button — click it to open the per-locale editor and enter values for each language side by side.',
        'Available locales: managed in Settings → Localization (stored in `nivaro_settings.available_locales`). Locales added there appear in every field translation editor.',
        'Marking fields translatable: Data Model → select the table → Content tab → per-field "Translatable" toggle (string/text fields).'
      ]
    },
    { type: 'h3', text: 'Marking a field as translatable' },
    {
      type: 'pre',
      code: `// Via the Data Model field editor — toggle "Translatable" on string/text fields.
// Via API:
PATCH /api/collections/:collection/fields/:field
{ "is_translatable": true }`
    },
    { type: 'h3', text: 'Reading translations' },
    {
      type: 'pre',
      code: `GET /api/field-translations/:collection/:itemId
Authorization: Bearer <token>

→ {
  "data": {
    "title": {
      "en": "Product Guide",
      "fr": "Guide du Produit",
      "de": "Produkthandbuch"
    },
    "description": {
      "en": "Full description...",
      "fr": "Description complète..."
    }
  }
}

// List available locales across all translations:
GET /api/field-translations/:collection/:itemId/locales
→ { "data": ["en", "fr", "de"] }`
    },
    { type: 'h3', text: 'Writing translations' },
    {
      type: 'pre',
      code: `PATCH /api/field-translations/:collection/:itemId
Authorization: Bearer <token>

{
  "locale": "fr",
  "values": {
    "title": "Guide du Produit",
    "description": "Description complète..."
  }
}

→ 200 { "data": { "updated": 2 } }`
    },
    {
      type: 'note',
      text: 'UNIQUE constraint on (collection, item_id, field, locale). Each PATCH upserts — it inserts if the locale/field pair does not exist, updates if it does.'
    }
  ]
}

export const contentOpsRecordTemplates: DocSection = {
  id: 'content-ops-record-templates',
  label: 'Record Templates',
  content: [
    { type: 'h1', id: 'content-ops-record-templates', text: 'Record Templates' },
    {
      type: 'p',
      text: 'Record templates let you save a named set of field values that can be applied when creating a new item. Templates can be personal (tied to your user) or shared (available to all users), and optionally role-scoped.'
    },
    { type: 'h3', text: 'Managing in the admin UI' },
    {
      type: 'p',
      text: 'On any item edit page, use the Templates menu in the header to save the current field values as a named template. On the create-new-item page, the "New from template" picker pre-fills fields from a chosen template. All templates across collections are managed centrally on the /record-templates page — rename, edit values, change sharing, or delete from there.'
    },
    { type: 'h3', text: 'API' },
    {
      type: 'table',
      head: ['Method', 'Path', 'Description'],
      rows: [
        [
          'GET',
          '/api/record-templates?collection=:col',
          'List templates for a collection. Returns personal + shared templates.'
        ],
        [
          'POST',
          '/api/record-templates',
          'Create a template. Body: { collection, name, data, is_shared?, role_id? }.'
        ],
        ['GET', '/api/record-templates/:id', 'Single template.'],
        ['PATCH', '/api/record-templates/:id', 'Update a template.'],
        ['DELETE', '/api/record-templates/:id', 'Delete a template.'],
        [
          'POST',
          '/api/record-templates/:id/apply',
          'Returns the template data as a pre-fill payload. Body: { overrides? }.'
        ]
      ]
    },
    { type: 'h3', text: 'Template object' },
    {
      type: 'pre',
      code: `{
  "id": "uuid",
  "collection": "contracts",
  "name": "Standard NDA",
  "is_shared": true,
  "role_id": null,             // null = all roles; FK to nivaro_roles
  "data": {
    "type": "nda",
    "currency": "USD",
    "payment_terms": "net30"
  },
  "created_by": "user-uuid",
  "created_at": "..."
}`
    }
  ]
}

export const contentOpsCollectionPresets: DocSection = {
  id: 'content-ops-collection-presets',
  label: 'Collection Presets',
  content: [
    { type: 'h1', id: 'content-ops-collection-presets', text: 'Collection Presets (Starter Kits)' },
    {
      type: 'p',
      text: 'Collection presets are pre-built schema bundles that scaffold complete collections with fields, relations, workflows, and dashboards in a single click. They are designed for common use cases and save hours of manual schema setup.'
    },
    { type: 'h3', text: 'Managing in the admin UI' },
    {
      type: 'p',
      text: 'Presets are installed from the /collection-presets page (also reachable via Collections → "Install preset"). Each preset card shows what it will create; click Install and the collections appear in the registry immediately.'
    },
    { type: 'h3', text: 'Available presets' },
    {
      type: 'table',
      head: ['Preset', 'Collections created', 'Description'],
      rows: [
        [
          'blog',
          'posts, categories, tags, authors',
          'Full blog schema with rich text body, publish workflow, and category taxonomy.'
        ],
        [
          'crm',
          'contacts, companies, deals, activities',
          'Sales CRM with pipeline workflow, company hierarchy, and activity log.'
        ],
        [
          'project_tracker',
          'projects, tasks, milestones, time_entries',
          'Project management with task assignments, milestone tracking, and time logging.'
        ],
        [
          'event_manager',
          'events, sessions, speakers, registrations',
          'Event management with session scheduling, speaker profiles, and attendee registration.'
        ],
        [
          'ecommerce',
          'products, orders, inventory_movements',
          'Headless shop primitives with a stock ledger and a pre-wired low-stock alert. See E-Commerce Primitives.'
        ]
      ]
    },
    { type: 'h3', text: 'Installing via API' },
    {
      type: 'pre',
      code: `GET /api/collection-presets
→ { "data": [{ "id": "blog", "name": "Blog", "description": "...", "collections": [...] }] }

// Preview what will be created:
GET /api/collection-presets/blog

// Install:
POST /api/collection-presets/blog/install
Authorization: Bearer <admin-token>
{ "workspace_id": "uuid" }   // optional — defaults to current workspace

→ {
  "data": {
    "created_collections": ["posts", "categories", "tags", "authors"],
    "created_workflows": ["post_publish_workflow"],
    "created_dashboards": ["blog_overview"]
  }
}`
    },
    {
      type: 'note',
      text: 'Preset installation is idempotent by collection name — if a collection with the same name already exists in the workspace, its creation is skipped and existing data is preserved.'
    }
  ]
}

export const contentOpsVirtualCollections: DocSection = {
  id: 'content-ops-virtual-collections',
  label: 'Virtual Collections',
  content: [
    { type: 'h1', id: 'content-ops-virtual-collections', text: 'Virtual Collections' },
    {
      type: 'p',
      text: 'Virtual collections are read-only collections backed by a SQL query rather than a dedicated table. They appear in the collection browser and REST API like normal collections but do not support create, update, or delete. Use them to expose reporting views, cross-table joins, or aggregated data.'
    },
    { type: 'h3', text: 'Creating a virtual collection' },
    {
      type: 'pre',
      code: `POST /api/virtual-collections
Authorization: Bearer <admin-token>

{
  "collection": "order_summary",
  "label": "Order Summary",
  "virtual_sql": "SELECT o.id, o.created_at, c.name AS customer, SUM(li.amount) AS total FROM orders o JOIN customers c ON c.id = o.customer_id LEFT JOIN line_items li ON li.parent_id = o.id GROUP BY o.id, o.created_at, c.name",
  "description": "Aggregated order totals with customer name"
}`
    },
    { type: 'h3', text: 'Query execution' },
    {
      type: 'p',
      text: 'The API wraps the stored SQL as `SELECT TOP 100 * FROM (...) _v` with an optional `WHERE` clause built from filter parameters. This keeps the user-supplied SQL clean while still supporting filtering and pagination.'
    },
    {
      type: 'pre',
      code: `POST /api/virtual-collections/:collection/query
Authorization: Bearer <token>

{
  "filter": { "total": { "_gt": 1000 } },
  "limit": 25,
  "offset": 0
}

→ { "data": [...], "total": 142 }`
    },
    { type: 'h3', text: 'Validate SQL' },
    {
      type: 'pre',
      code: `POST /api/virtual-collections/:collection/validate-sql
{ "sql": "SELECT id, name FROM contacts WHERE active = 1" }

→ { "data": { "valid": true, "columns": ["id", "name"] } }
→ { "data": { "valid": false, "error": "Invalid object name 'contactss'" } }`
    },
    { type: 'h3', text: 'Management API' },
    {
      type: 'table',
      head: ['Method', 'Path', 'Description'],
      rows: [
        ['GET', '/api/virtual-collections', 'List all virtual collections.'],
        ['POST', '/api/virtual-collections', 'Create a virtual collection.'],
        ['GET', '/api/virtual-collections/:collection', 'Get config.'],
        ['PATCH', '/api/virtual-collections/:collection', 'Update SQL or metadata.'],
        [
          'DELETE',
          '/api/virtual-collections/:collection',
          'Remove from registry (no physical table affected).'
        ],
        [
          'POST',
          '/api/virtual-collections/:collection/validate-sql',
          'Validate SQL syntax and return column names.'
        ],
        [
          'POST',
          '/api/virtual-collections/:collection/query',
          'Query the virtual collection with optional filter/limit/offset.'
        ]
      ]
    },
    {
      type: 'note',
      text: '`is_virtual=1` and `virtual_sql` are set on the `nivaro_collections` row. Virtual collections do not support mutations — the items API returns 405 for create/update/delete on virtual collections.'
    }
  ]
}

export const contentOpsCloneItem: DocSection = {
  id: 'content-ops-clone',
  label: 'Clone Item',
  content: [
    { type: 'h1', id: 'content-ops-clone', text: 'Duplicate / Clone Item' },
    {
      type: 'p',
      text: "Any item can be duplicated (deep-cloned) with a single API call. The clone copies all field values, sets `_status=draft` if the collection has draft/publish enabled, and returns the new item's ID. The clone body accepts optional parameters to fine-tune what is copied."
    },
    { type: 'h3', text: 'Cloning from the admin UI' },
    {
      type: 'p',
      text: 'On the item edit page, use Duplicate in the header actions menu. A Clone dialog opens letting editors set field overrides, exclude fields, and choose which sub-row fields to copy — before the clone is created. The endpoint below is the programmatic equivalent.'
    },
    { type: 'h3', text: 'Clone endpoint' },
    {
      type: 'pre',
      code: `POST /api/items/:collection/:id/clone
Authorization: Bearer <token>

// All body properties are optional:
{
  "field_overrides": {
    "title": "Copy of Original Title",
    "status": "draft"
  },
  "exclude_fields": ["internal_notes", "locked_by"],
  "include_sub_rows": ["components", "line_items"]
}

→ 201 { "data": { "id": "new-uuid" } }`
    },
    { type: 'h3', text: 'Body parameters' },
    {
      type: 'table',
      head: ['Parameter', 'Type', 'Description'],
      rows: [
        [
          'field_overrides',
          'Record<string, unknown>',
          'Map of field → new value applied to the clone before insert. Useful for resetting status, renaming, or stamping a copy date.'
        ],
        [
          'exclude_fields',
          'string[]',
          'Field names to omit from the clone entirely. The cloned record will have null/default for these fields.'
        ],
        [
          'include_sub_rows',
          'string[]',
          'Sub-row field names whose child rows should be copied to the new record. Sub-rows are not copied by default.'
        ]
      ]
    },
    { type: 'h3', text: 'SDK usage' },
    {
      type: 'pre',
      code: `import { cloneItem } from '@nivaro/sdk'

const result = await cms.request(
  cloneItem('articles', 'source-uuid', {
    field_overrides: { title: 'Copy — review before publishing' },
    exclude_fields: ['published_at'],
    include_sub_rows: ['sections']
  })
)
console.log(result.data.id) // new item id`
    },
    {
      type: 'note',
      text: 'Clone triggers the same before/after create hooks as a normal create. Activity log records the action as "clone" with a reference to the source item ID.'
    }
  ]
}

export const contentOpsRollback: DocSection = {
  id: 'content-ops-rollback',
  label: 'Rollback Revision',
  content: [
    { type: 'h1', id: 'content-ops-rollback', text: 'Rollback to Revision' },
    {
      type: 'p',
      text: 'Any revision in the revision history can be restored, reverting the item to the exact field values captured at that point in time. Rollback creates a new revision marking the restore action.'
    },
    { type: 'h3', text: 'Rollback endpoint' },
    {
      type: 'pre',
      code: `POST /api/revisions/:id/rollback
Authorization: Bearer <token>

→ 200 {
  "data": {
    "item_id": "uuid",
    "collection": "articles",
    "restored_from_revision": 42,
    "new_revision_id": 87
  }
}`
    },
    { type: 'h3', text: 'In the admin UI' },
    {
      type: 'p',
      text: 'Open the Revisions panel on any item edit page. Each revision row shows the timestamp, user, and changed fields. Click Restore on any revision to roll back. A confirmation dialog shows a diff of the changes that will be applied.'
    },
    {
      type: 'note',
      text: 'Rollback runs through the normal update pipeline — before/after hooks fire, activity is logged, and a new revision is written capturing the restored snapshot.'
    }
  ]
}

export const contentOpsFieldHistory: DocSection = {
  id: 'content-ops-field-history',
  label: 'Field Change History',
  content: [
    { type: 'h1', id: 'content-ops-field-history', text: 'Field Change History Graph' },
    {
      type: 'p',
      text: "The field history endpoint returns a time series of a single field's values across all revisions of a record, suitable for rendering as a sparkline or mini chart."
    },
    { type: 'h3', text: 'Endpoint' },
    {
      type: 'pre',
      code: `GET /api/items/:collection/:id/field-history/:field
Authorization: Bearer <token>

// Response:
{
  "data": [
    { "revision_id": 12, "timestamp": "2026-01-01T09:00:00Z", "value": 1200, "user": "Jane Smith" },
    { "revision_id": 18, "timestamp": "2026-01-08T14:23:00Z", "value": 1350, "user": "Rob Lee" },
    { "revision_id": 24, "timestamp": "2026-02-01T11:00:00Z", "value": 1500, "user": "Jane Smith" }
  ]
}`
    },
    {
      type: 'p',
      text: 'The admin UI renders this data as a sparkline in the item editor for numeric fields. Hovering over a point shows the timestamp, value, and the user who made the change.'
    }
  ]
}

export const contentOpsAddendums: DocSection = {
  id: 'content-ops-addendums',
  label: 'Addendums / Amendments',
  content: [
    { type: 'h1', id: 'content-ops-addendums', text: 'Addendum and Amendment Records' },
    {
      type: 'p',
      text: 'Addendums are formal amendment records attached to a parent item. They support a draft → submitted → approved/rejected lifecycle with cost and timeline impact tracking. Once approved, addendums are promoted to Change Orders for audit trail purposes.'
    },
    { type: 'h3', text: 'Addendum lifecycle' },
    {
      type: 'table',
      head: ['Status', 'Description'],
      rows: [
        ['draft', 'Being authored. Can be edited freely.'],
        ['submitted', 'Sent for approval. Locked for editing.'],
        ['approved', 'Accepted. Promoted to a change order.'],
        ['rejected', 'Declined. May be edited and resubmitted.']
      ]
    },
    { type: 'h3', text: 'API' },
    {
      type: 'table',
      head: ['Method', 'Path', 'Description'],
      rows: [
        [
          'GET',
          '/api/addendums/:parentCollection/:parentId',
          'List all addendums for a parent record.'
        ],
        [
          'POST',
          '/api/addendums/:parentCollection/:parentId',
          'Create a draft addendum. Body: { title, description, cost_impact?, timeline_impact_days? }.'
        ],
        ['GET', '/api/addendums/:parentCollection/:parentId/:id', 'Single addendum.'],
        ['PATCH', '/api/addendums/:parentCollection/:parentId/:id', 'Update a draft addendum.'],
        ['DELETE', '/api/addendums/:parentCollection/:parentId/:id', 'Delete a draft addendum.'],
        ['POST', '/api/addendums/:parentCollection/:parentId/:id/submit', 'Submit for approval.'],
        [
          'POST',
          '/api/addendums/:parentCollection/:parentId/:id/approve',
          'Approve and promote to change order. Body: { note? }.'
        ],
        [
          'POST',
          '/api/addendums/:parentCollection/:parentId/:id/reject',
          'Reject. Body: { reason }.'
        ]
      ]
    },
    { type: 'h3', text: 'Change orders' },
    {
      type: 'p',
      text: 'Approved addendums generate a corresponding `nivaro_addendum_approvals` row that accumulates net cost and timeline impacts. Approvals are read-only once created — they form the immutable approved-change log.'
    },
    {
      type: 'pre',
      code: `// List change orders for a parent record:
GET /api/addendums/:parentCollection/:parentId/change-orders

→ {
  "data": [
    {
      "id": 1,
      "addendum_id": "uuid",
      "title": "Scope expansion — phase 2",
      "cost_impact": 15000,
      "timeline_impact_days": 14,
      "approved_at": "2026-03-01T10:00:00Z",
      "approved_by": { "id": "...", "first_name": "Jane", "last_name": "Smith" }
    }
  ],
  "net_cost_impact": 15000,
  "net_timeline_impact_days": 14
}`
    }
  ]
}

export const contentOpsPercentComplete: DocSection = {
  id: 'content-ops-percent-complete',
  label: '% Complete Field',
  content: [
    { type: 'h1', id: 'content-ops-percent-complete', text: '% Complete Field Type' },
    {
      type: 'p',
      text: 'The `percent_complete` interface renders a numeric field (0–100) as a progress bar in both the item editor and the collection browser. It stores a plain integer in the database.'
    },
    { type: 'h3', text: 'Field definition' },
    {
      type: 'pre',
      code: `POST /api/collections/:collection/fields
{
  "field": "completion",
  "type": "integer",
  "interface": "percent_complete"
}`
    },
    { type: 'h3', text: 'Display' },
    {
      type: 'p',
      text: 'In the item editor: a numeric input (0–100) with an inline progress bar. In the collection browser: a coloured progress bar cell. Colour thresholds: 0–33% red, 34–66% amber, 67–99% blue, 100% green.'
    },
    {
      type: 'note',
      text: 'The percent_complete interface is a pure UI concern. The stored value is a plain integer. You can use rollup computed fields to automatically calculate % complete from related task records.'
    }
  ]
}

export const contentOpsPolymorphicRelations: DocSection = {
  id: 'content-ops-m2a',
  label: 'Polymorphic Relations (M2A)',
  content: [
    { type: 'h1', id: 'content-ops-m2a', text: 'Polymorphic Relations (M2A) Builder' },
    {
      type: 'p',
      text: 'Many-to-Any (M2A) relations allow a single field to relate to items from multiple different collections. The relation is stored as (collection_name, item_id) pairs in a junction table. Common use cases: content blocks that can attach to articles or pages, tags that apply to multiple entity types.'
    },
    { type: 'h3', text: 'Creating an M2A relation in the schema editor' },
    {
      type: 'ul',
      items: [
        'In Data Model, click a collection and add a new relation field.',
        'Choose Many-to-Any as the relation type.',
        'Name the junction table (e.g. page_content_blocks).',
        'Select the allowed collections — these are the target types the field can link to.',
        'Save. Nivaro creates the junction table with `item_collection` and `item_id` columns.'
      ]
    },
    { type: 'h3', text: 'API shape' },
    {
      type: 'pre',
      code: `// GET item with M2A field "content_blocks":
{
  "id": "page-uuid",
  "title": "Home Page",
  "content_blocks": [
    { "id": 1, "collection": "hero_banners",   "item": { "id": "...", "headline": "..." } },
    { "id": 2, "collection": "text_sections",  "item": { "id": "...", "body": "..." } },
    { "id": 3, "collection": "image_galleries","item": { "id": "...", "images": [...] } }
  ]
}

// Creating items with M2A nested write:
POST /api/items/pages
{
  "title": "Home Page",
  "content_blocks": [
    { "collection": "hero_banners",  "item": { "headline": "Welcome" } },
    { "collection": "text_sections", "item": { "body": "..." } }
  ]
}`
    },
    {
      type: 'note',
      text: 'M2A relations render in the item editor as a sorted list of "blocks" with a type-picker to add new ones. Drag handles allow reordering. Each block type expands to show its own fields inline.'
    }
  ]
}

export const pickerFilterGuide: DocSection = {
  id: 'picker-filter',
  label: 'Relation Picker Filter',
  content: [
    { type: 'h1', id: 'picker-filter', text: 'Relation Picker Filter' },
    {
      type: 'p',
      text: 'A collection-level JSON filter expression that hides matching records from all M2O and M2M relation pickers targeting that collection. The filter is merged with any active cascade filter using `_and` before the options fetch. Existing FK references to excluded records are unaffected — they load and display normally.'
    },
    { type: 'h3', text: 'Config format' },
    {
      type: 'pre',
      code: `// Stored on nivaro_collections.picker_filter
// Example: hide records where is_disabled = true
{"is_disabled": {"_neq": true}}

// Example: hide archived records
{"status": {"_neq": "archived"}}

// Supports any Nivaro filter expression
{"_and": [{"active": {"_eq": true}}, {"region": {"_neq": "EU"}}]}`
    },
    { type: 'h3', text: 'Configuring in the admin UI' },
    {
      type: 'p',
      text: 'Data Model → select the collection → Settings tab → "Relation Picker Filter". Enter a JSON filter expression, click Save. The filter applies immediately to all pickers in every form.'
    },
    { type: 'h3', text: 'Scope' },
    {
      type: 'table',
      head: ['Applies to', 'Does NOT apply to'],
      rows: [
        ['M2O RelationPicker option list', 'Collection browser / filter bars'],
        ['M2M multi-select option list', 'API list reads (GET /items/:col)'],
        ['M2M single-select option list', 'GraphQL queries'],
        ['', 'The current-value label (fetched by ID, no filter)']
      ]
    },
    {
      type: 'note',
      text: 'This is UX curation, not security enforcement. Use `row_filter` RLS policies to restrict data access. Prefer attribute-based filters (`{"is_disabled":{"_neq":true}}`) over hard-coded ID exclusions — IDs break on data migration.'
    }
  ]
}

export const pickerExclusionsGuide: DocSection = {
  id: 'picker-exclusions',
  label: 'Record Picker Exclusions',
  content: [
    { type: 'h1', id: 'picker-exclusions', text: 'Record Picker Exclusions' },
    {
      type: 'p',
      text: 'Individual records can be excluded from all M2O and M2M relation pickers without any schema changes. Exclusions are stored in `nivaro_picker_exclusions` and applied whenever pickers fetch options with `?picker=1`.'
    },
    { type: 'h3', text: 'How to exclude a record' },
    {
      type: 'p',
      text: '**From the edit form:** open the record → click "Disable in pickers" in the item header. The button turns amber and shows "Excluded from pickers". Click again to re-enable.'
    },
    {
      type: 'p',
      text: '**Bulk:** in any collection browser, select records → click "Disable in pickers" or "Enable in pickers" above the bulk action bar.'
    },
    { type: 'h3', text: 'Behavior on existing references' },
    {
      type: 'p',
      text: 'Excluding a record does not affect existing FK references. Forms that already reference an excluded record load and display it normally. The user can clear the field or pick a different value, but cannot re-select the excluded record.'
    },
    { type: 'h3', text: 'API' },
    {
      type: 'table',
      head: ['Method', 'Path', 'Description'],
      rows: [
        ['GET', '/api/picker-exclusions/status/:collection/:itemId', 'Check exclusion status for a single record.'],
        ['POST', '/api/picker-exclusions', 'Exclude a record. Body: `{collection, item_id}`.'],
        ['DELETE', '/api/picker-exclusions', 'Remove exclusion. Body: `{collection, item_id}`.'],
        ['POST', '/api/picker-exclusions/batch-status', 'Check multiple records. Body: `{collection, ids[]}`. Returns `{excluded: string[]}`.'],
        ['POST', '/api/picker-exclusions/bulk', 'Exclude/include many records. Body: `{collection, ids[], exclude: boolean}`.']
      ]
    },
    {
      type: 'note',
      text: 'Read endpoints require authentication. Write endpoints require admin access.'
    }
  ]
}
