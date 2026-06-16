import type { DocSection } from '../types.js'

export const orgChartView: DocSection = {
  id: 'org-chart-view',
  label: 'Org Chart View',
  content: [
    { type: 'h1', id: 'org-chart-view', text: 'Org Chart View' },
    {
      type: 'p',
      text: 'Render tree-enabled collections as interactive top-down organizational charts instead of indented lists. Perfect for org structures, reporting hierarchies, and project teams.'
    },
    { type: 'h3', text: 'Enabling org chart view' },
    { type: 'ul', items: ['Collection browser → collection with tree config.', 'Click "Tree" view button in toolbar.', 'Toggle "List | Org chart" switch (right side of toolbar).'] },
    { type: 'h3', text: 'Features' },
    {
      type: 'table',
      head: ['Feature', 'Description'],
      rows: [
        ['Node cards', 'Display label (from label_field) + child count.'],
        ['Collapse nodes', 'Click arrow to hide subtree; shows hidden child count.'],
        ['Zoom controls', 'Use −/% /+ buttons to scale; "Fit" auto-scales to viewport.'],
        ['Click to edit', 'Click any node card to open item editor.'],
        ['Search', 'Filter by node label (hides non-matching branches).'],
        ['Print', 'Print to PDF (preserves hierarchy structure).']
      ]
    },
    { type: 'h3', text: 'Technical details' },
    {
      type: 'pre',
      code: `// Data fetched once on load
GET /api/tree/:collection/nested

// Response shape
{
  "data": [
    {
      "id": 1,
      "name": "CEO",
      "parent_id": null,
      "children": [
        {
          "id": 2,
          "name": "VP Engineering",
          "parent_id": 1,
          "children": [
            { "id": 4, "name": "Backend Lead", "parent_id": 2, "children": [] },
            { "id": 5, "name": "Frontend Lead", "parent_id": 2, "children": [] }
          ]
        },
        {
          "id": 3,
          "name": "VP Sales",
          "parent_id": 1,
          "children": []
        }
      ]
    }
  ]
}`
    },
    {
      type: 'ul',
      items: [
        'Layout (positions, widths) computed client-side via D3-style layout algorithm.',
        'Collapse state is local UI only (not persisted).',
        'SDK: `readTreeNested(collection)` fetches the same nested structure.'
      ]
    },
    {
      type: 'note',
      text: 'Org chart toggle only appears for collections with a tree config. Best performance with trees < 2000 nodes (deeply nested trees may need server-side pagination).'
    }
  ]
}

export const treeReorder: DocSection = {
  id: 'tree-reorder',
  label: 'Reorder & Sort Siblings',
  content: [
    { type: 'h1', id: 'tree-reorder', text: 'Reorder & Sort Siblings' },
    {
      type: 'p',
      text: 'Maintain a custom sort order for sibling nodes. Configure an integer `order_field` on your tree config and use drag-and-drop or the API to reorder siblings.'
    },
    { type: 'h3', text: 'Setup' },
    { type: 'ul', items: ['Data Model → select collection → Tree / Hierarchy section.', 'Set "Order Field" to an integer column (e.g., `sort_order`).', 'Save — tree list view now shows grip handles on every node.'] },
    { type: 'h3', text: 'Drag and drop' },
    {
      type: 'ul',
      items: [
        'Grab the grip handle (≡) on a node row.',
        'Drag up/down within the same sibling group.',
        'Drop to update sort values immediately.',
        'Dragging under a different parent is a MOVE operation, not reorder.'
      ]
    },
    { type: 'h3', text: 'API: Reorder siblings' },
    {
      type: 'pre',
      code: `import { reorderTreeSiblings } from '@nivaro/sdk'

// Reorder siblings atomically
const result = await nivaro.request(
  reorderTreeSiblings('org_units', 'any-sibling-id', [
    { id: 'node-4', sort: 0 },
    { id: 'node-9', sort: 1 },
    { id: 'node-2', sort: 2 }
  ])
)
// All three siblings get updated with new sort values in one transaction`
    },
    { type: 'h3', text: 'API: Move node to new parent' },
    {
      type: 'pre',
      code: `import { moveTreeNode } from '@nivaro/sdk'

// Move a node (including its entire subtree)
const result = await nivaro.request(
  moveTreeNode('org_units', 'node-12', {
    new_parent_id: 'node-5',  // new parent
    new_sort: 0,  // position among new siblings
  })
)
// Recursively updates parent_id and sort for node and all descendants`
    },
    {
      type: 'table',
      head: ['Method', 'Description', 'Auth'],
      rows: [
        ['reorderTreeSiblings(col, anchorId, order[])', 'Bulk-update sort values for siblings', 'update permission'],
        ['moveTreeNode(col, nodeId, {new_parent_id, new_sort})', 'Move a node + subtree to new parent', 'update permission'],
        ['rebuildTreePaths(configId)', 'Rebuild path/depth columns if out of sync', 'admin'],
      ]
    },
    {
      type: 'note',
      text: 'Cycle detection: `moveTreeNode` prevents moving a node under its own descendant (would create a cycle). All descendants inherit the new parent_id and their paths are recomputed.'
    }
  ]
}

