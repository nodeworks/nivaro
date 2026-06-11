# Multiple Layouts per Collection

**Date:** 2026-06-11
**Status:** Approved

## Overview

Allow each collection to have multiple named layouts. One layout is marked active and used by ItemEdit. Other layouts can be fetched via SDK or referenced from other parts of the app.

A layout defines: ordered groups (sections/tabs) + per-layout field assignments (which field is in which group, in what order).

---

## Schema & Migration

### New table: `nivaro_collection_layouts`

| Column | Type | Notes |
|---|---|---|
| id | increments PK | |
| collection | varchar(255) NOT NULL | |
| name | varchar(255) NOT NULL | e.g. "Default", "Compact", "Print" |
| is_active | bit DEFAULT 0 | one active per collection, enforced in app |
| sort | int DEFAULT 0 | display order in left panel |
| created_at | datetime DEFAULT now | |

`UNIQUE(collection, name)`

### Modified: `nivaro_field_groups`

- Add `layout_id` int nullable → FK `nivaro_collection_layouts.id` ON DELETE CASCADE

### New table: `nivaro_layout_field_assignments`

| Column | Type | Notes |
|---|---|---|
| id | increments PK | |
| layout_id | int FK → nivaro_collection_layouts.id ON DELETE CASCADE | |
| field | varchar(255) NOT NULL | field name |
| group_key | varchar(255) nullable | null = ungrouped/floating |
| sort | int DEFAULT 0 | |

`UNIQUE(layout_id, field)`

### Migration `067_collection_layouts.ts`

1. Create `nivaro_collection_layouts`
2. Add `layout_id` nullable to `nivaro_field_groups`
3. Create `nivaro_layout_field_assignments`
4. Data migration: for each distinct collection in `nivaro_field_groups`, insert a "Default" layout (is_active=1), update all groups for that collection to set `layout_id`
5. Seed `nivaro_layout_field_assignments` from existing `group_key` + sort on `nivaro_fields` for every collection that has field groups

`group_key` on `nivaro_fields` is kept as legacy fallback — used when no layout assignment exists for a field.

---

## API Routes

### New resource: `/api/collection-layouts`

```
GET    /collection-layouts?collection=x         list layouts for collection
POST   /collection-layouts                      create { collection, name }
PATCH  /collection-layouts/:id                  update { name?, sort? }
DELETE /collection-layouts/:id                  blocked if is_active and only layout
POST   /collection-layouts/:id/activate         set active, deactivates others for same collection
POST   /collection-layouts/:id/clone            clone groups + assignments → new layout { name }
```

### Layout field assignments

```
GET /collection-layouts/:id/assignments         returns [{ field, group_key, sort }]
PUT /collection-layouts/:id/assignments         bulk-replace all assignments for layout
```

### Modified: `/api/field-groups`

```
GET /field-groups?collection=x                  returns groups for ACTIVE layout only (no breaking change)
GET /field-groups?collection=x&layout_id=y      explicit layout (SDK use case)
POST /field-groups                              requires layout_id in body
```

---

## Admin UI

### Layout tab in TableEditor

Master-detail layout (matches Roles/DataModel/Pipelines pattern):

- **Left panel** `w-[140px]`: layout list, active item has `●` + cyan highlight, "+ Add layout" at bottom
- **Right panel**: existing `FieldGroupsTab` reused, now scoped to `selectedLayoutId`
- **Top-right toolbar**: "Set active" (hidden when already active), "Clone", "Delete"
- Inline rename on double-click or pencil icon
- Switching layout in left panel re-fetches right panel content for that `layout_id`
- Delete blocked if it's the only layout for the collection
- Visual polish handled by `/impeccable`

`FieldGroupsTab` refactored to accept a `layoutId` prop. All group/assignment mutations pass `layout_id`. Field sort/group assignments saved to `nivaro_layout_field_assignments` instead of patching `group_key` on `nivaro_fields`.

### ItemEdit

No visible change. `GET /field-groups?collection=x` silently returns groups for the active layout. Zero frontend change needed in ItemEdit.

---

## SDK

New commands in `sdk/src/`:

```typescript
readCollectionLayouts(collection: string)
// GET /collection-layouts?collection=x
// Returns list of layouts with id, name, is_active, sort

readLayout(layoutId: number)
// GET /field-groups?layout_id=x  +  GET /collection-layouts/:id/assignments
// Returns groups with their assigned fields in order

readActiveLayout(collection: string)
// GET /collection-layouts?collection=x&active=true
// Convenience — returns the single active layout with groups + assignments
```

Primary SDK use case: external app fetches a named layout (e.g. "Compact") and uses the group/field structure to render its own form.

---

## @nivaro/react Form — Layout Support

`useNivaroForm` and `<NivaroForm>` accept an optional `layoutId` (or `layoutName`) option. When provided, form schema is fetched using that layout instead of the active default.

```typescript
// by id
useNivaroForm('articles', { layoutId: 42 })

// by name (convenience — resolves via readCollectionLayouts)
useNivaroForm('articles', { layoutName: 'Compact' })
```

`fetchFormSchema` in `@nivaro/sdk` updated to accept `layoutId` / `layoutName` param — passes `layout_id` query param to `/field-groups`.

---

## SDK Playground

Add "Layouts" section to the SDK Playground page:
- Dropdown to select a collection
- Fetch + display all layouts for that collection (`readCollectionLayouts`)
- Select a layout → display groups + field assignments (`readLayout`)

---

## Documentation Updates

After implementation:
1. `admin/src/docs/sections/` — update field-groups / data-model section to cover layouts
2. `admin/src/docs/index.ts` — export updated section
3. `www/docs.html` — add matching nav item + section content
4. SDK README — document `readCollectionLayouts`, `readLayout`, `readActiveLayout`
5. `CLAUDE.md` — add system tables, routes, and gotchas noted above

---

## CLAUDE.md Updates

- Add `nivaro_collection_layouts` and `nivaro_layout_field_assignments` to system tables
- Add `layout_id` column addition note to `nivaro_field_groups`
- Add `/collection-layouts` to API routes section
- Note: `group_key` on `nivaro_fields` is legacy fallback; layout assignments table takes precedence for layout-enabled collections
