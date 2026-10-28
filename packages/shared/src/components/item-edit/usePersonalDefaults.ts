import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createContext,
  type MutableRefObject,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { useNivaroClient } from '../../context'
import { del, get, put } from '../../lib/commands'
import {
  captureContext,
  cascadeParents,
  isEmptyValue,
  orderTopDown,
  pickDefault,
  type SavedDefault
} from '../../lib/personal-defaults'
import type { CascadeRule } from './helpers'

// Personal field defaults on the record form (spec 2026-10-28-personal-field-defaults-design,
// "Applying on a new record" + "Later parent changes"). Matching, ordering and context live in
// lib/personal-defaults.ts; this hook is the form-state side: one read per form, one apply pass
// per new-form open, the ledger of applied values (pill + undo), hints, and parent changes.

/** What a field's ⋯ menu (Save / Clear my default) and FieldRow (pill, hint) read. */
export type PersonalDefaultsApi = {
  /** The layout lets this field carry a personal default. */
  allowed(field: string): boolean
  /** The caller's saved default that fits the record's current parent values. */
  defaultFor(field: string): SavedDefault | null
  /** Saves the field's current value (with its context) and every allowed parent that has one. */
  save(field: string): Promise<void>
  /** Deletes the default `defaultFor(field)` answers. */
  clear(field: string): Promise<void>
  refresh(): void
  /** The field still holds the value its personal default put there (pill). */
  applied(field: string): boolean
  hintFor(field: string): string | null
  undo(field: string): void
}

export const PersonalDefaultsContext = createContext<PersonalDefaultsApi | null>(null)

export function usePersonalDefaultsApi(): PersonalDefaultsApi | null {
  return useContext(PersonalDefaultsContext)
}

/** Query key of GET /field-defaults/mine?collection= — cached shape: SavedDefault[]. */
export function personalDefaultsKey(collection: string) {
  return ['field-defaults', collection] as const
}

export type UsePersonalDefaultsOptions = {
  collection: string
  isNew: boolean
  layoutAllows: (field: string) => boolean
  draftRef: MutableRefObject<Record<string, unknown>>
  /** An auto-fill write (never a person edit). `previous` = what to take back first —
   *  the staged links an M2M undo removes, or a layout default being replaced. */
  setFieldValue: (field: string, value: unknown, previous?: unknown) => void
  markAutoFilled: (fields: string[]) => void
  revalidate: (field: string, value: unknown) => Promise<boolean>
  /** No applying at all (a restored draft, design mode). */
  disabled: boolean
  /** Read the person's defaults (some field on this form is allowed). Default true. */
  enabled?: boolean
  /** Form, layout, relations and the draft check have settled. Default true. */
  ready?: boolean
  rulesFor: (field: string) => CascadeRule[]
  /** Values that do not live in the draft (M2M effective ids); undefined = read the draft. */
  readValue?: (field: string) => unknown
  /** False = never fill (explicit prefill, the person touched it). Default true. */
  canFill?: (field: string) => boolean
  /** A value the personal default outranks (a layout default the person never touched). */
  replaceable?: (field: string, current: unknown) => boolean
  fieldLabel?: (field: string) => string
  valueLabel?: (field: string, value: unknown) => string | Promise<string>
  /** Runs once a pass has applied its values (field rules, cross-record defaults, cascades). */
  afterApply?: (field: string, value: unknown) => void
}

export type UsePersonalDefaultsResult = {
  ledger: Map<string, unknown>
  hintFor(field: string): string | null
  undo(field: string): void
  onPersonChange(field: string): void
  /** Synchronous ledger read (the form's dirty / unsaved-links accounting). */
  appliedNow(): ReadonlyMap<string, unknown>
  context: PersonalDefaultsApi
}

/** Draft values may hold a loaded `{id}` object instead of the bare id. */
function plain(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(plain)
  if (v && typeof v === 'object' && 'id' in (v as object)) return (v as { id: unknown }).id
  return v
}

/** Same value for the ledger: ids as strings, id lists in any order. */
export function sameDefaultValue(a: unknown, b: unknown): boolean {
  if (isEmptyValue(a) && isEmptyValue(b)) return true
  const norm = (v: unknown) => {
    const p = plain(v)
    return Array.isArray(p) ? p.map((x) => String(x)).sort() : String(p)
  }
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b))
}

