// Topology (Traffic Map group C) — what the canvas draws for the new node kinds:
//   • the poller (a toolbar item that renders nothing) keeping the topology store current;
//   • node providers: sources that only call partners, Redis when it runs commands;
//   • edge styles: partner edges coloured by why they fail (#1112), source edges dashed;
//   • side badges: pool pressure on SQL Server (#1109), a partner's error class, a job's failed
//     last run, the import run in progress, channel test mode;
//   • layers: source → partner/channel edges (a job with no request has no drawn lane to route
//     through), flow trigger edges (#1106), the partner dependency overlay (#1103).
import { useEffect } from 'react'
import { useTrafficMap } from '../../context'
import type { MapTokens, Rect } from '../../layout'
import { setDownLabel, setSourceLabel } from '../../nodeKinds'
import {
  type CanvasLayerArgs,
  canvasLayers,
  edgeStyles,
  nodeProviders,
  requestCanvasRepaint,
  sideBadges
} from '../../registry/canvasLayers'
import { register } from '../../registry/registry'
import { toolbarItems } from '../../registry/toolbarItems'
import {
  dependencyOverlay,
  setTopology,
  subscribeDependencyOverlay,
  topologyNow,
  topologyWin,
  useTopology
} from './store'

export const ERROR_CLASSES = [
  'transient',
  'rate_limited',
  'auth',
  'not_found',
  'validation',
  'unknown'
] as const
export type ErrorClass = (typeof ERROR_CLASSES)[number]
export const CLASS_TONE: Record<ErrorClass, keyof MapTokens> = {
  transient: 'ecTransient',
  rate_limited: 'ecRateLimited',
  auth: 'ecAuth',
  not_found: 'ecNotFound',
  validation: 'ecValidation',
  unknown: 'muted'
}
export const CLASS_VAR: Record<ErrorClass, string> = {
  transient: 'var(--tm-ec-transient)',
  rate_limited: 'var(--tm-ec-rate-limited)',
  auth: 'var(--tm-ec-auth)',
  not_found: 'var(--tm-ec-not-found)',
  validation: 'var(--tm-ec-validation)',
  unknown: 'var(--tm-muted)'
}
export const CLASS_LABEL: Record<ErrorClass, string> = {
  transient: 'transient',
  rate_limited: 'rate limited',
  auth: 'auth',
  not_found: 'not found',
  validation: 'validation',
  unknown: 'unknown'
}
export const CLASS_HINT: Record<ErrorClass, string> = {
  transient: 'timeouts, refused connections, 5xx — sending again usually works',
  rate_limited: '429 — the partner asked us to slow down',
  auth: '401/403 — credentials or token',
  not_found: '404 — the record or endpoint is gone',
  validation: '4xx — the partner rejected what we sent',
  unknown: 'no class could be read'
}

/** The class with the most failures (ties: ERROR_CLASSES order); null when none. */
export function dominantClass(classes: Record<string, number> | undefined): ErrorClass | null {
  let best: ErrorClass | null = null
  let n = 0
  for (const c of ERROR_CLASSES) {
    const v = classes?.[c] ?? 0
    if (v > n) {
      n = v
      best = c
    }
  }
  return best
}

export const isPartnerDown = (id: string) => id.startsWith('ext:') || id.startsWith('x:')

// ── poller ───────────────────────────────────────────────────────────────────
function TopologyPoller() {
  const { win, paused } = useTrafficMap()
  const q = useTopology(win, paused)
  useEffect(() => {
    if (!q.data) return
    setTopology(win, q.data)
    for (const [id, s] of Object.entries(q.data.sources?.sources ?? {})) setSourceLabel(id, s.label)
    for (const n of q.data.nodes ?? []) setDownLabel(n.id, n.label)
    requestCanvasRepaint()
  }, [q.data, win])
  useEffect(() => subscribeDependencyOverlay(() => requestCanvasRepaint()), [])
  return null
}
register(toolbarItems, { id: 'topology-poller', order: 999, Component: TopologyPoller })

