# Multiple Layouts per Collection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow each collection to have multiple named layouts (groups + field assignments); one layout is active for ItemEdit; others are reachable via SDK/API.

**Architecture:** New `nivaro_collection_layouts` table wraps existing `nivaro_field_groups` (groups now belong to a layout). A new `nivaro_layout_field_assignments` table stores per-layout field→group assignments. The API overlays active layout assignments transparently — ItemEdit needs no frontend changes. The Layout tab in TableEditor gains a left sidebar listing layouts; the existing `FieldGroupsTab` is refactored to accept a `layoutId` prop.

**Tech Stack:** Knex migrations (MSSQL), Fastify v5, React 19 + Tanstack Query v5, TypeScript, `@nivaro/sdk`, `@nivaro/react`

---

## File Map

| File | Action | What changes |
|---|---|---|
| `api/src/db/migrations/076_collection_layouts.ts` | Create | New tables + data migration |
| `api/src/routes/collection-layouts.ts` | Create | Full CRUD + activate + clone + assignments |
| `api/src/routes/field-groups.ts` | Modify | GET now accepts `?collection=x&layout_id=y`; POST requires `layout_id`; DELETE clears layout assignments |
| `api/src/routes/field-config.ts` | Modify | GET overlays active layout's `group_key`+`sort` from assignments |
| `api/src/routes/index.ts` | Modify | Register `collectionLayoutsRoutes` |
| `admin/src/pages/TableEditor.tsx` | Modify | Layout tab: add layout sidebar; refactor `FieldGroupsTab` to accept `layoutId`; mutations write to assignments endpoint |
| `sdk/src/commands/devex.ts` | Modify | Add `readCollectionLayouts`, `readLayout`, `readActiveLayout` |
| `admin/src/pages/SdkPlayground.tsx` | Modify | Add "Layouts" group to `COMMANDS` |
| `react/src/hooks/useFormSchema.ts` | Modify | `fetchSchema` + `useFormSchema` accept optional `layoutId` |
| `react/src/types.ts` | Modify | Add `layoutId?: number` to `UseNivaroFormOptions` |
| `react/src/hooks/useNivaroForm.ts` | Modify | Pass `layoutId` from options through to `useFormSchema` |
| `admin/src/docs/sections/platform.ts` | Modify | Add `collectionLayouts` doc section |
| `admin/src/docs/index.ts` | Modify | Export + wire new section |

---

## Task 1: Migration

**Files:**
- Create: `api/src/db/migrations/076_collection_layouts.ts`

- [ ] **Step 1: Write the migration**

```typescript
import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  // 1. collection layouts table
  await knex.schema.createTable('nivaro_collection_layouts', (t) => {
    t.increments('id').primary()
    t.string('collection', 255).notNullable()
    t.string('name', 255).notNullable()
    t.specificType('is_active', 'bit').notNullable().defaultTo(0)
    t.integer('sort').notNullable().defaultTo(0)
    t.datetime('created_at').defaultTo(knex.fn.now())
    t.unique(['collection', 'name'])
  })

  // 2. layout_id FK on field_groups
  await knex.schema.alterTable('nivaro_field_groups', (t) => {
    t.integer('layout_id').nullable().references('id').inTable('nivaro_collection_layouts').onDelete('CASCADE')
  })

  // 3. layout field assignments table
  await knex.schema.createTable('nivaro_layout_field_assignments', (t) => {
    t.increments('id').primary()
    t.integer('layout_id').notNullable().references('id').inTable('nivaro_collection_layouts').onDelete('CASCADE')
    t.string('field', 255).notNullable()
    t.string('group_key', 255).nullable()
    t.integer('sort').notNullable().defaultTo(0)
    t.unique(['layout_id', 'field'])
  })

  // 4. Data migration: one "Default" layout per collection that already has groups
  const collections = await knex('nivaro_field_groups')
    .distinct('collection')
    .pluck('collection') as string[]

  for (const collection of collections) {
    const [row] = await knex('nivaro_collection_layouts')
      .insert({ collection, name: 'Default', is_active: 1, sort: 0 })
      .returning('id')
    const layoutId = typeof row === 'object' ? row.id : row

    // point all existing groups at this layout
    await knex('nivaro_field_groups')
      .where({ collection })
      .update({ layout_id: layoutId })

    // seed assignments from current group_key + sort on nivaro_fields
    const fields = await knex('nivaro_fields')
      .where({ collection })
      .select('field', 'group_key', 'sort')

    const assignments = fields
      .filter((f: { field: string; group_key: string | null; sort: number | null }) => f.group_key !== null || f.sort !== null)
      .map((f: { field: string; group_key: string | null; sort: number | null }) => ({
        layout_id: layoutId,
        field: f.field,
        group_key: f.group_key ?? null,
        sort: f.sort ?? 0
      }))

    if (assignments.length > 0) {
      await knex('nivaro_layout_field_assignments').insert(assignments)
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_field_groups', (t) => {
    t.dropColumn('layout_id')
  })
  await knex.schema.dropTableIfExists('nivaro_layout_field_assignments')
  await knex.schema.dropTableIfExists('nivaro_collection_layouts')
}
```

- [ ] **Step 2: Run the migration**

```bash
pnpm migrate
```

Expected: `Batch 2 run: 1 migrations` (or similar)

- [ ] **Step 3: Verify tables exist**

```bash
pnpm dev:api
# In a separate shell:
curl -s http://localhost:3055/api/health | jq .
```

Expected: `{"status":"ok",...}`

- [ ] **Step 4: Commit**

```bash
git add api/src/db/migrations/076_collection_layouts.ts
git commit -m "feat: add collection layouts migration"
```

---

## Task 2: API Route — collection-layouts

**Files:**
- Create: `api/src/routes/collection-layouts.ts`

- [ ] **Step 1: Create the route file**

