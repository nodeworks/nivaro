import type { DocSection } from '../types.js'

export const userWorkflows: DocSection = {
  id: 'workflows-guide',
  label: 'Workflows',
  content: [
    { type: 'h1', id: 'workflows-guide', text: 'Workflows' },
    {
      type: 'p',
      text: 'Workflows are state machines that can be bound to any collection. Each workflow template defines a set of states and the transitions allowed between them. When a record is started in a workflow, an instance is created that tracks its current state.'
    },
    { type: 'h3', text: 'Key concepts' },
    {
      type: 'table',
      head: ['Concept', 'Description'],
      rows: [
        [
          'Template',
          'The blueprint — name, description, color, icon. Reusable across collections.'
        ],
        [
          'State',
          'A node in the graph. Has a key (machine-readable), label, color. One state is marked initial; one or more can be terminal.'
        ],
        [
          'Transition',
          'An edge from one state to another. Can require specific roles. from_state = null means "from any state."'
        ],
        [
          'Binding',
          'Attaches a template to a collection. Optional state_field syncs the current state key into a column on the record.'
        ],
        ['Instance', 'Per-record runtime: current_state, started_at, completed_at.'],
        ['History', 'Immutable log of every transition taken, including user and optional comment.']
      ]
    },
    { type: 'h3', text: 'WorkflowPanel' },
    {
      type: 'p',
      text: 'On every item edit page, a `WorkflowPanel` is rendered above the form. If no workflow is bound to that collection, the panel renders nothing. When a workflow is bound:'
    },
    {
      type: 'ul',
      items: [
        'If no instance exists: shows a "Start Workflow" button.',
        "If an instance is active: shows the current state badge and available transition buttons (filtered by the user's role).",
        'Clicking a transition button opens a confirm + comment form.',
        'History is collapsible within the panel.'
      ]
    },
    {
      type: 'note',
      text: '`lock_record` on a state prevents editing the record\'s fields while that state is active — useful for "under review" or terminal states.'
    },
    {
      type: 'h3',
      text: 'Stage Progress Visibility'
    },
    {
      type: 'p',
      text: 'Each state has a `stage_visibility` field that controls whether it appears in the stage progress track on the item edit page.'
    },
    {
      type: 'table',
      head: ['Value', 'Behaviour'],
      rows: [
        ['always', 'Default. State always shown in the stage progress track.'],
        ['hide_unless_active', 'Hidden unless the record is currently in this state or has visited it.'],
        ['hide', 'Never shown in the stage progress track.']
      ]
    }
  ]
}

export const pipelineOverview: DocSection = {
  id: 'pipeline-overview',
  label: 'Overview',
  content: [
    { type: 'h1', id: 'pipeline-overview', text: 'Pipeline Engine — Overview' },
    {
      type: 'p',
      text: 'The Pipeline Engine extends the Workflow Engine with a multi-dimensional ownership model. A pipeline template defines states and bindings, and each binding can have an Owner Matrix — a grid of user assignments keyed by dimension filter combinations.'
    },
    {
      type: 'p',
      text: 'The primary use case is multi-dimensional approval chains: different users own different states depending on attributes of the record (e.g. division, project type, specific project).'
    },
    {
      type: 'table',
      head: ['Concept', 'Description'],
      rows: [
        ['Template', 'The blueprint — same as a workflow template. States + bindings.'],
        ['State', 'Same as workflow states. Supports skip criteria for auto-advancing.'],
        ['Binding', 'Attaches the template to a collection. Supports state_field sync and auto_start on item create.'],
        [
          'Dimension',
          'A filter axis on the binding — a field path (e.g. regions.short_name), label, and flags.'
        ],
        [
          'Owner Group',
          'A set of users scoped to a state + filter combination. Has a filters JSON array and a priority integer.'
        ],
        ['Owner Matrix', 'The UI grid mapping dimension filter values to owner groups per state.']
      ]
    },
    { type: 'h3', text: 'Admin UI' },
    {
      type: 'p',
      text: 'Navigate to Pipelines in the sidebar to manage pipeline templates. Each template has:'
    },
    {
      type: 'ul',
      items: [
        'A states list with skip criteria configuration.',
        'A bindings panel for attaching to collections.',
        'A dimensions panel for each binding (drag-to-reorder, required flag).',
        'An Owner Matrix grid below the binding config.'
      ]
    }
  ]
}