// ── node providers ───────────────────────────────────────────────────────────
register(nodeProviders, {
  id: 'topology',
  sources(_m, win) {
    const t = topologyNow()
    const out = new Map<string, number>()
    for (const [k, n] of Object.entries(t?.sources?.sd ?? {})) {
      const src = k.slice(0, k.lastIndexOf('>'))
      out.set(src, (out.get(src) ?? 0) + n / win)
    }
    // a source whose runs fail deserves a node even when it writes nothing
    const figures = t?.sources?.sources ?? {}
    for (const [id, s] of Object.entries(figures))
      if (s.errors > 0 && !out.has(id)) out.set(id, s.runs / win)
    return [...out].map(([id, rps]) => ({ id, rps }))
  },
  downs() {
    const t = topologyNow()
    const extra: string[] = []
    if ((t?.redis?.commands ?? 0) > 0) extra.push('redis')
    for (const k of Object.keys(t?.sources?.sd ?? {})) extra.push(k.slice(k.lastIndexOf('>') + 1))
    return extra
  }
})

// ── edge styles ──────────────────────────────────────────────────────────────
register(edgeStyles, {
  id: 'topology-edges',
  style(edge) {
    if (edge.dir === 'out' && isPartnerDown(edge.to)) {
      const cls = dominantClass(topologyNow()?.partners?.downs[edge.to]?.classes)
      return cls ? { tone: CLASS_TONE[cls] } : null
    }
    if (edge.dir === 'in' && edge.from.includes(':')) return { tone: 'edge', dash: [5, 4] }
    return null
  }
})

