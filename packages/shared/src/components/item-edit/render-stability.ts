import { type MutableRefObject, useLayoutEffect, useMemo, useRef } from 'react'
import type { ApplyToLinesSpec, FieldAffordances } from './FieldAffordances'

// Render stability for the record form. Every row of the form is memoized
// (FieldRow, FieldRenderer, GroupSection, InlineGridField); a memo only skips
// when the props and context values it gets are the SAME objects as last
// time. These helpers keep a value's identity while its content is unchanged
// and hand out functions that never change identity but always run the
// newest implementation.

/** Same content, by value (plain data: filters, parsed config). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object') return false
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

/** Same keys, each value the same (Object.is). */
export function shallowRecordEqual(
  a: Record<string, unknown> | null | undefined,
  b: Record<string, unknown> | null | undefined
): boolean {
  if (Object.is(a, b)) return true
  if (!a || !b) return false
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  for (const k of ka) if (!Object.hasOwn(b, k) || !Object.is(a[k], b[k])) return false
  return true
}

/** Hands back the previous value while `equal` says the new one is the same
 *  (no hook: the ref is created by the caller before any early return). */
export function keepIfEqual<T>(
  ref: MutableRefObject<T | undefined>,
  next: T,
  equal: (a: T, b: T) => boolean
): T {
  const prev = ref.current
  if (prev !== undefined && equal(prev, next)) return prev
  ref.current = next
  return next
}

/** Hook form of keepIfEqual. */
export function useKeepIfEqual<T>(next: T, equal: (a: T, b: T) => boolean): T {
  const ref = useRef<T | undefined>(undefined)
  return keepIfEqual(ref, next, equal)
}

function applySpecsEqual(
  a: Record<string, ApplyToLinesSpec>,
  b: Record<string, ApplyToLinesSpec>
): boolean {
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  for (const k of ka) {
    const x = a[k]
    const y = b[k]
    if (!y || x.label !== y.label || x.count !== y.count) return false
  }
  return true
}

/**
 * The record form's FieldAffordances context value, kept the same object
 * while nothing a field reads from it changed. The form rebuilds the value on
 * every render (lock reasons, apply-to-lines and the callbacks are computed
 * inline), which re-rendered every field row on every form render, memo or
 * not. The callbacks become stable delegates to the newest value; an optional
 * callback stays absent when the newest value has none (rows test for it).
 */
export function useStableFieldAffordances(next: FieldAffordances): FieldAffordances {
  const latest = useRef(next)
  useLayoutEffect(() => {
    latest.current = next
  })
  const fns = useMemo(
    () => ({
      dismissRemoteChange: (field: string) => latest.current.dismissRemoteChange(field),
      takeRemoteChange: (field: string) => latest.current.takeRemoteChange?.(field),
      onLockHover: () => latest.current.onLockHover?.(),
      openRelated: (collection: string, id: string) => latest.current.openRelated?.(collection, id)
    }),
    []
  )
  const lockReasons = useKeepIfEqual(next.lockReasons, shallowRecordEqual)
  const applyData = useKeepIfEqual(next.applyToLines, applySpecsEqual)
  const applyToLines = useMemo(() => {
    const out: Record<string, ApplyToLinesSpec> = {}
    for (const [key, spec] of Object.entries(applyData)) {
      out[key] = {
        ...spec,
        onApply: (value: unknown) => latest.current.applyToLines[key]?.onApply(value)
      }
    }
    return out
  }, [applyData])
  const hasTake = !!next.takeRemoteChange
  const hasHover = !!next.onLockHover
  const hasOpen = !!next.openRelated
  const { remoteChanges, layoutId, pickerMisses, fromAutofill, glossaryHelp, placementText } = next
  return useMemo<FieldAffordances>(
    () => ({
      remoteChanges,
      dismissRemoteChange: fns.dismissRemoteChange,
      takeRemoteChange: hasTake ? fns.takeRemoteChange : undefined,
      lockReasons,
      onLockHover: hasHover ? fns.onLockHover : undefined,
      applyToLines,
      openRelated: hasOpen ? fns.openRelated : undefined,
      layoutId,
      pickerMisses,
      fromAutofill,
      glossaryHelp,
      placementText
    }),
    [
      remoteChanges,
      fns,
      hasTake,
      lockReasons,
      hasHover,
      applyToLines,
      hasOpen,
      layoutId,
      pickerMisses,
      fromAutofill,
      glossaryHelp,
      placementText
    ]
  )
}

function setsEqual(a: Set<unknown>, b: Set<unknown>): boolean {
  if (a.size !== b.size) return false
  for (const v of a) if (!b.has(v)) return false
  return true
}

function arraysEqual(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false
  return true
}

/** GroupSection props the form builds fresh on every render from parsed
 *  config — compared by content. */
const GROUP_JSON_PROPS = new Set(['summaryFields', 'swapConfig', 'alternateWidths'])
/** Inline closures that only capture the group's own id and a state setter:
 *  the same group always gets the same behaviour, so only presence counts. */
const GROUP_PRESENCE_PROPS = new Set(['onToggle', 'onSwapToggle'])

/**
 * GroupSection's memo comparator. The form rebuilds several props on every
 * render (the visible/locked field Sets, `fieldValues`, filtered field lists,
 * parsed summary/swap config, the accordion/swap toggles); comparing those by
 * content lets a section skip the renders where nothing it shows changed.
 * Everything else (the draft, callbacks, React nodes) is compared by identity.
 */
export function groupSectionPropsEqual(
  prev: Record<string, unknown>,
  next: Record<string, unknown>
): boolean {
  const keys = Object.keys(prev)
  if (keys.length !== Object.keys(next).length) return false
  for (const k of keys) {
    if (!Object.hasOwn(next, k)) return false
    const a = prev[k]
    const b = next[k]
    if (Object.is(a, b)) continue
    if (GROUP_PRESENCE_PROPS.has(k)) {
      if (typeof a === 'function' && typeof b === 'function') continue
      return false
    }
    if (GROUP_JSON_PROPS.has(k)) {
      if (jsonEqual(a, b)) continue
      return false
    }
    if (a instanceof Set && b instanceof Set) {
      if (setsEqual(a, b)) continue
      return false
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      if (arraysEqual(a, b)) continue
      return false
    }
    return false
  }
  return true
}
