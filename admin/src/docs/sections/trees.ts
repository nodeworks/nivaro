import type { DocSection } from '../types.js'

export const treeOverview: DocSection = {
  id: 'tree-overview',
  label: 'Tree / Hierarchy Overview',
  content: [
    { type: 'h1', id: 'tree-overview', text: 'Tree / Hierarchy Overview' },
    {
      type: 'p',
      text: 'Any Nivaro collection can become a hierarchical tree by enabling a tree configuration through Data Model → collection detail → Tree / Hierarchy section. No schema changes are required beyond having a self-referential parent field (e.g. `parent_id`) already defined on the collection.'
    },
    {
      type: 'p',
      text: 'Once a tree config is saved, the collection browser gains a Table / Tree view toggle, item edit pages show a breadcrumb trail above the form, and the parent field renders as a TreePicker instead of a plain input.'
    },
    { type: 'h3', text: 'How it works' },
    {
      type: 'ul',
      items: [
        'A `nivaro_tree_configs` row links a collection to its parent_field, label_field, and optional order_field.',
        'Tree queries use MSSQL recursive CTEs anchored at root nodes (WHERE parent_field IS NULL) with `OPTION (MAXRECURSION 100)` for unlimited depth.',
        'The flat node list endpoint returns each node with a computed `depth` integer and a `path` string (e.g. `/1/4/12`).',
        'The nested endpoint returns the same data shaped as a recursive `children` array for direct use in tree UIs.',
        'Move operations run `isDescendantOf()` before updating to prevent a node becoming its own ancestor.'
      ]
    },
    { type: 'h3', text: 'Admin UI integration' },
    {
      type: 'table',
      head: ['Location', 'Behaviour'],
      rows: [
        [
          'Data Model → collection detail',
          '"Tree / Hierarchy" section: enable toggle, field selectors for parent_field, label_field, order_field.'
        ],
        [
          'Collection browser toolbar',
          'Table / Tree toggle appears when a tree config exists for the collection.'
        ],
        [
          'Tree view',
          'Collapsible node rows with expand/collapse, Add Child, Move, and Edit actions per node.'
        ],
        [
          'Item edit page',
          'Breadcrumb trail above the form shows the full ancestor path with clickable links.'
        ],
        [
          'Parent field widget',
          'Renders as a TreePicker when the field matches the configured parent_field.'
        ]
      ]
    },
    {
      type: 'note',
      text: 'Tree features activate only when `GET /api/tree-configs/by-collection/:col` returns a non-null config. If you remove a tree config the collection browser reverts to table-only mode immediately.'
    }
  ]
}

export const treeSetup: DocSection = {
  id: 'tree-setup',
  label: 'Enabling Tree View',
  content: [
    { type: 'h1', id: 'tree-setup', text: 'Enabling Tree View' },
    {
      type: 'p',
      text: 'Follow these steps to turn any collection into a hierarchical tree. The collection must already have a nullable integer (or uuid) field that references itself — this becomes the parent pointer.'
    },
    { type: 'h3', text: 'Step 1 — Add a parent field to the collection' },
    {
      type: 'p',
      text: 'In Data Model → select the collection → Fields → Add Field. Create a field such as `parent_id` with type `integer`, marked nullable. You do not need to create a formal relation for tree purposes, though you may.'
    },
    {
      type: 'pre',
      code: `-- The underlying column Nivaro needs:
ALTER TABLE my_collection ADD parent_id INT NULL;`
    },
    { type: 'h3', text: 'Step 2 — Enable the tree config' },
    {
      type: 'p',
      text: 'Navigate to Data Model → select the collection → scroll to the "Tree / Hierarchy" section → click "Enable Tree View". Configure the three fields:'
    },
    {
      type: 'table',
      head: ['Setting', 'Description'],
      rows: [
        [
          'parent_field',
          'The field name that holds the parent record ID. Must already exist as a column. E.g. `parent_id`.'
        ],
        [
          'label_field',
          'The field used as the display label for each node in the tree UI. E.g. `name` or `title`.'
        ],
        [
          'order_field',
          'Optional. An integer field used to sort siblings. If omitted, siblings are ordered by their primary key. Required for drag-to-reorder (see Reorder Siblings).'
        ],
        [
          'Maintain path column',
          'Optional switch. Adds materialized `path` + `depth` columns to the table, kept current on create/move (see Breadcrumb Path Column).'
        ]
      ]
    },
    {
      type: 'p',
      text: 'Click Save. Nivaro creates a row in `nivaro_tree_configs` and the collection browser immediately shows the Table / Tree toggle.'
    },
    { type: 'h3', text: 'Step 3 — Use the tree browser' },
    {
      type: 'p',
      text: 'Open the collection browser and click the Tree icon in the toolbar. Root nodes (records where parent_field IS NULL) appear at the top level. Click the chevron on any node to expand its children. Use the node action menu to Add Child, Move, or Edit the record.'
    },
    {
      type: 'note',
      text: 'The `parent_field` value must be the exact column name in the underlying table, not a field alias. Use the same name you see in Data Model → Fields for that collection.'
    },
    { type: 'h3', text: 'Disabling tree view' },
    {
      type: 'p',
      text: 'Return to Data Model → collection → Tree / Hierarchy → toggle off → Save. The `nivaro_tree_configs` row is deleted. Existing data is unaffected; the parent_field column remains in the table.'
    }
  ]
}

