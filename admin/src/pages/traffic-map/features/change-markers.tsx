import { api } from '@/lib/api'
import { useTrafficMap } from '../context'
import { Empty, Section } from '../Inspector'
import { inspectorPanels } from '../registry/inspectorPanels'
import { register } from '../registry/registry'
import {
  type SparkMarker,
  type SparkMarkerSource,
  setSparkMarkerSource,
  useSparkMarkers
} from '../registry/sparkMarkers'

/**
 * Deploy, config and maintenance markers (#1093). One cached read of /traffic-map/markers
 * feeds every sparkline: a range the cache does not cover, or a cache older than REFRESH_MS,
 * starts one background fetch (a little wider than asked, so a live window sliding forward
 * stays covered).
 */

const REFRESH_MS = 30_000
const PAD_MS = 5 * 60_000
const MAX_RANGE_MS = 24 * 3600_000

export function createMarkerSource(
  fetcher: (from: number, to: number) => Promise<SparkMarker[]>,
  now: () => number = Date.now
): SparkMarkerSource {
  let cache: { from: number; to: number; at: number; list: SparkMarker[] } | null = null
  let inflight = false
  let version = 0
  const subs = new Set<() => void>()
  const load = (from: number, to: number) => {
    if (inflight) return
    inflight = true
    const f = Math.max(from - PAD_MS, to - MAX_RANGE_MS)
    const t = to + PAD_MS
    fetcher(f, t)
      .then((list) => {
        cache = { from: f, to: t, at: now(), list: Array.isArray(list) ? list : [] }
      })
      .catch(() => {
        // keep what we had; try again on the next ask after REFRESH_MS
        if (cache) cache.at = now()
        else cache = { from: f, to: t, at: now(), list: [] }
      })
      .finally(() => {
        inflight = false
        version++
        for (const fn of subs) fn()
      })
  }
  return {
    get(from, to) {
      const c = cache
      if (!c || from < c.from || to > c.to || now() - c.at > REFRESH_MS) load(from, to)
      if (!c) return []
      return c.list.filter((m) => (m.until ?? m.at) >= from && m.at <= to)
    },
    subscribe(fn) {
      subs.add(fn)
      return () => subs.delete(fn)
    },
    version: () => version
  }
}

const KINDS = new Set(['boot', 'deploy', 'config', 'snapshot', 'maintenance'])

async function fetchMarkers(from: number, to: number): Promise<SparkMarker[]> {
  const res = await api.get(`/traffic-map/markers?from=${Math.round(from)}&to=${Math.round(to)}`)
  const data = res?.data?.data
  if (!Array.isArray(data)) return []
  return data.filter(
    (m): m is SparkMarker =>
      !!m && typeof m === 'object' && KINDS.has(m.kind) && Number.isFinite(m.at)
  )
}

const KIND_LABEL: Record<SparkMarker['kind'], string> = {
  deploy: 'Deploy',
  boot: 'Restart',
  config: 'Config',
  snapshot: 'Snapshot',
  maintenance: 'Maintenance'
}

/** Inspector: what changed in the window the sparkline covers. */
export function ChangesSection() {
  const { model, win, ready } = useTrafficMap()
  const range = ready ? { from: (model.now - win) * 1000, to: model.now * 1000 } : undefined
  const list = useSparkMarkers(range)
  return (
    <Section title='What changed in the window'>
      {list.length ? (
        <ul className='grid gap-1 text-[12px]' data-tm-changes={list.length}>
          {list
            .slice(-8)
            .reverse()
            .map((m) => (
              <li key={`${m.kind}:${m.at}`} className='flex min-w-0 gap-2'>
                <span className='w-[44px] shrink-0 tabular-nums text-[var(--tm-muted)]'>
                  {new Date(m.at).toTimeString().slice(0, 5)}
                </span>
                <span className='shrink-0 text-[var(--tm-fg-2)]'>{KIND_LABEL[m.kind]}</span>
                <span className='min-w-0 truncate' title={m.label}>
                  {m.label}
                </span>
              </li>
            ))}
        </ul>
      ) : (
        <Empty>No restart, deploy, config write or maintenance window in this window.</Empty>
      )}
    </Section>
  )
}

setSparkMarkerSource(createMarkerSource(fetchMarkers))
register(inspectorPanels, {
  id: 'change-markers',
  order: 95,
  applies: () => true,
  Component: ChangesSection
})
