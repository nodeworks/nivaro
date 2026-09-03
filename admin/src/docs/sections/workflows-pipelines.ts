import type { DocSection } from '../types.js'

export const userWorkflows: DocSection = {
  id: 'workflows-guide',
  label: 'Workflows',
  content: [
    { type: 'h1', id: 'workflows-guide', text: 'Workflows — State Machines' },
    {
      type: 'p',
      text: 'Workflows are state machines that control the lifecycle of items. Define states and transitions, bind to any collection, and track instance state with history.'
    },
    { type: 'h3', text: 'Core concepts' },
    {
      type: 'table',
      head: ['Term', 'Definition'],
      rows: [
        [
          'Template',
          'Blueprint: name, description, icon, states, transitions. Reusable across collections.'
        ],
        [
          'State',
          'A node: key (machine-readable slug), label, color, is_initial, is_terminal, lock_record.'
        ],
        [
          'Transition',
          'Edge between states. May require roles. from_state=null means "from any state."'
        ],
        [
          'Binding',
          'Attaches template to collection. Optional state_field syncs current state key to column.'
        ],
        [
          'Instance',
          'Per-record runtime: current_state, started_at, completed_at, transitioned_at.'
        ],
        [
          'History',
          'Immutable log: every transition, who executed it, timestamp, optional comment.'
        ]
      ]
    },
    { type: 'h3', text: 'Item editor integration (WorkflowPanel)' },
    {
      type: 'p',
      text: 'Every item edit page shows a WorkflowPanel above the form:'
    },
    {
      type: 'ul',
      items: [
        'No workflow bound: panel hidden.',
        'Bound but no instance: "Start Workflow" button.',
        'Active instance: current state badge + available transition buttons (filtered by user role).',
        'Click transition: confirm + optional comment form.',
        'History collapsible within panel.'
      ]
    },
    { type: 'h3', text: 'State settings' },
    {
      type: 'table',
      head: ['Setting', 'Effect'],
      rows: [
        ['is_initial', 'This state is the starting point when workflow is started.'],
        ['is_terminal', 'No transitions allowed out of this state (end of workflow).'],
        ['lock_record', 'When active, prevent editing item fields (read-only mode + amber badge).'],
        [
          'stage_visibility',
          'always | hide_unless_active | hide — controls stage progress track display.'
        ],
        ['sort', 'Display order in state picker and available-transitions list.']
      ]
    },
    { type: 'h3', text: 'Transition requirements' },
    {
      type: 'ul',
      items: [
        'from_state=null: transition available from ANY state (useful for "Reject" paths).',
        'required_roles: JSON array of role UUIDs that can execute this transition; empty = all authenticated users.',
        'condition_rules (optional): field conditions that must match to offer the transition.',
        'group_label: optional; transitions with same label render in a dropdown menu instead of individual buttons.',
        'requirements (optional): data-entry gates enforced at execute time (422 + a fill-in dialog). Type child_fields requires listed fields on every related child row (scalar inputs or m2m multi-selects writing junction rows); type record_fields collects fields on the transitioning record itself (text inputs, m2o pickers) — e.g. confirm an order number at submit time.',
        'auto_trigger: engine-only transition — never shown as a button; fires automatically when its condition_rules pass (on record writes, on writes to child rows the rules reference, after manual transitions, after a staged import completes, and via the hourly sweep).',
        'Related-row conditions: field "<childCollection>:<fkField>" with op related_some / related_none counts child rows pointing at the record. value is an optional JSON filter on those rows: plain columns, ONE hop through a child M2O as "m2o.col", "$record.<field>" tokens for the parent record values, ops _eq _neq _gt _gte _lt _lte _null _nnull _in _round_eq (rounded-dollar equality). Example, a linked PO on the same project whose amount matches the requisition: {"purchase_order.project":{"_eq":"$record.project"},"purchase_order.amount":{"_round_eq":"$record.requisition_amount"}}. An unresolved $record token or unknown hop fails the filter closed.'
      ]
    },
    {
      type: 'note',
      text: 'Workflow state sync: if binding has state_field set, the current state KEY is written to that column on every transition. Enables cross-system integration and custom queries.'
    }
  ]
}