export const treeApi: DocSection = {
  id: 'tree-api',
  label: 'Tree API',
  content: [
    { type: 'h1', id: 'tree-api', text: 'Tree API' },
    {
      type: 'p',
      text: 'All tree endpoints require authentication. Config management endpoints (`/tree-configs`) require admin access. Data read/move endpoints (`/tree/:collection/...`) require at minimum read permission on the collection.'
    },
    { type: 'h3', text: 'Endpoint reference' },
    {
      type: 'table',
      head: ['Method', 'Path', 'Auth', 'Description'],
      rows: [
        ['GET', '/api/tree-configs', 'Admin', 'List all tree configurations.'],
        ['POST', '/api/tree-configs', 'Admin', 'Create a tree config for a collection.'],
        ['PATCH', '/api/tree-configs/:id', 'Admin', 'Update a tree config.'],
        [
          'DELETE',
          '/api/tree-configs/:id',
          'Admin',
          'Delete a tree config (disables tree mode for the collection).'
        ],
        [
          'GET',
          '/api/tree-configs/by-collection/:col',
          'Authenticated',
          'Return the tree config for a collection, or null if none exists.'
        ],
        [
          'GET',
          '/api/tree/:collection/nodes',
          'Authenticated',
          'Flat list of all nodes with depth and path.'
        ],
        [
          'GET',
          '/api/tree/:collection/nested',
          'Authenticated',
          'Full tree as nested JSON (children arrays).'
        ],
        [
          'GET',
          '/api/tree/:collection/:id/ancestors',
          'Authenticated',
          'Ordered list of ancestors from root to the immediate parent (breadcrumb).'
        ],
        [
          'GET',
          '/api/tree/:collection/:id/descendants',
          'Authenticated',
          'All descendants of a node at any depth.'
        ],
        [
          'GET',
          '/api/tree/:collection/:id/children',
          'Authenticated',
          'Direct children only (depth + 1).'
        ],
        [
          'PATCH',
          '/api/tree/:collection/:id/move',
          'Authenticated',
          'Reparent a node. Body: `{ "parent_id": <id|null> }`. Returns 409 if target is a descendant.'
        ],
        [
          'PATCH',
          '/api/tree/:collection/:id/reorder',
          'Authenticated',
          'Bulk-update sibling sort values. Body: `{ "order": [{ "id", "sort" }] }`. Requires the config\'s order_field; all ids must share the same parent.'
        ],
        [
          'POST',
          '/api/tree-configs/:id/rebuild-paths',
          'Admin',
          'Full rebuild of the materialized path/depth columns (maintain_path configs).'
        ]
      ]
    },
    { type: 'h3', text: 'FlatNode shape' },
    {
      type: 'pre',
      code: `// GET /api/tree/:collection/nodes
{
  "data": [
    {
      "id": 1,
      "parent_id": null,
      "label": "Root Category",
      "depth": 0,
      "path": "/1"
    },
    {
      "id": 4,
      "parent_id": 1,
      "label": "Sub Category",
      "depth": 1,
      "path": "/1/4"
    },
    {
      "id": 12,
      "parent_id": 4,
      "label": "Leaf Node",
      "depth": 2,
      "path": "/1/4/12"
    }
  ]
}`
    },
    { type: 'h3', text: 'NestedNode shape' },
    {
      type: 'pre',
      code: `// GET /api/tree/:collection/nested
{
  "data": [
    {
      "id": 1,
      "label": "Root Category",
      "depth": 0,
      "path": "/1",
      "children": [
        {
          "id": 4,
          "label": "Sub Category",
          "depth": 1,
          "path": "/1/4",
          "children": [
            {
              "id": 12,
              "label": "Leaf Node",
              "depth": 2,
              "path": "/1/4/12",
              "children": []
            }
          ]
        }
      ]
    }
  ]
}`
    },
    { type: 'h3', text: 'Ancestors (breadcrumb)' },
    {
      type: 'pre',
      code: `// GET /api/tree/categories/12/ancestors
{
  "data": [
    { "id": 1, "label": "Root Category", "depth": 0 },
    { "id": 4, "label": "Sub Category",  "depth": 1 }
  ]
}
// The node itself (id 12) is not included — only its ancestors, root-first.`
    },
    { type: 'h3', text: 'Move (reparent) a node' },
    {
      type: 'pre',
      code: `// PATCH /api/tree/categories/4/move
// Body:
{ "parent_id": 7 }

// Success — 200:
{ "ok": true }

// Move to root — set parent_id to null:
{ "parent_id": null }

// Cycle detected — 409:
{ "error": "Cannot move a node to one of its own descendants." }`
    },
    {
      type: 'note',
      text: 'Move uses `isDescendantOf()` — a recursive CTE query — before executing the UPDATE. If the target `parent_id` is the same node or any of its current descendants the request returns HTTP 409 with no data change.'
    },
    { type: 'h3', text: 'Creating a tree config via API' },
    {
      type: 'pre',
      code: `// POST /api/tree-configs
{
  "collection": "categories",
  "parent_field": "parent_id",
  "parent_label_field": "name",
  "order_field": "sort"        // optional
}

// Response 201:
{
  "data": {
    "id": 3,
    "collection": "categories",
    "parent_field": "parent_id",
    "parent_label_field": "name",
    "order_field": "sort"
  }
}`
    },
    {
      type: 'note',
      text: 'All recursive CTE queries include `OPTION (MAXRECURSION 100)`. For trees deeper than 100 levels contact the Nivaro team — the limit is configurable at the server level.'
    }
  ]
}

