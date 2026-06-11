# Relation Form — Auto-Create Column Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow typing a new column name in the M2O/M2A relation form that doesn't exist yet; it gets created automatically (with a type selector) before the relation is saved.

**Architecture:** All changes are in one file — `admin/src/pages/TableEditor.tsx`. `ColSel` gains `allowNew` + `onNewColumn` props. `DEFAULT_REL_FORM` gains four new fields. `RelationFormDiagram` renders a type pill when a new column is selected. `createMut` pre-creates the column via `schemaApi.addColumn` before saving the relation.

**Tech Stack:** React 19, Tanstack Query v5, shadcn/ui (Command/Popover), `schemaApi.addColumn`, Biome (no semicolons, single quotes, 2-space indent)

---

## File Map

| File | Change |
|---|---|
| `admin/src/pages/TableEditor.tsx` | All changes — ColSel, DEFAULT_REL_FORM, RelationFormDiagram, createMut |

---

## Task 1: Extend ColSel with `allowNew` + `onNewColumn`

**Files:**
- Modify: `admin/src/pages/TableEditor.tsx` — `ColSel` function (lines ~2050–2108)

The current `ColSel` is a pure column-picker dropdown. Add `allowNew?: boolean` and `onNewColumn?: (name: string) => void` props. When `allowNew` is true:
- Track the `CommandInput` search text in local state
- If the typed text doesn't match any existing column name, append a "✚ Create '[text]'" item at the bottom of the list
- Selecting that item calls `onChange(text)` + `onNewColumn?.(text)`
- When the displayed value is not in the loaded column list (i.e. it's a new name), show it in cyan with a small "NEW" badge

- [ ] **Step 1: Read the current `ColSel` function**

Read `admin/src/pages/TableEditor.tsx` lines 2050–2108 to understand the current code before editing.

- [ ] **Step 2: Replace `ColSel` with the extended version**

Replace the entire `function ColSel` block with:

```typescript
function ColSel({
  table,
  value,
  onChange,
  placeholder,
  disabled,
  allowNew,
  onNewColumn
}: {
  table: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  disabled?: boolean
  allowNew?: boolean
  onNewColumn?: (name: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const { data, isFetching } = useQuery({
    queryKey: ['data-model-table', table],
    queryFn: () => schemaApi.getTable(table),
    enabled: !!table
  })
  const cols = data?.data?.columns ?? []
  const selected = cols.find((c) => c.name === value)
  const isDisabled = disabled || !table || isFetching
  const isNew = !!value && !selected

  const trimmed = search.trim()
  const showCreate = allowNew && !!trimmed && !cols.some((c) => c.name === trimmed)

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setSearch('') }}>
      <PopoverTrigger asChild>
        <button
          type='button'
          disabled={isDisabled}
          className='flex h-7 w-full items-center justify-between rounded-md border border-slate-200 bg-white px-2 text-left text-[12px] text-slate-800 focus:outline-none focus:ring-1 focus:ring-nvr-cyan disabled:opacity-50 dark:border-border dark:bg-card dark:text-foreground'
        >
          <span className={cn('flex items-center gap-1 truncate', !value && 'text-slate-400')}>
            {isFetching
              ? 'Loading…'
              : value
                ? (
                  <>
                    <span className={cn('font-mono', isNew && 'text-nvr-cyan')}>{value}</span>
                    {isNew && (
                      <span className='rounded bg-nvr-cyan/10 px-1 py-0 text-[9px] font-semibold uppercase tracking-wide text-nvr-cyan'>
                        NEW
                      </span>
                    )}
                    {selected && (
                      <span className='text-slate-400'>({selected.data_type})</span>
                    )}
                  </>
                )
                : (placeholder ?? 'Select column…')}
          </span>
          <ChevronDown className='ml-1 h-3 w-3 shrink-0 text-slate-400' />
        </button>
      </PopoverTrigger>
      <PopoverContent className='w-[240px] p-0' align='start'>
        <Command>
          <CommandInput
            placeholder='Search or type new…'
            className='h-8 text-[12px]'
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            <CommandEmpty className={cn('py-2 text-center text-[12px] text-slate-400', showCreate && 'hidden')}>
              No columns
            </CommandEmpty>
            {cols.map((c) => (
              <CommandItem
                key={c.name}
                value={`${c.name} ${c.data_type}`}
                onSelect={() => { onChange(c.name); onNewColumn && onNewColumn(''); setOpen(false); setSearch('') }}
                className='text-[12px]'
              >
                <Check className={cn('mr-1.5 h-3 w-3 shrink-0', value === c.name ? 'opacity-100' : 'opacity-0')} />
                <span className='font-mono'>{c.name}</span>
                <span className='ml-1.5 text-slate-400'>({c.data_type})</span>
              </CommandItem>
            ))}
            {showCreate && (
              <CommandItem
                key='__create__'
                value={`__create__ ${trimmed}`}
                onSelect={() => {
                  onChange(trimmed)
                  onNewColumn?.(trimmed)
                  setOpen(false)
                  setSearch('')
                }}
                className='text-[12px] text-nvr-cyan'
              >
                <span className='mr-1.5 text-nvr-cyan'>✚</span>
                Create <span className='mx-1 font-mono font-semibold'>'{trimmed}'</span>
              </CommandItem>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
```

Note: when an **existing** column is selected, `onNewColumn?.('')` is called with an empty string — the parent uses this to clear `is_new_field`. The parent reads whether the value is new by checking if the string is non-empty.

- [ ] **Step 3: Verify build compiles**

```bash
cd /Users/nodeworks/Documents/Projects/nivaro && pnpm --filter @nivaro/admin build 2>&1 | tail -20
```

Expected: no TypeScript errors in `TableEditor.tsx`.

- [ ] **Step 4: Commit**

```bash
git add admin/src/pages/TableEditor.tsx
git commit -m "feat: ColSel supports allowNew + onNewColumn for new-column creation"
```

---

## Task 2: Add new fields to DEFAULT_REL_FORM

**Files:**
- Modify: `admin/src/pages/TableEditor.tsx` — `DEFAULT_REL_FORM` constant (lines ~2469–2484)

- [ ] **Step 1: Read the current `DEFAULT_REL_FORM` constant**

Read lines 2469–2484 to confirm current shape.

- [ ] **Step 2: Add four new fields to `DEFAULT_REL_FORM`**

Find:
```typescript
const DEFAULT_REL_FORM = {
  m2o_many_field: '',
  m2o_one_collection: '',
  m2o_one_field: '',
  m2o_create_fk: false,
  o2m_many_collection: '',
  o2m_many_field: '',
  m2m_junction: '',
  m2m_many_field: '',
  m2m_junction_field: '',
  m2m_one_collection: '',
  m2m_one_field: '',
  m2a_many_field: '',
  m2a_one_collection_field: '',
  m2a_one_allowed_collections: ''
}
```

Replace with:
```typescript
const DEFAULT_REL_FORM = {
  m2o_many_field: '',
  m2o_one_collection: '',
  m2o_one_field: '',
  m2o_create_fk: false,
  m2o_is_new_field: false,
  m2o_new_field_type: 'integer' as 'integer' | 'uuid',
  o2m_many_collection: '',
  o2m_many_field: '',
  m2m_junction: '',
  m2m_many_field: '',
  m2m_junction_field: '',
  m2m_one_collection: '',
  m2m_one_field: '',
  m2a_many_field: '',
  m2a_one_collection_field: '',
  m2a_one_allowed_collections: '',
  m2a_is_new_field: false,
  m2a_new_field_type: 'integer' as 'integer' | 'uuid'
}
```

- [ ] **Step 3: Verify build compiles**

```bash
cd /Users/nodeworks/Documents/Projects/nivaro && pnpm --filter @nivaro/admin build 2>&1 | tail -20
```

Expected: no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add admin/src/pages/TableEditor.tsx
git commit -m "feat: DEFAULT_REL_FORM gains new-field tracking for m2o + m2a"
```

---

## Task 3: Update RelationFormDiagram M2O + M2A ColSels + type pill

**Files:**
- Modify: `admin/src/pages/TableEditor.tsx` — `RelationFormDiagram` function, M2O block (~lines 2221–2282) and M2A block (~lines 2411–2466)

- [ ] **Step 1: Read the M2O block in RelationFormDiagram**

Read lines 2221–2282 to see the current M2O `ColSel` and checkbox layout.

- [ ] **Step 2: Update the M2O `ColSel` and add type pill**

Find the M2O `ColSel` for `m2o_many_field`:
```typescript
              <ColSel
                table={tableName}
                value={form.m2o_many_field}
                onChange={(v) => patch({ m2o_many_field: v })}
              />
```

Replace with:
```typescript
              <>
                <ColSel
                  table={tableName}
                  value={form.m2o_many_field}
                  onChange={(v) => patch({ m2o_many_field: v, m2o_is_new_field: false })}
                  allowNew
                  onNewColumn={(name) => patch({ m2o_is_new_field: !!name })}
                />
                {form.m2o_is_new_field && (
                  <div className='mt-1 flex items-center gap-1.5'>
                    <span className='text-[10px] text-slate-400'>Column type:</span>
                    {(['integer', 'uuid'] as const).map((t) => (
                      <button
                        key={t}
                        type='button'
                        onClick={() => patch({ m2o_new_field_type: t })}
                        className={cn(
                          'rounded px-2 py-0.5 text-[10px] font-medium transition-colors',
                          form.m2o_new_field_type === t
                            ? 'bg-nvr-cyan/10 text-nvr-cyan'
                            : 'bg-slate-100 text-slate-500 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400'
                        )}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                )}
              </>
```

- [ ] **Step 3: Read the M2A block in RelationFormDiagram**

Read lines 2411–2466 to see the current M2A `ColSel`.

- [ ] **Step 4: Update the M2A `ColSel` and add type pill**

Find the M2A `ColSel` for `m2a_many_field`:
```typescript
              <ColSel
                table={tableName}
                value={form.m2a_many_field}
                onChange={(v) => patch({ m2a_many_field: v })}
              />
```

Replace with:
```typescript
              <>
                <ColSel
                  table={tableName}
                  value={form.m2a_many_field}
                  onChange={(v) => patch({ m2a_many_field: v, m2a_is_new_field: false })}
                  allowNew
                  onNewColumn={(name) => patch({ m2a_is_new_field: !!name })}
                />
                {form.m2a_is_new_field && (
                  <div className='mt-1 flex items-center gap-1.5'>
                    <span className='text-[10px] text-slate-400'>Column type:</span>
                    {(['integer', 'uuid'] as const).map((t) => (
                      <button
                        key={t}
                        type='button'
                        onClick={() => patch({ m2a_new_field_type: t })}
                        className={cn(
                          'rounded px-2 py-0.5 text-[10px] font-medium transition-colors',
                          form.m2a_new_field_type === t
                            ? 'bg-nvr-cyan/10 text-nvr-cyan'
                            : 'bg-slate-100 text-slate-500 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400'
                        )}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                )}
              </>
```

- [ ] **Step 5: Verify build compiles**

```bash
cd /Users/nodeworks/Documents/Projects/nivaro && pnpm --filter @nivaro/admin build 2>&1 | tail -20
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add admin/src/pages/TableEditor.tsx
git commit -m "feat: M2O + M2A relation form show type pill when new column typed"
```

---

## Task 4: Pre-create column in createMut before saving relation

**Files:**
- Modify: `admin/src/pages/TableEditor.tsx` — `createMut` (lines ~2683–2696)

The current `createMut.mutationFn` is `() => schemaApi.createRelation(buildPayload())`. Change it to an async function that optionally calls `schemaApi.addColumn` first.

- [ ] **Step 1: Read the current `createMut`**

Read lines 2683–2696 to confirm current shape.

- [ ] **Step 2: Replace `createMut` with pre-create logic**

Find:
```typescript
  const createMut = useMutation({
    mutationFn: () => schemaApi.createRelation(buildPayload()),
    onSuccess: () => {
      toast.success('Relation created')
      resetAdd()
      invalidate()
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        'Failed to create relation'
      toast.error(msg)
    }
  })
```

Replace with:
```typescript
  const createMut = useMutation({
    mutationFn: async () => {
      if (selectedType === 'm2o' && form.m2o_is_new_field && form.m2o_many_field) {
        await schemaApi.addColumn(tableName, {
          name: form.m2o_many_field,
          type: form.m2o_new_field_type,
          nullable: true
        })
      }
      if (selectedType === 'm2a' && form.m2a_is_new_field && form.m2a_many_field) {
        await schemaApi.addColumn(tableName, {
          name: form.m2a_many_field,
          type: form.m2a_new_field_type,
          nullable: true
        })
      }
      return schemaApi.createRelation(buildPayload())
    },
    onSuccess: () => {
      toast.success('Relation created')
      resetAdd()
      invalidate()
      onRefresh()
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        'Failed to create relation'
      toast.error(msg)
    }
  })
```

Note: `nullable: true` — FK columns should allow null by default (not every row will have the relation set). `onRefresh()` is added so the Fields tab also reflects the new column immediately.

- [ ] **Step 3: Verify build compiles**

```bash
cd /Users/nodeworks/Documents/Projects/nivaro && pnpm --filter @nivaro/admin build 2>&1 | tail -20
```

Expected: no errors.

- [ ] **Step 4: Manual smoke test**

Start dev server (`pnpm dev`), open a registered collection in Data Model → Relations tab, click Add → M2O, type a non-existent column name in the "Foreign key field" picker. Verify:
- "✚ Create '[name]'" option appears
- Selecting it shows cyan `NEW` badge and type pills below
- `integer` is selected by default
- Clicking Save creates both the column (visible in Fields tab) and the relation (visible in Relations tab)
- Error case: if column creation fails (duplicate name), toast error appears and relation is NOT created

- [ ] **Step 5: Commit**

```bash
git add admin/src/pages/TableEditor.tsx
git commit -m "feat: relation form auto-creates new column before saving (M2O + M2A)"
```