```typescript
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'

export async function collectionLayoutsRoutes(app: FastifyInstance) {
  // GET /collection-layouts/active?collection=x — MUST be before /:id
  app.get('/active', { preHandler: authenticate }, async (req, reply) => {
    const { collection } = req.query as { collection?: string }
    if (!collection) return reply.code(400).send({ error: 'collection is required' })

    const layout = await db('nivaro_collection_layouts')
      .where({ collection, is_active: 1 })
      .first()
    if (!layout) return reply.code(404).send({ error: 'No active layout' })

    const [groups, assignments] = await Promise.all([
      db('nivaro_field_groups').where({ layout_id: layout.id }).orderBy('sort', 'asc'),
      db('nivaro_layout_field_assignments').where({ layout_id: layout.id }).orderBy('sort', 'asc')
    ])

    return reply.send({ data: { layout, groups, assignments } })
  })

  // GET /collection-layouts?collection=x[&active=true]
  app.get('/', { preHandler: authenticate }, async (req, reply) => {
    const { collection, active } = req.query as { collection?: string; active?: string }
    if (!collection) return reply.code(400).send({ error: 'collection is required' })

    let q = db('nivaro_collection_layouts').where({ collection }).orderBy('sort', 'asc')
    if (active === 'true') q = q.where({ is_active: 1 })

    const rows = await q.select('id', 'collection', 'name', 'is_active', 'sort', 'created_at')
    return reply.send({ data: rows })
  })

  // POST /collection-layouts
  app.post('/', { preHandler: requireAdmin }, async (req, reply) => {
    const body = req.body as { collection: string; name: string }
    if (!body.collection || !body.name) return reply.code(400).send({ error: 'collection and name are required' })

    const maxSort = await db('nivaro_collection_layouts')
      .where({ collection: body.collection })
      .max('sort as m')
      .first()
      .then((r) => (r?.m as number | null) ?? -1)

    const [row] = await db('nivaro_collection_layouts')
      .insert({ collection: body.collection, name: body.name, is_active: 0, sort: maxSort + 1 })
      .returning('id')
    const id = typeof row === 'object' ? row.id : row
    const created = await db('nivaro_collection_layouts').where({ id }).first()

    await logActivity({ action: 'create', user: req.user?.id, collection: 'nivaro_collection_layouts', item: String(id), req })
    return reply.code(201).send({ data: created })
  })

  // PATCH /collection-layouts/:id
  app.patch('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const existing = await db('nivaro_collection_layouts').where({ id }).first()
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    const body = req.body as Partial<{ name: string; sort: number }>
    const patch: Record<string, unknown> = {}
    if (body.name !== undefined) patch.name = body.name
    if (body.sort !== undefined) patch.sort = body.sort

    await db('nivaro_collection_layouts').where({ id }).update(patch)
    const updated = await db('nivaro_collection_layouts').where({ id }).first()

    await logActivity({ action: 'update', user: req.user?.id, collection: 'nivaro_collection_layouts', item: id, req })
    return reply.send({ data: updated })
  })

  // DELETE /collection-layouts/:id — blocked if it is the only layout for the collection
  app.delete('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const existing = await db('nivaro_collection_layouts').where({ id }).first()
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    const count = await db('nivaro_collection_layouts')
      .where({ collection: existing.collection })
      .count('id as c')
      .first()
      .then((r) => Number(r?.c ?? 0))

    if (count <= 1) return reply.code(409).send({ error: 'Cannot delete the only layout for a collection' })

    await db('nivaro_collection_layouts').where({ id }).delete()
    await logActivity({ action: 'delete', user: req.user?.id, collection: 'nivaro_collection_layouts', item: id, req })
    return reply.code(204).send()
  })

  // POST /collection-layouts/:id/activate
  app.post('/:id/activate', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const existing = await db('nivaro_collection_layouts').where({ id }).first()
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    await db('nivaro_collection_layouts')
      .where({ collection: existing.collection })
      .update({ is_active: 0 })
    await db('nivaro_collection_layouts').where({ id }).update({ is_active: 1 })

    const updated = await db('nivaro_collection_layouts').where({ id }).first()
    await logActivity({ action: 'update', user: req.user?.id, collection: 'nivaro_collection_layouts', item: id, req })
    return reply.send({ data: updated })
  })

  // POST /collection-layouts/:id/clone
  app.post('/:id/clone', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const source = await db('nivaro_collection_layouts').where({ id }).first()
    if (!source) return reply.code(404).send({ error: 'Not found' })

    const body = req.body as { name: string }
    if (!body.name) return reply.code(400).send({ error: 'name is required' })

    const maxSort = await db('nivaro_collection_layouts')
      .where({ collection: source.collection })
      .max('sort as m')
      .first()
      .then((r) => (r?.m as number | null) ?? 0)

    const [newRow] = await db('nivaro_collection_layouts')
      .insert({ collection: source.collection, name: body.name, is_active: 0, sort: maxSort + 1 })
      .returning('id')
    const newId = typeof newRow === 'object' ? newRow.id : newRow

    // Clone groups
    const groups = await db('nivaro_field_groups').where({ layout_id: Number(id) }).select('*')
    const keyMap = new Map<string, string>()
    for (const g of groups) {
      const [ng] = await db('nivaro_field_groups')
        .insert({ collection: g.collection, key: g.key, label: g.label, type: g.type, icon: g.icon ?? null, sort: g.sort, is_collapsed: g.is_collapsed, layout_id: newId })
        .returning('id')
      keyMap.set(g.key, g.key)
    }

    // Clone field assignments
    const assignments = await db('nivaro_layout_field_assignments').where({ layout_id: Number(id) }).select('*')
    if (assignments.length > 0) {
      await db('nivaro_layout_field_assignments').insert(
        assignments.map((a: { field: string; group_key: string | null; sort: number }) => ({
          layout_id: newId,
          field: a.field,
          group_key: a.group_key,
          sort: a.sort
        }))
      )
    }

    const created = await db('nivaro_collection_layouts').where({ id: newId }).first()
    await logActivity({ action: 'create', user: req.user?.id, collection: 'nivaro_collection_layouts', item: String(newId), req })
    return reply.code(201).send({ data: created })
  })

  // GET /collection-layouts/:id/assignments
  app.get('/:id/assignments', { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const rows = await db('nivaro_layout_field_assignments')
      .where({ layout_id: Number(id) })
      .select('field', 'group_key', 'sort')
      .orderBy('sort', 'asc')
    return reply.send({ data: rows })
  })

  // PUT /collection-layouts/:id/assignments — bulk replace
  app.put('/:id/assignments', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const layout = await db('nivaro_collection_layouts').where({ id }).first()
    if (!layout) return reply.code(404).send({ error: 'Not found' })

    const body = req.body as { assignments: Array<{ field: string; group_key: string | null; sort: number }> }
    if (!Array.isArray(body.assignments)) return reply.code(400).send({ error: 'assignments array required' })

    await db('nivaro_layout_field_assignments').where({ layout_id: Number(id) }).delete()
    if (body.assignments.length > 0) {
      await db('nivaro_layout_field_assignments').insert(
        body.assignments.map((a) => ({ layout_id: Number(id), field: a.field, group_key: a.group_key ?? null, sort: a.sort }))
      )
    }

    const rows = await db('nivaro_layout_field_assignments')
      .where({ layout_id: Number(id) })
      .select('field', 'group_key', 'sort')
      .orderBy('sort', 'asc')
    return reply.send({ data: rows })
  })
}
```

