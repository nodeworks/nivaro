/**
 * Pieces the node actions share (#2152 #2274 #2215 #2273 #2223 #2229): a small segmented picker,
 * the timed-action list every panel reads, and the node checks.
 */
import { useQuery } from '@tanstack/react-query'
import { useContext } from 'react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { TrafficMapContext } from '../../context'
import type { Selection } from '../../types'

const SEG =
  'px-2 py-[3px] text-[11.5px] font-medium leading-tight transition-colors duration-150 ease-out focus-visible:relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan'

export function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
  id
}: {
  label: string
  value: T
  options: Array<[T, string]>
  onChange: (v: T) => void
  id?: string
}) {
  return (
    <fieldset
      id={id}
      className='inline-flex min-w-0 overflow-hidden rounded-md border border-[var(--tm-line)]'
      aria-label={label}
    >
      {options.map(([v, text], i) => (
        <button
          key={String(v)}
          type='button'
          aria-pressed={value === v}
          data-tm-seg={String(v)}
          onClick={() => onChange(v)}
          className={cn(
            SEG,
            i > 0 && 'border-l border-[var(--tm-line)]',
            value === v
              ? 'bg-[var(--tm-accent-soft)] text-[var(--tm-accent-ink)]'
              : 'bg-[var(--tm-card)] text-[var(--tm-fg-2)] hover:bg-[var(--tm-card-2)]'
          )}
        >
          {text}
        </button>
      ))}
    </fieldset>
  )
}

/** `items/orders` → its parts; null for anything else. */
export function entityParts(sel: Selection): { lane: string; entity: string } | null {
  if (sel.kind !== 'entity') return null
  const cut = sel.id.indexOf('/')
  return cut > 0 ? { lane: sel.id.slice(0, cut), entity: sel.id.slice(cut + 1) } : null
}

/** The node a blast radius can be worked out for (an endpoint or a partner). */
export function blastNodeOf(sel: Selection): string | null {
  if (sel.kind === 'entity' && /^[a-z]+\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,119}$/.test(sel.id))
    return sel.id
  if (sel.kind === 'down' && /^ext:\d{1,9}$/.test(sel.id)) return sel.id
  return null
}

/** The node a debug window can be opened on (an endpoint, an API key or a person). */
export function debugTargetOf(sel: Selection): string | null {
  if (sel.kind === 'entity' && /^[a-z]+\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,119}$/.test(sel.id))
    return sel.id
  if (sel.kind === 'caller' && /^(k\d{1,12}|u[0-9A-F-]{36})$/.test(sel.id)) return sel.id
  return null
}

/** An ordinary collection's node (the only place a temporary cache can go). Mirrors the server. */
export function cacheTargetOf(sel: Selection): string | null {
  if (sel.kind !== 'entity') return null
  const m = sel.id.match(/^items\/([A-Za-z_][A-Za-z0-9_]{0,127})$/)
  if (!m || /^(nivaro_|directus_|chat_messages$|chat_last_read$)/i.test(m[1])) return null
  return sel.id
}

export interface DebugWindow {
  id: string
  target: string
  until: number
  at: number
  by_name: string | null
  matched: number
  kept: number
}
export interface TempCache {
  id: string
  target: string
  collection: string
  until: number
  at: number
  by_name: string | null
  entry_s: number
  related: number
  entries_here: number
  stats: {
    hit: number
    miss: number
    bypass: number
    stored: number
    rate: number | null
    scope: 'cluster' | 'process'
  }
}

/** Open debug windows (every 5 s while the page is live). */
export function useDebugWindows() {
  const ctx = useContext(TrafficMapContext)
  return useQuery({
    queryKey: ['traffic-map', 'debug-windows'],
    queryFn: async () =>
      (await api.get('/traffic-map/debug-windows')).data.data as {
        windows: DebugWindow[]
        available: boolean
        default_minutes: number
        max_minutes: number
      },
    enabled: !!ctx,
    refetchInterval: ctx?.paused ? false : 5000,
    staleTime: 2000
  })
}

/** Temporary caches with their live hit rate (every 3 s while one is on, else 10 s). */
export function useTempCaches() {
  const ctx = useContext(TrafficMapContext)
  return useQuery({
    queryKey: ['traffic-map', 'temp-caches'],
    queryFn: async () =>
      (await api.get('/traffic-map/temp-caches')).data.data as {
        caches: TempCache[]
        available: boolean
        default_minutes: number
        max_minutes: number
        default_entry_s: number
        max_entry_s: number
      },
    enabled: !!ctx,
    refetchInterval: (q) =>
      ctx?.paused ? false : (q.state.data?.caches.length ?? 0) > 0 ? 3000 : 10_000,
    staleTime: 1500
  })
}

export function minutesLeft(until: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((until - now) / 60_000))
}
