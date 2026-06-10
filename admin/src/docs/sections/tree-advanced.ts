import type { DocSection } from '../types.js'

export const orgChartView: DocSection = {
  id: 'org-chart-view',
  label: 'Org Chart View',
  content: [
    { type: 'h1', id: 'org-chart-view', text: 'Org Chart View' },
    {
      type: 'p',
      text: 'Tree-enabled collections can be rendered as a top-down organisational chart instead of an indented list. Open the collection browser, switch to Tree view, and use the new List | Org chart toggle in the tree toolbar.'
    },
    { type: 'h3', text: 'Using the org chart' },
    {
      type: 'ul',
      items: [
        "Each record renders as a node card showing its label (the tree config's label_field) and a child count.",
        'Click the collapse control on a node to hide its entire subtree; collapsed branches show the hidden child count.',
        'Zoom controls (−, %, +) and a "Fit" button scale the chart to the viewport — useful for wide trees.',
        'Click a node card to open the record in the item editor.'
      ]
    },
    { type: 'h3', text: 'Data source' },
    {
      type: 'p',
      text: 'The chart is rendered client-side from a single call to `GET /api/tree/:collection/nested` — the same recursive children-array endpoint used by the list view. Layout (subtree widths, positions) is computed in the browser; collapse state is local UI state.'
    },
    {
      type: 'note',
      text: 'The Org chart toggle appears only for collections that have a tree config (`nivaro_tree_configs`). SDK: fetch the same data with `readTreeNested(collection)`.'
    }
  ]
}

export const treeReorder: DocSection = {
  id: 'tree-reorder',
  label: 'Reorder Siblings',
  content: [
    { type: 'h1', id: 'tree-reorder', text: 'Reorder Siblings' },
    {
      type: 'p',
      text: 'When a tree config has an `order_field` configured, the tree list view shows a drag handle on every node row. Drag a node up or down within its sibling group to reorder it — the new sort values are persisted immediately and all children queries return siblings in `ORDER BY order_field`.'
    },
    { type: 'h3', text: 'Enabling' },
    {
      type: 'ul',
      items: [
        'Data Model → collection → Tree / Hierarchy → set an integer `order_field` (e.g. `sort_order`) and Save.',
        'Open the collection browser in Tree view — node rows now show a grip handle.',
        'Drag within the same sibling group only; dropping under a different parent is a Move, not a reorder.'
      ]
    },
    { type: 'h3', text: 'API' },
    {
      type: 'pre',
      code: `// PATCH /api/tree/:collection/:id/reorder
// :id identifies a node in the sibling group being reordered.
{
  "order": [
    { "id": 4, "sort": 0 },
    { "id": 9, "sort": 1 },
    { "id": 2, "sort": 2 }
  ]
}

// 200 → { "data": { "success": true } }
// 400 when: no order_field configured, duplicate ids, unknown ids,
//           or the ids do not all share the same parent.`
    },
    {
      type: 'note',
      text: 'Requires update permission on the collection (admins bypass). SDK: `reorderTreeSiblings(collection, anchorId, order)`.'
    }
  ]
}

