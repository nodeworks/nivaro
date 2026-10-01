/**
 * #1170 — blocking chains on the database node. While the map is watched the server samples
 * `sys.dm_exec_requests` every few seconds; when one SQL session waits on another, the map draws a
 * red edge from the waiting request's entity to the one holding it up (or to the database node
 * when the holder is background work or another program), and the database node's inspector
 * names the head blocker and its statement.
 */
import { useTrafficMap } from '../../context'
import { callerLabel } from '../../EventTicker'
import { Empty, Section } from '../../Inspector'
import type { MapLayout } from '../../layout'
import type { TrafficModel } from '../../model'
import { canvasLayers, sideBadges } from '../../registry/canvasLayers'
import { inspectorPanels } from '../../registry/inspectorPanels'
import { register } from '../../registry/registry'
import type { Selection } from '../../types'
import { inPage } from '../b1-shared'
import { LINK } from '../shared'
import {
  type BlockingChain,
  type BlockingSample,
  blockingEdges,
  DB_BLOCKING_TAP,
  involvedEntities,
  type Party,
  secs
} from './logic'
import { latestFrameValue, useDbLens } from './shared'
import { Sql } from './ui'

/** Frames carry a sample only when a new one landed (every ~3 s); hold it this long. */
const HOLD_S = 20

/** The newest sample the page has: a frame's, else the snapshot's when still fresh. */
export function blockingNow(m: TrafficModel): BlockingSample | null {
  const live = latestFrameValue<BlockingSample>(m, DB_BLOCKING_TAP, HOLD_S)
  if (live) return live
  const snap = m.snapshotExt?.[DB_BLOCKING_TAP] as BlockingSample | undefined
  return snap && Date.now() - snap.at <= HOLD_S * 1000 ? snap : null
}

function PartyLine({ p, what }: { p: Party; what: string }) {
  const { catalog, setSelection } = useTrafficMap()
  return (
    <span className='flex min-w-0 items-baseline gap-1.5'>
      <span className='w-[52px] shrink-0 text-[11px] text-[var(--tm-muted)]'>{what}</span>
      {p.entity ? (
        <button
          type='button'
          className={`${LINK} min-w-0 truncate font-mono text-[11px]`}
          onClick={() => setSelection({ kind: 'entity', id: p.entity as string })}
          title={p.label}
        >
          {p.entity}
        </button>
      ) : (
        <span className='min-w-0 truncate text-[11.5px]' title={p.label}>
          {p.label}
        </span>
      )}
      <span className='ml-auto shrink-0 font-mono text-[10.5px] tabular-nums text-[var(--tm-muted)]'>
        #{p.session}
        {p.caller ? ` · ${callerLabel(catalog, p.caller)}` : ''}
      </span>
    </span>
  )
}

function ChainItem({ c }: { c: BlockingChain }) {
  const sameHead = c.head.session === c.blocker.session
  return (
    <li
      className='grid min-w-0 gap-1 rounded-md border border-[var(--tm-line)] px-2 py-1.5'
      data-tm-block-chain={c.waiter.session}
    >
      <span className='text-[11.5px] font-medium text-[var(--tm-error-ink)]'>
        Waiting {secs(c.wait_ms)}
        {c.wait_type ? (
          <span className='font-normal text-[var(--tm-muted)]'> · {c.wait_type}</span>
        ) : null}
      </span>
      <PartyLine p={c.waiter} what='Waiting' />
      <PartyLine p={c.blocker} what='Held by' />
      {!sameHead && <PartyLine p={c.head} what='Head' />}
      <span className='text-[11px] text-[var(--tm-muted)]'>
        Head blocker statement
        {c.head.idle ? ' (idle — a transaction left open, its last statement):' : ':'}
      </span>
      <Sql text={c.head.sql} />
    </li>
  )
}

