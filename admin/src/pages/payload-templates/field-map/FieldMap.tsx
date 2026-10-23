import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors
} from '@dnd-kit/core'
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { AlertCircle, AlertTriangle, Plus, Redo2, Undo2 } from 'lucide-react'
import {
  memo,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import type { Field, MapSpec, Problem } from '../api'
import { FieldMapLayoutContext, FieldRow, INDENT, type RowActions } from './FieldRow'
import { parseContextPath } from './PathPicker'
import { EMPTY_META, type RowMeta, RowStore, useRowMeta } from './row-store'
import {
  addField,
  countFields,
  duplicateField,
  findField,
  inScalarList,
  latchLocks,
  lockState,
  moveField,
  moveFieldTo,
  type OpResult,
  removeField,
  renameKey,
  renameListAlias,
  SCALAR_ONE_FIELD,
  setType,
  structuralIssues,
  updateField,
  updateList,
  updateValue,
  visibleRowIds
} from './spec-ops'
import { type FieldMapEnv, FieldMapEnvContext, type ItemScope, type LookupInfo } from './ui'
import { useSpecHistory } from './useSpecHistory'

// ─── The field map editor ────────────────────────────────────────────────────
// The JSON body is built from rows, never typed, so it is always valid JSON
// with the right types. Every edit is a pure op from spec-ops.ts handed to the
// shell through onChange (the shell autosaves and refreshes the preview).
// Values and problems shown per row come from the server preview — the client
// never evaluates a template (spec §5.2).

export interface FieldMapProps {
  spec: MapSpec
  onChange: (spec: MapSpec) => void
  /** Server-computed value per field id for the preview record (lists: the first item). */
  values: Record<string, unknown>
  problems: Problem[]
  lockedKeys: string[]
  /** Body-secret names on the template's external API. */
  secretNames: string[]
  collection: string
  /** Template key — keeps undo history across tab switches. */
  historyKey?: string
  /** The template's own lookups (`{ key: { collection, … } }`) — offered as Related data. */
  lookups?: unknown
  /** Partner name for the locked-key tip (the external API name). */
  partner?: string | null
  /** The preview for the current draft is still loading. */
  valuesPending?: boolean
  /** `context.<key>` names a render can read (GET /:key `context_keys`) — offered as Related data. */
  contextKeys?: string[]
  /** Link to the API's Body secrets card (`/external-apis/<id>#body-secrets`); null = plain text. */
  secretsHref?: string | null
}

// Locks latched per template (row ids), kept across remounts like the undo history.
const latches = new Map<string, Set<string>>()

const NARROW_BELOW = 820

// Module constants: DndContext props that change identity re-render every sortable.
const MODIFIERS = [restrictToVerticalAxis]
// (sensor options too: a new object each render rebuilds the activators context)
const POINTER_OPTIONS = { activationConstraint: { distance: 4 } }
const KEYBOARD_OPTIONS = { coordinateGetter: sortableKeyboardCoordinates }
const A11Y = {
  screenReaderInstructions: {
    draggable:
      'To move a field, press Space or Enter. Use the arrow keys to move it inside its group, Space or Enter to drop it, Escape to cancel.'
  }
}

function isMod(e: KeyboardEvent | ReactKeyboardEvent) {
  return e.metaKey || e.ctrlKey
}

function lookupsFrom(raw: unknown, contextKeys: string[], spec: MapSpec): LookupInfo[] {
  const out = new Map<string, LookupInfo>()
  for (const key of contextKeys) if (key) out.set(key, { key })
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [key, def] of Object.entries(raw as Record<string, unknown>)) {
      const collection =
        def &&
        typeof def === 'object' &&
        typeof (def as { collection?: unknown }).collection === 'string'
          ? (def as { collection: string }).collection
          : undefined
      out.set(key, { key, collection: collection ?? out.get(key)?.collection })
    }
  }
  // Older rows without context_keys: the paths the map already reads name them.
  const seen = (p: string | undefined) => {
    const c = p ? parseContextPath(p) : null
    if (c && !out.has(c.key)) out.set(c.key, { key: c.key })
  }
  const walk = (fields: Field[] | undefined) => {
    for (const f of fields ?? []) {
      if (f.value?.source === 'path') seen(f.value.path)
      for (const fb of f.value?.fallbacks ?? []) if (fb.source === 'path') seen(fb.path)
      if (f.list) seen(f.list.source)
      walk(f.children)
    }
  }
  walk(spec.fields)
  return [...out.values()].sort((a, b) => a.key.localeCompare(b.key))
}

