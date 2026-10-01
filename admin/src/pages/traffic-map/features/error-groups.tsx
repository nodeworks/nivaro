/**
 * #1150 — an entity's errors grouped by normalised message (the issue fingerprint rule), each
 * server-error group linked to its issue.
 */
import { Link } from 'react-router'
import { useTrafficMap } from '../context'
import { fmtTime } from '../EventTicker'
import { Empty, type InspectorData, Section } from '../Inspector'
import { inspectorPanels } from '../registry/inspectorPanels'
import { register } from '../registry/registry'
import type { Selection } from '../types'
import { entityOf, LINK, useEntityDetail } from './shared'

interface ErrorGroup {
  key: string
  route: string
  status: number
  code: string | null
  message: string
  n: number
  last: string
  issue: { id: number; status: string; occurrence_count: number } | null
}

function ErrorGroupsPanel({ sel, d }: { sel: Selection; d: InspectorData }) {
  const { win } = useTrafficMap()
  const e = entityOf(sel)
  const { data, loading } = useEntityDetail<{ groups?: ErrorGroup[] }>(
    e?.key ?? null,
    'error-groups',
    win
  )
  const groups = data?.groups ?? []
  if (!loading && groups.length === 0 && d.errors.length === 0) return null
  return (
    <Section title='Error groups'>
      {loading ? (
        <Empty>Grouping errors…</Empty>
      ) : groups.length === 0 ? (
        <Empty>No errors in this window on this node.</Empty>
      ) : (
        <ul className='grid gap-1.5 text-[12px]' data-tm-error-groups=''>
          {groups.map((g) => (
            <li key={g.key} className='grid gap-0.5' data-tm-error-group={g.status}>
              <div className='grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-2'>
                <span className='font-mono font-medium tabular-nums text-[var(--tm-error-ink)]'>
                  {g.status}
                </span>
                <span className='min-w-0 truncate' title={g.message}>
                  {g.message}
                </span>
                <span className='tabular-nums text-[var(--tm-fg-2)]'>×{g.n.toLocaleString()}</span>
              </div>
              <div className='flex min-w-0 flex-wrap items-baseline gap-x-2 text-[11.5px] text-[var(--tm-muted)]'>
                <span className='min-w-0 truncate font-mono text-[11px]'>{g.route}</span>
                <span>last {fmtTime(g.last)}</span>
                {g.issue ? (
                  <Link
                    to={`/issues/${g.issue.id}`}
                    className={LINK}
                    data-tm-error-issue={g.issue.id}
                  >
                    Issue #{g.issue.id} · {g.issue.status}
                  </Link>
                ) : g.status >= 500 ? (
                  <span>no open issue</span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

register(inspectorPanels, {
  id: 'error-groups',
  order: 15,
  applies: (sel) => {
    const e = entityOf(sel)
    return !!e && !e.entity.startsWith('__')
  },
  Component: ErrorGroupsPanel
})
