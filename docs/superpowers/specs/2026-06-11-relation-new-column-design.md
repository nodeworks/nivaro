# Relation Form — Auto-Create Column

**Date:** 2026-06-11
**Status:** Approved

## Overview

When adding a new relation in the Data Model Relations tab, the user can type a column name that doesn't exist yet on the current table. The column is created automatically before the relation is saved. This removes the two-step process of creating the column under Fields first, then creating the relation.

**Scope:** Only columns on the **current table being edited** are auto-created. Fields on related/junction tables are not affected. This applies to:
- M2O `many_field` (FK on current table pointing to related table)
- M2A `many_field` (FK on current table for many-to-any)

---

## ColSel Component Changes

**New optional props:**
```typescript
allowNew?: boolean
onNewColumn?: (name: string) => void
```

**Behavior when `allowNew` is true:**
- If the typed search text doesn't match any existing column, a "✚ Create '[name]'" item appears at the bottom of the dropdown list
- Selecting it: calls `onChange(name)` + `onNewColumn(name)`
- Selecting an existing column: calls `onChange(name)` only (parent resets `is_new_field` to false)
- Trigger button: when the current value doesn't exist in the loaded column list, shows value in `text-nvr-cyan` with a small `NEW` badge

---

## Form State

Add to `DEFAULT_REL_FORM`:
```typescript
m2o_is_new_field: false,
m2o_new_field_type: 'integer' as 'integer' | 'uuid',
m2a_is_new_field: false,
m2a_new_field_type: 'integer' as 'integer' | 'uuid',
```

**Type toggle:** When `m2o_is_new_field` (or `m2a_is_new_field`) is true, a type pill appears inline below the ColSel inside the diagram node:

```
Column type:  [integer ✓]  [uuid]
```

Two-button pill, defaults to `integer`. Hides when user selects an existing column (is_new_field resets to false).

---

## RelationFormDiagram Changes

For **M2O** `many_field` ColSel:
- Add `allowNew` prop
- `onNewColumn` callback: `patch({ m2o_is_new_field: true })`
- `onChange` callback (normal pick): add `patch({ m2o_is_new_field: false })` reset alongside existing `patch({ m2o_many_field: v })`
- Render type pill below ColSel when `form.m2o_is_new_field` is true

For **M2A** `many_field` ColSel: same pattern with `m2a_*` fields.

O2M and M2M ColSels are unchanged (those fields are on other tables).

---

## Save Logic

In the relation save handler, before calling the relation API:

```typescript
if (relType === 'm2o' && form.m2o_is_new_field && form.m2o_many_field) {
  await schemaApi.addColumn(tableName, {
    name: form.m2o_many_field,
    type: form.m2o_new_field_type
  })
}
if (relType === 'm2a' && form.m2a_is_new_field && form.m2a_many_field) {
  await schemaApi.addColumn(tableName, {
    name: form.m2a_many_field,
    type: form.m2a_new_field_type
  })
}
```

**Error handling:** If `addColumn` throws, show `toast.error('Failed to create column')` and abort — do not call the relation API. No orphaned relations.

The created column has no FK constraint unless the existing "Also create FK constraint" checkbox is checked (that behavior is unchanged).

---

## Files

| File | Change |
|---|---|
| `admin/src/pages/TableEditor.tsx` | `ColSel` new props; `DEFAULT_REL_FORM` new fields; `RelationFormDiagram` M2O+M2A sections; save handler pre-create |