- [ ] **Step 2: Commit**

```bash
git add api/src/routes/collection-layouts.ts
git commit -m "feat: add collection-layouts API route"
```

---

## Task 3: API — Update field-groups route

**Files:**
- Modify: `api/src/routes/field-groups.ts`

The GET `/:collection` endpoint changes to support `?collection=x&layout_id=y` pattern. The `POST /` now requires `layout_id`. `DELETE /:id` also clears assignments for the group key in the layout.

- [ ] **Step 1: Replace the file**

```typescript
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'

export async function fieldGroupsRoutes(app: FastifyInstance) {
  // GET /field-groups/:collection — list groups for active layout (backward compat)
  // GET /field-groups?collection=x&layout_id=y — explicit layout
  app.get('/:collection', { preHandler: authenticate }, async (req, reply) => {
    const { collection } = req.params as { collection: string }
    const { layout_id } = req.query as { layout_id?: string }

    let targetLayoutId: number | null = null

    if (layout_id) {
      targetLayoutId = Number(layout_id)
    } else {
      // find active layout for this collection
      const active = await db('nivaro_collection_layouts')
        .where({ collection, is_active: 1 })
        .first('id')
      targetLayoutId = active?.id ?? null
    }

    let q = db('nivaro_field_groups')
      .where({ collection })
      .select('id', 'collection', 'key', 'label', 'type', 'icon', 'sort', 'is_collapsed', 'layout_id')
      .orderBy('sort', 'asc')

    if (targetLayoutId !== null) {
      q = q.where({ layout_id: targetLayoutId })
    } else {
      // no layouts yet (legacy collection) — return all groups without layout filter
      q = q.whereNull('layout_id')
    }

    const rows = await q
    return reply.send({ data: rows })
  })

  // POST /field-groups — create a field group (requires layout_id for registered collections)
  app.post('/', { preHandler: requireAdmin }, async (req, reply) => {
    const body = req.body as {
      collection: string
      key: string
      label: string
      type: string
      icon?: string
      sort?: number
      is_collapsed?: boolean
      layout_id?: number
    }

    if (!body.collection || !body.key || !body.label || !body.type) {
      return reply.code(400).send({ error: 'collection, key, label, and type are required' })
    }

    const [row] = await db('nivaro_field_groups')
      .insert({
        collection: body.collection,
        key: body.key,
        label: body.label,
        type: body.type,
        icon: body.icon ?? null,
        sort: body.sort ?? 0,
        is_collapsed: body.is_collapsed ? 1 : 0,
        layout_id: body.layout_id ?? null
      })
      .returning('id')

    const insertedId = typeof row === 'object' ? row.id : row
    const created = await db('nivaro_field_groups').where({ id: insertedId }).first()

    await logActivity({ action: 'create', user: req.user?.id, collection: 'nivaro_field_groups', item: String(insertedId), req })
    return reply.code(201).send({ data: created })
  })

  // PATCH /field-groups/:id — update a field group
  app.patch('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }

    const existing = await db('nivaro_field_groups').where({ id }).first()
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    const body = req.body as Partial<{
      key: string
      label: string
      type: string
      icon: string | null
      sort: number
      is_collapsed: boolean
    }>

    const patch: Record<string, unknown> = {}
    if (body.key !== undefined) patch.key = body.key
    if (body.label !== undefined) patch.label = body.label
    if (body.type !== undefined) patch.type = body.type
    if ('icon' in body) patch.icon = body.icon ?? null
    if (body.sort !== undefined) patch.sort = body.sort
    if (body.is_collapsed !== undefined) patch.is_collapsed = body.is_collapsed ? 1 : 0

    await db('nivaro_field_groups').where({ id }).update(patch)
    const updated = await db('nivaro_field_groups').where({ id }).first()

    await logActivity({ action: 'update', user: req.user?.id, collection: 'nivaro_field_groups', item: id, req })
    return reply.send({ data: updated })
  })

  // DELETE /field-groups/:id — delete group; clear assignments for this group_key in its layout
  app.delete('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }

    const existing = await db('nivaro_field_groups').where({ id }).first()
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    // Clear layout assignments for this group_key
    if (existing.layout_id) {
      await db('nivaro_layout_field_assignments')
        .where({ layout_id: existing.layout_id, group_key: existing.key })
        .update({ group_key: null })
    } else {
      // Legacy path — clear group_key directly on fields
      await db('nivaro_fields')
        .where({ collection: existing.collection, group_key: existing.key })
        .update({ group_key: null })
    }

    await db('nivaro_field_groups').where({ id }).delete()

    await logActivity({ action: 'delete', user: req.user?.id, collection: 'nivaro_field_groups', item: id, req })
    return reply.code(204).send()
  })

  // POST /field-groups/reorder — batch update sort values
  app.post('/reorder', { preHandler: requireAdmin }, async (req, reply) => {
    const body = req.body as { collection: string; order: Array<{ id: number; sort: number }> }

    if (!body.collection || !Array.isArray(body.order) || body.order.length === 0) {
      return reply.code(400).send({ error: 'collection and order array are required' })
    }

    for (const item of body.order) {
      await db('nivaro_field_groups')
        .where({ id: item.id, collection: body.collection })
        .update({ sort: item.sort })
    }

    const rows = await db('nivaro_field_groups')
      .where({ collection: body.collection })
      .select('id', 'key', 'label', 'sort')
      .orderBy('sort', 'asc')

    return reply.send({ data: rows })
  })
}
```

- [ ] **Step 2: Commit**

```bash
git add api/src/routes/field-groups.ts
git commit -m "feat: field-groups route supports layout_id filter"
```

---

## Task 4: API — Overlay layout assignments in field-config

**Files:**
- Modify: `api/src/routes/field-config.ts`