export const sdkTreeHierarchy: DocSection = {
  id: 'sdk-tree-hierarchy',
  label: 'Tree & Hierarchy',
  content: [
    { type: 'h1', id: 'sdk-tree-hierarchy', text: 'Tree & Hierarchy' },
    {
      type: 'p',
      text: 'The Nivaro SDK provides typed commands for both same-collection trees and multi-collection hierarchies.'
    },
    { type: 'h3', text: 'Tree commands' },
    {
      type: 'pre',
      code: `import { createNivaro, readTreeConfig, readTreeNodes, readTreeNested, readTreeAncestors, readTreeDescendants, readTreeChildren, moveTreeNode, reorderTreeSiblings, rebuildTreePaths } from '@nivaro/sdk'

const nivaro = createNivaro('https://nivaro.example.com', { token: 'my-token' })

// Check if a collection has a tree config
const config = await nivaro.request(readTreeConfig('org_units'))
// → { data: { id, collection, parent_field, label_field, order_field } | null }

// Flat node list (for custom rendering)
const nodes = await nivaro.request(readTreeNodes('org_units'))

// Fully nested tree (recursive children arrays)
const tree = await nivaro.request(readTreeNested('org_units'))

// Ancestors of a node (root-first breadcrumb)
const path = await nivaro.request(readTreeAncestors('org_units', 42))

// Direct children of a node
const kids = await nivaro.request(readTreeChildren('org_units', 42))

// All descendants (any depth)
const all = await nivaro.request(readTreeDescendants('org_units', 42))

// Move a node (null = make root)
await nivaro.request(moveTreeNode('org_units', 42, 7))

// Reorder siblings (requires order_field on the tree config)
await nivaro.request(reorderTreeSiblings('org_units', 42, [
  { id: 42, sort: 0 },
  { id: 43, sort: 1 },
]))

// Rebuild materialized path/depth columns (admin; maintain_path configs)
await nivaro.request(rebuildTreePaths(3))`
    },
    { type: 'h3', text: 'Tree permission commands (admin)' },
    {
      type: 'pre',
      code: `import { listTreePermissions, createTreePermission, updateTreePermission, deleteTreePermission } from '@nivaro/sdk'

// List rules (optionally for one collection)
const rules = await nivaro.request(listTreePermissions('org_units'))

// Deny the "Contractors" role updates inside node 42's subtree
await nivaro.request(createTreePermission({
  collection: 'org_units',
  node_id: 42,
  role: '0a1b2c3d-…',     // role UUID
  action: 'update',
  allow: false,
}))

await nivaro.request(updateTreePermission(7, { action: '*' }))
await nivaro.request(deleteTreePermission(7))`
    },
    {
      type: 'note',
      text: 'Item reads on tree collections may include an `_inherited` sidecar (`{ field: ancestorId }`) when inheritable fields resolved values from an ancestor — see Inherited Field Values.'
    },
    { type: 'h3', text: 'Hierarchy commands' },
    {
      type: 'pre',
      code: `import { createNivaro, listHierarchyConfigs, readHierarchyConfig, readHierarchyTree, readHierarchyNodes, readHierarchyNodeChildren, readHierarchyNodeAncestors, createHierarchyConfig, updateHierarchyConfig, deleteHierarchyConfig } from '@nivaro/sdk'

// List all hierarchy configs
const configs = await nivaro.request(listHierarchyConfigs())

// Full nested tree for hierarchy #1
const tree = await nivaro.request(readHierarchyTree(1))

// Flat nodes for hierarchy #1
const nodes = await nivaro.request(readHierarchyNodes(1))

// Children of a specific node
const children = await nivaro.request(readHierarchyNodeChildren(1, 'divisions', 5))

// Ancestors (breadcrumb) of a node
const ancestors = await nivaro.request(readHierarchyNodeAncestors(1, 'regions', 22))

// Create a new hierarchy config
await nivaro.request(createHierarchyConfig({
  name: 'Org Structure',
  levels: [
    { collection: 'divisions', label_field: 'name', parent_fk: null },
    { collection: 'regions', label_field: 'name', parent_fk: 'division_id' },
  ],
}))`
    }
  ]
}

