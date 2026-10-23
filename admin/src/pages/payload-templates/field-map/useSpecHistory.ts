import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { MapSpec } from '../api'

// ─── Undo / redo for the field map ───────────────────────────────────────────
// The shell owns the draft (and autosaves it); this only remembers earlier
// specs and hands one back through the same onChange. History is kept per
// template key in a module map, so switching to the Code tab and back keeps
// it. A spec that arrives from outside (Code tab edit, conflict reload) is
// recorded as a step too, so it can be undone like any other change.

const LIMIT = 200
/** Edits to the same input closer together than this are one undo step (typing a key). */
const MERGE_MS = 1000

export interface SpecHistory {
  past: MapSpec[]
  future: MapSpec[]
  merge: { key: string; at: number } | null
}

export function emptyHistory(): SpecHistory {
  return { past: [], future: [], merge: null }
}

/** Remember `prev` (the spec before a change). Same `mergeKey` within 1 s → one step. */
export function recordHistory(
  h: SpecHistory,
  prev: MapSpec,
  mergeKey?: string,
  now: number = Date.now()
): SpecHistory {
  if (mergeKey && h.merge?.key === mergeKey && now - h.merge.at < MERGE_MS && h.past.length)
    return { past: h.past, future: [], merge: { key: mergeKey, at: now } }
  const past = h.past.length >= LIMIT ? h.past.slice(h.past.length - LIMIT + 1) : h.past.slice()
  past.push(prev)
  return { past, future: [], merge: mergeKey ? { key: mergeKey, at: now } : null }
}

export function undoHistory(
  h: SpecHistory,
  current: MapSpec
): { history: SpecHistory; spec: MapSpec } | null {
  if (!h.past.length) return null
  const past = h.past.slice()
  const spec = past.pop() as MapSpec
  return { spec, history: { past, future: [...h.future, current], merge: null } }
}

export function redoHistory(
  h: SpecHistory,
  current: MapSpec
): { history: SpecHistory; spec: MapSpec } | null {
  if (!h.future.length) return null
  const future = h.future.slice()
  const spec = future.pop() as MapSpec
  return { spec, history: { past: [...h.past, current], future, merge: null } }
}

interface Store {
  history: SpecHistory
  /** The last spec this hook saw (prop or emitted). */
  seen: MapSpec | null
}

const stores = new Map<string, Store>()

function storeFor(key: string | undefined): Store {
  if (!key) return { history: emptyHistory(), seen: null }
  let s = stores.get(key)
  if (!s) {
    s = { history: emptyHistory(), seen: null }
    stores.set(key, s)
  }
  return s
}

export interface SpecHistoryApi {
  /** Apply a new spec (records the current one first). Same object → nothing happens. */
  apply: (next: MapSpec, mergeKey?: string) => void
  /** The newest spec — includes edits applied earlier in the same tick. */
  current: () => MapSpec
  undo: () => boolean
  redo: () => boolean
  canUndo: boolean
  canRedo: boolean
}

export function useSpecHistory(
  spec: MapSpec,
  onChange: (spec: MapSpec) => void,
  historyKey?: string
): SpecHistoryApi {
  const storeRef = useRef<{ key: string | undefined; store: Store } | null>(null)
  if (!storeRef.current || storeRef.current.key !== historyKey)
    storeRef.current = { key: historyKey, store: storeFor(historyKey) }
  const store = storeRef.current.store
  const latest = useRef(spec)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const [flags, setFlags] = useState({ undo: false, redo: false })

  const sync = useCallback(() => {
    const h = storeRef.current?.store.history
    const next = { undo: !!h?.past.length, redo: !!h?.future.length }
    setFlags((f) => (f.undo === next.undo && f.redo === next.redo ? f : next))
  }, [])

  // A spec from outside (another tab, a reload) becomes a step of its own.
  useLayoutEffect(() => {
    const s = storeRef.current?.store
    if (!s) return
    // Same content in a new object (the shell re-read the draft) is not a step.
    if (s.seen && s.seen !== spec && JSON.stringify(s.seen) !== JSON.stringify(spec))
      s.history = recordHistory(s.history, s.seen)
    s.seen = spec
    latest.current = spec
    sync()
  }, [spec, sync])

  const emit = useCallback(
    (next: MapSpec) => {
      const s = storeRef.current?.store
      if (s) s.seen = next
      latest.current = next
      onChangeRef.current(next)
      sync()
    },
    [sync]
  )

  const apply = useCallback(
    (next: MapSpec, mergeKey?: string) => {
      const cur = latest.current
      if (next === cur) return
      const s = storeRef.current?.store
      if (s) s.history = recordHistory(s.history, cur, mergeKey)
      emit(next)
    },
    [emit]
  )

  const undo = useCallback(() => {
    const s = storeRef.current?.store
    const r = s ? undoHistory(s.history, latest.current) : null
    if (!s || !r) return false
    s.history = r.history
    emit(r.spec)
    return true
  }, [emit])

  const redo = useCallback(() => {
    const s = storeRef.current?.store
    const r = s ? redoHistory(s.history, latest.current) : null
    if (!s || !r) return false
    s.history = r.history
    emit(r.spec)
    return true
  }, [emit])

  const current = useCallback(() => latest.current, [])

  // `flags` only re-renders; the store is the truth (it outlives a remount).
  void flags
  const canUndo = !!store.history.past.length
  const canRedo = !!store.history.future.length
  return { apply, current, undo, redo, canUndo, canRedo }
}
