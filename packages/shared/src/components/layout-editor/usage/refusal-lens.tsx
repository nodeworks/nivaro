import { useQuery } from '@tanstack/react-query'
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { useNivaroClient } from '../../../context'
import { get } from '../../../lib/commands'
import { cn } from '../../../lib/utils'
import type { DesignOverlay, DesignTarget } from '../design-context'
import { usageKeys } from './usage-api'

/**
 * Where saves fail (#3185): the record form counts each refused save and the
 * fields it named (required and empty, or another rule broken), and the
 * editor's error-rate lens tints each field by the share of save attempts
 * refused on it, over the last 30 days. Admin-only read:
 * GET /layout-usage/:id/refusals.
 */

export interface FieldRefusals {
  field: string
  required: number
  invalid: number
  refusals: number
  /** refusals / save attempts, 0–1. */
  rate: number
}

export interface LayoutRefusals {
  ready: boolean
  days: number
  saves: number
  refused: number
  attempts: number
  fields: FieldRefusals[]
}

export function useSaveRefusals(layoutId: number | null, enabled = true) {
  const client = useNivaroClient()
  return useQuery<LayoutRefusals | null>({
    queryKey: usageKeys.refusals(layoutId ?? 0),
    queryFn: () =>
      client
        .request<{ data?: LayoutRefusals }>(get(`/layout-usage/${layoutId}/refusals`))
        .then((r) => r?.data ?? null),
    enabled: enabled && layoutId != null,
    staleTime: 5 * 60_000,
    retry: false
  })
}

/** At or above: the field is tinted amber; at HIGH, red. Below LOW it only gets a chip. */
export const REFUSAL_LOW = 0.05
export const REFUSAL_HIGH = 0.2
/** Fewer save attempts than this say too little to tint anything. */
export const REFUSAL_MIN_ATTEMPTS = 5

export type RefusalTone = 'none' | 'some' | 'high'

export function refusalTone(rate: number): RefusalTone {
  return rate >= REFUSAL_HIGH ? 'high' : rate >= REFUSAL_LOW ? 'some' : 'none'
}

/** "12%", "<1%". */
export function refusalPct(rate: number): string {
  const pct = rate * 100
  return pct > 0 && pct < 1 ? '<1%' : `${Math.round(pct)}%`
}

export function refusalTip(f: FieldRefusals, attempts: number, days: number): string {
  const parts = [
    f.required > 0 ? `${f.required} left empty while required` : null,
    f.invalid > 0 ? `${f.invalid} broke another rule` : null
  ].filter(Boolean)
  return `Refused ${f.refusals.toLocaleString()} of ${attempts.toLocaleString()} saves in ${days} days: ${parts.join(', ')}`
}

const TINT: Record<RefusalTone, string> = {
  none: '',
  some: 'bg-amber-50/70 ring-1 ring-amber-300 dark:bg-amber-500/10 dark:ring-amber-500/40',
  high: 'bg-red-50/70 ring-1 ring-red-300 dark:bg-red-500/10 dark:ring-red-500/40'
}

const CHIP: Record<RefusalTone, string> = {
  none: 'bg-white text-slate-500 ring-slate-200 dark:bg-card dark:text-muted-foreground dark:ring-border',
  some: 'bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-500/15 dark:text-amber-200 dark:ring-amber-500/30',
  high: 'bg-red-50 text-red-700 ring-red-200 dark:bg-red-500/15 dark:text-red-200 dark:ring-red-500/30'
}

export function RefusalChip({
  f,
  attempts,
  days
}: {
  f: FieldRefusals
  attempts: number
  days: number
}) {
  const tone = refusalTone(f.rate)
  return (
    <span
      data-design-refusal={refusalPct(f.rate)}
      data-refusal-tone={tone}
      data-tip={refusalTip(f, attempts, days)}
      className={cn(
        'pointer-events-auto inline-flex items-center rounded px-1 text-[10.5px] tabular-nums ring-1',
        CHIP[tone]
      )}
    >
      {refusalPct(f.rate)} refused
      <span className='sr-only'> saves on this field</span>
    </span>
  )
}

/** The overlay for one node, or null when the field has no refusals (or too few saves to judge). */
export function refusalOverlayFor(
  data: LayoutRefusals | null | undefined,
  t: DesignTarget
): DesignOverlay | null {
  if (!data || data.attempts < REFUSAL_MIN_ATTEMPTS) return null
  if (t.kind !== 'field' && t.kind !== 'header') return null
  const f = data.fields.find((x) => x.field === t.field)
  if (!f || f.refusals === 0) return null
  return {
    className: TINT[refusalTone(f.rate)],
    chip: <RefusalChip f={f} attempts={data.attempts} days={data.days} />
  }
}

// ── The lens switch: one per browser, shared by the toolbar and the Usage tab ──

const KEY = 'nvr:layout-editor:show-refusals'
const listeners = new Set<() => void>()
let current: boolean | null = null

function read(): boolean {
  if (current != null) return current
  try {
    current = window.localStorage.getItem(KEY) === '1'
  } catch {
    current = false
  }
  return current
}

export function setShowRefusals(on: boolean): void {
  current = on
  try {
    window.localStorage.setItem(KEY, on ? '1' : '0')
  } catch {
    // Not remembered; holds for this visit.
  }
  for (const l of listeners) l()
}

export function useShowRefusals(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    read,
    () => false
  )
  return [on, setShowRefusals]
}

type OverlayFn = (t: DesignTarget) => DesignOverlay | null

/**
 * The error-rate lens for the canvas: `wrap(overlay)` keeps any overlay a
 * preview mode already draws on a node and adds the lens where it draws none.
 * The same function comes back for the same input while the data holds, so
 * the canvas memo stays put.
 */
export function useRefusalLens(layoutId: number | null): {
  on: boolean
  setOn: (on: boolean) => void
  data: LayoutRefusals | null
  wrap: (overlay: OverlayFn | undefined) => OverlayFn | undefined
} {
  const [on, setOn] = useShowRefusals()
  const { data = null } = useSaveRefusals(layoutId, on)
  const lens = useMemo<OverlayFn | null>(
    () => (on && data ? (t) => refusalOverlayFor(data, t) : null),
    [on, data]
  )
  // A fresh cache whenever the lens changes: merged functions never outlive it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the lens on purpose
  const cache = useMemo(() => new WeakMap<object, OverlayFn>(), [lens])
  const wrap = useCallback(
    (overlay: OverlayFn | undefined): OverlayFn | undefined => {
      if (!lens) return overlay
      if (!overlay) return lens
      const hit = cache.get(overlay)
      if (hit) return hit
      const merged: OverlayFn = (t) => overlay(t) ?? lens(t)
      cache.set(overlay, merged)
      return merged
    },
    [lens, cache]
  )
  return { on, setOn, data, wrap }
}