// ── side badges ──────────────────────────────────────────────────────────────
const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`)
register(sideBadges, {
  id: 'topology-badges',
  badge(kind, id) {
    const t = topologyNow()
    if (!t) return null
    if (kind === 'down') {
      if (id === 'db' && t.pool && t.pool.level !== 'ok') {
        const tone = t.pool.level === 'error' ? 'error' : 'warn'
        return t.pool.saturated_pct >= 25
          ? { text: `pool busy ${t.pool.saturated_pct}%`, tone }
          : { text: `pool wait ${fmtMs(t.pool.wait_p95_ms)}`, tone }
      }
      if (isPartnerDown(id)) {
        const classes = t.partners?.downs[id]?.classes
        const cls = dominantClass(classes)
        if (!cls) return null
        const tone =
          cls === 'auth' || cls === 'validation' ? 'error' : cls === 'unknown' ? 'info' : 'warn'
        return { text: `${CLASS_LABEL[cls]} ${classes?.[cls] ?? ''}`.trim(), tone }
      }
      if (t.channels?.[id]?.redirected) return { text: 'test mode', tone: 'info' }
      return null
    }
    if (id === 'import:worker' && t.sources?.import.current) {
      return { text: `run ${t.sources.import.current.run_id}`, tone: 'info' }
    }
    const s = t.sources?.sources[id]
    if (s?.last && !s.last.ok) return { text: 'last run failed', tone: 'error' }
    return null
  }
})

// ── layers ───────────────────────────────────────────────────────────────────
function curve(
  ctx: CanvasRenderingContext2D,
  a: { x: number; y: number },
  b: { x: number; y: number }
): void {
  const mx = (a.x + b.x) / 2
  ctx.beginPath()
  ctx.moveTo(a.x, a.y)
  ctx.bezierCurveTo(mx, a.y, mx, b.y, b.x, b.y)
}
const selId = (a: CanvasLayerArgs['active']) => (a ? `${a.kind}:${a.id}` : '')

/** Source → partner / channel / AI / webhook calls, drawn straight across the lanes. */
register(canvasLayers, {
  id: 'topology-source-downs',
  order: 10,
  draw(ctx, { layout, tokens, active }) {
    const sd = topologyNow()?.sources?.sd
    if (!sd) return
    const win = topologyWin()
    const hl = selId(active)
    for (const [k, n] of Object.entries(sd)) {
      const cut = k.lastIndexOf('>')
      const from = layout.callers[k.slice(0, cut)]
      const to = layout.downs[k.slice(cut + 1)]
      if (!from || !to || n <= 0) continue
      const on = hl === `caller:${k.slice(0, cut)}` || hl === `down:${k.slice(cut + 1)}`
      ctx.strokeStyle = on ? tokens.accent : tokens.edge
      ctx.globalAlpha = on ? 0.8 : 1
      ctx.lineWidth = Math.min(4, 1 + Math.sqrt(n / win) * 1.5)
      ctx.setLineDash([2, 4])
      curve(
        ctx,
        { x: from.x + from.w, y: from.y + from.h / 2 + 6 },
        { x: to.x, y: to.y + to.h / 2 + 6 }
      )
      ctx.stroke()
    }
    ctx.setLineDash([])
    ctx.globalAlpha = 1
  }
})

/** Trigger → flow (#1106): from the entity (or lane) whose write fired the flow. */
register(canvasLayers, {
  id: 'topology-flow-triggers',
  order: 11,
  draw(ctx, { layout, tokens, active }) {
    const triggers = topologyNow()?.sources?.triggers
    if (!triggers) return
    const hl = selId(active)
    for (const flowId of layout.sourceIds) {
      if (!flowId.startsWith('flow:')) continue
      const r = layout.callers[flowId]
      const list = triggers[flowId]
      if (!r || !list?.length) continue
      for (const t of list.slice(0, 3)) {
        let from: Rect | undefined = layout.ents[t.key]
        if (!from && t.key.includes('/')) {
          const lane = layout.lanes[t.key.slice(0, t.key.indexOf('/'))]
          from = lane ? { x: lane.x, y: lane.y, w: lane.w, h: 22 } : undefined
        }
        if (!from) continue
        const a = { x: from.x, y: from.y + from.h / 2 }
        const b = { x: r.x + r.w, y: r.y + r.h / 2 }
        const on = hl === `caller:${flowId}` || hl === `entity:${t.key}`
        ctx.strokeStyle = on ? tokens.accent : tokens.muted
        ctx.globalAlpha = on ? 0.9 : 0.55
        ctx.lineWidth = 1.25
        ctx.setLineDash([4, 3])
        curve(ctx, a, b)
        ctx.stroke()
        ctx.setLineDash([])
        // arrowhead into the flow node
        ctx.beginPath()
        ctx.moveTo(b.x, b.y)
        ctx.lineTo(b.x + 6, b.y - 3.5)
        ctx.lineTo(b.x + 6, b.y + 3.5)
        ctx.closePath()
        ctx.fillStyle = on ? tokens.accent : tokens.muted
        ctx.fill()
        ctx.globalAlpha = 1
      }
    }
  }
})

/** Partner dependency overlay (#1103): the caller's collections ringed, the rest dimmed. */
register(canvasLayers, {
  id: 'topology-dependencies',
  order: 12,
  draw(ctx, { layout, tokens }) {
    const o = dependencyOverlay()
    if (!o) return
    for (const [key, r] of Object.entries(layout.ents)) {
      const lane = key.slice(0, key.indexOf('/'))
      const entity = key.slice(key.indexOf('/') + 1)
      const coll = lane === 'items' || lane === 'system' ? o.collections.get(entity) : undefined
      if (coll) {
        ctx.beginPath()
        ctx.roundRect(r.x - 1, r.y, r.w + 2, r.h, 4)
        ctx.lineWidth = 2
        ctx.strokeStyle = coll.writes ? tokens.update : tokens.accent
        ctx.stroke()
      } else {
        ctx.beginPath()
        ctx.roundRect(r.x, r.y + 1, r.w, r.h - 2, 4)
        ctx.fillStyle = tokens.card
        ctx.globalAlpha = 0.6
        ctx.fill()
        ctx.globalAlpha = 1
      }
    }
  }
})