The `GET /:collection` handler needs to overlay `group_key` and `sort` from `nivaro_layout_field_assignments` for the active layout.

- [ ] **Step 1: Update the GET handler in `field-config.ts`**

Find the existing GET handler (around line 126) and replace it:

```typescript
  // GET /field-config/:collection — get all field configs, overlaid with active layout assignments
  app.get('/:collection', { preHandler: authenticate }, async (req, reply) => {
    const { collection } = req.params as { collection: string }
    const { layout_id } = req.query as { layout_id?: string }

    const rows = (await db('nivaro_fields')
      .where({ collection })
      .select(
        'field', 'label', 'note', 'hidden', 'readonly', 'required',
        'interface', 'options', 'group_key', 'visibility_rules',
        'dependency_config', 'validation_rules', 'lock_condition',
        'default_formula', 'cross_record_defaults', 'remote_options_config',
        'repeater_schema', 'is_translatable'
      )
      .orderBy('sort', 'asc')) as FieldRow[]

    // Resolve layout assignments — use explicit layout_id or fall back to active layout
    let targetLayoutId: number | null = null
    if (layout_id) {
      targetLayoutId = Number(layout_id)
    } else {
      const active = await db('nivaro_collection_layouts')
        .where({ collection, is_active: 1 })
        .first('id')
      targetLayoutId = active?.id ?? null
    }

    let assignmentMap = new Map<string, { group_key: string | null; sort: number }>()
    if (targetLayoutId !== null) {
      const assignments = await db('nivaro_layout_field_assignments')
        .where({ layout_id: targetLayoutId })
        .select('field', 'group_key', 'sort')
      for (const a of assignments) {
        assignmentMap.set(a.field, { group_key: a.group_key, sort: a.sort })
      }
    }

    const formatted = rows.map((row, idx) => {
      const assignment = assignmentMap.get(row.field)
      return {
        ...formatFieldConfig(row),
        group_key: assignment ? assignment.group_key : row.group_key,
        sort: assignment ? assignment.sort : idx
      }
    })

    // Re-sort by resolved sort value
    formatted.sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))

    return reply.send({ data: formatted })
  })
```

- [ ] **Step 2: Commit**

```bash
git add api/src/routes/field-config.ts
git commit -m "feat: field-config GET overlays active layout assignments"
```

---

## Task 5: Register routes

**Files:**
- Modify: `api/src/routes/index.ts`

- [ ] **Step 1: Add import**

After the existing `fieldGroupsRoutes` import line, add:

```typescript
import { collectionLayoutsRoutes } from './collection-layouts.js'
```

- [ ] **Step 2: Register the route**

In `registerRoutes`, add after the `fieldGroupsRoutes` registration line (search for `field-groups`):

```typescript
  await app.register(collectionLayoutsRoutes, { prefix: '/collection-layouts' })
```

- [ ] **Step 3: Verify API starts**

```bash
pnpm dev:api
```

Expected: no errors, server starts on port 3055.

- [ ] **Step 4: Smoke test**

```bash
# Create a test — replace TOKEN with a valid admin token from your local instance
curl -s "http://localhost:3055/api/collection-layouts?collection=articles" \
  -H "Authorization: Bearer TOKEN" | jq .
```

