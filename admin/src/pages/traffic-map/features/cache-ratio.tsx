import { useTrafficMap } from '../context'
import { fmtCount, fmtMs } from '../EventTicker'
import { Section } from '../Inspector'
import type { TrafficModel } from '../model'
import { canvasLayers } from '../registry/canvasLayers'
import { inspectorPanels } from '../registry/inspectorPanels'
import { register } from '../registry/registry'
import type { Selection } from '../types'
import { inPage, liveEntityExt } from './b1-shared'

/**
 * #1111 — cache hit ratio on custom-query and widget nodes: a ring around the node's dot whose
 * filled share is the hit ratio (last 60 s), and "saved ~N ms" per hit in the inspector (the
 * median uncached time minus the median cached time).
 */
export const CACHE_RATIO_TAP = 'cache-ratio'
const LANES = new Set(['queries', 'widgets'])

interface Figures {
  hits: number
  misses: number
  ratio: number
  hit_ms?: number
  miss_ms?: number
  saved_ms?: number
}
type Live = number[] | Figures

export function cacheFigures(v: Live | undefined): Figures | null {
  if (!v) return null
  if (Array.isArray(v)) {
    const [hits = 0, misses = 0] = v
    return { hits, misses, ratio: hits + misses ? hits / (hits + misses) : 0 }
  }
  return v
}

export function liveCache(m: TrafficModel, key: string): Figures | null {
  return cacheFigures(liveEntityExt<Live>(m, CACHE_RATIO_TAP, key))
}

function CachePanel({ sel }: { sel: Selection }) {
  const { model } = useTrafficMap()
  const live = liveCache(model, sel.id)
  const snap = cacheFigures(model.entityMeta(sel.id)?.ext?.[CACHE_RATIO_TAP] as Live | undefined)
  const f = live ?? snap
  if (!f || f.hits + f.misses === 0) return null
  const saved = snap?.saved_ms ?? f.saved_ms ?? 0
  return (
    <Section title='Cache'>
      <div
        className='grid gap-1 text-[12px] tabular-nums'
        id='tm-cache'
        data-tm-cache-ratio={f.ratio}
      >
        <span>
          <span className='font-semibold'>{Math.round(f.ratio * 100)}%</span> served from the cache
          <span className='text-[var(--tm-muted)]'>
            {' '}
            · {fmtCount(f.hits)} hits, {fmtCount(f.misses)} misses
          </span>
        </span>
        {saved > 0 && snap ? (
          <span data-tm-cache-saved={saved}>
            Saved ~{fmtMs(saved)} per hit
            <span className='text-[var(--tm-muted)]'>
              {' '}
              · cached {fmtMs(snap.hit_ms ?? 0)} vs {fmtMs(snap.miss_ms ?? 0)} uncached (medians)
            </span>
          </span>
        ) : (
          <span className='text-[11.5px] text-[var(--tm-muted)]'>
            Time saved shows once both cached and uncached answers have been seen.
          </span>
        )}
      </div>
    </Section>
  )
}

register(canvasLayers, {
  id: 'cache-ratio',
  order: 30,
  draw(ctx, { layout, data, tokens, model }) {
    for (const lane of data.lanes) {
      if (!LANES.has(lane.id)) continue
      for (const e of lane.entities) {
        const r = layout.ents[e.key]
        const f = r ? liveCache(model, e.key) : null
        if (!r || !f || f.hits + f.misses === 0) continue
        const cx = r.x + 7
        const cy = r.y + r.h / 2
        ctx.lineWidth = 1.6
        ctx.beginPath()
        ctx.arc(cx, cy, 5.5, 0, Math.PI * 2)
        ctx.strokeStyle = tokens.line
        ctx.stroke()
        if (f.ratio > 0) {
          ctx.beginPath()
          ctx.arc(cx, cy, 5.5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * f.ratio)
          ctx.strokeStyle = tokens.create
          ctx.stroke()
        }
      }
    }
  }
})
register(inspectorPanels, {
  id: 'cache-ratio',
  order: 31,
  applies: (sel) => sel.kind === 'entity' && LANES.has(sel.id.slice(0, sel.id.indexOf('/'))),
  Component: inPage(CachePanel)
})