export const treeExample: DocSection = {
  id: 'tree-example',
  label: 'Worked Example',
  content: [
    { type: 'h1', id: 'tree-example', text: 'Worked Example — Organisational Hierarchy' },
    {
      type: 'p',
      text: 'This walkthrough builds a four-level organisational unit tree: Company → Region → Zone → Site. The same pattern applies to any hierarchy — product categories, project types, cost centres, file taxonomies, and so on.'
    },
    { type: 'h3', text: 'Step 1 — Create the collection' },
    {
      type: 'p',
      text: 'Go to Data Model → New Collection → name it `org_units`. Add these fields:'
    },
    {
      type: 'table',
      head: ['Field', 'Type', 'Notes'],
      rows: [
        ['name', 'string', 'Required. The node label displayed in tree view.'],
        ['type', 'string', "Optional discriminator — e.g. 'company', 'region', 'zone', 'site'."],
        ['sort_order', 'integer', 'Optional. Used to order siblings. Leave null to sort by id.'],
        ['parent_id', 'integer', 'Nullable. Self-reference — the parent org unit.'],
        ['description', 'text', 'Optional. Free-form notes.']
      ]
    },
    {
      type: 'note',
      text: '`parent_id` must be added as a plain integer field. You do not need to define a formal relation in Nivaro — the tree engine finds children via the raw column value.'
    },
    { type: 'h3', text: 'Step 2 — Enable the tree config' },
    {
      type: 'p',
      text: 'Data Model → org_units → scroll to "Tree / Hierarchy" → Enable Tree View. Set:'
    },
    {
      type: 'pre',
      code: `Parent field:  parent_id
Label field:   name
Order field:   sort_order   (optional)`
    },
    { type: 'h3', text: 'Step 3 — Seed some data' },
    {
      type: 'pre',
      code: `-- Root (company)
INSERT INTO org_units (name, type, parent_id) VALUES ('Acme Corp', 'company', NULL);        -- id 1

-- Regions
INSERT INTO org_units (name, type, parent_id) VALUES ('North America', 'region', 1);        -- id 2
INSERT INTO org_units (name, type, parent_id) VALUES ('Europe',        'region', 1);        -- id 3

-- Zones under North America
INSERT INTO org_units (name, type, parent_id) VALUES ('US East',   'zone', 2);              -- id 4
INSERT INTO org_units (name, type, parent_id) VALUES ('US West',   'zone', 2);              -- id 5
INSERT INTO org_units (name, type, parent_id) VALUES ('Canada',    'zone', 2);              -- id 6

-- Sites under US East
INSERT INTO org_units (name, type, parent_id) VALUES ('New York HQ',   'site', 4);          -- id 7
INSERT INTO org_units (name, type, parent_id) VALUES ('Boston Office', 'site', 4);          -- id 8`
    },
    { type: 'h3', text: 'Step 4 — Browse the tree' },
    {
      type: 'p',
      text: 'Open Collections → org_units → click the "Tree" toggle in the toolbar. You will see:'
    },
    {
      type: 'pre',
      code: `▼ Acme Corp
  ▼ North America
    ▼ US East
        New York HQ
        Boston Office
      US West
      Canada
    Europe`
    },
    {
      type: 'p',
      text: 'Click "Add Child" on any node to create a new record with `parent_id` pre-filled. Click a node label to open its edit page. The breadcrumb at the top of the edit page shows the full path:'
    },
    {
      type: 'pre',
      code: `Acme Corp › North America › US East › New York HQ`
    },
    { type: 'h3', text: 'Step 5 — Query the tree via API' },
    {
      type: 'pre',
      code: `// Full tree from root (nested JSON)
GET /api/tree/org_units/nested
Authorization: Bearer <token>

// Response
{
  "data": [
    {
      "id": 1, "label": "Acme Corp", "type": "company", "depth": 0, "parent_id": null,
      "children": [
        {
          "id": 2, "label": "North America", "type": "region", "depth": 1,
          "children": [
            {
              "id": 4, "label": "US East", "type": "zone", "depth": 2,
              "children": [
                { "id": 7, "label": "New York HQ",   "type": "site", "depth": 3, "children": [] },
                { "id": 8, "label": "Boston Office", "type": "site", "depth": 3, "children": [] }
              ]
            },
            { "id": 5, "label": "US West", "type": "zone", "depth": 2, "children": [] },
            { "id": 6, "label": "Canada",  "type": "zone", "depth": 2, "children": [] }
          ]
        },
        { "id": 3, "label": "Europe", "type": "region", "depth": 1, "children": [] }
      ]
    }
  ]
}`
    },
    {
      type: 'pre',
      code: `// Breadcrumb for New York HQ (id 7)
GET /api/tree/org_units/7/ancestors

{
  "data": [
    { "id": 1, "label": "Acme Corp",     "depth": 0 },
    { "id": 2, "label": "North America", "depth": 1 },
    { "id": 4, "label": "US East",       "depth": 2 }
  ]
}
// Node 7 itself is not included — only its ancestors, root-first.`
    },
    {
      type: 'pre',
      code: `// All descendants of North America (id 2)
GET /api/tree/org_units/2/descendants

{
  "data": [
    { "id": 4, "label": "US East",        "depth": 1, "parent_id": 2 },
    { "id": 5, "label": "US West",        "depth": 1, "parent_id": 2 },
    { "id": 6, "label": "Canada",         "depth": 1, "parent_id": 2 },
    { "id": 7, "label": "New York HQ",    "depth": 2, "parent_id": 4 },
    { "id": 8, "label": "Boston Office",  "depth": 2, "parent_id": 4 }
  ]
}`
    },
    { type: 'h3', text: 'Step 6 — Move a node' },
    {
      type: 'pre',
      code: `// Move "Boston Office" (id 8) under US West (id 5)
PATCH /api/tree/org_units/8/move
Content-Type: application/json
{ "parent_id": 5 }

// 200 OK
{ "ok": true }

// The next GET /nested will show Boston Office under US West.

// Promote Canada (id 6) to a direct child of Acme Corp (move up a level):
PATCH /api/tree/org_units/6/move
{ "parent_id": 1 }

// Cycle prevention — moving North America (id 2) under US East (id 4, its own descendant):
PATCH /api/tree/org_units/2/move
{ "parent_id": 4 }
// → 409 Conflict: "Cannot move a node to one of its own descendants."`
    },
    { type: 'h3', text: 'Using the tree in an extension' },
    {
      type: 'pre',
      code: `// Emit a custom trigger whenever a site is added under a new parent zone
hooks.after('org_units', 'update', async ({ item, previousData }) => {
  const prev = previousData as { parent_id: number | null; type: string } | undefined;
  const curr = item as { id: number; parent_id: number | null; type: string };

  if (curr.type !== 'site') return;
  if (curr.parent_id === prev?.parent_id) return;

  // Fetch the new parent's ancestors to derive the full path
  const ancestors = await database.raw(\`
    WITH cte AS (
      SELECT id, name, parent_id, 0 AS depth
      FROM org_units WHERE id = ?
      UNION ALL
      SELECT p.id, p.name, p.parent_id, cte.depth + 1
      FROM org_units p INNER JOIN cte ON p.id = cte.parent_id
    )
    SELECT id, name FROM cte ORDER BY depth DESC
    OPTION (MAXRECURSION 100)
  \`, [curr.parent_id]);

  const path = ancestors[0].map((r: { name: string }) => r.name).join(' › ');
  logger.info({ siteId: curr.id, path }, 'Site reparented');

  flows.emit('my-ext:site-moved', { siteId: curr.id, newPath: path });
});`
    }
  ]
}