export const treePathColumn: DocSection = {
  id: 'tree-path-column',
  label: 'Breadcrumb Path Column',
  content: [
    { type: 'h1', id: 'tree-path-column', text: 'Breadcrumb Path Column' },
    {
      type: 'p',
      text: 'A tree config can optionally maintain materialized `path` and `depth` columns on the collection table itself. Enable it in Data Model → collection → Tree / Hierarchy → "Maintain path column" switch (`nivaro_tree_configs.maintain_path`), then click "Rebuild paths" to backfill existing rows.'
    },
    { type: 'h3', text: 'What it adds' },
    {
      type: 'ul',
      items: [
        'A real `path` column on the collection: `/rootId/.../selfId` — note the segments are record IDs, not labels.',
        'A real `depth` column (0 = root).',
        'Both are maintained automatically: new records get a path on create, and reparenting a node recomputes the paths of its whole subtree.'
      ]
    },
    { type: 'h3', text: 'Why enable it' },
    {
      type: 'ul',
      items: [
        "Subtree queries become a plain LIKE — `WHERE path LIKE '/12/%'` returns every descendant of node 12 without a recursive CTE. Ideal for custom queries, reports, and external consumers.",
        'Inherited field values resolve ancestors straight from `path` with one batched fetch instead of a per-row recursive CTE.'
      ]
    },
    { type: 'h3', text: 'Rebuilding' },
    {
      type: 'pre',
      code: `// POST /api/tree-configs/:id/rebuild-paths   (admin)
// Ensures the path/depth columns exist, then recomputes every row.
// Use after enabling maintain_path on existing data or after bulk imports.

// 200 → { "data": { "success": true } }`
    },
    {
      type: 'note',
      text: 'The path is ID-based, not label-based — it never goes stale when labels change. SDK: `rebuildTreePaths(configId)`; the `maintain_path` flag is included in `readTreeConfig()` results.'
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
      text: "Fields on a tree-configured collection can be marked inheritable: when a record's value is null or empty, reads fill it from the nearest ancestor that has a non-null value. Think org-unit settings, category defaults, or cost-centre rates that cascade down the tree until a node overrides them."
    },
    { type: 'h3', text: 'Enabling' },
    {
      type: 'ul',
      items: [
        'Data Model → table → open a field in the field editor → switch on "Inheritable" (`nivaro_fields.is_inheritable`).',
        'The collection must have a tree config — without one the flag has no effect.'
      ]
    },
    { type: 'h3', text: 'In the item editor' },
    {
      type: 'ul',
      items: [
        'A field showing a value that came from an ancestor displays an "Inherited" chip.',
        'A field with its own value where an ancestor also provides one displays an "Overridden" chip.',
        "Clearing a field's own value reverts it to the inherited value on the next read — inheritance is resolved at read time, nothing is copied into the row."
      ]
    },
    { type: 'h3', text: 'API shape' },
    {
      type: 'pre',
      code: `// GET /api/items/org_units/12
{
  "data": {
    "id": 12,
    "name": "Boston Office",
    "currency": "USD",            // own value was null — filled from ancestor 1
    "_inherited": { "currency": 1 } // sidecar: field → ancestor item id
  }
}
// Rows where every inheritable field has its own value carry no _inherited key.`
    },
    {
      type: 'p',
      text: 'Resolution walks the ancestor chain nearest-first and stops at the first non-null value. When the tree config maintains a path column, ancestor IDs are parsed from `path` and fetched in one batched query; otherwise a recursive CTE resolves the chain per row. Inheritance runs before computed fields, so formulas see the effective values.'
    },
    {
      type: 'note',
      text: 'List reads include the same `_inherited` sidecar per row. SDK consumers can read it from any item response — it is typed as an optional `Record<string, string | number>`.'
    }
  ]
}

export const treePermissionsGuide: DocSection = {
  id: 'tree-permissions',
  label: 'Tree Permissions',
  content: [
    { type: 'h1', id: 'tree-permissions', text: 'Tree Permissions' },
    {
      type: 'p',
      text: 'Tree permissions scope role access to a subtree of a tree-enabled collection. A rule anchors to a node and applies to that node and all of its descendants — e.g. "the Sales role may only read records under the Sales org unit".'
    },
    { type: 'h3', text: 'Managing rules' },
    {
      type: 'p',
      text: 'Data Model → collection → Tree / Hierarchy section → "Tree permissions" (admin only). Each rule combines:'
    },
    {
      type: 'table',
      head: ['Setting', 'Description'],
      rows: [
        ['Node', 'Picked from the tree — the rule covers this node and all descendants.'],
        ['Role', 'The role the rule applies to.'],
        ['Action', '`read`, `update`, `delete`, or `*` (all actions).'],
        ['Allow / Deny', 'Whether the rule grants or blocks the action inside the subtree.']
      ]
    },
    { type: 'h3', text: 'Resolution semantics' },
    {
      type: 'ul',
      items: [
        "The deepest matching rule in the item's ancestor chain wins — a rule on the item itself beats anything inherited from an ancestor.",
        "On the same node, an action-specific rule beats a '*' rule; remaining ties resolve to deny (deny overrides allow).",
        'Restriction-only: tree permissions never grant access that `nivaro_policies` did not already allow — they can only further restrict it.',
        'Admins bypass tree permissions entirely. Collections with no rules behave exactly as before (zero extra queries — a 60s TTL cache short-circuits the check).'
      ]
    },
    { type: 'h3', text: 'Enforcement' },
    {
      type: 'ul',
      items: [
        'Item read — single reads return 403 on a denied node; list reads are batch-filtered so denied rows simply disappear from results.',
        'Item update and delete — rejected with 403 when the effective rule denies.'
      ]
    },
    { type: 'h3', text: 'API' },
    {
      type: 'table',
      head: ['Method', 'Path', 'Auth', 'Description'],
      rows: [
        ['GET', '/api/tree-permissions?collection=', 'Admin', 'List rules (role name joined).'],
        [
          'POST',
          '/api/tree-permissions',
          'Admin',
          'Create. Body: `{ collection, node_id, role, action?, allow? }` — action defaults to `*`, allow to true.'
        ],
        ['PATCH', '/api/tree-permissions/:id', 'Admin', 'Update node_id / role / action / allow.'],
        ['DELETE', '/api/tree-permissions/:id', 'Admin', 'Remove a rule. → 204']
      ]
    },
    {
      type: 'note',
      text: 'Rules live in `nivaro_tree_permissions`. SDK: `listTreePermissions(collection?)`, `createTreePermission(body)`, `updateTreePermission(id, patch)`, `deleteTreePermission(id)`.'
    }
  ]
}
