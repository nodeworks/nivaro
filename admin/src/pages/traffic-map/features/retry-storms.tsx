import { useTrafficMap } from '../context'
import { callerLabel, entityLabel, fmtCount } from '../EventTicker'
import { Section } from '../Inspector'
import type { TrafficModel } from '../model'
import { canvasLayers } from '../registry/canvasLayers'
import { inspectorPanels } from '../registry/inspectorPanels'
import { register } from '../registry/registry'
import type { Selection } from '../types'
import {
  ago,
  drawPill,
  frameExt,
  inEdgeEnds,
  inPage,
  snapExt,
  strokeEdge,
  useLens
} from './b1-shared'

/**
 * #1118 — retry storms: one caller repeating the same failing request (same route, status and
 * code) more than 10 times in a rolling minute. The caller's edge turns into a red dashed line
 * with a "retry storm" pill, the ticker carries a `retry storm` event, and the caller's inspector
 * lists what it keeps retrying.
 */
export const RETRY_STORMS_TAP = 'retry-storms'

export interface Storm {
  caller: string
  entity_key: string
  route: string
  status: number
  code: string | null
  n: number
  since: number
}

/** Storms active now: the newest frame's list once frames flow, else the snapshot's. */
export function currentStorms(m: TrafficModel): Storm[] {
  if (m.lastFrameAt > 0) return frameExt<{ storms: Storm[] }>(m, RETRY_STORMS_TAP)?.storms ?? []
  return snapExt<{ storms: Storm[] }>(m, RETRY_STORMS_TAP)?.storms ?? []
}

function StormPanel({ sel }: { sel: Selection }) {
  const { catalog } = useTrafficMap()
  const { data } = useLens<{ storms: Storm[] }>(RETRY_STORMS_TAP)
  const storms = (data?.storms ?? []).filter((s) => s.caller === sel.id)
  if (!storms.length) return null
  return (
    <Section title='Retry storm'>
      <div className='grid gap-1.5 text-[12px]' id='tm-storms'>
        {storms.map((s) => {
          const cut = s.entity_key.indexOf('/')
          return (
            <div key={`${s.route}|${s.status}|${s.code}`} className='grid gap-0.5' data-tm-storm=''>
              <span>
                <span className='font-semibold text-[var(--tm-error-ink)]'>
                  {fmtCount(s.n)} failures
                </span>{' '}
                in the last minute on{' '}
                <span className='font-mono text-[11px]'>
                  {entityLabel(catalog, s.entity_key.slice(0, cut), s.entity_key.slice(cut + 1))}
                </span>
              </span>
              <span
                className='min-w-0 truncate text-[11.5px] text-[var(--tm-fg-2)]'
                title={s.route}
              >
                <span className='font-mono'>{s.status}</span>
                {s.code ? <span className='font-mono'> {s.code}</span> : null} ·{' '}
                <span className='font-mono'>{s.route}</span> · since{' '}
                {ago(new Date(s.since).toISOString())}
              </span>
            </div>
          )
        })}
        <p className='text-[11.5px] text-[var(--tm-muted)]'>
          {callerLabel(catalog, sel.id)} keeps sending the same request and getting the same refusal
          — look at the integration's retry policy before the error itself.
        </p>
      </div>
    </Section>
  )
}

register(canvasLayers, {
  id: 'retry-storms',
  order: 50,
  draw(ctx, { layout, tokens, fonts, model }) {
    const storms = currentStorms(model)
    if (!storms.length) return
    const seen = new Set<string>()
    for (const s of storms) {
      const lane = s.entity_key.slice(0, s.entity_key.indexOf('/'))
      const ends = inEdgeEnds(layout, s.caller, lane)
      if (!ends) continue
      ctx.save()
      ctx.setLineDash([5, 4])
      ctx.lineWidth = 2
      ctx.strokeStyle = tokens.error
      strokeEdge(ctx, ends.a, ends.b)
      ctx.restore()
      if (seen.has(s.caller)) continue
      seen.add(s.caller)
      const c = layout.callers[s.caller]
      drawPill(
        ctx,
        c.x + c.w - 4,
        c.y - 6,
        'retry storm',
        tokens.error,
        tokens.card,
        `600 9.5px ${fonts.mono}`,
        'right'
      )
    }
  }
})
register(inspectorPanels, {
  id: 'retry-storms',
  order: 15,
  applies: (sel) => sel.kind === 'caller',
  Component: inPage(StormPanel)
})