Expected: `{"data": [...]}` — may be empty array if no layouts yet.

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/index.ts
git commit -m "feat: register collection-layouts route"
```

---

## Task 6: TableEditor — Layout tab UI

**Files:**
- Modify: `admin/src/pages/TableEditor.tsx`

This is the largest change. The `FieldGroupsTab` is refactored to accept a `layoutId` prop and all mutations use the assignments endpoint. A `LayoutSidebar` component is added to the layout tab.

- [ ] **Step 1: Add layout query + sidebar state near the top of `FieldGroupsTab`**

Find `function FieldGroupsTab({ tableName, dbColumns = [] }` (around line 4506) and update its signature and add a layout sidebar above the existing content:

Replace the function signature:
```typescript
function FieldGroupsTab({ tableName, dbColumns = [] }: { tableName: string; dbColumns?: Array<{ name: string; data_type: string }> }) {
```
With:
```typescript
function FieldGroupsTab({ tableName, dbColumns = [], layoutId }: { tableName: string; dbColumns?: Array<{ name: string; data_type: string }>; layoutId: number | null }) {
```

- [ ] **Step 2: Update the groups query in `FieldGroupsTab` to filter by layoutId**

Find the groups query (search for `queryKey: ['field-groups', tableName]`) and update:
```typescript
  const { data: groups = [] } = useQuery<FieldGroup[]>({
    queryKey: ['field-groups', tableName, layoutId],
    queryFn: () =>
      api
        .get<{ data: FieldGroup[] }>(`/field-groups/${tableName}`, {
          params: layoutId ? { layout_id: layoutId } : {}
        })
        .then((r) => r.data.data ?? []),
    enabled: !!tableName
  })
```

- [ ] **Step 3: Update the fieldConfig query to pass layoutId**

Find the query with `queryKey: ['field-config', tableName]` and update:
```typescript
  const { data: fieldConfig = [] } = useQuery({
    queryKey: ['field-config', tableName, layoutId],
    queryFn: () =>
      api
        .get<{ data: Array<{ field: string; sort?: number | null; group_key: string | null }> }>(
          `/field-config/${tableName}`,
          { params: layoutId ? { layout_id: layoutId } : {} }
        )
        .then((r) => r.data.data ?? []),
    enabled: !!tableName
  })
```

- [ ] **Step 4: Update the createMut in `FieldGroupsTab` to include layoutId**

Find `const createMut = useMutation` (around line 4613) and add `layout_id` to the insert body:
```typescript
  const createMut = useMutation({
    mutationFn: (body: { collection: string; key: string; label: string; type: 'section' | 'tab' }) =>
      api.post('/field-groups', { ...body, layout_id: layoutId }),
    onSuccess: () => { invalidateGroups(); setAdding(false); setNewKey(''); setNewLabel(''); toast.success('Group created') },
    onError: () => toast.error('Failed to create group')
  })
```

- [ ] **Step 5: Update patchField to write to assignments endpoint**

Find `const patchField = useCallback` (around line 4645) and replace:
```typescript
  const patchField = useCallback((field: string, patch: Record<string, unknown>) => {
    if (layoutId && ('group_key' in patch || 'sort' in patch)) {
      // Write group/sort to layout assignments
      const allAssignments = Object.entries(localAssignments).map(([f, gk]) => ({
        field: f,
        group_key: gk ?? null,
        sort: localFieldOrder[gk ?? '__unassigned__']?.indexOf(f) ?? 0
      }))
      api.put(`/collection-layouts/${layoutId}/assignments`, { assignments: allAssignments })
        .then(() => { invalidateFieldConfig() })
    } else {
      api.patch(`/field-config/${tableName}/${field}`, patch)
        .then(() => { invalidateFieldConfig(); invalidateMeta() })
    }
  }, [tableName, layoutId, localAssignments, localFieldOrder, invalidateFieldConfig, invalidateMeta])
```

- [ ] **Step 6: Add `LayoutsTab` wrapper component above `FieldGroupsTab`**

Add this new component just above `function FieldGroupsTab`:

```typescript
// ─── Layouts tab (wraps FieldGroupsTab with layout sidebar) ──────────────────

interface CollectionLayout {
  id: number
  collection: string
  name: string
  is_active: boolean | number
  sort: number
}

function LayoutsTab({ tableName, dbColumns }: { tableName: string; dbColumns: Array<{ name: string; data_type: string }> }) {
  const qc = useQueryClient()
  const invalidateLayouts = useCallback(
    () => qc.invalidateQueries({ queryKey: ['collection-layouts', tableName] }),
    [qc, tableName]
  )

  const { data: layouts = [] } = useQuery<CollectionLayout[]>({
    queryKey: ['collection-layouts', tableName],
    queryFn: () =>
      api.get<{ data: CollectionLayout[] }>('/collection-layouts', { params: { collection: tableName } })
        .then((r) => r.data.data ?? []),
    enabled: !!tableName
  })

  const activeLayout = layouts.find((l) => l.is_active) ?? layouts[0] ?? null
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const effectiveId = selectedId ?? activeLayout?.id ?? null

  const createMut = useMutation({
    mutationFn: (name: string) => api.post('/collection-layouts', { collection: tableName, name }),
    onSuccess: () => { invalidateLayouts(); setAdding(false); setNewName('') },
    onError: () => toast.error('Failed to create layout')
  })

  const activateMut = useMutation({
    mutationFn: (id: number) => api.post(`/collection-layouts/${id}/activate`),
    onSuccess: () => { invalidateLayouts(); toast.success('Layout activated') }
  })

  const cloneMut = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) =>
      api.post<{ data: CollectionLayout }>(`/collection-layouts/${id}/clone`, { name }),
    onSuccess: (res) => {
      invalidateLayouts()
      setSelectedId(res.data.data.id)
      toast.success('Layout cloned')
    }
  })

  const deleteMut = useMutation({
    mutationFn: (id: number) => api.delete(`/collection-layouts/${id}`),
    onSuccess: () => { invalidateLayouts(); setSelectedId(null) },
    onError: () => toast.error('Cannot delete the only layout')
  })

  const renameMut = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) =>
      api.patch(`/collection-layouts/${id}`, { name }),
    onSuccess: () => { invalidateLayouts(); setEditingId(null) }
  })

  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editingName, setEditingName] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null)

  // Auto-create default layout if collection has groups but no layouts
  useEffect(() => {
    if (layouts.length === 0 && tableName) {
      // No layouts yet — the migration should have created one, but handle edge case
    }
  }, [layouts, tableName])

  const selected = layouts.find((l) => l.id === effectiveId) ?? null

  return (
    <div className='flex min-h-0 flex-1 gap-0'>
      {/* Left sidebar */}
      <div className='flex w-[140px] shrink-0 flex-col gap-0.5 border-r border-slate-200 pr-3 dark:border-border'>
        <p className='mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400'>Layouts</p>
        {layouts.map((l) => (
          <div key={l.id} className='group relative'>
            {editingId === l.id ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  if (editingName.trim()) renameMut.mutate({ id: l.id, name: editingName.trim() })
                }}
              >
                <input
                  autoFocus
                  value={editingName}
                  onChange={(e) => setEditingName(e.target.value)}
                  onBlur={() => setEditingId(null)}
                  className='w-full rounded border border-nvr-cyan px-2 py-1 text-[11px] outline-none'
                />
              </form>
            ) : (
              <button
                type='button'
                onClick={() => setSelectedId(l.id)}
                onDoubleClick={() => { setEditingId(l.id); setEditingName(l.name) }}
                className={cn(
                  'flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[11px] transition-colors',
                  effectiveId === l.id
                    ? 'bg-nvr-cyan/10 font-medium text-nvr-cyan'
                    : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
                )}
              >
                {l.is_active ? (
                  <span className='h-1.5 w-1.5 shrink-0 rounded-full bg-nvr-cyan' />
                ) : (
                  <span className='h-1.5 w-1.5 shrink-0 rounded-full bg-transparent' />
                )}
                <span className='truncate'>{l.name}</span>
              </button>
            )}
          </div>
        ))}
        {adding ? (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (newName.trim()) createMut.mutate(newName.trim())
            }}
            className='mt-1'
          >
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onBlur={() => { setAdding(false); setNewName('') }}
              placeholder='Layout name'
              className='w-full rounded border border-slate-300 px-2 py-1 text-[11px] outline-none focus:border-nvr-cyan dark:border-border'
            />
          </form>
        ) : (
          <button
            type='button'
            onClick={() => setAdding(true)}
            className='mt-1 flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-slate-400 hover:text-slate-600 dark:hover:text-slate-200'
          >
            <span>+ Add layout</span>
          </button>
        )}
      </div>

      {/* Right content */}
      <div className='min-h-0 flex-1 pl-4'>
        {selected && (
          <div className='mb-3 flex items-center gap-2'>
            <span className='text-[12px] font-medium text-slate-700 dark:text-slate-200'>{selected.name}</span>
            {!selected.is_active && (
              <button
                type='button'
                onClick={() => activateMut.mutate(selected.id)}
                className='rounded bg-nvr-cyan/10 px-2 py-0.5 text-[10px] font-medium text-nvr-cyan hover:bg-nvr-cyan/20'
              >
                Set active
              </button>
            )}
            {selected.is_active && (
              <span className='rounded bg-nvr-cyan/10 px-2 py-0.5 text-[10px] font-medium text-nvr-cyan'>
                Active
              </span>
            )}
            <div className='ml-auto flex items-center gap-1'>
              <button
                type='button'
                onClick={() => {
                  const name = `${selected.name} (copy)`
                  cloneMut.mutate({ id: selected.id, name })
                }}
                className='rounded px-2 py-0.5 text-[10px] text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800'
              >
                Clone
              </button>
              {confirmDeleteId === selected.id ? (
                <>
                  <span className='text-[10px] text-slate-500'>Delete?</span>
                  <button
                    type='button'
                    onClick={() => { deleteMut.mutate(selected.id); setConfirmDeleteId(null) }}
                    className='rounded px-2 py-0.5 text-[10px] text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20'
                  >
                    Yes
                  </button>
                  <button
                    type='button'
                    onClick={() => setConfirmDeleteId(null)}
                    className='rounded px-2 py-0.5 text-[10px] text-slate-500 hover:bg-slate-100'
                  >
                    No
                  </button>
                </>
              ) : (
                <button
                  type='button'
                  onClick={() => setConfirmDeleteId(selected.id)}
                  className='rounded px-2 py-0.5 text-[10px] text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20'
                >
                  Delete
                </button>
              )}
            </div>
          </div>
        )}
        <FieldGroupsTab
          tableName={tableName}
          dbColumns={dbColumns}
          layoutId={effectiveId}
        />
      </div>
    </div>
  )
}
```

- [ ] **Step 7: Replace the `tab === 'groups'` render in the tab content area**

Find:
```typescript
{tab === 'groups' && <FieldGroupsTab tableName={table ?? ''} dbColumns={tableData?.columns ?? []} />}
```
Replace with:
```typescript
{tab === 'groups' && <LayoutsTab tableName={table ?? ''} dbColumns={tableData?.columns ?? []} />}
```

- [ ] **Step 8: Run `/impeccable` on the Layout tab**

```
/impeccable admin/src/pages/TableEditor.tsx LayoutsTab
```

- [ ] **Step 9: Commit**

```bash
git add admin/src/pages/TableEditor.tsx
git commit -m "feat: Layout tab supports multiple named layouts with sidebar"
```

---

## Task 7: SDK — Layout commands

**Files:**
- Modify: `sdk/src/commands/devex.ts`

- [ ] **Step 1: Add the interfaces and commands at the end of `devex.ts`**

```typescript
// ─── Collection layouts ───────────────────────────────────────────────────────