export const pipelineDimensions: DocSection = {
  id: 'pipeline-dimensions',
  label: 'Dimensions',
  content: [
    { type: 'h1', id: 'pipeline-dimensions', text: 'Dimensions' },
    {
      type: 'p',
      text: 'Dimensions define the filter axes for the Owner Matrix. Each dimension belongs to a binding and references a field path on the bound collection.'
    },
    {
      type: 'table',
      head: ['Field', 'Description'],
      rows: [
        [
          'field',
          'Dotted field path, e.g. regions.short_name or project.project_type.name. Supports M2O, M2M, and O2M traversal.'
        ],
        ['label', 'Display name shown in the matrix filter bar.'],
        [
          'is_row_axis',
          'Exactly one dimension per binding must be the row axis — it becomes the row header in the matrix grid.'
        ],
        ['sort', 'Display order. Drag-to-reorder in the admin UI; persisted via PATCH.'],
        [
          'required',
          'If true, the user must select a value for this dimension before editing owner assignments.'
        ]
      ]
    },
    { type: 'h3', text: 'Field paths' },
    {
      type: 'p',
      text: 'Dimensions support dotted field paths resolved through relation traversal. For example:'
    },
    {
      type: 'ul',
      items: [
        '`regions.short_name` — M2O: use the short_name field from the related regions record.',
        '`project.project_type.name` — chained M2O: traverse project → project_type → name.',
        '`divisions.short_name` — M2M parent-side: traverse through the junction table to the divisions collection.'
      ]
    },
    {
      type: 'p',
      text: 'Use the field picker in the dimension form to browse and select paths — it handles relation traversal automatically.'
    },
    {
      type: 'note',
      text: 'Required dimensions must have a value selected before the matrix becomes editable. An amber warning banner appears listing unmet required dimensions.'
    }
  ]
}

export const pipelineOwnerMatrix: DocSection = {
  id: 'pipeline-owner-matrix',
  label: 'Owner Matrix',
  content: [
    { type: 'h1', id: 'pipeline-owner-matrix', text: 'Owner Matrix' },
    {
      type: 'p',
      text: 'The Owner Matrix is a table where rows are values of the row-axis dimension and columns are workflow states. Each cell holds a set of users — the owners for that combination of row value and state.'
    },
    { type: 'h3', text: 'Filter bar' },
    {
      type: 'p',
      text: 'Column-filter dimensions appear as searchable comboboxes above the matrix. Selecting a value narrows which owner group is shown per cell. The search is server-side with a 300ms debounce — typing filters items from the full table, not just the initial 100.'
    },
    { type: 'h3', text: 'Cell states' },
    {
      type: 'table',
      head: ['State', 'Visual', 'Meaning'],
      rows: [
        ['Empty', 'Em dash (—)', 'No owners assigned for this combination.'],
        [
          'Explicit',
          'Cyan avatar circles',
          'An owner group exists exactly for this filter context.'
        ],
        [
          'Inherited',
          'Gray faded avatars + "inherited" label',
          'No exact match — showing owners from a less-specific (base-level) group.'
        ],
        [
          'Override indicator',
          'Amber dot on base-level cell',
          'This cell has context-specific overrides defined for optional filter values.'
        ]
      ]
    },
    { type: 'h3', text: 'Editing owners' },
    {
      type: 'p',
      text: 'Click any cell to expand it inline. For an explicit cell: add or remove users directly. For an inherited cell: click "Create override for this context" to create a new explicit group scoped to the current filter values, then add users.'
    },
    { type: 'h3', text: 'Adding rows' },
    {
      type: 'p',
      text: 'Click "+ Add Row" below the matrix. If the row-axis dimension references a related collection, a searchable picker appears. Otherwise, enter a raw value.'
    }
  ]
}