export const multiHierarchyOverview: DocSection = {
  id: 'multi-hierarchy-overview',
  label: 'Multi-collection Hierarchies',
  content: [
    { type: 'h1', id: 'multi-hierarchy-overview', text: 'Multi-collection Hierarchies' },
    {
      type: 'p',
      text: 'A Multi-collection Hierarchy lets admins define a named tree where each level is a *different* collection, linked by regular foreign-key columns. For example: Divisions (level 0) → Regions (level 1, via `regions.division`) → Zones (level 2, via `zones.region`). Each collection keeps its own schema, workflows, RBAC, computed fields, and revision history.'
    },
    {
      type: 'p',
      text: 'This is distinct from the same-collection tree (`nivaro_tree_configs`), which uses a single self-referential parent_id on one collection. The same-collection tree remains the right choice for homogeneous recursive trees such as categories, folders, and org charts. Use a multi-collection hierarchy when each level is a conceptually different entity that needs its own structure.'
    },
    { type: 'h3', text: 'Same-collection tree vs multi-collection hierarchy' },
    {
      type: 'table',
      head: ['Feature', 'Same-collection Tree', 'Multi-collection Hierarchy'],
      rows: [
        ['Node types', 'All same collection', 'Each level a different collection'],
        ['Schema per level', 'Shared', 'Independent'],
        ['Workflows/RBAC', 'Shared', 'Per-collection'],
        ['Depth', 'Unlimited (recursive)', 'Fixed (defined levels)'],
        [
          'Use cases',
          'Categories, folders, org charts',
          'Divisions/Regions, Product Types/Sub-types, Project Type/Sub-type'
        ]
      ]
    },
    { type: 'h3', text: 'Config structure' },
    {
      type: 'pre',
      code: `interface HierarchyLevel {
  collection: string;       // e.g. 'divisions'
  label_field: string;      // e.g. 'name'
  parent_fk: string | null; // column on THIS collection pointing to parent level's id. null = root
}

interface HierarchyConfig {
  id: number;
  name: string;
  description: string | null;
  levels: HierarchyLevel[];  // stored as JSON in nivaro_hierarchy_configs.levels
  created_at: string;
  created_by: number | null;
}`
    },
    {
      type: 'note',
      text: 'A hierarchy config is stored as a single row in `nivaro_hierarchy_configs`, with the ordered `levels` array serialized to a JSON column. No schema changes are required beyond the FK columns that already link the collections.'
    },
    { type: 'h3', text: 'Admin UI integration' },
    {
      type: 'table',
      head: ['Location', 'Behaviour'],
      rows: [
        [
          'Sidebar → Content → Hierarchies',
          'New "Hierarchies" item (Network icon). Master-detail list of configs.'
        ],
        [
          '/hierarchies',
          'Left panel lists configs; right panel shows the edit form and levels editor.'
        ],
        ['/hierarchies/:id', 'Same page with a config selected.'],
        [
          '/hierarchies/:id/tree',
          'Full tree browser: indented tree, each node shows a collection badge, "Open" links to the item edit page, "Add Child" creates a record in the next level\'s collection.'
        ]
      ]
    }
  ]
}

export const multiHierarchySetup: DocSection = {
  id: 'multi-hierarchy-setup',
  label: 'Setting Up a Hierarchy',
  content: [
    { type: 'h1', id: 'multi-hierarchy-setup', text: 'Setting Up a Hierarchy' },
    {
      type: 'p',
      text: 'A multi-collection hierarchy is built on top of collections that already exist and that are already linked by foreign-key columns. The hierarchy config simply records the order of the collections and which FK column links each child level to its parent.'
    },
    { type: 'h3', text: 'Step 1 — Create the collections with FK columns' },
    {
      type: 'p',
      text: "Each child level needs an integer (or uuid) field that points to its parent level's id. For example, a `regions` collection needs a `division` integer field that holds the id of the parent division. The root level needs no parent FK."
    },
    {
      type: 'pre',
      code: `-- Root level: divisions
ALTER TABLE divisions ADD short_code NVARCHAR(20) NULL;

-- Child level: regions, with an FK column pointing to divisions.id
ALTER TABLE regions ADD division INT NULL;`
    },
    { type: 'h3', text: 'Step 2 — Open Hierarchies' },
    {
      type: 'p',
      text: 'In the admin sidebar, go to Content → Hierarchies. The list of existing hierarchy configs appears in the left panel.'
    },
    { type: 'h3', text: 'Step 3 — Create a new hierarchy' },
    {
      type: 'p',
      text: 'Click "New Hierarchy" and give it a name (e.g. "Territory Hierarchy") and an optional description.'
    },
    { type: 'h3', text: 'Step 4 — Add levels in order' },
    {
      type: 'p',
      text: 'Add one level per collection, top-down. Level 0 is the root collection with `parent_fk` set to null. Each subsequent level names the child collection and the FK column on that child collection that points back to the parent level.'
    },
    {
      type: 'table',
      head: ['Level setting', 'Description'],
      rows: [
        [
          'collection',
          'The collection for this level. E.g. `divisions` for level 0, `regions` for level 1.'
        ],
        [
          'label_field',
          'The field used as the display label for nodes at this level. E.g. `name`.'
        ],
        [
          'parent_fk',
          "The column on THIS level's collection that points to the parent level's id. Set to null for level 0 (the root)."
        ]
      ]
    },
    { type: 'h3', text: 'Step 5 — Save' },
    {
      type: 'p',
      text: 'Saving writes a row to `nivaro_hierarchy_configs` with the ordered `levels` array serialized to JSON.'
    },
    { type: 'h3', text: 'Step 6 — View the tree' },
    {
      type: 'p',
      text: 'Click "View Tree" to open `/hierarchies/:id/tree`. Root records appear at the top; expand each to see children fetched from the next level\'s collection. Each node shows its collection badge, an "Open" link to the item editor, and an "Add Child" action to create a record in the next level\'s collection with the parent FK pre-filled.'
    },
    {
      type: 'note',
      text: "`parent_fk` is the exact column name on the CHILD collection, not a field alias. It must be the column whose value equals the parent record's id. This is never the same as `parent_id` in a same-collection tree."
    }
  ]
}