export interface CollectionLayout {
  id: number
  collection: string
  name: string
  is_active: boolean | number
  sort: number
  created_at: ISODate
}

export interface LayoutAssignment {
  field: string
  group_key: string | null
  sort: number
}

export interface LayoutGroup {
  id: number
  collection: string
  key: string
  label: string
  type: 'section' | 'tab'
  icon: string | null
  sort: number
  is_collapsed: boolean | number
  layout_id: number
}

/** List all layouts for a collection. */
export function readCollectionLayouts(
  collection: string
): Command<{ data: CollectionLayout[] }> {
  return cmd('GET', '/collection-layouts', { collection })
}

/** Read the active layout for a collection (groups + assignments). */
export function readActiveLayout(collection: string): Command<{
  data: { layout: CollectionLayout; groups: LayoutGroup[]; assignments: LayoutAssignment[] }
}> {
  return cmd('GET', `/collection-layouts/active`, { collection })
}

/** Read groups for a specific layout by id (requires knowing the collection). */
export function readLayoutGroups(
  collection: string,
  layoutId: number
): Command<{ data: LayoutGroup[] }> {
  return cmd('GET', `/field-groups/${collection}`, { layout_id: layoutId })
}

/** Read field assignments for a specific layout. */
export function readLayoutAssignments(layoutId: number): Command<{ data: LayoutAssignment[] }> {
  return cmd('GET', `/collection-layouts/${layoutId}/assignments`)
}

/** Activate a layout (deactivates all others for the collection). */
export function activateLayout(layoutId: number): Command<{ data: CollectionLayout }> {
  return cmd('POST', `/collection-layouts/${layoutId}/activate`)
}

/** Clone a layout. */
export function cloneLayout(layoutId: number, name: string): Command<{ data: CollectionLayout }> {
  return cmd('POST', `/collection-layouts/${layoutId}/clone`, undefined, { name })
}
```

> **Note:** `readActiveLayout` requires the `GET /collection-layouts/active?collection=x` convenience endpoint added in Task 2. It must appear BEFORE the `/:id` route in `collection-layouts.ts` (static routes before param routes in Fastify). Code was added there already — see Task 2.

```typescript
  // GET /collection-layouts/active?collection=x — convenience: active layout + groups + assignments
  app.get('/active', { preHandler: authenticate }, async (req, reply) => {
    const { collection } = req.query as { collection?: string }
    if (!collection) return reply.code(400).send({ error: 'collection is required' })

    const layout = await db('nivaro_collection_layouts')
      .where({ collection, is_active: 1 })
      .first()
    if (!layout) return reply.code(404).send({ error: 'No active layout' })

    const [groups, assignments] = await Promise.all([
      db('nivaro_field_groups').where({ layout_id: layout.id }).orderBy('sort', 'asc'),
      db('nivaro_layout_field_assignments').where({ layout_id: layout.id }).orderBy('sort', 'asc')
    ])

    return reply.send({ data: { layout, groups, assignments } })
  })
