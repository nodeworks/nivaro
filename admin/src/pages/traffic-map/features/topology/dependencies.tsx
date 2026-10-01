// Topology (Traffic Map group C) — #1103 partner dependency overlay. On an API key or an account
// caller, "Show dependencies" reads the partner dependency map (/api/partner-dependencies, the
// fields a caller read and wrote over the logged window) and rings those collections on the map
// (amber = written, accent = read only) while dimming the rest — a planned schema change can be
// checked against the traffic that would feel it.
import { useQuery } from '@tanstack/react-query'
import { useEffect, useSyncExternalStore } from 'react'
import { Link } from 'react-router'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useTrafficMap } from '../../context'
import { callerLabel } from '../../EventTicker'
import { Empty, Section } from '../../Inspector'
import { inspectorActions } from '../../registry/inspectorActions'
import { inspectorPanels } from '../../registry/inspectorPanels'
import { register } from '../../registry/registry'
import type { Selection } from '../../types'
import {
  type DependencyCollection,
  dependencyKeyOf,
  dependencyOverlay,
  setDependencyOverlay,
  subscribeDependencyOverlay
} from './store'

const LINK =
  'rounded-sm text-[var(--tm-accent-ink)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
const BTN =
  'rounded-md border px-2 py-[2px] text-[12px] font-medium transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:cursor-not-allowed disabled:opacity-60'

interface CallerDeps {
  label: string
  calls: number
  collections: DependencyCollection[]
}

function useOverlay() {
  return useSyncExternalStore(subscribeDependencyOverlay, dependencyOverlay, dependencyOverlay)
}

function useDeps(caller: string, enabled: boolean) {
  const key = dependencyKeyOf(caller)
  return useQuery({
    queryKey: ['traffic-map', 'partner-deps', key],
    queryFn: async () => {
      const res = await api.get(`/partner-dependencies/${encodeURIComponent(key as string)}`)
      return res.data.data as CallerDeps
    },
    enabled: enabled && !!key,
    staleTime: 3 * 60_000,
    retry: false
  })
}

function DependenciesToggle({ sel }: { sel: Selection }) {
  const { catalog } = useTrafficMap()
  const overlay = useOverlay()
  const on = overlay?.caller === sel.id
  const q = useDeps(sel.id, on)
  // the answer arrives after the click: fill the overlay once it does
  const data = q.data
  useEffect(() => {
    const cur = dependencyOverlay()
    if (!data || cur?.caller !== sel.id || cur.collections.size > 0) return
    setDependencyOverlay({
      ...cur,
      collections: new Map(data.collections.map((c) => [c.collection, c]))
    })
  }, [data, sel.id])
  return (
    <button
      type='button'
      id='tm-deps-toggle'
      aria-pressed={on}
      onClick={() =>
        setDependencyOverlay(
          on
            ? null
            : { caller: sel.id, label: callerLabel(catalog, sel.id), collections: new Map() }
        )
      }
      className={cn(
        BTN,
        on
          ? 'border-[color-mix(in_srgb,var(--tm-accent)_55%,var(--tm-line))] bg-[var(--tm-accent-soft)] text-[var(--tm-accent-ink)]'
          : 'border-[var(--tm-line)] bg-[var(--tm-card)] text-[var(--tm-fg-2)] hover:bg-[var(--tm-card-2)]'
      )}
    >
      {on ? 'Hide dependencies' : 'Show dependencies'}
    </button>
  )
}

register(inspectorActions, {
  id: 'topology-dependencies',
  order: 40,
  applies: (sel) => sel.kind === 'caller' && dependencyKeyOf(sel.id) !== null,
  Component: DependenciesToggle
})

function DependenciesPanel({ sel }: { sel: Selection }) {
  const overlay = useOverlay()
  const q = useDeps(sel.id, true)
  if (overlay?.caller !== sel.id) return null
  const cols = (q.data?.collections ?? []).slice().sort((a, b) => b.calls - a.calls)
  return (
    <Section title='Dependencies · last 14 days'>
      {q.isLoading ? (
        <Empty>Reading the request log…</Empty>
      ) : q.isError ? (
        <Empty>No logged calls from this caller in the window.</Empty>
      ) : cols.length ? (
        <div className='grid gap-2' data-tm-deps=''>
          <p className='text-[11.5px] text-[var(--tm-muted)]'>
            Ringed on the map: amber where it writes, accent where it only reads.
          </p>
          {cols.slice(0, 20).map((c) => (
            <div
              key={c.collection}
              className='min-w-0 text-[12px]'
              data-tm-deps-collection={c.collection}
            >
              <div className='flex items-baseline justify-between gap-2'>
                <span className='min-w-0 truncate font-mono text-[11.5px] font-medium'>
                  {c.collection}
                </span>
                <span
                  className='shrink-0 text-[11px] font-medium'
                  style={{ color: c.writes ? 'var(--tm-update)' : 'var(--tm-accent-ink)' }}
                >
                  {c.writes ? 'reads and writes' : 'reads'}
                </span>
              </div>
              <p className='min-w-0 truncate text-[11.5px] text-[var(--tm-fg-2)]'>
                {c.read_all ? 'every field' : c.read.map((f) => f.field).join(', ') || '—'}
                {c.written.length ? (
                  <span className='text-[var(--tm-update)]'>
                    {' '}
                    · writes {c.written.map((f) => f.field).join(', ')}
                  </span>
                ) : null}
              </p>
            </div>
          ))}
          <Link to='/integration-health?tab=inbound' className={cn(LINK, 'w-fit text-[12px]')}>
            Open the full dependency map
          </Link>
        </div>
      ) : (
        <Empty>This caller touched no collection fields in the window.</Empty>
      )}
    </Section>
  )
}

register(inspectorPanels, {
  id: 'topology-dependencies',
  order: 6,
  applies: (sel) => sel.kind === 'caller' && dependencyKeyOf(sel.id) !== null,
  Component: DependenciesPanel
})