export const multiHierarchyApi: DocSection = {
  id: 'multi-hierarchy-api',
  label: 'Hierarchy API',
  content: [
    { type: 'h1', id: 'multi-hierarchy-api', text: 'Hierarchy API' },
    {
      type: 'p',
      text: 'All hierarchy endpoints live under `/api` and require authentication (Bearer static token or session). Config write endpoints (POST/PATCH/DELETE on `/hierarchy-configs`) require admin access.'
    },
    { type: 'h3', text: 'Endpoint reference' },
    {
      type: 'table',
      head: ['Method', 'Path', 'Auth', 'Description'],
      rows: [
        [
          'GET',
          '/api/hierarchy-configs',
          'Authenticated',
          'List all hierarchy configs. → `{ data: HierarchyConfig[] }`'
        ],
        [
          'POST',
          '/api/hierarchy-configs',
          'Admin',
          'Create a hierarchy config. → `{ data: HierarchyConfig }`'
        ],
        [
          'GET',
          '/api/hierarchy-configs/:id',
          'Authenticated',
          'Fetch a single config. → `{ data: HierarchyConfig }`'
        ],
        [
          'PATCH',
          '/api/hierarchy-configs/:id',
          'Admin',
          'Update a config. → `{ data: HierarchyConfig }`'
        ],
        ['DELETE', '/api/hierarchy-configs/:id', 'Admin', 'Delete a config. → 204'],
        [
          'GET',
          '/api/hierarchy/:id/tree',
          'Authenticated',
          'Full hierarchy as nested JSON. → `{ data: HierarchyNode[] }`'
        ],
        [
          'GET',
          '/api/hierarchy/:id/nodes',
          'Authenticated',
          'Flat list of all nodes. → `{ data: FlatHierarchyNode[] }`'
        ],
        [
          'GET',
          '/api/hierarchy/:id/node/:collection/:nodeId/children',
          'Authenticated',
          'Direct children (next level) of a node. → `{ data: FlatHierarchyNode[] }`'
        ],
        [
          'GET',
          '/api/hierarchy/:id/node/:collection/:nodeId/ancestors',
          'Authenticated',
          'Ancestor chain, root-first. → `{ data: FlatHierarchyNode[] }`'
        ]
      ]
    },
    { type: 'h3', text: 'HierarchyNode shape' },
    {
      type: 'table',
      head: ['Field', 'Type', 'Description'],
      rows: [
        ['id', 'number | string', 'Primary key of the underlying record.'],
        ['collection', 'string', 'The collection this node belongs to.'],
        ['label', 'string', "Value of the level's `label_field`."],
        ['level_index', 'number', 'Zero-based index of the level in the config.'],
        [
          'parent_id',
          'number | string | null',
          "Parent record id (value of this level's parent_fk). null at the root."
        ],
        ['parent_collection', 'string | null', 'Collection of the parent level. null at the root.'],
        ['raw', 'Record<string, unknown>', 'The full row from the DB.'],
        ['children', 'HierarchyNode[]', 'Child nodes from the next level (nested endpoint only).']
      ]
    },
    { type: 'h3', text: 'FlatHierarchyNode shape' },
    {
      type: 'p',
      text: 'Identical to `HierarchyNode` but without the `children` array. Returned by `/nodes`, `/children`, and `/ancestors`.'
    },
    { type: 'h3', text: 'Nested tree response' },
    {
      type: 'pre',
      code: `// GET /api/hierarchy/1/tree
{
  "data": [
    {
      "id": 5,
      "collection": "divisions",
      "label": "Western Division",
      "level_index": 0,
      "parent_id": null,
      "parent_collection": null,
      "raw": { "id": 5, "name": "Western Division", "short_code": "WST" },
      "children": [
        {
          "id": 11,
          "collection": "regions",
          "label": "Pacific Northwest",
          "level_index": 1,
          "parent_id": 5,
          "parent_collection": "divisions",
          "raw": { "id": 11, "name": "Pacific Northwest", "short_code": "PNW", "division": 5 },
          "children": []
        }
      ]
    }
  ]
}`
    },
    { type: 'h3', text: 'Flat nodes response' },
    {
      type: 'pre',
      code: `// GET /api/hierarchy/1/nodes
{
  "data": [
    {
      "id": 5, "collection": "divisions", "label": "Western Division",
      "level_index": 0, "parent_id": null, "parent_collection": null,
      "raw": { "id": 5, "name": "Western Division", "short_code": "WST" }
    },
    {
      "id": 11, "collection": "regions", "label": "Pacific Northwest",
      "level_index": 1, "parent_id": 5, "parent_collection": "divisions",
      "raw": { "id": 11, "name": "Pacific Northwest", "short_code": "PNW", "division": 5 }
    }
  ]
}`
    },
    { type: 'h3', text: 'Children and ancestors' },
    {
      type: 'pre',
      code: `// Direct children (next level) of division 5
GET /api/hierarchy/1/node/divisions/5/children
// → { "data": [ { "id": 11, "collection": "regions", ... } ] }

// Ancestor chain of region 11, root-first
GET /api/hierarchy/1/node/regions/11/ancestors
// → { "data": [ { "id": 5, "collection": "divisions", "label": "Western Division", ... } ] }
// The node itself (11) is not included — only its ancestors.`
    },
    { type: 'h3', text: 'Creating a config via API' },
    {
      type: 'pre',
      code: `// POST /api/hierarchy-configs   (admin)
{
  "name": "Territory Hierarchy",
  "description": "Divisions broken down by region",
  "levels": [
    { "collection": "divisions", "label_field": "name", "parent_fk": null },
    { "collection": "regions",   "label_field": "name", "parent_fk": "division" }
  ]
}

// Response 201:
{
  "data": {
    "id": 1,
    "name": "Territory Hierarchy",
    "description": "Divisions broken down by region",
    "levels": [
      { "collection": "divisions", "label_field": "name", "parent_fk": null },
      { "collection": "regions",   "label_field": "name", "parent_fk": "division" }
    ],
    "created_at": "2026-06-09T10:00:00.000Z",
    "created_by": 1
  }
}`
    },
    {
      type: 'note',
      text: 'The `levels` array is stored as JSON in `nivaro_hierarchy_configs.levels`. Always parse it on read and serialize it on write — the column is `nvarchar(max)`.'
    }
  ]
}