```

> Register this route BEFORE `/:id` routes in `collection-layouts.ts` (static routes before param routes in Fastify).

- [ ] **Step 2: Export the new types from `sdk/src/index.ts`**

The SDK already does `export * from './commands/devex.js'` — the new types are automatically exported.

- [ ] **Step 3: Commit**

```bash
git add sdk/src/commands/devex.ts sdk/src/routes/collection-layouts.ts
git commit -m "feat: SDK layout commands + /active convenience endpoint"
```

---

## Task 8: SDK Playground — Layouts group

**Files:**
- Modify: `admin/src/pages/SdkPlayground.tsx`

- [ ] **Step 1: Add Layouts group to the `COMMANDS` array**

Find the end of the `COMMANDS` array (before the closing `]`) and add:

```typescript
  // ─── Layouts ───
  {
    name: 'readCollectionLayouts',
    group: 'Layouts',
    description: 'List all layouts for a collection.',
    method: 'GET',
    path: '/collection-layouts',
    params: [pc('query', true, 'articles')]
  },
  {
    name: 'readActiveLayout',
    group: 'Layouts',
    description: 'Read the active layout with groups + field assignments.',
    method: 'GET',
    path: '/collection-layouts/active',
    params: [pc('query', true, 'articles')]
  },
  {
    name: 'readLayoutAssignments',
    group: 'Layouts',
    description: 'Read field assignments for a specific layout by ID.',
    method: 'GET',
    path: '/collection-layouts/{id}/assignments',
    params: [p('id', 'number', 'path', true, '1')]
  },
  {
    name: 'activateLayout',
    group: 'Layouts',
    description: 'Activate a layout — deactivates all others for the collection.',
    method: 'POST',
    path: '/collection-layouts/{id}/activate',
    params: [p('id', 'number', 'path', true, '1')]
  },
  {
    name: 'cloneLayout',
    group: 'Layouts',
    description: 'Clone a layout with a new name.',
    method: 'POST',
    path: '/collection-layouts/{id}/clone',
    params: [
      p('id', 'number', 'path', true, '1'),
      p('name', 'string', 'body', true, 'Compact copy')
    ]
  },
