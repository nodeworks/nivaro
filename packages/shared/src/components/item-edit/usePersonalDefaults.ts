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
import { titleCase } from '../../lib/utils'
import type { CascadeRule } from './helpers'

// Personal field defaults on the record form (spec 2026-10-28-personal-field-defaults-design,
// "Applying on a new record" + "Later parent changes"). Matching, ordering and context live in
// lib/personal-defaults.ts; this hook is the form-state side: one read per form, one apply pass
// per new-form open, the ledger of applied values (pill + undo), hints, and parent changes.

/** What a field's ⋯ menu (Save / Clear my default) and FieldRow (pill, hint) read. */
export type PersonalDefaultsApi = {
  /** The layout lets this field carry a personal default (and the form reads them: never on
   *  the design canvas). */
  allowed(field: string): boolean
  /** The person may save, update or clear this field's default right on the form (Make
   *  default). False when the form keeps that to their profile: an applied default still shows
   *  with Undo. Only meaningful where `allowed`. */
  manageable(field: string): boolean
  /** The person's saved defaults have been read, or the read failed (until then nobody can
   *  tell what is saved). */
  loaded: boolean
  /** The read failed: nothing is known to be saved (Make default still works). */
  failed: boolean
  /** The form shows a new record (the prefilled state can appear on it). */
  isNew: boolean
  /** The caller's saved default that fits the record's current parent values. */
  defaultFor(field: string): SavedDefault | null
  /** The field holds a value and it IS the saved default for the current parent values
   *  (the visible control then says "Your default" instead of offering Make default). */
  isDefault(field: string): boolean
  /** Saves the field's current value (with its context) and every allowed parent that has one. */
  save(field: string): Promise<void>
  /** Replaces the value of the default `defaultFor(field)` answers with the field's current
   *  value, keeping that default's context (the same slot: no new row, parents untouched). */
  update(field: string): Promise<void>
  /** The confirm line for `update(field)`: the new value's label and the saved default's
   *  context labels, top-down ("Zone 2", "Boston"). */
  describeUpdate(field: string): Promise<{ value: string; context: string[] }>
  /** Deletes the default `defaultFor(field)` answers; resolves with what it removed (for Undo). */
  clear(field: string): Promise<SavedDefault | null>
  /** Saves a removed default back exactly as it was (value + context): the Clear toast's Undo. */
  restore(saved: SavedDefault): Promise<void>
  refresh(): void
  /** The field has a value to save (reads M2M ids too, which are not in the draft). */
  hasValue(field: string): boolean
  /** What `save(field)` would store, top-down (allowed parents with a value, then the field),
   *  as the labels a person knows ("Zone 2", "Boston"). For the confirm line. */
  describeSave(field: string): Promise<string[]>
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
  /** False = the placement keeps saving / clearing to the profile (no Make default on the
   *  form). Default true. */
  layoutManage?: (field: string) => boolean
  draftRef: MutableRefObject<Record<string, unknown>>
  /** An auto-fill write (never a person edit). `previous` = what to take back first —
   *  the staged links an M2M undo removes, or a layout default being replaced. */
  setFieldValue: (field: string, value: unknown, previous?: unknown) => void
  markAutoFilled: (fields: string[]) => void
  /** true = still pickable, false = checked and refused, null = could not check (skip quietly). */
  revalidate: (field: string, value: unknown) => Promise<boolean | null>
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
  /** The label the picker would show; null = none (hints then say "Your saved default"). */
  valueLabel?: (field: string, value: unknown) => string | null | Promise<string | null>
  /** The field's data type (decimal, date, timestamp…): equal values compare by type. */
  fieldType?: (field: string) => string | null | undefined
  /** Runs after undo with every field it took back: the form then takes back what those
   *  values derived (upstream cascades, cross-record defaults). */
  onUndone?: (fields: string[]) => void
  /** Runs once a pass has applied its values (field rules, cross-record defaults, cascades). */
  afterApply?: (field: string, value: unknown) => void
  /** The record the form shows (e.g. `orders:new`): a change starts the ledger over — a
   *  created record that stays on screen keeps no pills. */
  resetKey?: string
}