export const multiHierarchyExample: DocSection = {
  id: 'multi-hierarchy-example',
  label: 'Worked Example (Divisions → Regions)',
  content: [
    {
      type: 'h1',
      id: 'multi-hierarchy-example',
      text: 'Worked Example — Territory Hierarchy'
    },
    {
      type: 'p',
      text: 'This walkthrough builds a two-level "Territory Hierarchy" where Divisions contain Regions. Each level is its own collection with its own schema; the hierarchy is held together by a single FK column on `regions`.'
    },
    { type: 'h3', text: 'Step 1 — Create the collections' },
    {
      type: 'p',
      text: 'Create two collections in Data Model. Each has its own fields; `regions` adds an integer `division` column that references `divisions.id`.'
    },
    {
      type: 'table',
      head: ['Collection', 'Fields'],
      rows: [
        ['divisions', 'id, name, short_code'],
        ['regions', 'id, name, short_code, division (INT — FK to divisions.id)']
      ]
    },
    { type: 'h3', text: 'Step 2 — Create the hierarchy in the UI' },
    {
      type: 'p',
      text: 'Go to Content → Hierarchies in the sidebar. Click "New Hierarchy", enter the name "Territory Hierarchy", and click "Create hierarchy".'
    },
    {
      type: 'p',
      text: 'In the detail panel, scroll to "Hierarchy Levels" and click "Add Level" twice to create two levels:'
    },
    {
      type: 'table',
      head: ['Level', 'Collection', 'Label field', 'Parent FK'],
      rows: [
        ['0 (root)', 'divisions', 'name', '— (disabled, root has no parent)'],
        ['1', 'regions', 'name', 'division']
      ]
    },
    {
      type: 'p',
      text: 'Parent FK for level 1 is `division` — the column on the `regions` table that stores the parent division\'s id. Click "Save Levels" to persist.'
    },
    {
      type: 'note',
      text: 'Everything is configured through the UI. The levels editor stores the config as a JSON array internally — you never edit JSON directly.'
    },
    { type: 'h3', text: 'Step 3 — Seed some data' },
    {
      type: 'pre',
      code: `-- Divisions (root level)
INSERT INTO divisions (name, short_code) VALUES ('Western Division', 'WST');   -- id 5
INSERT INTO divisions (name, short_code) VALUES ('Eastern Division', 'EST');   -- id 6

-- Regions (child level, division FK points to a division id)
INSERT INTO regions (name, short_code, division) VALUES ('Pacific Northwest', 'PNW', 5);  -- id 11
INSERT INTO regions (name, short_code, division) VALUES ('Southwest',         'SW',  5);  -- id 12
INSERT INTO regions (name, short_code, division) VALUES ('Northeast',         'NE',  6);  -- id 13`
    },
    { type: 'h3', text: 'Step 4 — Query the tree' },
    {
      type: 'pre',
      code: `GET /api/hierarchy/1/tree
Authorization: Bearer <token>

{
  "data": [
    {
      "id": 5, "collection": "divisions", "label": "Western Division",
      "level_index": 0, "parent_id": null, "parent_collection": null,
      "raw": { "id": 5, "name": "Western Division", "short_code": "WST" },
      "children": [
        {
          "id": 11, "collection": "regions", "label": "Pacific Northwest",
          "level_index": 1, "parent_id": 5, "parent_collection": "divisions",
          "raw": { "id": 11, "name": "Pacific Northwest", "short_code": "PNW", "division": 5 },
          "children": []
        },
        {
          "id": 12, "collection": "regions", "label": "Southwest",
          "level_index": 1, "parent_id": 5, "parent_collection": "divisions",
          "raw": { "id": 12, "name": "Southwest", "short_code": "SW", "division": 5 },
          "children": []
        }
      ]
    },
    {
      "id": 6, "collection": "divisions", "label": "Eastern Division",
      "level_index": 0, "parent_id": null, "parent_collection": null,
      "raw": { "id": 6, "name": "Eastern Division", "short_code": "EST" },
      "children": [
        {
          "id": 13, "collection": "regions", "label": "Northeast",
          "level_index": 1, "parent_id": 6, "parent_collection": "divisions",
          "raw": { "id": 13, "name": "Northeast", "short_code": "NE", "division": 6 },
          "children": []
        }
      ]
    }
  ]
}`
    },
    { type: 'h3', text: 'Step 5 — Browse and add children in the UI' },
    {
      type: 'p',
      text: 'Open Hierarchies → Territory Hierarchy → View Tree. Each node shows a collection badge ("divisions" / "regions"). "Open" navigates to the item edit page for that record. "Add Child" creates a record in the next level\'s collection with the parent FK pre-filled.'
    },
    {
      type: 'pre',
      code: `// "Add Child" under Western Division (id 5) navigates to:
/collections/regions/new?parentField=division&parentId=5

// The new region's edit form opens with division pre-set to 5.`
    },
    {
      type: 'note',
      text: 'Because each level is an independent collection, Regions can have their own workflows, RBAC policies, computed fields, and revision history — entirely separate from Divisions.'
    }
  ]
}

