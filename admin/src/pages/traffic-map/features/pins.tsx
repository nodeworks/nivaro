import { Pin, PinOff, Star } from 'lucide-react'
import { useMemo, useState, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { cn } from '@/lib/utils'
import { hotColumns } from '../registry/hotColumns'
import { inspectorActions } from '../registry/inspectorActions'
import { register } from '../registry/registry'
import { toolbarItems } from '../registry/toolbarItems'
import { BTN } from './shared'
import { useFrozenSnapshotId } from './snapshots'

/**
 * #1125 — pinned entities: a watch list that survives reload (the `traffic_pins` preference,
 * per admin). Pin from the inspector or the star in Hot entities; "Pinned only" narrows the
 * ticker and the hot table to the pins.
 */
const MAX_PINS = 40
let pinsOnly = false
const subs = new Set<() => void>()
export function pinsOnlyOn(): boolean {
  return pinsOnly
}
export function setPinsOnly(v: boolean): void {
  if (pinsOnly === v) return
  pinsOnly = v
  for (const fn of subs) fn()
}
export function subscribePinsOnly(fn: () => void): () => void {
  subs.add(fn)
  return () => {
    subs.delete(fn)
  }
}
function usePinsOnly(): boolean {
  return useSyncExternalStore(
    subscribePinsOnly,
    () => pinsOnly,
    () => pinsOnly
  )
}

/** The signed-in admin's pinned entity keys (from their preferences). */
export function pinsOf(user: unknown): string[] {
  const p = (user as { preferences?: { traffic_pins?: unknown } } | null)?.preferences?.traffic_pins
  return Array.isArray(p) ? p.filter((k): k is string => typeof k === 'string') : []
}

/** What the page applies: null = no pin filter; else the set of pinned keys. */
export function usePinFilter(): Set<string> | null {
  const { user } = useAuth()
  const only = usePinsOnly()
  const key = only ? pinsOf(user).join('\n') : null
  return useMemo(() => (key === null ? null : new Set(key ? key.split('\n') : [])), [key])
}

let optimistic: string[] | null = null
function usePins(): { pins: string[]; toggle: (key: string) => Promise<void>; busy: boolean } {
  const { user, refetch } = useAuth()
  const [busy, setBusy] = useState(false)
  const pins = optimistic ?? pinsOf(user)
  const toggle = async (key: string) => {
    const cur = pinsOf(user)
    const next = cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]
    if (next.length > MAX_PINS) {
      toast.error(`Pin at most ${MAX_PINS} entities`)
      return
    }
    setBusy(true)
    optimistic = next
    try {
      await api.patch('/users/me/preferences', { traffic_pins: next.length ? next : null })
      await refetch()
    } catch {
      toast.error('Could not save the pin')
    } finally {
      optimistic = null
      setBusy(false)
    }
  }
  return { pins, toggle, busy }
}

function PinAction({ sel }: { sel: { id: string } }) {
  const { pins, toggle, busy } = usePins()
  const on = pins.includes(sel.id)
  return (
    <button
      type='button'
      className={BTN}
      disabled={busy}
      aria-pressed={on}
      data-tm-pin={sel.id}
      onClick={() => void toggle(sel.id)}
    >
      {on ? (
        <PinOff className='h-3.5 w-3.5' aria-hidden='true' />
      ) : (
        <Pin className='h-3.5 w-3.5' aria-hidden='true' />
      )}
      {on ? 'Unpin' : 'Pin'}
    </button>
  )
}

function PinStar({ id }: { id: string }) {
  const { pins, toggle, busy } = usePins()
  const on = pins.includes(id)
  return (
    <button
      type='button'
      disabled={busy}
      aria-pressed={on}
      aria-label={on ? 'Unpin' : 'Pin'}
      title={on ? 'Pinned: click to unpin' : 'Pin to your watch list'}
      data-tm-pin-star={id}
      onClick={(e) => {
        e.stopPropagation()
        void toggle(id)
      }}
      className='rounded-sm p-0.5 text-[var(--tm-muted)] hover:text-[var(--tm-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
    >
      <Star
        className={cn('h-3.5 w-3.5', on && 'fill-[var(--tm-update)] text-[var(--tm-update)]')}
        aria-hidden='true'
      />
    </button>
  )
}

function PinsOnlyToggle() {
  const { user } = useAuth()
  const only = usePinsOnly()
  const frozen = useFrozenSnapshotId()
  const n = pinsOf(user).length
  if (frozen || (!n && !only)) return null
  return (
    <button
      type='button'
      id='tm-pins-only'
      aria-pressed={only}
      onClick={() => setPinsOnly(!only)}
      title='Show only your pinned entities in the ticker and Hot entities'
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-[3px] text-[12px] font-medium leading-tight transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--tm-card)]',
        only
          ? 'border-[color-mix(in_srgb,var(--tm-accent)_55%,var(--tm-line))] bg-[var(--tm-accent-soft)] text-[var(--tm-accent-ink)]'
          : 'border-[var(--tm-line)] bg-[var(--tm-card)] text-[var(--tm-fg-2)] hover:bg-[var(--tm-card-2)]'
      )}
    >
      <Star className='h-3.5 w-3.5' aria-hidden='true' />
      Pinned only <span className='tabular-nums'>{n}</span>
    </button>
  )
}

register(inspectorActions, {
  id: 'pin',
  order: 5,
  applies: (sel) => sel.kind === 'entity',
  Component: PinAction
})
register(hotColumns, {
  id: 'pin',
  header: 'Pin',
  align: 'left',
  cell: (row) => <PinStar id={row.key} />
})
register(toolbarItems, { id: 'pins-only', order: 40, Component: PinsOnlyToggle })
