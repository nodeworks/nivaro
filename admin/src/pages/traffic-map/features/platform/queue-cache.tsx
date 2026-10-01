/**
 * #1175 — the queue cache. Materialized queues keep a cached row per matched record current on
 * every write to a source collection; this draws that work as a down node ("Queue cache"), with an
 * edge from each collection whose writes it resynced in the window. Its inspector lists each
 * materialized queue: rows resynced and what they cost, failures, backfill runs, and how long since
 * the cache was last rebuilt; plus the per-write lookup every business write pays to ask.
 */
import { useEffect } from 'react'
import { useTrafficMap } from '../../context'
import { fmtMs } from '../../EventTicker'
import { Empty, Section } from '../../Inspector'
import { setDownLabel } from '../../nodeKinds'
import { canvasLayers, nodeProviders, sideBadges } from '../../registry/canvasLayers'
import { inspectorPanels } from '../../registry/inspectorPanels'
import { register } from '../../registry/registry'
import { toolbarItems } from '../../registry/toolbarItems'
import type { Selection } from '../../types'
import { entityOf, SafeLink } from '../shared'
import {
  ageText,
  QUEUE_CACHE_NODE,
  type QueueCacheData,
  queueCacheNow,
  setQueueCache,
  useQueueCache
} from './store'

setDownLabel(QUEUE_CACHE_NODE, 'Queue cache')

/** Show the node at all: a materialized queue exists, or something resynced in the window. */
export function queueCacheVisible(d: QueueCacheData | null): boolean {
  return !!d && d.queues.some((q) => q.materialized || q.syncs > 0)
}
/** collection → rows resynced in the window (all queues). */
export function syncsByCollection(d: QueueCacheData | null): Map<string, number> {
  const out = new Map<string, number>()
  for (const q of d?.queues ?? [])
    for (const c of q.collections) out.set(c, (out.get(c) ?? 0) + q.syncs)
  return out
}

function QueueCachePoller() {
  const q = useQueueCache()
  useEffect(() => {
    if (q.data) setQueueCache(q.data)
  }, [q.data])
  useEffect(() => () => setQueueCache(null), [])
  return null
}
register(toolbarItems, { id: 'queue-cache-poller', order: 998, Component: QueueCachePoller })

register(nodeProviders, {
  id: 'queue-cache',
  downs: () => (queueCacheVisible(queueCacheNow()) ? [QUEUE_CACHE_NODE] : [])
})

register(sideBadges, {
  id: 'queue-cache',
  badge(kind, id) {
    if (kind !== 'down' || id !== QUEUE_CACHE_NODE) return null
    const d = queueCacheNow()
    if (!d) return null
    if (d.queues.some((q) => q.backfill.running)) return { text: 'rebuilding', tone: 'info' }
    const failed = d.queues.reduce((a, q) => a + q.failed, 0)
    if (failed) return { text: `${failed} sync failed`, tone: 'error' }
    const n = d.queues.filter((q) => q.materialized).length
    return n ? { text: `${n} queue${n === 1 ? '' : 's'}`, tone: 'info' } : null
  }
})

/** collection entity → queue cache node, for the collections whose writes it resynced. */
register(canvasLayers, {
  id: 'queue-cache-edges',
  order: 13,
  draw(ctx, { layout, tokens, active }) {
    const to = layout.downs[QUEUE_CACHE_NODE]
    if (!to) return
    const by = syncsByCollection(queueCacheNow())
    for (const [collection, n] of by) {
      if (n <= 0) continue
      const key = `items/${collection}`
      const from = layout.ents[key] ?? layout.lanes.items
      if (!from) continue
      const on =
        (active?.kind === 'entity' && active.id === key) ||
        (active?.kind === 'down' && active.id === QUEUE_CACHE_NODE)
      const a = { x: from.x + from.w, y: from.y + Math.min(from.h, layout.rowH) / 2 }
      const b = { x: to.x, y: to.y + to.h / 2 }
      const mx = (a.x + b.x) / 2
      ctx.strokeStyle = on ? tokens.accent : tokens.muted
      ctx.globalAlpha = on ? 0.85 : 0.45
      ctx.lineWidth = Math.min(3, 1 + Math.log10(1 + n))
      ctx.setLineDash([2, 3])
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.bezierCurveTo(mx, a.y, mx, b.y, b.x, b.y)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.globalAlpha = 1
    }
  }
})