/** Staged links that are someone's work: everything but the ids a personal default (or what
 *  it derived) staged. `quiet` = staging key → ids. */
export function linksBeyond(
  links: ReadonlyMap<string, unknown[]>,
  quiet: ReadonlyMap<string, ReadonlySet<string>>
): number {
  let n = 0
  for (const [key, ids] of links) {
    const q = quiet.get(key)
    for (const id of ids) if (!q?.has(String(id))) n++
  }
  return n
}

function asList(v: unknown): unknown[] {
  return Array.isArray(v) ? v : isEmptyValue(v) ? [] : [v]
}

export function usePersonalDefaults(opts: UsePersonalDefaultsOptions): UsePersonalDefaultsResult {
  const { collection, isNew, disabled, enabled = true, ready = true } = opts
  const client = useNivaroClient()
  const qc = useQueryClient()
  // Latest options for the stable callbacks below (the form hands in new closures each render).
  const optsRef = useRef(opts)
  optsRef.current = opts

  const { data } = useQuery<SavedDefault[]>({
    queryKey: personalDefaultsKey(collection),
    queryFn: () =>
      client
        .request<{ data: SavedDefault[] }>(get('/field-defaults/mine', { collection }))
        .then((r) => r.data ?? []),
    staleTime: 5 * 60_000,
    enabled: !!collection && enabled
  })
  const byField = useMemo(() => {
    const m = new Map<string, SavedDefault[]>()
    for (const row of data ?? []) {
      const list = m.get(row.field) ?? []
      list.push(row)
      m.set(row.field, list)
    }
    return m
  }, [data])
  const byFieldRef = useRef(byField)
  byFieldRef.current = byField

  const ledgerRef = useRef(new Map<string, unknown>())
  const [ledger, setLedger] = useState<Map<string, unknown>>(() => new Map())
  const hintsRef = useRef(new Map<string, string>())
  const [hints, setHints] = useState<Map<string, string>>(() => new Map())
  // Fields the person undid: never refilled by a later parent change.
  const undoneRef = useRef(new Set<string>())
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const publish = useCallback(() => {
    if (!mountedRef.current) return
    setLedger((prev) => {
      const next = ledgerRef.current
      if (prev.size === next.size && [...next].every(([k, v]) => prev.get(k) === v)) return prev
      return new Map(next)
    })
    setHints((prev) => {
      const next = hintsRef.current
      if (prev.size === next.size && [...next].every(([k, v]) => prev.get(k) === v)) return prev
      return new Map(next)
    })
  }, [])

  const currentValue = useCallback((field: string): unknown => {
    const o = optsRef.current
    const alias = o.readValue?.(field)
    return alias !== undefined ? alias : o.draftRef.current[field]
  }, [])
  const viewOf = useCallback(
    (fields: Iterable<string>) => {
      const out: Record<string, unknown> = {}
      for (const f of fields) out[f] = currentValue(f)
      return out
    },
    [currentValue]
  )
  const label = useCallback(async (field: string, value: unknown): Promise<string> => {
    const o = optsRef.current
    const parts = await Promise.all(
      asList(plain(value)).map(async (v) => {
        try {
          return String((await o.valueLabel?.(field, v)) ?? v)
        } catch {
          return String(v)
        }
      })
    )
    return parts.join(', ')
  }, [])
  const setHint = useCallback(
    async (field: string, text: Promise<string>) => {
      const t = await text
      hintsRef.current.set(field, t)
      publish()
    },
    [publish]
  )
  const blockedHint = useCallback(
    async (parent: string, want: unknown) => {
      const name = optsRef.current.fieldLabel?.(parent) ?? parent
      return `Your default is for ${name} ${await label(parent, want)}`
    },
    [label]
  )

  const write = useCallback((field: string, value: unknown, previous?: unknown) => {
    const o = optsRef.current
    o.setFieldValue(field, value, previous)
    if (isEmptyValue(value)) {
      ledgerRef.current.delete(field)
      return
    }
    ledgerRef.current.set(field, value)
    hintsRef.current.delete(field)
    o.markAutoFilled([field])
  }, [])

  /** Step 3–5 for one field. Answers the fields it wrote (parents first), [] when none. */
  const applyField = useCallback(
    async (field: string): Promise<string[]> => {
      const o = optsRef.current
      const cands = byFieldRef.current.get(field) ?? []
      if (cands.length === 0 || !o.layoutAllows(field)) return []
      if (undoneRef.current.has(field) || !(o.canFill?.(field) ?? true)) return []
      const start = currentValue(field)
      const replacing = !isEmptyValue(start)
      if (replacing && !(o.replaceable?.(field, start) ?? false)) return []
      const keys = new Set(cands.flatMap((c) => Object.keys(c.context ?? {})))
      const view = viewOf(keys)
      const { pick, fillParents, blockedBy } = pickDefault(cands, view)
      if (!pick) {
        if (blockedBy) {
          const want = cands.find(
            (c) =>
              c.context &&
              blockedBy in c.context &&
              !sameDefaultValue(c.context[blockedBy], view[blockedBy])
          )?.context[blockedBy]
          await setHint(field, blockedHint(blockedBy, want))
        }
        return []
      }
      // Parents from the same saved set, farthest first (Zone before Region).
      const order = cascadeParents(field, o.rulesFor).reverse()
      const parents = [
        ...order.filter((p) => p in fillParents),
        ...Object.keys(fillParents).filter((p) => !order.includes(p))
      ]
      const filled: Array<[string, unknown]> = []
      const rollback = () => {
        for (const [p, v] of filled.reverse()) write(p, null, v)
      }
      for (const p of parents) {
        const want = fillParents[p]
        const fillable = o.layoutAllows(p) && !undoneRef.current.has(p) && (o.canFill?.(p) ?? true)
        if (!fillable || !(await o.revalidate(p, want)) || !isEmptyValue(currentValue(p))) {
          rollback()
          await setHint(field, blockedHint(p, want))
          return []
        }
        write(p, want)
        filled.push([p, want])
      }
      if (!(await o.revalidate(field, pick.value))) {
        rollback()
        await setHint(
          field,
          label(field, pick.value).then((l) => `Your default "${l}" is no longer available`)
        )
        return []
      }
      // The person (or a prefill) got there while the checks ran: theirs stays.
      if (!sameDefaultValue(currentValue(field), start) || !(o.canFill?.(field) ?? true)) {
        rollback()
        return []
      }
      write(field, pick.value, replacing ? start : undefined)
      return [...filled.map(([p]) => p), field]
    },
    [currentValue, viewOf, setHint, blockedHint, label, write]
  )

  /** Applies fields in order, then lets rules / cross-record defaults run for what landed. */
  const runPass = useCallback(
    async (fields: string[]) => {
      // Parents filled from a child's saved set count too, in the order they were written.
      const landed = new Set<string>()
      for (const f of fields) {
        if (!mountedRef.current) return
        for (const w of await applyField(f)) landed.add(w)
        publish()
      }
      for (const f of landed) {
        if (ledgerRef.current.has(f)) optsRef.current.afterApply?.(f, ledgerRef.current.get(f))
      }
      publish()
    },
    [applyField, publish]
  )

  const allowedWithDefaults = useCallback(() => {
    const o = optsRef.current
    return orderTopDown(
      [...byFieldRef.current.keys()].filter((f) => o.layoutAllows(f)),
      o.rulesFor
    )
  }, [])

  // One pass per new-form open. The ref (not state) guards it: StrictMode runs the effect
  // twice and the second run must not apply again.
  const appliedOnceRef = useRef(false)
  useEffect(() => {
    if (!isNew || disabled || !ready || appliedOnceRef.current || data === undefined) return
    appliedOnceRef.current = true
    void runPass(allowedWithDefaults())
  }, [isNew, disabled, ready, data, runPass, allowedWithDefaults])

  // A field whose value moved on (a rule, a document fill, a restored draft) loses its pill;
  // a hinted field the person filled loses its hint. After every render: M2M values change
  // without a draft change, and the ledger is a handful of fields.
  useEffect(() => {
    let changed = false
    for (const [f, v] of ledgerRef.current) {
      if (!sameDefaultValue(currentValue(f), v)) {
        ledgerRef.current.delete(f)
        changed = true
      }
    }
    for (const f of hintsRef.current.keys()) {
      if (!isEmptyValue(currentValue(f))) {
        hintsRef.current.delete(f)
        changed = true
      }
    }
    if (changed) publish()
  })

  // Parent changes are processed after the render that carries them, so M2M parents read
  // their new effective ids.
  const queueRef = useRef(new Set<string>())
  const [personTick, setPersonTick] = useState(0)
  const onPersonChange = useCallback(
    (field: string) => {
      let changed = ledgerRef.current.delete(field)
      if (hintsRef.current.delete(field)) changed = true
      undoneRef.current.delete(field)
      if (changed) publish()
      if (!optsRef.current.isNew) return
      queueRef.current.add(field)
      setPersonTick((t) => t + 1)
    },
    [publish]
  )
  // biome-ignore lint/correctness/useExhaustiveDependencies: personTick is the trigger
  useEffect(() => {
    if (queueRef.current.size === 0 || optsRef.current.disabled) return
    const changedParents = [...queueRef.current]
    queueRef.current.clear()
    const o = optsRef.current
    const again: string[] = []
    for (const child of allowedWithDefaults()) {
      const parents = cascadeParents(child, o.rulesFor)
      if (!changedParents.some((p) => parents.includes(p))) continue
      if (ledgerRef.current.has(child)) {
        const v = ledgerRef.current.get(child)
        // Still holding its personal-default value: cleared, then picked again for the new context.
        o.setFieldValue(child, null, v)
        ledgerRef.current.delete(child)
        again.push(child)
      } else if (hintsRef.current.has(child) && isEmptyValue(currentValue(child))) {
        hintsRef.current.delete(child)
        again.push(child)
      }
    }
    publish()
    if (again.length > 0) void runPass(again)
  }, [personTick])

  const undo = useCallback(
    (field: string) => {
      const o = optsRef.current
      if (!ledgerRef.current.has(field)) return
      const targets = [
        field,
        ...[...ledgerRef.current.keys()].filter(
          (f) => f !== field && cascadeParents(f, o.rulesFor).includes(field)
        )
      ]
      for (const f of targets) {
        const v = ledgerRef.current.get(f)
        if (sameDefaultValue(currentValue(f), v)) o.setFieldValue(f, null, v)
        ledgerRef.current.delete(f)
      }
      undoneRef.current.add(field)
      publish()
    },
    [currentValue, publish]
  )

  const hintFor = useCallback((field: string) => hints.get(field) ?? null, [hints])
  const appliedNow = useCallback(() => ledgerRef.current as ReadonlyMap<string, unknown>, [])

  const defaultFor = useCallback(
    (field: string): SavedDefault | null => {
      const cands = byField.get(field) ?? []
      if (cands.length === 0) return null
      const keys = new Set(cands.flatMap((c) => Object.keys(c.context ?? {})))
      return pickDefault(cands, viewOf(keys)).pick
    },
    [byField, viewOf]
  )

  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: personalDefaultsKey(collection) })
  }, [qc, collection])

  const save = useCallback(
    async (field: string) => {
      const o = optsRef.current
      const value = currentValue(field)
      if (isEmptyValue(value)) throw new Error('Pick a value first')
      const parents = cascadeParents(field, o.rulesFor)
      const view = viewOf([field, ...parents])
      const one = (f: string) =>
        client.request(
          put('/field-defaults/mine', {
            collection,
            field: f,
            value: plain(view[f]),
            context: captureContext(f, view, o.rulesFor)
          })
        )
      // Allowed parents with a value first (Zone, then Region), then the field itself.
      for (const p of [...parents].reverse())
        if (o.layoutAllows(p) && !isEmptyValue(view[p])) await one(p)
      await one(field)
      await qc.invalidateQueries({ queryKey: personalDefaultsKey(collection) })
    },
    [client, qc, collection, currentValue, viewOf]
  )

  const clear = useCallback(
    async (field: string) => {
      const d = defaultFor(field)
      if (!d) return
      await client.request(del(`/field-defaults/mine/${d.id}`))
      await qc.invalidateQueries({ queryKey: personalDefaultsKey(collection) })
    },
    [client, qc, collection, defaultFor]
  )

  const context = useMemo<PersonalDefaultsApi>(
    () => ({
      allowed: (f) => optsRef.current.layoutAllows(f),
      defaultFor,
      save,
      clear,
      refresh,
      applied: (f) => ledger.has(f),
      hintFor,
      undo
    }),
    [defaultFor, save, clear, refresh, ledger, hintFor, undo]
  )

  return { ledger, hintFor, undo, onPersonChange, appliedNow, context }
}