/** The rows' collection for a list whose source is a related lookup. */
function itemCollectionOf(f: Field, lookups: LookupInfo[]): string | undefined {
  if (f.type !== 'list' || !f.list?.source) return undefined
  const c = parseContextPath(f.list.source)
  return c ? lookups.find((l) => l.key === c.key)?.collection : undefined
}

// ─── Sortable block + group ──────────────────────────────────────────────────

interface BlockShared {
  store: RowStore
  actions: RowActions
  lookups: LookupInfo[]
}

const FieldBlock = memo(function FieldBlock({
  field,
  depth,
  scopeAlias,
  scopeCollection,
  isScalarChild,
  shared
}: {
  field: Field
  depth: number
  scopeAlias: string | null
  scopeCollection: string | undefined
  isScalarChild: boolean
  shared: BlockShared
}) {
  const meta = useRowMeta(shared.store, field.id)
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id: field.id })
  const scope = useMemo<ItemScope | null>(
    () => (scopeAlias ? { alias: scopeAlias, collection: scopeCollection } : null),
    [scopeAlias, scopeCollection]
  )
  const itemCollection = itemCollectionOf(field, shared.lookups)
  const isGroup = field.type === 'object' || field.type === 'list'
  const childAlias = field.type === 'list' ? field.list?.item || 'line' : scopeAlias
  const childCollection = field.type === 'list' ? itemCollection : scopeCollection
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
        zIndex: isDragging ? 5 : undefined
      }}
      className={cn(
        'relative',
        isDragging &&
          'rounded-md bg-white shadow-[0_4px_16px_rgba(0,0,0,0.10),0_1px_4px_rgba(0,0,0,0.06)] dark:bg-card'
      )}
    >
      <FieldRow
        field={field}
        depth={depth}
        meta={meta}
        scope={scope}
        itemCollection={itemCollection}
        isScalarChild={isScalarChild}
        actions={shared.actions}
        handle={{ ref: setActivatorNodeRef, attributes, listeners }}
        dragging={isDragging}
      />
      {isGroup && !meta.collapsed && (
        <FieldGroup
          fields={field.children ?? []}
          parentId={field.id}
          depth={depth + 1}
          scopeAlias={childAlias}
          scopeCollection={childCollection}
          scalarList={field.type === 'list' && !!field.list?.scalar}
          shared={shared}
        />
      )}
    </div>
  )
})

function AddRow({
  parentId,
  depth,
  actions,
  disabled
}: {
  parentId: string | null
  depth: number
  actions: RowActions
  disabled?: boolean
}) {
  const [text, setText] = useState('')
  const commit = () => {
    actions.add({ parent: parentId, key: text.trim() || undefined })
    setText('')
  }
  if (disabled) return null
  return (
    <div
      className='group/add flex h-8 items-center gap-1.5 pr-1.5'
      style={{ paddingLeft: 4 + depth * INDENT + 16 + 6 }}
      data-add-row={parentId ?? ''}
    >
      <Plus className='h-3.5 w-3.5 shrink-0 text-slate-400' aria-hidden />
      <input
        data-add-input=''
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          } else if (e.key === 'Escape') setText('')
        }}
        spellCheck={false}
        autoComplete='off'
        aria-label={parentId ? 'Add a field to this group' : 'Add a field'}
        placeholder={
          parentId
            ? 'Add a field here — type a key, press Enter'
            : 'Add a field — type a key, press Enter'
        }
        className='h-7 w-full min-w-0 max-w-[420px] rounded border border-transparent bg-transparent px-1.5 font-mono text-[12.5px] text-slate-900 placeholder:font-sans placeholder:text-slate-400 hover:border-slate-200 focus:border-nvr-cyan focus:bg-white focus:outline-none dark:text-foreground dark:placeholder:text-slate-500 dark:hover:border-border dark:focus:bg-background'
      />
    </div>
  )
}