export const pipelineOverview: DocSection = {
  id: 'pipeline-overview',
  label: 'Pipeline Engine — Overview',
  content: [
    { type: 'h1', id: 'pipeline-overview', text: 'Pipeline Engine — Overview' },
    {
      type: 'p',
      text: 'Pipelines extend workflows with a multi-dimensional Owner Matrix. Resolve different users as owners depending on record attributes (region, project type, product line, etc.).'
    },
    { type: 'h3', text: 'Use case' },
    {
      type: 'p',
      text: 'An approval chain where the approver depends on multiple attributes:'
    },
    {
      type: 'ul',
      items: [
        'Budget requests under $10k: approved by division manager.',
        'Budget requests $10k–$100k: approved by director (if Northeast) or CFO (if other regions).',
        'Budget requests > $100k: CEO approval required.',
        'Marketing project proposals: approved by VP Marketing (not CFO).',
        'Staffing requests during hiring freeze: escalated to CEO.'
      ]
    },
    { type: 'h3', text: 'Architecture' },
    {
      type: 'table',
      head: ['Component', 'Description'],
      rows: [
        ['Template', 'States + transitions (same as workflow).'],
        ['Binding', 'Attaches template to collection. Includes auto_start config.'],
        [
          'Dimensions',
          'Filter axes: field paths (e.g., division.name, project.type). Exactly one is row axis.'
        ],
        [
          'Owner Groups',
          'Per-state sets of users, scoped to dimension filter combinations. Prioritized.'
        ],
        [
          'Owner Matrix',
          'UI grid: rows = dimension values, columns = states. Each cell = users for that combo.'
        ],
        [
          'Resolution',
          "On read, match the item against groups; return most specific group's users (filter count DESC, priority ASC)."
        ]
      ]
    },
    { type: 'h3', text: 'Example matrix' },
    {
      type: 'pre',
      code: `Template: Budget Approval
States: Draft → Manager Review → Director Approval → Finance → Approved

Dimensions:
- Division (row axis): North, South, East, West
- Budget Range (column): <10k, 10k-100k, >100k

Owner Matrix:
              <10k          10k-100k        >100k
North    | Manager-N   | Director-N   | CFO
South    | Manager-S   | Director-S   | CFO
East     | Manager-E   | Director-E   | CFO
West     | Manager-W   | Director-W   | CEO

Reading: "approve a 25k budget from the South division"
→ Match South + 10k-100k → Director-S is the owner for Manager Review state`
    },
    {
      type: 'note',
      text: 'Unlike workflows (simple state tracking), pipelines resolve owners dynamically based on each record. Same template, different owners per item.'
    }
  ]
}

export const pipelineDimensions: DocSection = {
  id: 'pipeline-dimensions',
  label: 'Dimensions & Filter Axes',
  content: [
    { type: 'h1', id: 'pipeline-dimensions', text: 'Dimensions & Filter Axes' },
    {
      type: 'p',
      text: 'Dimensions define the filter axes for the owner matrix. Each dimension references a field path on the collection and maps to columns/rows in the matrix UI.'
    },
    { type: 'h3', text: 'Dimension properties' },
    {
      type: 'table',
      head: ['Property', 'Type', 'Description'],
      rows: [
        [
          'field',
          'string (dotted)',
          'e.g., division.name, project.type.label, categories.category_name (M2O or M2M). Validated on save.'
        ],
        ['label', 'string', 'Display name in filter bar and row/column headers.'],
        [
          'is_row_axis',
          'boolean',
          'Exactly one dimension per binding must be true. Becomes the row header.'
        ],
        ['sort', 'number', 'Display order. Drag-to-reorder in admin UI.'],
        [
          'required',
          'boolean',
          'If true, user must select a value before matrix is editable (amber warning if unmet).'
        ]
      ]
    },
    { type: 'h3', text: 'Field path examples' },
    {
      type: 'ul',
      items: [
        'Simple M2O: division.short_code',
        'Chained M2O: project.program.name',
        'M2M parent-side: categories.name',
        'Pick via the field picker in the dimension form — handles relation traversal automatically.'
      ]
    },
    { type: 'h3', text: 'Row axis selection' },
    {
      type: 'p',
      text: 'Exactly one dimension is the row axis. It becomes the left-most rows in the matrix. Other dimensions are column filters (searchable comboboxes above the grid). To promote a column to row axis: edit dimension, toggle is_row_axis, save.'
    },
    {
      type: 'note',
      text: 'Required dimensions must have values selected before the matrix is editable. An amber banner lists which required dimensions are unmet. Optional dimensions can be left unselected (matrix shows base-level owners for that cell).'
    }
  ]
}