export const pipelineSpecificity: DocSection = {
  id: 'pipeline-specificity',
  label: 'Specificity & Priority',
  content: [
    { type: 'h1', id: 'pipeline-specificity', text: 'Specificity & Priority' },
    {
      type: 'p',
      text: 'When multiple owner groups could apply to a given record, the system uses a specificity-first resolution to pick the most relevant one.'
    },
    { type: 'h3', text: 'Specificity' },
    {
      type: 'p',
      text: 'Specificity equals the number of filters on an owner group. A group scoped to `division=Northeast + project_type=Marketing + project=SpecialProject` (3 filters) beats a group scoped to `division=Northeast + project_type=Marketing` (2 filters) when all three values match the current record.'
    },
    { type: 'h3', text: 'Priority tie-breaker' },
    {
      type: 'p',
      text: 'When two groups have the same filter count, the `priority` integer field decides. Lower number = higher priority. Default is 0. Edit priority in the expanded cell panel.'
    },
    {
      type: 'table',
      head: ['Rule', 'Value'],
      rows: [
        ['Most filters wins', 'filter count DESC'],
        ['Tie-break', 'priority ASC (lower = higher priority)'],
        ['Default priority', '0']
      ]
    },
    { type: 'h3', text: 'Inherited fallback' },
    {
      type: 'p',
      text: 'If optional filter dimensions are active but no group covers them, the system falls back to the most specific matching group (typically the base-level group with only required filters). The cell shows an "inherited" indicator — the base-level owners are used but no override exists yet.'
    },
    {
      type: 'note',
      text: 'Create an override by clicking the cell and using "Create override for this context." This creates a new group with the full current filter context, letting you assign different owners for that specific combination.'
    }
  ]
}