const FieldGroup = memo(function FieldGroup({
  fields,
  parentId,
  depth,
  scopeAlias,
  scopeCollection,
  scalarList,
  shared
}: {
  fields: Field[]
  parentId: string | null
  depth: number
  scopeAlias: string | null
  scopeCollection: string | undefined
  scalarList: boolean
  shared: BlockShared
}) {
  // Same ids → same array, so a keystroke does not re-render every sortable in the group.
  const sig = fields.map((f) => f.id).join('\u0001')
  const ids = useMemo(() => (sig ? sig.split('\u0001') : []), [sig])
  return (
    <div>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {fields.map((f) => (
          <FieldBlock
            key={f.id}
            field={f}
            depth={depth}
            scopeAlias={scopeAlias}
            scopeCollection={scopeCollection}
            isScalarChild={scalarList}
            shared={shared}
          />
        ))}
      </SortableContext>
      <AddRow
        parentId={parentId}
        depth={depth}
        actions={shared.actions}
        // A plain-values list has exactly one child.
        disabled={scalarList && fields.length > 0}
      />
    </div>
  )
})

// ─── Field map ───────────────────────────────────────────────────────────────

export function FieldMap(props: FieldMapProps) {
  const { spec, values, problems, lockedKeys } = props
  const history = useSpecHistory(spec, props.onChange, props.historyKey)
  // The functions are stable; the object is not (canUndo/canRedo change).
  const { apply, current, undo, redo, isKnown } = history
  const rootRef = useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = useState(false)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [fresh, setFresh] = useState<string | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const storeRef = useRef<RowStore | null>(null)
  if (!storeRef.current) storeRef.current = new RowStore()
  const store = storeRef.current

  // Width decides one-line rows or two-line rows.
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? el.clientWidth
      setNarrow(w > 0 && w < NARROW_BELOW)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Recomputed per edit (the spec names context keys) but kept as the same array while
  // its content holds, so rows reading the env do not all re-render on every keystroke.
  const lookupsRef = useRef<{ sig: string; list: LookupInfo[] } | null>(null)
  const lookups = useMemo(() => {
    const list = lookupsFrom(props.lookups, props.contextKeys ?? [], spec)
    const sig = list.map((l) => `${l.key}\u0001${l.collection ?? ''}`).join('\u0002')
    if (lookupsRef.current?.sig === sig) return lookupsRef.current.list
    lookupsRef.current = { sig, list }
    return list
  }, [props.lookups, props.contextKeys, spec])
  // Same names → same array, whatever the caller passes (an inline [] re-renders every row).
  const secretSig = props.secretNames.join('\u0001')
  const secretNames = useMemo(() => (secretSig ? secretSig.split('\u0001') : []), [secretSig])
  const env = useMemo<FieldMapEnv>(
    () => ({
      collection: props.collection,
      lookups,
      secretNames,
      partner: props.partner?.trim() || 'the partner',
      secretsHref: props.secretsHref ?? null
    }),
    [props.collection, lookups, secretNames, props.partner, props.secretsHref]
  )

  // ── Per-row facts → row store (one row re-renders, not all of them) ──
  // Locks follow rows, not names (spec-ops latchLocks): latched when a spec comes in from
  // outside (load, reload, Code tab) and kept while the person edits here, so typing a row
  // through a locked name never locks it and a duplicate of a locked key stays removable.
  const lockSig = lockedKeys.join('\u0001')
  const latchRef = useRef<{ ids: Set<string>; sig: string; key: string | undefined } | null>(null)
  const lockedIds = useMemo(() => {
    const prev =
      latchRef.current?.key === props.historyKey
        ? latchRef.current
        : props.historyKey && latches.has(props.historyKey)
          ? { ids: latches.get(props.historyKey) as Set<string>, sig: '', key: props.historyKey }
          : null
    if (prev && prev.sig === lockSig && isKnown(spec)) return prev.ids
    const ids = latchLocks(spec, lockSig ? lockSig.split('\u0001') : [], prev?.ids)
    latchRef.current = { ids, sig: lockSig, key: props.historyKey }
    if (props.historyKey) latches.set(props.historyKey, ids)
    return ids
  }, [spec, lockSig, props.historyKey, isKnown])
  const lockedRef = useRef(lockedIds)
  lockedRef.current = lockedIds
  const locks = useMemo(() => lockState(spec, lockedIds), [spec, lockedIds])
  const issues = useMemo(() => structuralIssues(spec), [spec])
  const { byRow, pageProblems } = useMemo(() => {
    const ids = new Set<string>()
    const walk = (fs: Field[]) => {
      for (const f of fs) {
        ids.add(f.id)
        if (f.children) walk(f.children)
      }
    }
    walk(spec.fields ?? [])
    const byRow = new Map<string, Problem[]>()
    const page: Problem[] = []
    const seen = new Set<string>()
    for (const p of problems) {
      if (!p.field_id) {
        page.push(p)
        continue
      }
      // A row the map no longer has (or never had): say it above the map, never drop it.
      if (!ids.has(p.field_id)) {
        page.push(p)
        continue
      }
      // A list repeats a problem per row — show it once.
      const dedupe = `${p.field_id}\u0001${p.severity}\u0001${p.message}`
      if (seen.has(dedupe)) continue
      seen.add(dedupe)
      const list = byRow.get(p.field_id)
      if (list) list.push(p)
      else byRow.set(p.field_id, [p])
    }
    return { byRow, pageProblems: page }
  }, [problems, spec])

  const metaMap = useMemo(() => {
    const m = new Map<string, RowMeta>()
    const valueKeys = new Set(Object.keys(values))
    const walk = (fs: Field[]) => {
      for (const f of fs) {
        const l = locks.get(f.id)
        const has = valueKeys.has(f.id)
        m.set(f.id, {
          lock: l ? (l.self ? 'self' : 'inside') : null,
          issues: issues.get(f.id) ?? EMPTY_META.issues,
          problems: byRow.get(f.id) ?? EMPTY_META.problems,
          value: has ? values[f.id] : undefined,
          hasValue: has,
          collapsed: collapsed.has(f.id),
          fresh: fresh === f.id
        })
        if (f.children) walk(f.children)
      }
    }
    walk(spec.fields ?? [])
    return m
  }, [spec, locks, issues, byRow, values, collapsed, fresh])
  // Written during render so rows rendering in this pass read it; notified after commit
  // (a ref, so a StrictMode second render that sees "no change" still notifies).
  const notifyPending = useRef(false)
  if (store.replace(metaMap)) notifyPending.current = true
  useLayoutEffect(() => {
    if (!notifyPending.current) return
    notifyPending.current = false
    store.notify()
  })

  // ── Ops ──
  const collapsedRef = useRef(collapsed)
  collapsedRef.current = collapsed
  const focusAfter = useRef<{ id: string; target: 'key' | 'row' } | null>(null)

  const actions = useMemo<RowActions>(() => {
    const cur = () => current()
    const result = (r: OpResult, mergeKey?: string) => {
      if (r.ok) apply(r.spec, mergeKey)
      else toast.error(r.reason)
    }
    return {
      rename: (id, key) => result(renameKey(cur(), id, key, lockedRef.current), `key:${id}`),
      setType: (id, type) => result(setType(cur(), id, type, lockedRef.current)),
      // Typing inside one source is one undo step; switching the source is its own.
      setValue: (id, v) => apply(updateValue(cur(), id, v), `value:${id}:${v?.source ?? ''}`),
      setInclude: (id, inc) => apply(updateField(cur(), id, { include: inc }), `include:${id}`),
      setRules: (id, r) => apply(updateField(cur(), id, { rules: r }), `rules:${id}`),
      setNote: (id, note) => apply(updateField(cur(), id, { note }), `note:${id}`),
      patchList: (id, patch) => apply(updateList(cur(), id, patch), `list:${id}`),
      renameAlias: (id, from, to) => {
        const r = renameListAlias(cur(), id, from, to)
        apply(r.spec, `alias:${id}`)
        return r.rewrote
      },
      add: (args) => {
        if (args.after && inScalarList(cur(), args.after)) {
          toast.error(SCALAR_ONE_FIELD)
          return ''
        }
        const r = addField(cur(), args)
        apply(r.spec)
        if (args.parent)
          setCollapsed((s) => {
            if (!s.has(args.parent as string)) return s
            const n = new Set(s)
            n.delete(args.parent as string)
            return n
          })
        if (!args.key) setFresh(r.id)
        focusAfter.current = { id: r.id, target: 'key' }
        return r.id
      },
      remove: (id) => {
        const s = cur()
        const r = removeField(s, id, lockedRef.current)
        if (!r.ok) {
          toast.error(r.reason)
          return
        }
        // Keep the keyboard where it was: the next row still there, else the one before.
        const order = visibleRowIds(s, collapsedRef.current)
        const at = order.indexOf(id)
        const alive = (x: string) => !!findField(r.spec, x)
        const next =
          order.slice(at + 1).find(alive) ?? order.slice(0, Math.max(0, at)).reverse().find(alive)
        if (next) focusAfter.current = { id: next, target: 'row' }
        apply(r.spec)
      },
      duplicate: (id) => {
        if (inScalarList(cur(), id)) {
          toast.error(SCALAR_ONE_FIELD)
          return
        }
        const r = duplicateField(cur(), id)
        if (r.id === id) return
        apply(r.spec)
        focusAfter.current = { id: r.id, target: 'key' }
      },
      move: (id, delta) => {
        const r = moveField(cur(), id, delta)
        if (r.ok) apply(r.spec)
      },
      toggle: (id) =>
        setCollapsed((s) => {
          const n = new Set(s)
          if (n.has(id)) n.delete(id)
          else n.add(id)
          return n
        }),
      settle: (id) => setFresh((f) => (f === id ? null : f))
    }
  }, [apply, current])

  // Move focus to a row that an op just created or revealed.
  useLayoutEffect(() => {
    const want = focusAfter.current
    if (!want) return
    const row = rootRef.current?.querySelector<HTMLElement>(
      `[data-row-id="${CSS_ESCAPE(want.id)}"]`
    )
    if (!row) return
    focusAfter.current = null
    const key = want.target === 'key' ? row.querySelector<HTMLElement>('[data-key-input]') : null
    ;(key ?? row).focus()
    row.scrollIntoView({ block: 'nearest' })
  })

  // ── Keyboard ──
  const activeRef = useRef(activeId)
  activeRef.current = activeId

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement
      // Keys inside popovers (portaled, so outside this DOM) and during a keyboard drag are theirs.
      if (activeRef.current || !rootRef.current?.contains(target)) return
      const row = target.closest<HTMLElement>('[data-row-id]')
      const inAdd = target.closest<HTMLElement>('[data-add-row]')
      const isKeyInput = target.hasAttribute('data-key-input')
      const isText =
        target.tagName === 'TEXTAREA' || (target.tagName === 'INPUT' && !isKeyInput && !inAdd)
      if (isText) return

      const order = visibleRowIds(current(), collapsedRef.current)
      const focusRow = (id: string, preferKey: boolean) => {
        const el = rootRef.current?.querySelector<HTMLElement>(`[data-row-id="${CSS_ESCAPE(id)}"]`)
        if (!el) return
        const key = preferKey ? el.querySelector<HTMLElement>('[data-key-input]') : null
        ;(key ?? el).focus()
        el.scrollIntoView({ block: 'nearest' })
      }

      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !isMod(e) && !e.shiftKey) {
        const id = row?.dataset.rowId
        if (e.altKey && id) {
          e.preventDefault()
          actions.move(id, e.key === 'ArrowUp' ? -1 : 1)
          // focus stays on the same element: rows are keyed by id
          requestAnimationFrame(() => target.scrollIntoView({ block: 'nearest' }))
          return
        }
        if (e.altKey) return
        if (inAdd && !row) {
          // From an add-row: up goes to the last row above it.
          if (e.key !== 'ArrowUp') return
          const rows = [...(rootRef.current?.querySelectorAll<HTMLElement>('[data-row-id]') ?? [])]
          const above = rows.filter(
            (r) => r.compareDocumentPosition(inAdd) & Node.DOCUMENT_POSITION_FOLLOWING
          )
          const last = above[above.length - 1]?.dataset.rowId
          if (last) {
            e.preventDefault()
            focusRow(last, true)
          }
          return
        }
        if (!id) return
        const i = order.indexOf(id)
        const nextId = order[i + (e.key === 'ArrowUp' ? -1 : 1)]
        e.preventDefault()
        if (nextId) focusRow(nextId, isKeyInput)
        else if (e.key === 'ArrowDown') {
          // Past the last row: the top-level add-row.
          rootRef.current?.querySelector<HTMLElement>('[data-add-row=""] [data-add-input]')?.focus()
        }
        return
      }
      if (!row) return
      const id = row.dataset.rowId as string
      if (isKeyInput && e.key === 'Enter') {
        e.preventDefault()
        // Named it → pick its value (a group: add its first field).
        const chip = row.querySelector<HTMLElement>('[data-value-chip]')
        const add = rootRef.current?.querySelector<HTMLElement>(
          `[data-add-row="${CSS_ESCAPE(id)}"] [data-add-input]`
        )
        const f = findField(current(), id)?.field
        if (f?.type === 'object' && add) add.focus()
        else (chip ?? add)?.focus()
        return
      }
      if (isKeyInput && e.key === 'Escape') {
        e.preventDefault()
        row.focus()
        return
      }
      if (isMod(e) && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        actions.duplicate(id)
        return
      }
      if (target === row && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault()
        actions.remove(id)
        return
      }
      if (target === row && e.key === 'Enter') {
        e.preventDefault()
        row.querySelector<HTMLElement>('[data-key-input]')?.focus()
        return
      }
      if (target === row && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        const f = findField(current(), id)?.field
        if (f && (f.type === 'object' || f.type === 'list')) {
          const isCollapsed = collapsedRef.current.has(id)
          if ((e.key === 'ArrowLeft') !== isCollapsed) {
            e.preventDefault()
            actions.toggle(id)
          }
        }
      }
    },
    [actions, current]
  )

  // ⌘Z / ⇧⌘Z: anywhere in the map, its popovers, or with nothing focused.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isMod(e) || e.altKey) return
      const k = e.key.toLowerCase()
      const isUndo = k === 'z' && !e.shiftKey
      const isRedo = (k === 'z' && e.shiftKey) || (k === 'y' && e.ctrlKey && !e.metaKey)
      if (!isUndo && !isRedo) return
      const t = e.target as HTMLElement | null
      const ours =
        !t ||
        t === document.body ||
        !!rootRef.current?.contains(t) ||
        !!t.closest?.('[data-field-map-popover]')
      if (!ours) return
      e.preventDefault()
      const done = isUndo ? undo() : redo()
      if (!done) return
      // A focused element whose row the undo removed: fall back to the map.
      requestAnimationFrame(() => {
        const a = document.activeElement
        if (!a || a === document.body) rootRef.current?.focus()
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo])

  // ── Drag and drop (keyboard sensor included) ──
  const sensors = useSensors(
    useSensor(PointerSensor, POINTER_OPTIONS),
    useSensor(KeyboardSensor, KEYBOARD_OPTIONS)
  )
  const onDragStart = useCallback((e: DragStartEvent) => setActiveId(String(e.active.id)), [])
  const onDragEnd = useCallback(
    (e: DragEndEvent) => {
      setActiveId(null)
      if (!e.over || e.active.id === e.over.id) return
      const r = moveFieldTo(current(), String(e.active.id), String(e.over.id))
      if (r.ok) apply(r.spec)
      // The row springs back; say why when it was dropped into another group.
      else if (r.reason !== 'Same place.') toast.message(r.reason)
    },
    [apply, current]
  )

  const shared = useMemo<BlockShared>(
    () => ({ store, actions, lookups }),
    [store, actions, lookups]
  )
  const layout = useMemo(
    () => ({ narrow, valuesPending: !!props.valuesPending }),
    [narrow, props.valuesPending]
  )
  const total = useMemo(() => countFields(spec.fields), [spec.fields])
  const lockedCount = useMemo(() => [...locks.values()].filter((l) => l.self).length, [locks])
  const issueCount = issues.size
  const errorCount = useMemo(
    () => problems.filter((p) => p.severity === 'error').length,
    [problems]
  )

  return (
    <FieldMapEnvContext.Provider value={env}>
      <FieldMapLayoutContext.Provider value={layout}>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: one keyboard handler for every row (↑/↓, ⌥↑/⌥↓, ⌘D, ⌫) */}
        <div
          ref={rootRef}
          className='flex min-h-full flex-col outline-none'
          tabIndex={-1}
          onKeyDown={onKeyDown}
          data-payload-field-map=''
        >
          <div className='sticky top-0 z-10 flex h-10 shrink-0 items-center gap-3 border-b border-slate-100 bg-white/95 px-4 backdrop-blur-sm dark:border-border dark:bg-card/95'>
            <p className='min-w-0 flex-1 truncate text-[12px] text-slate-500 dark:text-muted-foreground'>
              {total === 0 ? (
                'No fields yet'
              ) : (
                <>
                  {total} {total === 1 ? 'field' : 'fields'}
                  {lockedCount > 0 && <> · {lockedCount} locked</>}
                  {issueCount > 0 && (
                    <span className='text-red-600 dark:text-red-400'>
                      {' '}
                      · {issueCount} {issueCount === 1 ? 'row needs' : 'rows need'} a fix
                    </span>
                  )}
                  {errorCount > 0 && issueCount === 0 && (
                    <span className='text-red-600 dark:text-red-400'>
                      {' '}
                      · {errorCount} {errorCount === 1 ? 'problem' : 'problems'} on this record
                    </span>
                  )}
                </>
              )}
            </p>
            <div className='flex items-center gap-0.5'>
              <button
                type='button'
                onClick={() => undo()}
                disabled={!history.canUndo}
                aria-label='Undo'
                data-tip='Undo (⌘Z)'
                className='inline-flex h-7 w-7 items-center justify-center rounded text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:opacity-35 disabled:hover:bg-transparent dark:text-muted-foreground dark:hover:bg-muted dark:hover:text-foreground'
              >
                <Undo2 className='h-3.5 w-3.5' />
              </button>
              <button
                type='button'
                onClick={() => redo()}
                disabled={!history.canRedo}
                aria-label='Redo'
                data-tip='Redo (⇧⌘Z)'
                className='inline-flex h-7 w-7 items-center justify-center rounded text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:opacity-35 disabled:hover:bg-transparent dark:text-muted-foreground dark:hover:bg-muted dark:hover:text-foreground'
              >
                <Redo2 className='h-3.5 w-3.5' />
              </button>
            </div>
          </div>

          {pageProblems.length > 0 && (
            <ul
              className='mx-4 mt-3 space-y-1 rounded-md border border-red-200 bg-red-50 px-3 py-2 dark:border-red-500/30 dark:bg-red-500/10'
              aria-live='polite'
            >
              {pageProblems.map((p, i) => (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: page problems may repeat
                  key={i}
                  className={cn(
                    'flex items-start gap-1.5 text-[12px] leading-snug',
                    p.severity === 'warning'
                      ? 'text-amber-800 dark:text-amber-300'
                      : 'text-red-700 dark:text-red-300'
                  )}
                >
                  {p.severity === 'warning' ? (
                    <AlertTriangle className='mt-px h-3.5 w-3.5 shrink-0' />
                  ) : (
                    <AlertCircle className='mt-px h-3.5 w-3.5 shrink-0' />
                  )}
                  <span>{p.message}</span>
                </li>
              ))}
            </ul>
          )}

          <div className='px-2 py-2'>
            {total === 0 && (
              <div className='px-3 pb-2 pt-4'>
                <p className='text-[13px] font-medium text-slate-900 dark:text-foreground'>
                  Build the body one key at a time
                </p>
                <p className='mt-1 max-w-[560px] text-[12.5px] leading-relaxed text-slate-500 dark:text-muted-foreground'>
                  Each row is one key the partner receives. Type a key below and press Enter, then
                  pick where its value comes from — a field of the {props.collection || 'record'},
                  related data, today’s date, an API secret or a fixed value. The JSON is always
                  valid; the preview shows exactly what would be sent.
                </p>
              </div>
            )}
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              modifiers={MODIFIERS}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onDragCancel={() => setActiveId(null)}
              accessibility={A11Y}
            >
              <FieldGroup
                fields={spec.fields ?? []}
                parentId={null}
                depth={0}
                scopeAlias={null}
                scopeCollection={undefined}
                scalarList={false}
                shared={shared}
              />
            </DndContext>
          </div>
          <p className='mt-auto px-4 pb-3 pt-1 text-[11.5px] text-slate-400 dark:text-slate-500'>
            ↑ ↓ move between rows · ⌥↑ ⌥↓ reorder · ⌘D duplicate · ⌫ on a row removes it · ⌘Z undo
          </p>
        </div>
      </FieldMapLayoutContext.Provider>
    </FieldMapEnvContext.Provider>
  )
}

/** `CSS.escape` for attribute selectors (ids are alphanumeric, but stored specs may hold anything). */
function CSS_ESCAPE(s: string): string {
  return typeof window !== 'undefined' && window.CSS?.escape
    ? window.CSS.escape(s)
    : s.replace(/"/g, '\\"')
}