export const pipelineOwnerMatrix: DocSection = {
  id: 'pipeline-owner-matrix',
  label: 'Owner Matrix UI',
  content: [
    { type: 'h1', id: 'pipeline-owner-matrix', text: 'Owner Matrix UI' },
    {
      type: 'p',
      text: 'The Owner Matrix is an interactive table where you assign users to states. Rows are values of the row-axis dimension; columns are workflow states.'
    },
    { type: 'h3', text: 'Layout' },
    {
      type: 'ul',
      items: [
        'Filter bar: searchable comboboxes for each column-filter dimension (server-side search, 300ms debounce).',
        'Row axis selector: shows which dimension is currently the row axis.',
        'Matrix grid: cyan avatar circles = explicit owners, gray faded = inherited, em dash = none assigned.',
        'Add row button: add a new row value (if row axis is a relation, picker; otherwise text input).'
      ]
    },
    { type: 'h3', text: 'Cell states' },
    {
      type: 'table',
      head: ['Visual', 'Meaning', 'Action'],
      rows: [
        ['Em dash (—)', 'No owners assigned', 'Click to create explicit group'],
        ['Cyan avatars', 'Explicit group for this filter combo', 'Click to add/remove users'],
        [
          'Gray faded avatars',
          'Inherited from base/less-specific group',
          'Click to create override'
        ],
        [
          'Amber dot on base cell',
          'This cell has context-specific overrides',
          'Shows when optional filters have explicit matches'
        ]
      ]
    },
    { type: 'h3', text: 'Editing a cell' },
    {
      type: 'p',
      text: 'Click any cell to expand inline:'
    },
    {
      type: 'ul',
      items: [
        'Explicit cell: add/remove users directly via the user picker.',
        'Inherited cell: two options: (1) Create override for this context (creates explicit group with current filter values), or (2) Edit base (jump to base-level group).',
        'Priority field: tie-breaker when two groups have the same filter count (lower = higher priority).',
        'Save/Cancel buttons at bottom.'
      ]
    },
    { type: 'h3', text: 'Adding rows' },
    {
      type: 'p',
      text: 'Click "+ Add Row" below the matrix. If row axis is a relation field, a searchable picker appears. Otherwise, enter a text value. Once created, the row appears and cells can be populated.'
    },
    {
      type: 'note',
      text: 'Column filters (optional dimensions) can be left unset — the matrix shows "base-level" owners (groups with only required filter values). Set optional filters to see context-specific overrides.'
    }
  ]
}

export const pipelineSpecificity: DocSection = {
  id: 'pipeline-specificity',
  label: 'Specificity & Resolution',
  content: [
    { type: 'h1', id: 'pipeline-specificity', text: 'Specificity & Owner Resolution' },
    {
      type: 'p',
      text: 'When multiple owner groups could apply to a record, the system picks the most specific one using a deterministic algorithm.'
    },
    { type: 'h3', text: 'Specificity ranking' },
    {
      type: 'ul',
      items: [
        'Filter count DESC: A group scoped to 3 filters (division=Northeast + type=Marketing + project=SpecialProject) beats a 2-filter group (division=Northeast + type=Marketing) if all 3 values match.',
        'Priority ASC: When two groups have the same filter count, the priority integer decides. Lower = higher priority. Tie-breaker only.',
        'Manual overrides win: Instance-level owners (manual assignments added via the "Owners" section) always apply, merged with rule-resolved owners.'
      ]
    },
    { type: 'h3', text: 'Example resolution' },
    {
      type: 'pre',
      code: `Record: { division: "Northeast", type: "Marketing", project: null, amount: 5000 }

Available groups for "Manager Review" state:
A) division=Northeast + type=Marketing + project=SpecialProject  (filter count: 3, priority: 0)
B) division=Northeast + type=Marketing                            (filter count: 2, priority: 0)
C) division=Northeast                                             (filter count: 1, priority: 0)
D) (base: no filters)                                             (filter count: 0)

Matching (all filters must match the record):
- A: FAIL (project=SpecialProject but record.project=null)
- B: PASS (both filters match)
- C: PASS (filter matches)
- D: PASS (no filters, always matches)

Winner: B (highest filter count)
Result: Owners from group B are assigned`
    },
    { type: 'h3', text: 'Inherited fallback' },
    {
      type: 'p',
      text: 'If optional dimensions are active but no group exactly matches, the system falls back to the most specific matching group (typically base-level). The Owner Matrix shows an "inherited" indicator — creating an override specifies the exact filter context.'
    },
    {
      type: 'note',
      text: 'Manual instance owners (POST /pipelines/instance/:col/:item/owners) are always included in the resolved set. Use them for one-off exceptions or escalations.'
    }
  ]
}