export const treePathColumn: DocSection = {
  id: 'tree-path-column',
  label: 'Materialized Path Column',
  content: [
    { type: 'h1', id: 'tree-path-column', text: 'Materialized Path Column' },
    {
      type: 'p',
      text: 'Optionally maintain `path` and `depth` columns on the collection table. Path is a materialized breadcrumb (/rootId/.../selfId) that enables fast subtree queries without recursive CTEs.'
    },
    { type: 'h3', text: 'Enable path column' },
    { type: 'ul', items: ['Data Model → collection → Tree / Hierarchy section.', 'Toggle "Maintain path column".', 'Click "Rebuild paths" to backfill existing rows.'] },
    { type: 'h3', text: 'What it maintains' },
    {
      type: 'table',
      head: ['Column', 'Type', 'Meaning', 'Example'],
      rows: [
        ['path', 'varchar', 'Breadcrumb: /root_id/.../self_id (ID-based, not label-based)', '/1/5/12'],
        ['depth', 'int', 'Distance from root (0 = root)', '2']
      ]
    },
    { type: 'h3', text: 'Benefits' },
    {
      type: 'ul',
      items: [
        'Subtree queries become trivial: `WHERE path LIKE \'/12/%\'` returns all descendants of node 12.',
        'No recursive CTE needed — single index scan.',
        'Perfect for custom queries, external reporting, and API consumers.',
        'Inherited field resolution uses batched path parsing instead of per-row recursion.',
        'Path never goes stale (ID-based, changes only on move).'
      ]
    },
    { type: 'h3', text: 'Custom query example' },
    {
      type: 'pre',
      code: `-- Find all org units under "Sales" (ID 5) with their depth
SELECT id, name, depth, path
FROM org_units
WHERE path LIKE '/1/5/%'  -- sales org_unit is at /1/5
ORDER BY depth, name

-- Result: all Sales children, grandchildren, etc. (fast!)`
    },
    { type: 'h3', text: 'Maintenance' },
    {
      type: 'ul',
      items: [
        'Paths auto-maintain on create/move/delete.',
        'If paths get out of sync (bulk data import), rebuild: `POST /api/tree-configs/:id/rebuild-paths`.',
        'SDK: `rebuildTreePaths(configId)`.'
      ]
    },
    {
      type: 'note',
      text: 'Path uses IDs not labels — remains valid even if ancestor labels change. Depth is computed from path length on every rebuild; kept in sync automatically.'
    }
  ]
}

export const treeInheritedFields: DocSection = {
  id: 'tree-inherited-fields',
  label: 'Inherited Field Values',
  content: [
    { type: 'h1', id: 'tree-inherited-fields', text: 'Inherited Field Values' },
    {
      type: 'p',
      text: 'Mark fields as inheritable so they cascade values down the tree. If a child has no value, it inherits from the nearest non-null ancestor. Perfect for org settings, cost codes, compliance levels, and defaults that vary by branch.'
    },
    { type: 'h3', text: 'Enable inheritance on a field' },
    { type: 'ul', items: ['Data Model → select collection (must have tree config).', 'Open a field in the editor.', 'Toggle "Inheritable" (`nivaro_fields.is_inheritable`).'] },
    { type: 'h3', text: 'In the item editor' },
    {
      type: 'pre',
      code: `Item view shows:

┌─────────────────────┐
│ Name: Boston Office │
│ Currency: USD       │ ← Shows "Inherited from parent" chip
│ Budget: 50000       │ ← Shows "Overridden (parent: 100000)" chip
└─────────────────────┘

- Inherited field: value came from an ancestor (shown in lighter color + chip)
- Overridden field: own value differs from ancestor's value (chip shows original)
- Clear the field to revert to inherited value (on next read)`
    },
    { type: 'h3', text: 'API response' },
    {
      type: 'pre',
      code: `// GET /api/items/org_units/12
{
  "data": {
    "id": 12,
    "name": "Boston Office",
    "currency": "USD",           // null on write, resolved to "USD" from parent
    "budget": 50000,             // own value
    "compliance_level": "SOC2",  // inherited from grandparent (no parent value)
    "_inherited": {
      "currency": 1,               // ancestor item ID 1 provides this value
      "compliance_level": 3        // ancestor item ID 3 provides this
    }
  }
}

// Rows with all own values (no inheritance) have no _inherited key`
    },
    { type: 'h3', text: 'Resolution algorithm' },
    {
      type: 'ul',
      items: [
        'If field has a non-null value on this record, use it.',
        'Walk ancestors from immediate parent up to root.',
        'First ancestor with non-null value: use that.',
        'No ancestors have it: field is null (use field default if set).',
        'Include `_inherited: { field: ancestorId }` sidecar in response.'
      ]
    },
    { type: 'h3', text: 'Performance' },
    {
      type: 'ul',
      items: [
        'If path column maintained: ancestors parsed from path string + single batched fetch.',
        'If no path column: recursive CTE per row (slower but works).',
        'Inheritance resolves BEFORE computed fields (formulas see effective values).',
        'List reads include _inherited per row.'
      ]
    },
    {
      type: 'note',
      text: 'Inheritance is virtual — values not stored on child rows, resolved at read time. Clearing a field reverts to inherited value on next read.'
    }
  ]
}

