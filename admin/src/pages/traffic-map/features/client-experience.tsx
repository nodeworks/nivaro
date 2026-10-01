/**
 * #1115 — client experience on the pages lane: what the browser felt (RUM p75 LCP, full load and
 * in-app route settle) beside what the API took for the same page (p95 from the ring).
 */
import { useTrafficMap } from '../context'
import { fmtMs } from '../EventTicker'
import { Empty, type InspectorData, Section } from '../Inspector'
import { inspectorPanels } from '../registry/inspectorPanels'
import { register } from '../registry/registry'
import type { Selection } from '../types'
import { entityOf, useEntityDetail } from './shared'

interface RumRow {
  app: string
  route: string
  samples: number
  lcp_p75: number | null
  load_p75: number | null
  route_p75: number | null
}

const TH = 'px-1.5 py-1 text-right text-[11.5px] font-medium text-[var(--tm-muted)]'
const TD = 'px-1.5 py-1 text-right tabular-nums'

function ClientExperiencePanel({ sel, d }: { sel: Selection; d: InspectorData }) {
  const { win } = useTrafficMap()
  const e = entityOf(sel)
  const { data, loading } = useEntityDetail<{ hours?: number; rows?: RumRow[] }>(
    e?.key ?? null,
    'client-experience',
    win
  )
  const rows = data?.rows ?? []
  return (
    <Section title='What users felt'>
      <p className='mb-1.5 text-[12px] text-[var(--tm-fg-2)]' data-tm-api-p95=''>
        API p95 for this page: <span className='font-medium tabular-nums'>{fmtMs(d.p95)}</span>
      </p>
      {loading ? (
        <Empty>Reading browser timings…</Empty>
      ) : rows.length === 0 ? (
        <Empty>
          No browser timings for this page in the last {data?.hours ?? 24} hours. They arrive as
          people open it.
        </Empty>
      ) : (
        <table className='w-full border-collapse text-[12px]' data-tm-client-experience=''>
          <thead>
            <tr className='border-b border-[var(--tm-line-2)]'>
              <th scope='col' className={`${TH} text-left`}>
                Where
              </th>
              <th scope='col' className={TH}>
                LCP p75
              </th>
              <th scope='col' className={TH}>
                Load p75
              </th>
              <th scope='col' className={TH}>
                Route p75
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 5).map((r) => (
              <tr
                key={`${r.app} ${r.route}`}
                className='border-b border-[var(--tm-line-2)] last:border-0'
              >
                <td className='max-w-0 truncate px-1.5 py-1' title={`${r.app} ${r.route}`}>
                  <span className='font-mono text-[11px]'>{r.route}</span>{' '}
                  <span className='text-[var(--tm-muted)]'>
                    {r.app} · {r.samples}
                  </span>
                </td>
                <td className={TD}>{fmtMs(r.lcp_p75 ?? 0)}</td>
                <td className={TD}>{fmtMs(r.load_p75 ?? 0)}</td>
                <td className={TD}>{fmtMs(r.route_p75 ?? 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  )
}

register(inspectorPanels, {
  id: 'client-experience',
  order: 30,
  applies: (sel) => {
    const e = entityOf(sel)
    return !!e && e.lane === 'pages' && !e.entity.startsWith('__')
  },
  Component: ClientExperiencePanel
})
