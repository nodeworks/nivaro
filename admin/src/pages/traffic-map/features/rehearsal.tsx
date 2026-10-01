import { useTrafficMap } from '../context'
import { fmtCount } from '../EventTicker'
import { Section } from '../Inspector'
import { canvasLayers } from '../registry/canvasLayers'
import { inspectorPanels } from '../registry/inspectorPanels'
import { register } from '../registry/registry'
import { stripTiles } from '../registry/stripTiles'
import type { Selection } from '../types'
import { inPage, recentCount, useEntityDetail, useLens } from './b1-shared'

/**
 * #1139 — rehearsal traffic: dry runs (`?dry_run=1`, GraphQL `_dry_run`), sandbox-key writes and
 * flow tests. They never commit, so the Writes tile never counts them; this tile counts them
 * apart, the map outlines entities that had them (dashed), and the ticker tags them.
 */
export const REHEARSAL_TAP = 'rehearsal'
export const REHEARSAL_LABEL: Record<string, string> = {
  dry_run: 'dry run',
  graphql_dry_run: 'GraphQL dry run',
  sandbox_key: 'sandbox key',
  flow_test: 'flow test'
}

export function reasonText(reasons: Record<string, number>): string {
  return Object.entries(reasons)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${fmtCount(n)} ${REHEARSAL_LABEL[k] ?? k}`)
    .join(' · ')
}

function RehearsalTile() {
  const { data } = useLens<{ n: number; reasons: Record<string, number> }>(REHEARSAL_TAP)
  const n = data?.n ?? 0
  return (
    <div className='min-w-0 bg-[var(--tm-card)] px-3.5 pb-2.5 pt-2.5' id='tm-strip-rehearsal'>
      <div className='text-[12px] font-medium text-[var(--tm-muted)]'>Rehearsals</div>
      <div className='mt-0.5 text-[22px] font-semibold leading-tight tracking-tight tabular-nums'>
        <span data-testid='tm-strip-rehearsal'>{n ? fmtCount(n) : '—'}</span>
      </div>
      <div className='mt-1 truncate text-[11.5px] text-[var(--tm-muted)]'>
        {n
          ? `${reasonText(data?.reasons ?? {})} · not counted as writes`
          : 'dry runs and tests, none in window'}
      </div>
    </div>
  )
}

function RehearsalPanel({ sel }: { sel: Selection }) {
  const { model } = useTrafficMap()
  const detail = useEntityDetail(sel.id)
  const d = (detail?.[REHEARSAL_TAP] ?? model.entityMeta(sel.id)?.ext?.[REHEARSAL_TAP]) as
    | { n: number; reasons: Record<string, number> }
    | undefined
  if (!d?.n) return null
  return (
    <Section title='Rehearsals'>
      <p className='text-[12px]' id='tm-rehearsal'>
        <span className='font-semibold tabular-nums'>{fmtCount(d.n)}</span> rehearsed writes —{' '}
        {reasonText(d.reasons)}
      </p>
      <p className='mt-1 text-[11.5px] text-[var(--tm-muted)]'>
        Tried and thrown away: they count as requests, never as writes.
      </p>
    </Section>
  )
}

register(stripTiles, { id: 'rehearsal', order: 20, Component: inPage(RehearsalTile) })
register(canvasLayers, {
  id: 'rehearsal',
  order: 36,
  draw(ctx, { layout, data, tokens, model }) {
    ctx.setLineDash([3, 3])
    ctx.lineWidth = 1.2
    ctx.strokeStyle = tokens.read
    for (const lane of data.lanes)
      for (const e of lane.entities) {
        const r = layout.ents[e.key]
        if (!r || recentCount(model, REHEARSAL_TAP, e.key, 60) <= 0) continue
        ctx.beginPath()
        ctx.roundRect(r.x + 0.75, r.y + 1.75, r.w - 1.5, r.h - 3.5, 4)
        ctx.stroke()
      }
  }
})
register(inspectorPanels, {
  id: 'rehearsal',
  order: 50,
  applies: (sel) => sel.kind === 'entity',
  Component: inPage(RehearsalPanel)
})
