/**
 * #2198 — Web vs worker split. Traffic, background jobs and pool use per process role, from
 * NIVARO_ROLE on the instance roster, to show whether workers take the load they should. Shown
 * only when at least one process reports a role.
 */
import { useTrafficMap } from '../../context'
import { fmtCount } from '../../EventTicker'
import { pagePanels } from '../../registry/pagePanels'
import { register } from '../../registry/registry'
import { fmtLag, inMapOnly, PanelCard, useTmRoute } from '../ops-common'

interface Group {
  role: string
  nodes: number
  req: number
  error: number
  p95: number
  background: number
  pool: { peak_used: number; max: number; saturated_pct: number; wait_p95_ms: number } | null
}
interface RoleSplit {
  groups: Group[]
  answered: number
  note: string | null
}

function RoleSplitPanel() {
  const { win } = useTrafficMap()
  const { data } = useTmRoute<RoleSplit>(['role-split', win], `/role-split?window=${win}`, 10_000)
  if (!data || !data.groups.some((g) => g.role !== 'unset')) return null
  const th = 'px-3.5 py-1.5 text-left text-[11.5px] font-medium text-[var(--tm-muted)]'
  const td = 'px-3.5 py-1.5 tabular-nums'
  return (
    <PanelCard
      id='tm-role-split'
      title='Web and workers'
      hint={`${data.answered} process${data.answered === 1 ? '' : 'es'} answering, by NIVARO_ROLE`}
    >
      <div data-tm-role-split={data.groups.length} className='overflow-x-auto'>
        <table className='w-full text-[12px]'>
          <thead>
            <tr className='border-b border-[var(--tm-line-2)]'>
              <th className={th}>Role</th>
              <th className={th}>Processes</th>
              <th className={th}>Requests</th>
              <th className={th}>Errors</th>
              <th className={th}>p95</th>
              <th className={th}>Background calls</th>
              <th className={th}>Pool busiest</th>
            </tr>
          </thead>
          <tbody>
            {data.groups.map((g) => (
              <tr key={g.role} className='border-b border-[var(--tm-line-2)] last:border-0'>
                <td className='px-3.5 py-1.5 font-medium'>{g.role}</td>
                <td className={td}>{g.nodes}</td>
                <td className={td}>{fmtCount(g.req)}</td>
                <td className={`${td} ${g.error ? 'text-[var(--tm-error-ink)]' : ''}`}>
                  {fmtCount(g.error)}
                </td>
                <td className={td}>{fmtLag(g.p95)}</td>
                <td className={td}>{fmtCount(g.background)}</td>
                <td className={td}>
                  {g.pool ? `${g.pool.peak_used} of ${g.pool.max}` : '—'}
                  {g.pool && g.pool.saturated_pct > 0 ? (
                    <span className='ml-1 text-[var(--tm-update)]'>
                      full {Math.round(g.pool.saturated_pct)}%
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.note && (
          <p
            className='border-t border-[var(--tm-line-2)] px-3.5 py-2 text-[12px] text-[var(--tm-update)]'
            data-tm-role-note=''
          >
            {data.note}
          </p>
        )}
      </div>
    </PanelCard>
  )
}

register(pagePanels, { id: 'role-split', order: 71, Component: inMapOnly(RoleSplitPanel) })