```

- [ ] **Step 2: Commit**

```bash
git add admin/src/pages/SdkPlayground.tsx
git commit -m "feat: SDK Playground adds Layouts group"
```

---

## Task 9: @nivaro/react — layout support

**Files:**
- Modify: `react/src/types.ts`
- Modify: `react/src/hooks/useFormSchema.ts`
- Modify: `react/src/hooks/useNivaroForm.ts`

- [ ] **Step 1: Add `layoutId` to `UseNivaroFormOptions` in `types.ts`**

Find `UseNivaroFormOptions` (around line 104) and add the option:

```typescript
export type UseNivaroFormOptions = {
  mode: 'create' | 'edit'
  /** required when mode='edit' */
  itemId?: string | number
  defaultValues?: Record<string, unknown>
  onSuccess?: (item: Record<string, unknown>) => void
  onError?: (error: Error) => void
  /** custom synchronous validators; return an error string or null when valid */
  validate?: Record<string, (value: unknown, values: Record<string, unknown>) => string | null>
  /** include hidden fields in the schema (default false) */
  includeHidden?: boolean
  /**
   * Specific layout id to use for group/field ordering.
   * When omitted, the collection's active layout is used automatically.
   */
  layoutId?: number
}
```

- [ ] **Step 2: Update `fetchSchema` in `useFormSchema.ts` to accept and use `layoutId`**

Find `export async function fetchSchema` (around line 292) and replace:

```typescript
export async function fetchSchema(
  client: NivaroClient,
  collection: string,
  includeHidden: boolean,
  layoutId?: number
): Promise<FormSchema> {
  const groupsPath = layoutId
    ? `/field-groups/${collection}`
    : `/field-groups/${collection}`
  const groupsParams = layoutId ? { layout_id: layoutId } : {}

  const [collectionRes, groupsRes, assignmentsRes] = await Promise.all([
    client.request<{ data: CMSCollectionResponse }>(get(`/collections/${collection}`)),
    client.request<{ data: CMSGroupRow[] }>(get(groupsPath, groupsParams)),
    layoutId
      ? client.request<{ data: Array<{ field: string; group_key: string | null; sort: number }> }>(
          get(`/collection-layouts/${layoutId}/assignments`)
        )
      : Promise.resolve({ data: [] as Array<{ field: string; group_key: string | null; sort: number }> })
  ])

  // Build assignment override map
  const assignmentMap = new Map<string, { group_key: string | null; sort: number }>()
  for (const a of assignmentsRes.data ?? []) {
    assignmentMap.set(a.field, { group_key: a.group_key, sort: a.sort })
  }

  return buildSchema(collection, collectionRes.data, groupsRes.data ?? [], includeHidden, assignmentMap)
}
```

- [ ] **Step 3: Update `buildSchema` to accept and apply the assignment map**

Find `function buildSchema(` (around line 217) and update its signature and field mapping:

```typescript
function buildSchema(
  collection: string,
  meta: CMSCollectionResponse,
  groupRows: CMSGroupRow[],
  includeHidden: boolean,
  assignmentMap?: Map<string, { group_key: string | null; sort: number }>
): FormSchema {
  const rawFields = meta.fields ?? []
  const relations = meta.relations ?? []

  const fields: FormFieldDescriptor[] = rawFields
    .filter((f) => includeHidden || !toBool(f.hidden))
    .map((f) => {
      const relation = buildFieldRelation(collection, f.field, relations)
      const type = f.type ?? 'string'
      const iface = f.interface ?? null
      const assignment = assignmentMap?.get(f.field)
      return {
        field: f.field,
        type,
        fieldType: normalizeFieldType(type, iface, relation),
        interface: iface,
        label: f.label ?? titleCaseField(f.field),
        note: f.note ?? null,
        required: toBool(f.required),
        readonly: toBool(f.readonly),
        hidden: toBool(f.hidden),
        sort: assignment ? assignment.sort : (f.sort ?? null),
        group: assignment ? assignment.group_key : (f.group_key ?? null),
        options:
          parseJsonColumn<Record<string, unknown>>(f.options) ??
          parseJsonColumn<Record<string, unknown>>(
            (f as Record<string, unknown>).remote_options_config
          ),
        validationRules: parseJsonColumn<FormValidationRule[]>(f.validation_rules),
        visibilityRules: parseJsonColumn<FormVisibilityRule[]>(f.visibility_rules),
        lockCondition: parseJsonColumn<FormLockCondition>(f.lock_condition),
        relation,
        defaultValue: f.default_value
      }
    })
    .sort((a, b) => {
      if (a.sort == null && b.sort == null) return 0
      if (a.sort == null) return 1
      if (b.sort == null) return -1
      return a.sort - b.sort
    })
  // ... rest of buildSchema unchanged (groups + return)
```

- [ ] **Step 4: Update `cacheKey` and `useFormSchema` to include layoutId**

Find `function cacheKey` (around line 288):
```typescript
function cacheKey(clientUrl: string, collection: string, includeHidden: boolean, layoutId?: number): string {
  return `${clientUrl}::${collection}::${includeHidden ? 'h' : ''}::${layoutId ?? 'active'}`
}
```

Update `useFormSchema` signature:
```typescript
export function useFormSchema(
  client: NivaroClient | null,
  collection: string,
  includeHidden = false,
  layoutId?: number
): { schema: FormSchema | null; loading: boolean; error: Error | null } {
  const key = client ? cacheKey(client.url, collection, includeHidden, layoutId) : null
```

Update the `fetchSchema` call inside the effect:
```typescript
    fetchSchema(client, collection, includeHidden, layoutId)
```

Update the effect deps array: `}, [client, collection, includeHidden, key, layoutId])`

- [ ] **Step 5: Thread `layoutId` from `useNivaroForm`**

In `useNivaroForm.ts`, find:
```typescript
  const {
    includeHidden = false
  } = options
```
Add `layoutId` to the destructure:
```typescript
  const {
    includeHidden = false,
    layoutId
  } = options
```

Find the `useFormSchema` call:
```typescript
  const {
    schema,
    loading: schemaLoading,
    error: schemaError
  } = useFormSchema(resolvedClient, collection, includeHidden)
```
Replace with:
```typescript
  const {
    schema,
    loading: schemaLoading,
    error: schemaError
  } = useFormSchema(resolvedClient, collection, includeHidden, layoutId)
```

- [ ] **Step 6: Commit**

```bash
git add react/src/types.ts react/src/hooks/useFormSchema.ts react/src/hooks/useNivaroForm.ts
git commit -m "feat: @nivaro/react useNivaroForm accepts layoutId option"
```

---

## Task 10: Docs + CLAUDE.md

**Files:**
- Modify: `admin/src/docs/sections/platform.ts`
- Modify: `admin/src/docs/index.ts`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add doc section to `platform.ts`**

At the end of `platform.ts`, add:

```typescript
export const collectionLayouts: DocSection = {
  id: 'collection-layouts',
  label: 'Collection Layouts',
  content: [
    { type: 'h1', id: 'collection-layouts', text: 'Collection Layouts' },
    {
      type: 'p',
      text: 'Each registered collection can have multiple named layouts. A layout defines how fields are grouped and ordered in the item editor. One layout is marked active and used by ItemEdit automatically; others can be referenced by name via the SDK.'
    },
    { type: 'h3', text: 'Managing layouts' },
    {
      type: 'p',
      text: 'Open Data Model → select a collection → Layout tab. The left panel lists layouts for the collection. Click a layout to edit its groups and field assignments. The active layout (shown with a cyan dot) is what the item editor displays. Double-click a layout name to rename it inline.'
    },
    {
      type: 'table',
      head: ['Action', 'How'],
      rows: [
        ['Create layout', 'Click "+ Add layout" at the bottom of the left panel'],
        ['Set active', 'Open a layout → click "Set active" in the toolbar'],
        ['Clone layout', 'Open a layout → click "Clone" to duplicate groups + field assignments'],
        ['Delete layout', 'Open a layout → click "Delete" (blocked if it is the only layout)'],
        ['Rename layout', 'Double-click the layout name in the left panel']
      ]
    },
    { type: 'h3', text: 'API' },
    {
      type: 'pre',
      code: `GET  /api/collection-layouts?collection=articles
POST /api/collection-layouts                    { collection, name }
POST /api/collection-layouts/:id/activate
POST /api/collection-layouts/:id/clone          { name }
GET  /api/collection-layouts/:id/assignments
PUT  /api/collection-layouts/:id/assignments    { assignments: [{field, group_key, sort}] }
DELETE /api/collection-layouts/:id`
    },
    { type: 'h3', text: 'SDK' },
    {
      type: 'pre',
      code: `import { readCollectionLayouts, readActiveLayout, readLayoutAssignments, activateLayout, cloneLayout } from '@nivaro/sdk'

// List all layouts
const layouts = await cms.request(readCollectionLayouts('articles'))

// Read active layout with groups + assignments
const active = await cms.request(readActiveLayout('articles'))

// Use a specific layout in @nivaro/react
useNivaroForm('articles', { mode: 'create', layoutId: 42 })`
    }
  ]
}
```

- [ ] **Step 2: Export from `admin/src/docs/index.ts`**

Find the existing platform section exports and add `collectionLayouts` to the appropriate nav group. Search for where `platform` sections are listed and add:

```typescript
import { collectionLayouts } from './sections/platform.js'
// ... in the nav group for Data Model / Schema:
collectionLayouts,
```

- [ ] **Step 3: Update CLAUDE.md system tables**

In the system tables section, add after `nivaro_field_groups`:

```markdown
| `nivaro_collection_layouts` | Named layouts per collection; `is_active` marks the one used by ItemEdit; UNIQUE(collection, name) |
| `nivaro_layout_field_assignments` | Per-layout field→group assignment + sort; UNIQUE(layout_id, field); overrides `group_key` on `nivaro_fields` |
```

Add to "Column additions" section:
```
`nivaro_field_groups` — layout_id (int nullable FK → nivaro_collection_layouts.id ON DELETE CASCADE)
```

Add to routes table:
```
| `/collection-layouts` | Layout CRUD + activate + clone + assignments |
```

Add to gotchas section:
```
- **`group_key` on `nivaro_fields` is legacy fallback** — for collections with layouts, `nivaro_layout_field_assignments` takes precedence; `GET /field-config/:collection` overlays the active layout's assignments automatically
- **`readActiveLayout` is a compound endpoint** — returns `{ layout, groups, assignments }` in one call to avoid N+1 in SDK consumers
- **Layout tab = `LayoutsTab` wrapping `FieldGroupsTab`** — `FieldGroupsTab` accepts `layoutId` prop; writes field assignments to `PUT /collection-layouts/:id/assignments`, not to `group_key` on fields
```

- [ ] **Step 4: Commit**

```bash
git add admin/src/docs/sections/platform.ts admin/src/docs/index.ts CLAUDE.md
git commit -m "docs: add collection layouts documentation and CLAUDE.md updates"
```

---

## Parallel Execution Map

Tasks 1 → 2,3,4 → 5 → 6,7,9 (parallel) → 8 → 10

```
Task 1 (migration)
   ↓
Tasks 2+3+4 (API — can be written in parallel, deployed together)
   ↓
Task 5 (register routes)
   ↓
┌──────────┬──────────┐
Task 6    Task 7    Task 9
(TableEditor) (SDK)  (@nivaro/react)
    ↓
Task 8 (Playground)
    ↓
Task 10 (Docs + CLAUDE.md)
```