export const treePermissionsGuide: DocSection = {
  id: 'tree-permissions',
  label: 'Subtree Access Control',
  content: [
    { type: 'h1', id: 'tree-permissions', text: 'Subtree Access Control' },
    {
      type: 'p',
      text: 'Restrict role access to a subtree of a tree-enabled collection. A single rule anchors to a node and applies read/update/delete permissions to that node and all descendants.'
    },
    { type: 'h3', text: 'Use case' },
    {
      type: 'ul',
      items: [
        'Sales role can only read/edit their own org unit and children (not Finance branch).',
        'Department managers can view team org units but not corporate parent.',
        'Regional admins govern their region and all subsidiaries.'
      ]
    },
    { type: 'h3', text: 'Create a tree permission rule' },
    {
      type: 'ul',
      items: [
        'Data Model → collection → Tree / Hierarchy → "Subtree permissions" (admin only).',
        'Click "New rule".',
        'Pick a node from the tree (the rule applies to it + descendants).',
        'Choose role.',
        'Choose action: read / update / delete / * (all).',
        'Choose allow or deny.'
      ]
    },
    { type: 'h3', text: 'API' },
    {
      type: 'pre',
      code: `import { listTreePermissions, createTreePermission, deleteTreePermission } from '@nivaro/sdk'

// List all rules for a collection
const { data: rules } = await nivaro.request(
  listTreePermissions('org_units')
)
// rules → [{ id, node_id, role_id, action, allow, node_label, role_name }]

// Create a rule: Sales role can read Sales org unit + children
const { data: rule } = await nivaro.request(
  createTreePermission('org_units', {
    node_id: '5',        // Sales org unit
    role: 'sales-role-uuid',
    action: 'read',      // read | update | delete | *
    allow: true,
  })
)

// Delete a rule
await nivaro.request(deleteTreePermission(rule.id))`
    },
    { type: 'h3', text: 'Resolution semantics' },
    {
      type: 'table',
      head: ['Scenario', 'Rule Wins', 'Result'],
      rows: [
        ['Rule on node vs ancestor', 'Node rule (deepest wins)', 'Use node rule'],
        ['read rule vs * rule on same node', 'read rule (specific beats wildcard)', 'read rule applies'],
        ['allow vs deny on same node+action', 'Deny (deny overrides allow)', 'Access denied'],
        ['No matching rule', 'Falls back to nivaro_policies', 'Use base role permissions'],
        ['Admin user', 'All rules bypassed', 'Admin sees everything']
      ]
    },
    { type: 'h3', text: 'Enforcement' },
    {
      type: 'ul',
      items: [
        'Single item read denied: return 403.',
        'List read (batch): denied rows silently filtered out.',
        'Update/delete denied: return 403.',
        'Admins bypass all tree permissions.',
        'Collections with no rules: zero performance penalty (60s cache).'
      ]
    },
    { type: 'h3', text: 'Important' },
    {
      type: 'ul',
      items: [
        'Restriction-only: can only narrow access, never grant beyond base policies.',
        'If nivaro_policies says a role cannot read "org_units", tree perms cannot override it.',
        'Best combined with row-level security (RLS) for additional control.'
      ]
    },
    {
      type: 'note',
      text: 'Rules stored in `nivaro_tree_permissions`. Deepest matching rule in ancestor chain always wins.'
    }
  ]
}
