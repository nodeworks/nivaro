import { useTrafficMap } from '../context'
import { callerLabel, fmtCount } from '../EventTicker'
import { Section, t } from '../Inspector'
import { nodeBadges } from '../registry/canvasLayers'
import { inspectorPanels } from '../registry/inspectorPanels'
import { register } from '../registry/registry'
import type { Selection } from '../types'
import { inPage, recentCount, useEntityDetail } from './b1-shared'

/**
 * #1117 — duplicate requests: the same GET (method + path + query) from the same caller started
 * within 500 ms of the previous one (the double resolve-paths / field-config class). The entity
 * gets a badge; the inspector lists the pairs.
 */
export const DUPLICATES_TAP = 'duplicates'

interface Dups {
  n: number
  routes: Array<{ route: string; n: number }>
  pairs: Array<{ at: string; route: string; caller: string; gap_ms: number }>
}

function DupPanel({ sel }: { sel: Selection }) {
  const { model, catalog } = useTrafficMap()
  const detail = useEntityDetail(sel.id)
  const d = (detail?.[DUPLICATES_TAP] ?? model.entityMeta(sel.id)?.ext?.[DUPLICATES_TAP]) as
    | Dups
    | undefined
  const live = recentCount(model, DUPLICATES_TAP, sel.id, 60)
  if (!d?.n && !live) return null
  return (
    <Section title='Duplicate requests'>
      <div className='grid gap-1.5 text-[12px]' id='tm-dups'>
        <span className='tabular-nums'>
          <span className='font-semibold text-[var(--tm-update)]'>
            {fmtCount(live || d?.n || 0)}
          </span>{' '}
          identical GETs within 500 ms of the same request
          {live ? ' in the last minute' : ' in the window'}
        </span>
        {d?.pairs.length ? (
          <div className='grid gap-1'>
            {d.pairs.slice(0, 6).map((p, i) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: pairs can share a timestamp
                key={`${p.at}-${i}`}
                className='grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-2 text-[11.5px]'
                data-tm-dup-pair=''
              >
                <span className='font-mono text-[10.5px] tabular-nums text-[var(--tm-muted)]'>
                  {t(p.at)}
                </span>
                <span className='min-w-0 truncate' title={p.route}>
                  <span className='font-mono text-[11px]'>{p.route}</span>
                  <span className='text-[var(--tm-muted)]'>
                    {' '}
                    · {callerLabel(catalog, p.caller)}
                  </span>
                </span>
                <span className='tabular-nums text-[var(--tm-fg-2)]'>+{p.gap_ms} ms</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </Section>
  )
}

register(nodeBadges, {
  id: 'duplicates',
  order: 40,
  badge(nodeId, model) {
    const n = recentCount(model, DUPLICATES_TAP, nodeId, 60)
    return n > 0 ? { text: `${n}× dup`, tone: 'warn' } : null
  }
})
register(inspectorPanels, {
  id: 'duplicates',
  order: 40,
  applies: (sel) => sel.kind === 'entity',
  Component: inPage(DupPanel)
})