export type UsePersonalDefaultsResult = {
  ledger: Map<string, unknown>
  hintFor(field: string): string | null
  undo(field: string): void
  onPersonChange(field: string): void
  /** An explicit fill (document autofill) takes the field over: its default's value goes. */
  release(field: string): void
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

const NUMERIC_TYPES = new Set(['integer', 'bigInteger', 'float', 'decimal', 'number', 'double'])
const DATE_TYPES = new Set(['date'])
const DATETIME_TYPES = new Set(['dateTime', 'datetime', 'timestamp', 'time'])

/** Same value for the ledger: ids as strings, id lists in any order. With the field's type,
 *  numbers compare as numbers ("1.50" = 1.5), dates by their day ("2026-10-28" =
 *  "2026-10-28T00:00:00") and date-times by their instant. */
export function sameDefaultValue(a: unknown, b: unknown, type?: string | null): boolean {
  if (isEmptyValue(a) && isEmptyValue(b)) return true
  if (type && !Array.isArray(a) && !Array.isArray(b) && !isEmptyValue(a) && !isEmptyValue(b)) {
    const pa = plain(a)
    const pb = plain(b)
    if (NUMERIC_TYPES.has(type)) {
      const na = Number(pa)
      const nb = Number(pb)
      if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb
    } else if (DATE_TYPES.has(type)) {
      const day = (v: unknown) => /^(\d{4}-\d{2}-\d{2})/.exec(String(v))?.[1]
      const da = day(pa)
      const db = day(pb)
      if (da && db) return da === db
    } else if (DATETIME_TYPES.has(type)) {
      const ta = Date.parse(String(pa))
      const tb = Date.parse(String(pb))
      if (Number.isFinite(ta) && Number.isFinite(tb)) return ta === tb
    }
  }
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

  const { data, isError } = useQuery<SavedDefault[]>({
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
  // Parents a field's default filled on its way in (empty parents set from the same saved
  // set): undoing that field takes them back too, unless something still applied needs them.
  const filledByRef = useRef(new Map<string, string[]>())
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
  const label = useCallback(async (field: string, value: unknown): Promise<string | null> => {
    const o = optsRef.current
    const parts = await Promise.all(
      asList(plain(value)).map(async (v) => {
        if (!o.valueLabel) return String(v)
        try {
          return (await o.valueLabel(field, v)) ?? null
        } catch {
          return null
        }
      })
    )
    const known = parts.filter((x): x is string => !!x)
    return known.length > 0 ? known.join(', ') : null
  }, [])
  // Bumped by every reset (another record on this form instance): a pass started under an older
  // generation writes nothing — no value, ledger entry or hint lands on the next record.
  const genRef = useRef(0)
  const setHint = useCallback(
    async (field: string, text: Promise<string>, gen: number) => {
      const t = await text
      if (genRef.current !== gen) return
      hintsRef.current.set(field, t)
      publish()
    },
    [publish]
  )
  const blockedHint = useCallback(
    async (parent: string, want: unknown) => {
      const name = optsRef.current.fieldLabel?.(parent) ?? parent
      const l = await label(parent, want)
      return l
        ? `Your default is for ${name} “${l}”`
        : `Your saved default is for a different ${name}`
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

  /** Steps 3–5 for one field, once. 'stale' = a parent moved while the checks ran. */
  const applyOnce = useCallback(
    async (field: string, gen: number): Promise<string[] | 'stale'> => {
      const o = optsRef.current
      // The form moved on to another record while this step waited: write nothing (no rollback
      // either — the draft now belongs to that record).
      const moved = () => genRef.current !== gen
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
          await setHint(field, blockedHint(blockedBy, want), gen)
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
      // Takes back only what still holds this step's value (never a value someone set since).
      const rollback = () => {
        for (const [p, v] of filled.reverse()) {
          if (sameDefaultValue(currentValue(p), v)) write(p, null, v)
          else ledgerRef.current.delete(p)
        }
      }
      for (const p of parents) {
        const want = fillParents[p]
        const fillable = o.layoutAllows(p) && !undoneRef.current.has(p) && (o.canFill?.(p) ?? true)
        const ok = fillable ? await o.revalidate(p, want) : false
        if (moved()) return []
        if (ok === null) {
          rollback()
          return []
        }
        if (!ok || !isEmptyValue(currentValue(p))) {
          rollback()
          await setHint(field, blockedHint(p, want), gen)
          return []
        }
        write(p, want)
        filled.push([p, want])
      }
      const ok = await o.revalidate(field, pick.value)
      if (moved()) return []
      if (ok === null) {
        // The check could not run (network): skip, and say nothing untrue.
        rollback()
        return []
      }
      if (!ok) {
        rollback()
        await setHint(
          field,
          label(field, pick.value).then((l) =>
            l
              ? `Your default "${l}" is no longer available`
              : 'Your saved default is no longer available'
          ),
          gen
        )
        return []
      }
      // The person (or a prefill) got there while the checks ran: theirs stays.
      if (!sameDefaultValue(currentValue(field), start) || !(o.canFill?.(field) ?? true)) {
        rollback()
        return []
      }
      // A parent moved while the checks ran: the pick was for the old context.
      const fresh = pickDefault(cands, viewOf(keys))
      if (fresh.pick?.id !== pick.id || Object.keys(fresh.fillParents).length > 0) {
        rollback()
        return 'stale'
      }
      write(field, pick.value, replacing ? start : undefined)
      filledByRef.current.set(
        field,
        filled.map(([p]) => p)
      )
      return [...filled.map(([p]) => p), field]
    },
    [currentValue, viewOf, setHint, blockedHint, label, write]
  )

  /** Answers the fields it wrote (parents first), [] when none. */
  const applyField = useCallback(
    async (field: string, gen: number): Promise<string[]> => {
      // A parent that moved while the checks ran makes the pick stale: pick again (bounded).
      for (let attempt = 0; attempt < 3; attempt++) {
        const r = await applyOnce(field, gen)
        if (r !== 'stale') return r
      }
      return []
    },
    [applyOnce]
  )
  /** Applies fields in order, then lets rules / cross-record defaults run for what landed. */
  const runPass = useCallback(
    async (fields: string[]) => {
      // Parents filled from a child's saved set count too, in the order they were written.
      const gen = genRef.current
      const landed = new Set<string>()
      for (const f of fields) {
        if (!mountedRef.current || genRef.current !== gen) return
        for (const w of await applyField(f, gen)) landed.add(w)
        publish()
      }
      if (genRef.current !== gen) return
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
  // Children still holding their default when their parent changed (child → that value), taken
  // out of the ledger NOW: the same edit may already have nulled them (clear_on_parent_change),
  // and the ledger reconcile would otherwise drop them before they are picked again.
  const repickRef = useRef(new Map<string, unknown>())
  const [personTick, setPersonTick] = useState(0)
  const onPersonChange = useCallback(
    (field: string) => {
      let changed = ledgerRef.current.delete(field)
      if (hintsRef.current.delete(field)) changed = true
      undoneRef.current.delete(field)
      repickRef.current.delete(field)
      if (!optsRef.current.isNew) {
        if (changed) publish()
        return
      }
      const rulesFor = optsRef.current.rulesFor
      for (const [child, v] of [...ledgerRef.current]) {
        if (!cascadeParents(child, rulesFor).includes(field)) continue
        repickRef.current.set(child, v)
        ledgerRef.current.delete(child)
        changed = true
      }
      if (changed) publish()
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
    const repick = new Map(repickRef.current)
    repickRef.current.clear()
    const o = optsRef.current
    const again: string[] = []
    for (const child of allowedWithDefaults()) {
      if (repick.has(child)) {
        const v = repick.get(child)
        const now = currentValue(child)
        // Still holding its personal-default value: cleared, then picked again for the new
        // context. Already emptied by the parent's clear_on_parent_change: just picked again.
        if (sameDefaultValue(now, v)) o.setFieldValue(child, null, v)
        else if (!isEmptyValue(now)) continue
        again.push(child)
        continue
      }
      const parents = cascadeParents(child, o.rulesFor)
      if (!changedParents.some((p) => parents.includes(p))) continue
      if (hintsRef.current.has(child) && isEmptyValue(currentValue(child))) {
        hintsRef.current.delete(child)
        again.push(child)
      }
    }
    publish()
    if (again.length > 0) void runPass(again)
  }, [personTick])

  /**
   * Undo takes back everything the default brought with it: the field, the auto-filled
   * children that cascade from it, and the empty parents its default filled on the way in —
   * unless another default that stays still sits on that parent (its own fill, or a child that
   * cascades from it). Each is cleared only while it still holds the applied value.
   */
  const undo = useCallback(
    (field: string) => {
      const o = optsRef.current
      const ledger = ledgerRef.current
      if (!ledger.has(field)) return
      const parentsOf = (f: string) => cascadeParents(f, o.rulesFor)
      const going = new Set<string>([field])
      for (let grew = true; grew; ) {
        grew = false
        // Downstream: applied fields that cascade from anything going.
        for (const f of ledger.keys()) {
          if (going.has(f)) continue
          if (parentsOf(f).some((p) => going.has(p))) {
            going.add(f)
            grew = true
          }
        }
        // Upstream: parents a going field's default filled, when nothing staying needs them.
        for (const g of [...going]) {
          for (const p of filledByRef.current.get(g) ?? []) {
            if (going.has(p) || !ledger.has(p)) continue
            const needed = [...ledger.keys()].some(
              (f) =>
                f !== p &&
                !going.has(f) &&
                ((filledByRef.current.get(f) ?? []).includes(p) || parentsOf(f).includes(p))
            )
            if (!needed) {
              going.add(p)
              grew = true
            }
          }
        }
      }
      // Children before their parents, so a cleared parent never clears a child twice.
      const depth = (f: string) => parentsOf(f).length
      const cleared: string[] = []
      for (const f of [...going].sort((a, b) => depth(b) - depth(a))) {
        const v = ledger.get(f)
        if (sameDefaultValue(currentValue(f), v)) {
          o.setFieldValue(f, null, v)
          cleared.push(f)
        }
        ledger.delete(f)
        filledByRef.current.delete(f)
        undoneRef.current.add(f)
      }
      if (cleared.length) o.onUndone?.(cleared)
      publish()
    },
    [currentValue, publish]
  )

  const release = useCallback(
    (field: string) => {
      if (!ledgerRef.current.has(field)) return
      const v = ledgerRef.current.get(field)
      if (sameDefaultValue(currentValue(field), v)) optsRef.current.setFieldValue(field, null, v)
      ledgerRef.current.delete(field)
      undoneRef.current.add(field)
      publish()
    },
    [currentValue, publish]
  )

  // Another record on the same form instance (a create that stays on screen, the next record):
  // nothing of this one's ledger, hints or queue carries over.
  const resetSig = `${collection}|${isNew ? 'new' : 'saved'}|${opts.resetKey ?? ''}`
  const resetSigRef = useRef(resetSig)
  useEffect(() => {
    if (resetSigRef.current === resetSig) return
    resetSigRef.current = resetSig
    ledgerRef.current.clear()
    hintsRef.current.clear()
    undoneRef.current.clear()
    filledByRef.current.clear()
    repickRef.current.clear()
    queueRef.current.clear()
    appliedOnceRef.current = false
    genRef.current += 1
    publish()
  }, [resetSig, publish])

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

  const hasValue = useCallback(
    (field: string) => !isEmptyValue(currentValue(field)),
    [currentValue]
  )
  const isDefault = useCallback(
    (field: string) => {
      const cur = currentValue(field)
      if (isEmptyValue(cur)) return false
      const d = defaultFor(field)
      return !!d && sameDefaultValue(d.value, cur, optsRef.current.fieldType?.(field))
    },
    [currentValue, defaultFor]
  )
  const describeSave = useCallback(
    async (field: string): Promise<string[]> => {
      const o = optsRef.current
      const fields = [
        ...[...cascadeParents(field, o.rulesFor)]
          .reverse()
          .filter((p) => o.layoutAllows(p) && !isEmptyValue(currentValue(p))),
        field
      ]
      return Promise.all(
        // A value with no label says which field it is, never its stored id ("Save 4521 · …").
        fields.map(
          async (f) => (await label(f, currentValue(f))) ?? o.fieldLabel?.(f) ?? titleCase(f)
        )
      )
    },
    [currentValue, label]
  )

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
      // The field first: if it is refused nothing else is saved. Then the allowed parents
      // (Zone, then Region). The cache is refreshed whatever happened.
      try {
        await one(field)
        for (const p of [...parents].reverse())
          if (o.layoutAllows(p) && !isEmptyValue(view[p])) await one(p)
      } finally {
        await qc.invalidateQueries({ queryKey: personalDefaultsKey(collection) })
      }
    },
    [client, qc, collection, currentValue, viewOf]
  )

  const update = useCallback(
    async (field: string) => {
      const d = defaultFor(field)
      if (!d) throw new Error('You have no default here to update')
      const value = currentValue(field)
      if (isEmptyValue(value)) throw new Error('Pick a value first')
      try {
        await client.request(
          put('/field-defaults/mine', {
            collection,
            field,
            value: plain(value),
            context: d.context ?? {}
          })
        )
      } finally {
        await qc.invalidateQueries({ queryKey: personalDefaultsKey(collection) })
      }
    },
    [client, qc, collection, currentValue, defaultFor]
  )
  const describeUpdate = useCallback(
    async (field: string) => {
      const o = optsRef.current
      const d = defaultFor(field)
      const ctx = d?.context ?? {}
      const order = [...cascadeParents(field, o.rulesFor)].reverse()
      const keys = [
        ...order.filter((p) => p in ctx),
        ...Object.keys(ctx).filter((k) => !order.includes(k))
      ]
      const name = (f: string) => o.fieldLabel?.(f) ?? titleCase(f)
      const [value, ...context] = await Promise.all([
        label(field, currentValue(field)).then((l) => l ?? name(field)),
        ...keys.map((k) => label(k, ctx[k]).then((l) => l ?? name(k)))
      ])
      return { value, context }
    },
    [currentValue, defaultFor, label]
  )

  const clear = useCallback(
    async (field: string) => {
      const d = defaultFor(field)
      if (!d) return null
      await client.request(del(`/field-defaults/mine/${d.id}`))
      // A prefilled value whose default is forgotten is the person's to keep ("this field keeps
      // its value"): out of the ledger, so no parent change empties or re-picks it.
      if (ledgerRef.current.delete(field)) {
        undoneRef.current.add(field)
        publish()
      }
      await qc.invalidateQueries({ queryKey: personalDefaultsKey(collection) })
      return d
    },
    [client, qc, collection, defaultFor, publish]
  )

  const restore = useCallback(
    async (saved: SavedDefault) => {
      await client.request(
        put('/field-defaults/mine', {
          collection,
          field: saved.field,
          value: saved.value,
          context: saved.context ?? {}
        })
      )
      await qc.invalidateQueries({ queryKey: personalDefaultsKey(collection) })
    },
    [client, qc, collection]
  )

  const context = useMemo<PersonalDefaultsApi>(
    () => ({
      allowed: (f) => (optsRef.current.enabled ?? true) && optsRef.current.layoutAllows(f),
      manageable: (f) => optsRef.current.layoutManage?.(f) ?? true,
      loaded: data !== undefined || isError,
      failed: data === undefined && isError,
      isNew,
      defaultFor,
      isDefault,
      save,
      update,
      describeUpdate,
      clear,
      restore,
      refresh,
      hasValue,
      describeSave,
      applied: (f) => ledger.has(f),
      hintFor,
      undo
    }),
    [
      data,
      isError,
      isNew,
      defaultFor,
      isDefault,
      save,
      update,
      describeUpdate,
      clear,
      restore,
      refresh,
      hasValue,
      describeSave,
      ledger,
      hintFor,
      undo
    ]
  )

  return { ledger, hintFor, undo, onPersonChange, release, appliedNow, context }
}