export const pipelineApi: DocSection = {
  id: 'pipeline-api',
  label: 'Pipeline API',
  content: [
    { type: 'h1', id: 'pipeline-api', text: 'Pipeline API' },
    {
      type: 'p',
      text: 'All endpoints are under `/api/pipelines` and require admin access unless noted.'
    },
    { type: 'h3', text: 'Templates' },
    {
      type: 'table',
      head: ['Method', 'Path', 'Description'],
      rows: [
        ['GET', '/api/pipelines', 'List all pipeline templates.'],
        ['POST', '/api/pipelines', 'Create a template.'],
        ['GET', '/api/pipelines/:id', 'Single template with states and bindings.'],
        ['PATCH', '/api/pipelines/:id', 'Update template metadata.'],
        ['DELETE', '/api/pipelines/:id', 'Delete template.'],
        [
          'GET',
          '/api/pipelines/:id/export',
          'Export template as JSON (states, bindings, dimensions, groups).'
        ],
        ['POST', '/api/pipelines/import', 'Import a previously exported template JSON.']
      ]
    },
    { type: 'h3', text: 'States' },
    {
      type: 'table',
      head: ['Method', 'Path', 'Description'],
      rows: [
        ['POST', '/api/pipelines/:id/states', 'Add a state to a template.'],
        [
          'PATCH',
          '/api/pipelines/states/:stateId',
          'Update state (label, color, is_initial, is_terminal, lock_record).'
        ],
        ['DELETE', '/api/pipelines/states/:stateId', 'Remove a state.'],
        ['PATCH', '/api/pipelines/states/:stateId/skip', 'Update skip criteria for auto-advancing.']
      ]
    },
    { type: 'h3', text: 'Bindings & Dimensions' },
    {
      type: 'table',
      head: ['Method', 'Path', 'Description'],
      rows: [
        ['GET', '/api/pipelines/bindings', 'List all bindings.'],
        ['POST', '/api/pipelines/:id/bind', 'Bind a template to a collection.'],
        ['PATCH', '/api/pipelines/bindings/:bindingId', 'Update binding config: auto_start, auto_start_state.'],
        ['DELETE', '/api/pipelines/bindings/:bindingId', 'Remove a binding.'],
        ['GET', '/api/pipelines/bindings/:bindingId/dimensions', 'List dimensions for a binding.'],
        [
          'POST',
          '/api/pipelines/bindings/:bindingId/dimensions',
          'Add a dimension. Body: { field, label, is_row_axis, sort, required }.'
        ],
        [
          'PATCH',
          '/api/pipelines/dimensions/:dimId',
          'Update dimension (field, label, is_row_axis, sort, required).'
        ],
        ['DELETE', '/api/pipelines/dimensions/:dimId', 'Remove a dimension.']
      ]
    },
    { type: 'h3', text: 'Auto-Start' },
    {
      type: 'p',
      text: 'A binding can be configured to automatically start a pipeline instance whenever a new item is created in the bound collection. Enable auto_start on the binding and optionally set auto_start_state to a specific state ID. If auto_start_state is null, the pipeline starts in the first initial state (ordered by sort). The auto-start is non-blocking — if it fails, the item creation still succeeds.'
    },
    {
      type: 'table',
      head: ['Field', 'Type', 'Description'],
      rows: [
        ['auto_start', 'boolean', 'When true, a pipeline instance is created automatically on item create.'],
        ['auto_start_state', 'UUID | null', 'State to start in. Null = first initial state ordered by sort.']
      ]
    },
    { type: 'h3', text: 'Owner Groups (admin)' },
    {
      type: 'table',
      head: ['Method', 'Path', 'Description'],
      rows: [
        [
          'GET',
          '/api/pipelines/:id/owner-groups',
          'All owner groups for all states in a template, keyed by state id.'
        ],
        ['GET', '/api/pipelines/states/:stateId/owner-groups', 'Owner groups for a single state.'],
        [
          'POST',
          '/api/pipelines/states/:stateId/owner-groups',
          'Create a group. Body: { filters, is_default, sort, priority }.'
        ],
        [
          'PATCH',
          '/api/pipelines/owner-groups/:groupId',
          'Update group (filters, is_default, sort, priority).'
        ],
        ['DELETE', '/api/pipelines/owner-groups/:groupId', 'Delete a group.'],
        [
          'POST',
          '/api/pipelines/owner-groups/:groupId/users',
          'Add a user to a group. Body: { user: userId }.'
        ],
        ['DELETE', '/api/pipelines/owner-group-users/:id', 'Remove a user from a group.']
      ]
    },
    { type: 'h3', text: 'Owner queries (authenticated)' },
    {
      type: 'p',
      text: 'These endpoints resolve actual owners against live record data using the specificity model (filter count DESC, priority ASC). Requires a valid session or static token — not admin-only.'
    },
    {
      type: 'table',
      head: ['Method', 'Path', 'Description'],
      rows: [
        [
          'GET',
          '/api/pipelines/:id/matrix',
          'Full owner matrix for a template: all states → groups → users. No record context — returns configured groups as-is.'
        ],
        [
          'GET',
          '/api/pipelines/instance/:collection/:item/owners',
          "Resolved owners for the record's current pipeline state."
        ],
        [
          'GET',
          '/api/pipelines/instance/:collection/:item/owners/all',
          'Resolved owners for every state in the bound pipeline, keyed by stateId. Single call for full matrix resolution.'
        ],
        [
          'GET',
          '/api/pipelines/instance/:collection/:item/owners/:stateId',
          "Resolved owners for a specific state given the record's filter context (any state, not just the current one)."
        ]
      ]
    },
    { type: 'h3', text: 'Owner resolution' },
    {
      type: 'p',
      text: 'Owner groups are matched against the record using the specificity model:'
    },
    {
      type: 'pre',
      code: `// Specificity algorithm (mirrors the Owner Matrix UI):
// 1. Evaluate each non-default group: all its filters must match the record.
// 2. Sort matched groups by filter count DESC, then priority ASC.
// 3. Winner: the single most specific group. Its users are the resolved owners.
// 4. If no filter-based group matches, fall back to default groups.
// 5. Instance-level manual owners (POST /owners) are merged in last.

// Filter shape — stored on each owner group:
{
  "filters": [
    { "field": "regions.short_name", "op": "eq", "value": "NED", "id_value": 3 },
    { "field": "project.project_type.name", "op": "eq", "value": "CAR", "id_value": 7 }
  ],
  "priority": 0   // lower number = higher priority (tie-breaker only)
}
// id_value: optional FK id used for M2O relation fields (more stable than display text)`
    },
    { type: 'h3', text: 'Skip criteria' },
    {
      type: 'p',
      text: 'States can be auto-skipped when a record enters them. Skip criteria are evaluated server-side during transitions.'
    },
    {
      type: 'pre',
      code: `// SkipCriteria shape (stored per state):
{
  "mode": "any",   // "any" = skip if ANY condition true; "all" = skip if ALL true
  "conditions": [
    { "type": "no_owners" },                              // skip if resolved owners = []
    { "type": "field_compare", "field": "amount", "op": "lt", "value": 1000 },
    { "type": "field_empty",    "field": "region" },
    { "type": "field_nonempty", "field": "approved_by" }
  ]
}`
    }
  ]
}