export const hierarchyBrowserScope: DocSection = {
  id: 'hierarchy-browser-scope',
  label: 'Hierarchy Scope Filter',
  content: [
    { type: 'h1', id: 'hierarchy-browser-scope', text: 'Hierarchy Scope Filter' },
    {
      type: 'p',
      text: 'When a collection participates in a multi-collection hierarchy as a non-root level, the Collection Browser automatically shows a scope filter above the filter bar.'
    },
    {
      type: 'p',
      text: 'Example: if "regions" is level 2 in the "Sales Territory" hierarchy (under "divisions"), browsing /collections/regions shows a "Scope by Division" dropdown. Selecting a division narrows the table to only regions that belong to that division.'
    },
    {
      type: 'note',
      text: 'M2O levels filter directly via the FK column. M2M levels resolve child IDs via the hierarchy API and filter by ID.'
    },
    { type: 'h3', text: 'How it works' },
    {
      type: 'ul',
      items: [
        'On page load, all hierarchy configs are fetched.',
        'If the current collection appears at level_index > 0 in any config, the scope bar appears.',
        'Selecting a parent adds an implicit filter to the items query (not shown in the active filter bar).',
        'Clear the scope with the "Clear" link to restore the full table.'
      ]
    }
  ]
}

export const hierarchyItemContext: DocSection = {
  id: 'hierarchy-item-context',
  label: 'Hierarchy Context on Item Edit',
  content: [
    { type: 'h1', id: 'hierarchy-item-context', text: 'Hierarchy Context on Item Edit' },
    {
      type: 'p',
      text: 'The item editor automatically shows a "Hierarchy Membership" card for any item that belongs to a multi-collection hierarchy as a non-root level.'
    },
    {
      type: 'p',
      text: 'For M2O levels the card displays a breadcrumb trail linking up through parent levels. For M2M levels it shows the first resolved ancestor path, with a note that multiple paths may exist.'
    },
    {
      type: 'p',
      text: 'Each ancestor is a clickable link navigating to that item\'s edit page. If no parent is assigned the card shows "No parent assigned".'
    },
    {
      type: 'note',
      text: 'The panel appears only when the collection is configured in at least one hierarchy. It is silently omitted for root-level collections and for same-collection trees (which use the breadcrumb in the page header instead).'
    }
  ]
}

export const treeExtensions: DocSection = {
  id: 'tree-ext',
  label: 'Tree in Extensions',
  content: [
    { type: 'h1', id: 'tree-ext', text: 'Tree in Extensions' },
    {
      type: 'p',
      text: 'Extensions can query tree data directly via `ctx.database` (the Knex instance) using raw recursive CTEs, or by calling the tree API routes with `callExternalApi` or a plain HTTP client.'
    },
    { type: 'h3', text: 'Using ctx.database with a recursive CTE' },
    {
      type: 'pre',
      code: `// api/extensions/my-extension/index.ts
export default {
  id: 'my-extension',
  async register({ app, database, logger }) {
    // Get all descendants of node 5 in the 'categories' collection
    app.register(async (f) => {
      f.get('/my-extension/subtree/:id', async (req) => {
        const { id } = req.params as { id: string };

        const rows = await database.raw(\`
          WITH cte AS (
            SELECT id, name, parent_id, 0 AS depth
            FROM categories
            WHERE id = ?

            UNION ALL

            SELECT c.id, c.name, c.parent_id, cte.depth + 1
            FROM categories c
            INNER JOIN cte ON c.parent_id = cte.id
          )
          SELECT * FROM cte ORDER BY depth, id
          OPTION (MAXRECURSION 100)
        \`, [parseInt(id, 10)]);

        return { data: rows[0] };
      });
    }, { prefix: '/api' });
  },
};`
    },
    { type: 'h3', text: 'Reading the tree config from DB' },
    {
      type: 'pre',
      code: `// Check if a collection has tree support before running tree queries
const config = await database('nivaro_tree_configs')
  .where({ collection: 'categories' })
  .first();

if (!config) {
  throw new Error('categories is not a tree collection');
}

const { parent_field, parent_label_field, order_field } = config;`
    },
    { type: 'h3', text: 'Calling the tree API routes' },
    {
      type: 'p',
      text: 'If your extension runs server-side hooks or background jobs, you can call the tree API routes directly. Use a static token for authentication.'
    },
    {
      type: 'pre',
      code: `import { callExternalApi } from '...'; // from ExtensionContext

// Inside a hook or cron callback:
const result = await callExternalApi('my-nivaro-config', {
  method: 'GET',
  path: '/api/tree/categories/5/descendants',
});
// result.data is DescendantNode[]`
    },
    { type: 'h3', text: 'Walking a subtree in a hook' },
    {
      type: 'pre',
      code: `// Invalidate cached paths when any category is reparented
hooks.after('categories', 'update', async ({ item, previousData }) => {
  if (item.parent_id === previousData?.parent_id) return;

  // Fetch all descendants to bust their cached paths
  const rows = await database.raw(\`
    WITH cte AS (
      SELECT id FROM categories WHERE id = ?
      UNION ALL
      SELECT c.id FROM categories c INNER JOIN cte ON c.parent_id = cte.id
    )
    SELECT id FROM cte
    OPTION (MAXRECURSION 100)
  \`, [item.id]);

  const ids = rows[0].map((r: { id: number }) => r.id);
  logger.info({ ids }, 'Busting path cache for subtree');
  // ... your cache invalidation logic
});`
    },
    {
      type: 'note',
      text: 'Always include `OPTION (MAXRECURSION 100)` on every recursive CTE you write. MSSQL uses `WITH cte AS (...)` syntax — not the `RECURSIVE` keyword used by PostgreSQL and MySQL.'
    }
  ]
}