function BlockingPanel({ sel }: { sel: Selection }) {
  // the database node reads the route (works while paused); an entity uses the frames it has
  const { data, loading } = useDbLens<BlockingSample>('blocking', {
    every: 3000,
    enabled: sel.kind === 'down'
  })
  const { model } = useTrafficMap()
  const s = data ?? blockingNow(model)
  const chains =
    sel.kind === 'entity'
      ? (s?.chains ?? []).filter(
          (c) =>
            c.waiter.entity === sel.id || c.blocker.entity === sel.id || c.head.entity === sel.id
        )
      : (s?.chains ?? [])
  if (sel.kind === 'entity' && chains.length === 0) return null
  return (
    <Section title='Blocking chains'>
      <div className='grid gap-1.5 text-[12px]' id='tm-blocking' data-tm-blocking={chains.length}>
        {!s && loading ? (
          <Empty>Reading database sessions…</Empty>
        ) : s && !s.available ? (
          <Empty>{s.error ?? 'The database sessions could not be read.'}</Empty>
        ) : chains.length === 0 ? (
          <Empty>No session is waiting on another right now.</Empty>
        ) : (
          <ul className='grid gap-1.5'>
            {chains.slice(0, 8).map((c) => (
              <ChainItem key={`${c.waiter.session}-${c.blocker.session}`} c={c} />
            ))}
          </ul>
        )}
        {sel.kind === 'down' && (
          <p className='text-[11.5px] text-[var(--tm-muted)]'>
            Sampled every 3 s while the map is open; waits under 0.5 s are not shown.
          </p>
        )}
      </div>
    </Section>
  )
}

register(inspectorPanels, {
  id: 'db-blocking',
  order: 6,
  applies: (sel) => (sel.kind === 'down' && sel.id === 'db') || sel.kind === 'entity',
  Component: inPage(BlockingPanel)
})

register(sideBadges, {
  id: 'db-blocking',
  order: 10,
  badge(kind, id, model) {
    if (kind !== 'down' || id !== 'db') return null
    const s = blockingNow(model)
    return s && s.blocked > 0 ? { text: `${s.blocked} blocked`, tone: 'error' } : null
  }
})

/** Right-middle of an entity row, else its lane header (rows hidden by zoom). */
function anchorOf(layout: MapLayout, key: string): { x: number; y: number } | null {
  const r = layout.ents[key] ?? layout.lanes[key.slice(0, key.indexOf('/'))]
  return r ? { x: r.x + r.w, y: r.y + Math.min(r.h, layout.rowH) / 2 } : null
}

register(canvasLayers, {
  id: 'db-blocking',
  order: 62,
  draw(ctx, { layout, tokens, fonts, model }) {
    const s = blockingNow(model)
    const edges = blockingEdges(s)
    if (!edges.length) return
    const entities = involvedEntities(s)
    ctx.lineCap = 'round'
    ctx.font = `600 9.5px ${fonts.mono}`
    ctx.strokeStyle = tokens.error
    ctx.fillStyle = tokens.error
    ctx.lineWidth = 2
    for (const e of edges) {
      const a = anchorOf(layout, e.from)
      if (!a) continue
      let b: { x: number; y: number } | null
      if (e.to === 'db') {
        const r = layout.downs.db
        b = r ? { x: r.x, y: r.y + r.h / 2 } : null
      } else b = anchorOf(layout, e.to)
      if (!b) continue
      ctx.beginPath()
      let mid: { x: number; y: number }
      if (e.to === e.from) {
        // two requests of one entity: a loop on its right edge
        ctx.moveTo(a.x, a.y - 3)
        ctx.bezierCurveTo(a.x + 34, a.y - 18, a.x + 34, a.y + 18, a.x, a.y + 3)
        mid = { x: a.x + 30, y: a.y }
      } else if (e.to === 'db') {
        const mx = (a.x + b.x) / 2
        ctx.moveTo(a.x, a.y)
        ctx.bezierCurveTo(mx, a.y, mx, b.y, b.x, b.y)
        mid = { x: mx, y: (a.y + b.y) / 2 }
      } else {
        const bulge = 46 + Math.min(80, Math.abs(a.y - b.y) * 0.2)
        ctx.moveTo(a.x, a.y)
        ctx.bezierCurveTo(a.x + bulge, a.y, b.x + bulge, b.y, b.x, b.y)
        mid = { x: Math.max(a.x, b.x) + bulge * 0.75, y: (a.y + b.y) / 2 }
      }
      ctx.stroke()
      // arrow head at the holder
      if (e.to !== e.from) {
        ctx.beginPath()
        const dir = e.to === 'db' ? 1 : -1
        ctx.moveTo(b.x, b.y)
        ctx.lineTo(b.x - 6 * dir, b.y - 3.5)
        ctx.lineTo(b.x - 6 * dir, b.y + 3.5)
        ctx.closePath()
        ctx.fill()
      }
      ctx.textAlign = 'left'
      ctx.fillText(e.label, mid.x + 4, mid.y - 4)
    }
    // ring the entities caught in a chain
    ctx.lineWidth = 1.5
    for (const key of entities) {
      const r = layout.ents[key]
      if (!r) continue
      ctx.beginPath()
      ctx.roundRect(r.x + 0.75, r.y + 1.75, r.w - 1.5, r.h - 3.5, 4)
      ctx.stroke()
    }
  }
})