export const workflowsApi: DocSection = {
  id: 'workflows-api',
  label: 'Workflows API',
  content: [
    { type: 'h1', id: 'workflows-api', text: 'Workflows API' },
    {
      type: 'p',
      text: 'All endpoints are under `/api/workflows` and require admin access unless noted.'
    },
    { type: 'h3', text: 'Templates' },
    {
      type: 'table',
      head: ['Method', 'Path', 'Description'],
      rows: [
        ['GET', '/api/workflows', 'List all workflow templates.'],
        ['POST', '/api/workflows', 'Create a template.'],
        ['GET', '/api/workflows/:id', 'Single template.'],
        ['PATCH', '/api/workflows/:id', 'Update template.'],
        ['DELETE', '/api/workflows/:id', 'Delete template.']
      ]
    },
    { type: 'h3', text: 'States & Transitions' },
    {
      type: 'table',
      head: ['Method', 'Path', 'Description'],
      rows: [
        ['POST', '/api/workflows/:id/states', 'Add a state.'],
        ['PATCH', '/api/workflows/states/:stateId', 'Update state.'],
        ['DELETE', '/api/workflows/states/:stateId', 'Delete state.'],
        [
          'POST',
          '/api/workflows/:id/transitions',
          'Add a transition. Body: { from_state, to_state, label, color, required_roles }.'
        ],
        ['PATCH', '/api/workflows/transitions/:txId', 'Update transition.'],
        ['DELETE', '/api/workflows/transitions/:txId', 'Delete transition.']
      ]
    },
    { type: 'h3', text: 'Bindings & Instances' },
    {
      type: 'table',
      head: ['Method', 'Path', 'Description'],
      rows: [
        ['GET', '/api/workflows/bindings', 'All bindings.'],
        [
          'POST',
          '/api/workflows/:id/bind',
          'Bind template to a collection. Body: { collection, state_field? }.'
        ],
        ['DELETE', '/api/workflows/bindings/:bindingId', 'Remove binding.'],
        ['GET', '/api/workflows/instance/:collection/:item', 'Get or check instance for a record.'],
        [
          'POST',
          '/api/workflows/instance/:collection/:item/start',
          'Start a workflow instance for a record.'
        ],
        [
          'POST',
          '/api/workflows/instance/:collection/:item/transition',
          'Advance to next state. Body: { transition_id, comment? }.'
        ]
      ]
    }
  ]
}

export const pipelineBranching: DocSection = {
  id: 'pipeline-branching',
  label: 'Conditional Branching',
  content: [
    { type: 'h1', id: 'pipeline-branching', text: 'Conditional Branching' },
    {
      type: 'p',
      text: 'Transitions can carry condition rules so a record\'s field values decide which paths are offered. In the pipeline template editor, open a transition and use the "Conditions (optional)" section to add field / operator / value rows.'
    },
    { type: 'h3', text: 'How it behaves' },
    {
      type: 'ul',
      items: [
        "A transition is offered on the item page only when ALL of its conditions match the record's current values (AND semantics). No conditions = always offered, subject to required_roles.",
        'Branching: create two transitions out of the same state with opposite conditions — e.g. "Approve" when `amount lte 10000` and "Escalate" when `amount gt 10000`. Exactly one is offered per record.',
        'Operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains`, `null`, `nnull`. Numeric values are compared numerically; ordering ops fall back to lexicographic comparison for ISO date strings.',
        'Server-side revalidation: on execute, the API re-fetches the record and re-evaluates the conditions. If the client\'s view was stale, the transition is rejected with HTTP 409 "Transition conditions not met".'
      ]
    },
    { type: 'h3', text: 'Storage and API' },
    {
      type: 'pre',
      code: `// Stored as JSON in nivaro_workflow_transitions.condition_rules
// (shared by workflow and pipeline templates):
[
  { "field": "amount", "op": "gt", "value": 10000 },
  { "field": "region", "op": "eq", "value": "EMEA" }
]

// Set via the transitions endpoints — POST/PATCH transition bodies accept
// condition_rules; available-transition listings and the execute endpoint
// both evaluate them.`
    },
    {
      type: 'note',
      text: 'Null, empty, or malformed condition_rules are treated as "no conditions" — existing transitions behave exactly as before. SDK: the `WorkflowTransition` type includes `condition_rules?: Array<{ field, op, value }> | null`.'
    }
  ]
}