function QueueRows({ data, only }: { data: QueueCacheData; only?: string }) {
  const list = only ? data.queues.filter((q) => q.collections.includes(only)) : data.queues
  if (!list.length)
    return <Empty>No materialized queue resynced rows of this collection in the window.</Empty>
  return (
    <ul className='grid gap-2 text-[12px]' data-tm-queue-cache=''>
      {list.slice(0, 12).map((q) => (
        <li key={q.id} className='grid gap-0.5' data-tm-queue-cache-row={q.id}>
          <span className='flex min-w-0 items-baseline justify-between gap-2'>
            <SafeLink
              to={`/queues/${q.id}`}
              className='min-w-0 truncate rounded-sm text-[var(--tm-accent-ink)] hover:underline'
            >
              {q.name}
            </SafeLink>
            <span className='shrink-0 tabular-nums text-[var(--tm-fg-2)]'>
              {q.syncs.toLocaleString()} row{q.syncs === 1 ? '' : 's'}
              {q.avg_ms != null && ` · ${fmtMs(q.avg_ms)} avg`}
              {q.max_ms != null && ` · ${fmtMs(q.max_ms)} worst`}
            </span>
          </span>
          <span className='text-[11.5px] text-[var(--tm-muted)]'>
            {q.materialized ? 'Cached' : 'Not cached (reads live)'}
            {q.rows != null && ` · ${q.rows.toLocaleString()} rows held`}
            {' · '}
            {q.backfill.running
              ? 'rebuilding now'
              : `rebuilt ${q.since_rebuild_s == null ? 'never' : `${ageText(q.since_rebuild_s)} ago`}`}
            {q.backfill.last_duration_ms != null &&
              !q.backfill.running &&
              ` (took ${fmtMs(q.backfill.last_duration_ms)})`}
            {q.backfill.last_status === 'error' && (
              <span className='text-[var(--tm-error-ink)]'> · last rebuild failed</span>
            )}
            {q.failed > 0 && (
              <span className='text-[var(--tm-error-ink)]'> · {q.failed} resync failed</span>
            )}
          </span>
        </li>
      ))}
    </ul>
  )
}

function QueueCacheNodePanel() {
  const q = useQueueCache()
  const d = q.data
  return (
    <>
      <Section title='Materialized queues'>
        {q.isLoading || !d ? <Empty>Reading the queue cache…</Empty> : <QueueRows data={d} />}
      </Section>
      {d && d.lookups.length > 0 && (
        <Section title='Per-write lookup'>
          <p className='mb-1.5 text-[11.5px] text-[var(--tm-muted)]'>
            Every business write asks whether a materialized queue reads its collection.
          </p>
          <ul className='grid gap-1 text-[12px]' data-tm-queue-lookups=''>
            {d.lookups.slice(0, 8).map((l) => (
              <li key={l.collection} className='flex min-w-0 justify-between gap-2'>
                <span className='min-w-0 truncate font-mono text-[11px]'>{l.collection}</span>
                <span className='shrink-0 tabular-nums text-[var(--tm-fg-2)]'>
                  {l.writes.toLocaleString()} write{l.writes === 1 ? '' : 's'} ·{' '}
                  {fmtMs(l.ms / Math.max(1, l.writes))} each
                  {l.hits > 0 && ` · ${l.hits} resynced`}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  )
}

function CollectionQueuePanel({ sel }: { sel: Selection }) {
  const e = entityOf(sel)
  const q = useQueueCache()
  const { win } = useTrafficMap()
  if (!e || !q.data) return null
  const hit = q.data.queues.some((x) => x.collections.includes(e.entity))
  if (!hit) return null
  return (
    <Section title={`Queue cache resyncs (last ${win / 60} min)`}>
      <QueueRows data={q.data} only={e.entity} />
    </Section>
  )
}

register(inspectorPanels, {
  id: 'queue-cache-node',
  order: 20,
  applies: (sel) => sel.kind === 'down' && sel.id === QUEUE_CACHE_NODE,
  Component: QueueCacheNodePanel
})
register(inspectorPanels, {
  id: 'queue-cache-collection',
  order: 60,
  applies: (sel) => {
    const e = entityOf(sel)
    return !!e && e.lane === 'items'
  },
  Component: CollectionQueuePanel
})