export const pipelineApi: DocSection = {
  id: 'pipeline-api',
  label: 'Pipeline API Reference',
  content: [
    { type: 'h1', id: 'pipeline-api', text: 'Pipeline API Reference' },
    {
      type: 'p',
      text: 'All endpoints under `/api/pipelines`. Admin auth required unless noted.'
    },
    { type: 'h3', text: 'Templates' },
    {
      type: 'pre',
      code: `import { readPipelineTemplates, readPipelineTemplate, createPipelineTemplate, updatePipelineTemplate, deletePipelineTemplate } from '@nivaro/sdk'

// List all pipeline templates
const { data: templates } = await nivaro.request(readPipelineTemplates())

// Single template with states and bindings
const { data: tpl } = await nivaro.request(readPipelineTemplate(templateId))

// Create a template
const { data: created } = await nivaro.request(
  createPipelineTemplate({
    name: 'Budget Approval',
    description: 'Multi-level budget sign-off',
    color: 'cyan',
    icon: 'document-check'
  })
)

// Update template metadata
await nivaro.request(updatePipelineTemplate(templateId, { name: 'Updated name' }))

// Delete
await nivaro.request(deletePipelineTemplate(templateId))`
    },
    { type: 'h3', text: 'States & Transitions' },
    {
      type: 'pre',
      code: `import { createPipelineState, updatePipelineState, deletePipelineState } from '@nivaro/sdk'

// Create a state
const { data: state } = await nivaro.request(
  createPipelineState(templateId, {
    key: 'manager_review',
    label: 'Manager Review',
    color: 'blue',
    is_initial: true,
    is_terminal: false,
    lock_record: false,
    stage_visibility: 'always',
    sort: 0
  })
)

// Update state
await nivaro.request(updatePipelineState(stateId, { lock_record: true }))

// Delete state
await nivaro.request(deletePipelineState(stateId))`
    },
    { type: 'h3', text: 'Bindings & Dimensions' },
    {
      type: 'pre',
      code: `import { bindPipelineToCollection, readDimensions, createDimension, updateDimension, deleteDimension } from '@nivaro/sdk'

// Bind template to a collection
const { data: binding } = await nivaro.request(
  bindPipelineToCollection(templateId, {
    collection: 'budget_requests',
    auto_start: true,
    auto_start_state: null  // null = first initial state
  })
)

// List dimensions for a binding
const { data: dims } = await nivaro.request(readDimensions(bindingId))

// Create dimension (row axis example)
const { data: dim } = await nivaro.request(
  createDimension(bindingId, {
    field: 'division.name',
    label: 'Division',
    is_row_axis: true,
    sort: 0,
    required: true
  })
)

// Add column filter dimension
const { data: colDim } = await nivaro.request(
  createDimension(bindingId, {
    field: 'budget_range',  // select field with options: Small, Medium, Large
    label: 'Budget Range',
    is_row_axis: false,
    sort: 1,
    required: false  // optional filter
  })
)

// Update dimension
await nivaro.request(updateDimension(dimId, { sort: 2 }))

// Delete
await nivaro.request(deleteDimension(dimId))`
    },
    { type: 'h3', text: 'Owner Groups (Admin)' },
    {
      type: 'pre',
      code: `import { readOwnerGroups, createOwnerGroup, updateOwnerGroup, deleteOwnerGroup, addOwnerToGroup, removeOwnerFromGroup } from '@nivaro/sdk'

// List all owner groups for a template (keyed by state id)
const { data: allGroups } = await nivaro.request(readOwnerGroups(templateId))

// Create a group for a state with filters
const { data: group } = await nivaro.request(
  createOwnerGroup(stateId, {
    filters: [
      { field: 'division.name', op: 'eq', value: 'Northeast', id_value: 5 },
      { field: 'budget_range', op: 'eq', value: 'Medium' }
    ],
    priority: 0,  // lower = higher priority (tie-breaker)
    sort: 0
  })
)

// Add user to group
await nivaro.request(addOwnerToGroup(groupId, { user: userUUID }))

// Remove user from group
await nivaro.request(removeOwnerFromGroup(ownerAssignmentId))

// Update group (filters, priority)
await nivaro.request(updateOwnerGroup(groupId, { priority: 1 }))

// Delete group
await nivaro.request(deleteOwnerGroup(groupId))`
    },
    { type: 'h3', text: 'Owner Resolution (Authenticated)' },
    {
      type: 'pre',
      code: `import { readInstanceOwners, readStateOwners, readAllStateOwners, addInstanceOwner, removeInstanceOwner } from '@nivaro/sdk'

// Get owners for current state (applying specificity + priority)
const { data: owners } = await nivaro.request(
  readInstanceOwners('budget_requests', itemId)
)
// owners → User[] (resolved via matrix rules)

// Get owners for a specific state given the record
const { data: result } = await nivaro.request(
  readStateOwners('budget_requests', itemId, stateId)
)
// result.state → { id, key, label, ... }
// result.owners → User[] (resolved)

// Get all state owners in one call (no N+1)
const { data: allOwners } = await nivaro.request(
  readAllStateOwners('budget_requests', itemId)
)
// allOwners → { [stateId]: { state, owners } }

// Manual owner override (for exceptions)
const { data: override } = await nivaro.request(
  addInstanceOwner('budget_requests', itemId, userUUID, {
    state_id: stateId  // optional: scope to specific state
  })
)

// Remove manual override
await nivaro.request(removeInstanceOwner(overrideId))`
    },
    {
      type: 'note',
      text: 'Owner resolution applies specificity + priority rules server-side, then merges manual instance owners. Always accurate against live record data.'
    }
  ]
}

