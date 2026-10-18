/**
 * Platform nodes drawn from the one poll (store.ts): the work queues (#2157) and running bulk
 * actions (#2271) as down nodes; a missed-run badge on job nodes (#2267); a tuning-proposal badge
 * on collection and query nodes (#2199); and the database server's resource level on the database
 * node (#2265). The storage node (#2164) is drawn by the map itself — its panel lives in
 * storage.tsx.
 */
import { useEffect } from 'react'
import { setDownLabel } from '../../nodeKinds'
import { canvasLayers, nodeBadges, nodeProviders, sideBadges } from '../../registry/canvasLayers'
import { register } from '../../registry/registry'
import { toolbarItems } from '../../registry/toolbarItems'
import { latestFrameValue } from '../db-lenses/shared'
import {
  bulkNodeId,
  bulkOf,
  type DbServerSample,
  fmtRate,
  isBulkNode,
  isQueueNode,
  isStorageNode,
  missFor,
  platformDownIds,
  queueBadgeText,
  queueNodeId,
  queueOf,
  queueTone,
  type StorageSnapshot,
  storageLevel,
  tuningFor
} from './logic'
import { platformNow, setPlatform, usePlatformNodes } from './store'

function PlatformPoller() {
  const q = usePlatformNodes()
  useEffect(() => {
    if (!q.data) return
    for (const w of q.data.work_queues) setDownLabel(queueNodeId(w.id), w.label)
    for (const r of q.data.bulk_runs) setDownLabel(bulkNodeId(r.id), `Bulk · ${r.label}`)
    setPlatform(q.data)
  }, [q.data])
  useEffect(() => () => setPlatform(null), [])
  return null
}
register(toolbarItems, { id: 'platform-nodes-poller', order: 996, Component: PlatformPoller })

register(nodeProviders, {
  id: 'platform-nodes',
  downs: () => platformDownIds(platformNow())
})

// ── badges on side-column nodes ───────────────────────────────────────────────
register(sideBadges, {
  id: 'platform-nodes',
  order: 60,
  badge(kind, id, model) {
    const d = platformNow()
    if (kind === 'caller') {
      const miss = missFor(d, id)
      return miss ? { text: 'missed a run', tone: 'warn' } : null
    }
    if (isQueueNode(id)) {
      const q = queueOf(d, id)
      return q ? { text: queueBadgeText(q), tone: queueTone(q.level) } : null
    }
    if (isBulkNode(id)) {
      const r = bulkOf(d, id)
      if (!r) return null
      if (r.failed > 0) return { text: `${r.failed} refused`, tone: 'warn' }
      return { text: r.per_s != null ? fmtRate(r.per_s, 's') : 'running', tone: 'info' }
    }
    if (isStorageNode(id)) {
      const snap = model.snapshotExt?.storage as StorageSnapshot | undefined
      const fig = snap?.drivers[id.slice(8)]
      if (!fig) return null
      const level = storageLevel(fig)
      if (level === 'error') return { text: 'failing', tone: 'error' }
      if (level === 'warn') return { text: 'slow', tone: 'warn' }
      return null
    }
    if (id === 'db') {
      const s =
        latestFrameValue<DbServerSample>(model, 'db-server', 60) ??
        (model.snapshotExt?.['db-server'] as DbServerSample | undefined)
      if (!s?.available || s.level === 'ok') return null
      return {
        text:
          s.waits && s.waits.data_io >= 200
            ? 'disk waits'
            : (s.reasons[0] ?? 'server busy').slice(0, 28),
        tone: s.level === 'error' ? 'error' : 'warn'
      }
    }
    return null
  }
})

// ── tuning proposals on collection / query nodes ──────────────────────────────
register(nodeBadges, {
  id: 'tuning-proposals',
  order: 40,
  badge(nodeId) {
    const t = tuningFor(platformNow(), nodeId)
    return t
      ? { text: t.count > 1 ? `${t.count} tuning ideas` : 'tuning idea', tone: 'info' }
      : null
  }
})

// ── edges ─────────────────────────────────────────────────────────────────────
/** import worker → staged import queue; collection → the bulk run writing into it. */
register(canvasLayers, {
  id: 'platform-node-edges',
  order: 15,
  draw(ctx, { layout, tokens, active }) {
    const d = platformNow()
    if (!d) return
    const stroke = (
      a: { x: number; y: number },
      b: { x: number; y: number },
      on: boolean,
      n: number
    ) => {
      const mx = (a.x + b.x) / 2
      ctx.strokeStyle = on ? tokens.accent : tokens.muted
      ctx.globalAlpha = on ? 0.85 : 0.4
      ctx.lineWidth = Math.min(3, 1 + Math.log10(1 + n))
      ctx.setLineDash([2, 3])
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.bezierCurveTo(mx, a.y, mx, b.y, b.x, b.y)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.globalAlpha = 1
    }
    const importQ = d.work_queues.find((q) => q.id === 'import')
    const to = layout.downs[queueNodeId('import')]
    const from = layout.callers['import:worker']
    if (importQ && to && from) {
      const on =
        (active?.kind === 'down' && active.id === queueNodeId('import')) ||
        (active?.kind === 'caller' && active.id === 'import:worker')
      stroke(
        { x: from.x + from.w, y: from.y + from.h / 2 },
        { x: to.x, y: to.y + to.h / 2 },
        on,
        importQ.depth
      )
    }
    for (const r of d.bulk_runs) {
      const node = layout.downs[bulkNodeId(r.id)]
      const ent = r.collection ? layout.ents[`items/${r.collection}`] : undefined
      if (!node || !ent) continue
      const on =
        (active?.kind === 'down' && active.id === bulkNodeId(r.id)) ||
        (active?.kind === 'entity' && active.id === `items/${r.collection}`)
      stroke(
        { x: ent.x + ent.w, y: ent.y + Math.min(ent.h, layout.rowH) / 2 },
        { x: node.x, y: node.y + node.h / 2 },
        on,
        r.done
      )
    }
  }
})