export const workflowsApi: DocSection = {
  id: 'workflows-api',
  label: 'Workflows API Reference',
  content: [
    { type: 'h1', id: 'workflows-api', text: 'Workflows API Reference' },
    {
      type: 'p',
      text: 'All endpoints under `/api/workflows`. Admin auth required unless noted.'
    },
    { type: 'h3', text: 'Templates' },
    {
      type: 'pre',
      code: `import {
  readWorkflowTemplates, readWorkflowTemplate,
  createWorkflowTemplate, updateWorkflowTemplate, deleteWorkflowTemplate
} from '@nivaro/sdk'

// List all workflow templates
const { data: templates } = await nivaro.request(readWorkflowTemplates())

// Single template
const { data: tpl } = await nivaro.request(readWorkflowTemplate(templateId))

// Create template
const { data: created } = await nivaro.request(
  createWorkflowTemplate({
    name: 'Content Approval',
    description: 'Draft → Review → Published',
    color: 'amber',
    icon: 'workflow'
  })
)

// Update
await nivaro.request(updateWorkflowTemplate(templateId, { name: 'Updated' }))

// Delete
await nivaro.request(deleteWorkflowTemplate(templateId))`
    },
    { type: 'h3', text: 'States' },
    {
      type: 'pre',
      code: `import { createWorkflowState, updateWorkflowState, deleteWorkflowState } from '@nivaro/sdk'

// Create state
const { data: state } = await nivaro.request(
  createWorkflowState(templateId, {
    key: 'draft',
    label: 'Draft',
    color: 'gray',
    is_initial: true,
    is_terminal: false,
    lock_record: false,
    stage_visibility: 'always',
    sort: 0
  })
)

// Update
await nivaro.request(updateWorkflowState(stateId, { lock_record: true }))

// Delete
await nivaro.request(deleteWorkflowState(stateId))`
    },
    { type: 'h3', text: 'Transitions' },
    {
      type: 'pre',
      code: `import { createTransition, updateTransition, deleteTransition } from '@nivaro/sdk'

// Create transition (from_state=null means "from any state")
const { data: tx } = await nivaro.request(
  createTransition(templateId, {
    from_state: 'draft',        // or null for "from any"
    to_state: 'review',
    label: 'Submit for Review',
    color: 'blue',
    required_roles: ['editor-role-uuid'],  // empty = all authenticated
    group_label: null,           // optional: group similar transitions
    condition_rules: [           // optional: field conditions
      { field: 'title', op: 'nnull', value: null },
      { field: 'body', op: 'nnull', value: null }
    ]
  })
)

// Update transition
await nivaro.request(updateTransition(txId, { label: 'Submit' }))

// Delete
await nivaro.request(deleteTransition(txId))`
    },
    { type: 'h3', text: 'Bindings & Instances' },
    {
      type: 'pre',
      code: `import {
  bindWorkflowToCollection, readWorkflowInstance,
  startWorkflow, transitionWorkflow
} from '@nivaro/sdk'

// Bind template to collection
const { data: binding } = await nivaro.request(
  bindWorkflowToCollection(templateId, {
    collection: 'articles',
    state_field: 'status'  // optional: write current state key to this column
  })
)

// Get workflow instance for a record
const { data: wf } = await nivaro.request(
  readWorkflowInstance('articles', itemId)
)
// wf === null if no workflow bound
// wf.instance → { current_state, started_at, completed_at }
// wf.states → all states
// wf.available_transitions → filtered by user role + condition rules
// wf.history → all past transitions

// Start workflow (creates instance in initial state)
await nivaro.request(startWorkflow('articles', itemId))

// Execute transition
const { data: updated } = await nivaro.request(
  transitionWorkflow('articles', itemId, transitionId, {
    comment: 'Looks good, approved'  // optional
  })
)
// Returns error 409 if condition_rules no longer match (stale client)`
    },
    {
      type: 'note',
      text: 'If binding has state_field set, the current state KEY (not label) is written to that column. Enables external integrations and custom queries on workflow status.'
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
      text: 'Transitions can have field conditions. A transition is only offered when ALL its conditions match the record.'
    },
    { type: 'h3', text: 'Setup' },
    {
      type: 'ul',
      items: [
        'Edit or create a transition in the template editor.',
        'Expand "Conditions (optional)".',
        'Add condition rows: field / operator / value.',
        'Save — transitions are now conditional.'
      ]
    },
    { type: 'h3', text: 'How it works' },
    {
      type: 'pre',
      code: `Example: Budget approval workflow with branching

State: Manager Review
  Transition A: "Approve" → Approved
    Condition: amount <= 10000
  Transition B: "Escalate" → Director Review
    Condition: amount > 10000

When viewing an item:
- amount = 5000 → only "Approve" offered
- amount = 15000 → only "Escalate" offered

Server revalidation: when you execute a transition, the API re-fetches the record
and re-checks conditions. If stale (conditions no longer match), HTTP 409 returned.`
    },
    { type: 'h3', text: 'Operators' },
    {
      type: 'table',
      head: ['Op', 'Type', 'Example'],
      rows: [
        ['eq', 'Equality', 'status eq "approved"'],
        ['neq', 'Inequality', 'region neq "EMEA"'],
        ['gt', 'Greater than', 'amount gt 10000'],
        ['gte', 'Greater or equal', 'age gte 18'],
        ['lt', 'Less than', 'days_remaining lt 5'],
        ['lte', 'Less or equal', 'cost lte 50000'],
        ['contains', 'Substring (text)', 'email contains "@example.com"'],
        ['null', 'Is null', 'approver null'],
        ['nnull', 'Is not null', 'manager nnull']
      ]
    },
    { type: 'h3', text: 'Storage & API' },
    {
      type: 'pre',
      code: `// Stored as JSON in condition_rules:
[
  { "field": "amount", "op": "gt", "value": 10000 },
  { "field": "region", "op": "eq", "value": "EMEA" }
]

// Set via POST/PATCH transition endpoints:
POST /api/workflows/:id/transitions
{
  "from_state": "manager_review",
  "to_state": "director_review",
  "label": "Escalate",
  "condition_rules": [
    { "field": "amount", "op": "gt", "value": 10000 }
  ]
}

// SDK:
const { data: tx } = await nivaro.request(
  createTransition(templateId, {
    condition_rules: [{ field: 'amount', op: 'gt', value: 10000 }]
  })
)`
    },
    {
      type: 'note',
      text: 'Empty or malformed condition_rules = no conditions (always offered). Semantics: ALL conditions must be true (AND logic).'
    }
  ]
}
