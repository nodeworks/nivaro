import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { SimpleSelect } from '@/components/ui/simple-select'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { fmtMs, fmtRate } from '../EventTicker'
import { pagePanels } from '../registry/pagePanels'
import { register } from '../registry/registry'
import { inMapOnly, PanelCard } from './ops-common'
import { BTN, Segmented } from './shared'

/**
 * #2174 — two stored snapshots side by side: the difference per node and per edge (requests a
 * minute, error share, p95), for before and after a release or this Monday against last Monday.
 * Windows may differ in length; figures are per minute so they still compare. The server does the
 * arithmetic (GET /traffic-map/snapshots/compare).
 */
interface ListRow {
  id: string
  name: string
  kind: 'manual' | 'peak' | 'schedule'
  window_s: number
  created_at: string
}
interface Side {
  id: string
  name: string
  at: string
  window_s: number
  totals: { req: number; error: number; p95: number }
  environment?: string
}
interface NodeRow {
  key: string
  label: string
  kind: string
  a: { rpm: number; error_rpm: number; p95: number }
  b: { rpm: number; error_rpm: number; p95: number }
  delta_rpm: number
  delta_pct: number | null
  delta_error_pts: number
  delta_p95: number
  only: 'a' | 'b' | null
}
interface EdgeRow {
  key: string
  label: string
  a_rpm: number
  b_rpm: number
  delta_rpm: number
  delta_pct: number | null
  only: 'a' | 'b' | null
}
interface Diff {
  a: Side
  b: Side
  nodes: NodeRow[]
  edges: EdgeRow[]
  truncated: boolean
}

const TH = 'whitespace-nowrap px-2.5 py-1.5 text-[11.5px] font-medium text-[var(--tm-muted)]'
const TD = 'px-2.5 py-1.5'
const WEEK_MS = 7 * 86_400_000
const KIND_WORD: Record<string, string> = { manual: '', peak: 'peak · ', schedule: 'scheduled · ' }

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}
const label = (r: ListRow) => `${KIND_WORD[r.kind] ?? ''}${r.name} · ${when(r.created_at)}`

/** The snapshot nearest to `target` ms within `within` ms, other than `skip` (pure). */
export function nearestTo(
  rows: ListRow[],
  target: number,
  within: number,
  skip: string
): ListRow | null {
  let best: ListRow | null = null
  let gap = Number.POSITIVE_INFINITY
  for (const r of rows) {
    if (r.id === skip) continue
    const g = Math.abs(new Date(r.created_at).getTime() - target)
    if (g <= within && g < gap) {
      best = r
      gap = g
    }
  }
  return best
}

function Delta({ value, pct, unit }: { value: number; pct?: number | null; unit?: string }) {
  if (!Number.isFinite(value) || value === 0)
    return <span className='text-[var(--tm-muted)]'>no change</span>
  const up = value > 0
  return (
    <span className={up ? 'font-medium text-[var(--tm-fg)]' : 'text-[var(--tm-fg-2)]'}>
      {up ? '+' : '−'}
      {fmtRate(Math.abs(value))}
      {unit ?? ''}
      {pct == null
        ? ''
        : Math.abs(pct) >= 1000
          ? ` (${up ? 'over 10×' : 'under a tenth'})`
          : ` (${up ? '+' : '−'}${Math.abs(pct)}%)`}
    </span>
  )
}
function Only({ children }: { children: string }) {
  return (
    <span className='ml-1.5 rounded border border-[var(--tm-line)] px-1 py-px text-[10.5px] text-[var(--tm-fg-2)]'>
      {children}
    </span>
  )
}

function SideCard({ s, tag }: { s: Side; tag: 'A' | 'B' }) {
  const mins = Math.max(1, s.window_s / 60)
  return (
    <div className='min-w-0 bg-[var(--tm-card)] px-3.5 py-2 text-[12px]'>
      <div className='truncate font-medium' data-tip={s.name}>
        {tag}: {s.name}
      </div>
      <div className='text-[var(--tm-muted)]'>
        {when(s.at)} · {s.window_s / 60} min{s.environment ? ` · ${s.environment}` : ''}
      </div>
      <div className='mt-0.5 tabular-nums text-[var(--tm-fg-2)]'>
        {fmtRate(s.totals.req / mins)} req/min · {s.totals.error.toLocaleString('en-US')} errors ·
        p95 {fmtMs(s.totals.p95)}
      </div>
    </div>
  )
}

export function SnapshotComparePanel() {
  const [a, setA] = useState('')
  const [b, setB] = useState('')
  const [view, setView] = useState<'nodes' | 'edges'>('nodes')
  // nothing is read until someone opens the panel
  const [open, setOpen] = useState(false)
  const list = useQuery({
    queryKey: ['traffic-map', 'snapshots', 'all-for-compare'],
    queryFn: async () =>
      (await api.get('/traffic-map/snapshots', { params: { kind: 'all', limit: 100 } })).data
        .data as ListRow[],
    enabled: open,
    staleTime: 30_000,
    retry: false
  })
  const rows = useMemo(() => (Array.isArray(list.data) ? list.data : []), [list.data])
  // Start on the two newest snapshots (A the older, B the newer) once they load.
  useEffect(() => {
    if (!a && !b && rows.length >= 2) {
      setB(rows[0].id)
      setA(rows[1].id)
    }
  }, [rows, a, b])

  const diff = useQuery({
    queryKey: ['traffic-map', 'snapshot-compare', a, b],
    queryFn: async () =>
      (await api.get('/traffic-map/snapshots/compare', { params: { a, b } })).data.data as Diff,
    enabled: !!a && !!b && a !== b,
    staleTime: Number.POSITIVE_INFINITY, // stored snapshots never change
    retry: false
  })
  const options = rows.map((r) => ({ value: r.id, label: label(r) }))
  const weekAgo = () => {
    const cur = rows.find((r) => r.id === b)
    if (!cur) return
    const hit = nearestTo(rows, new Date(cur.created_at).getTime() - WEEK_MS, 36 * 3_600_000, b)
    if (hit) setA(hit.id)
  }
  const canWeek = (() => {
    const cur = rows.find((r) => r.id === b)
    return (
      !!cur && !!nearestTo(rows, new Date(cur.created_at).getTime() - WEEK_MS, 36 * 3_600_000, b)
    )
  })()
  const d = diff.data

  return (
    <PanelCard
      id='tm-snapshot-compare'
      title='Compare snapshots'
      hint='Two saved snapshots, node by node and edge by edge. Figures are per minute.'
    >
      {!open ? (
        <div className='px-3.5 py-3'>
          <button type='button' className={BTN} onClick={() => setOpen(true)} id='tm-cmp-open'>
            Choose two snapshots
          </button>
        </div>
      ) : list.isError ? (
        <p className='px-3.5 py-3 text-[12px] text-[var(--tm-muted)]'>
          Snapshots are not available here.
        </p>
      ) : rows.length < 2 ? (
        <p className='px-3.5 py-3 text-[12px] text-[var(--tm-muted)]'>
          {list.isLoading
            ? 'Loading…'
            : 'Needs two snapshots. Share a view, or let the map take its daily peak snapshot.'}
        </p>
      ) : (
        <div>
          <div className='flex flex-wrap items-center gap-2 border-b border-[var(--tm-line-2)] px-3.5 py-2'>
            <label className='sr-only' htmlFor='tm-cmp-a'>
              Snapshot A
            </label>
            <SimpleSelect
              value={a}
              onChange={setA}
              options={options}
              ariaLabel='Snapshot A'
              triggerProps={{ id: 'tm-cmp-a' }}
              className='h-7 min-w-0 max-w-[250px] flex-1 border-[var(--tm-line)] bg-[var(--tm-card)] px-2.5 text-[12px] text-[var(--tm-fg-2)]'
            />
            <span className='text-[12px] text-[var(--tm-muted)]'>against</span>
            <label className='sr-only' htmlFor='tm-cmp-b'>
              Snapshot B
            </label>
            <SimpleSelect
              value={b}
              onChange={setB}
              options={options}
              ariaLabel='Snapshot B'
              triggerProps={{ id: 'tm-cmp-b' }}
              className='h-7 min-w-0 max-w-[250px] flex-1 border-[var(--tm-line)] bg-[var(--tm-card)] px-2.5 text-[12px] text-[var(--tm-fg-2)]'
            />
            <button
              type='button'
              className={BTN}
              disabled={!canWeek}
              onClick={weekAgo}
              data-tip='Set A to the snapshot closest to a week before B'
            >
              A a week earlier
            </button>
          </div>
          {a === b ? (
            <p className='px-3.5 py-3 text-[12px] text-[var(--tm-muted)]'>
              Pick two different snapshots.
            </p>
          ) : diff.isError ? (
            <p className='px-3.5 py-3 text-[12px] text-[var(--tm-error-ink)]'>
              The comparison could not be read.
            </p>
          ) : !d ? (
            <p className='px-3.5 py-3 text-[12px] text-[var(--tm-muted)]'>Comparing…</p>
          ) : (
            <div data-tm-snapshot-diff=''>
              <div className='grid gap-px bg-[var(--tm-line-2)] min-[700px]:grid-cols-2'>
                <SideCard s={d.a} tag='A' />
                <SideCard s={d.b} tag='B' />
              </div>
              <div className='mx-3.5 mt-2'>
                <Segmented
                  label='Compare by'
                  value={view}
                  options={[
                    ['nodes', 'Nodes'],
                    ['edges', 'Edges']
                  ]}
                  onChange={setView}
                />
              </div>
              <div className='mt-1.5 max-h-[320px] overflow-auto'>
                {view === 'nodes' ? (
                  <table className='w-full border-collapse text-[12px] tabular-nums'>
                    <thead className='sticky top-0'>
                      <tr className='border-b border-[var(--tm-line-2)] bg-[var(--tm-card-2)] text-left'>
                        <th scope='col' className={TH}>
                          Node
                        </th>
                        <th scope='col' className={`${TH} text-right`}>
                          A /min
                        </th>
                        <th scope='col' className={`${TH} text-right`}>
                          B /min
                        </th>
                        <th scope='col' className={`${TH} text-right`}>
                          Change
                        </th>
                        <th scope='col' className={`${TH} text-right`}>
                          Errors
                        </th>
                        <th scope='col' className={`${TH} text-right`}>
                          p95
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.nodes.map((n) => (
                        <tr
                          key={`${n.kind}:${n.key}`}
                          className='border-b border-[var(--tm-line-2)] last:border-0'
                          data-tm-diff-node={n.key}
                        >
                          <td className={cn(TD, 'max-w-[240px] truncate')} data-tip={n.key}>
                            {n.label}
                            {n.only === 'a' && <Only>only in A</Only>}
                            {n.only === 'b' && <Only>only in B</Only>}
                          </td>
                          <td className={`${TD} text-right`}>{fmtRate(n.a.rpm)}</td>
                          <td className={`${TD} text-right`}>{fmtRate(n.b.rpm)}</td>
                          <td className={`${TD} text-right`}>
                            <Delta value={n.delta_rpm} pct={n.delta_pct} />
                          </td>
                          <td className={`${TD} text-right`}>
                            {n.delta_error_pts === 0 ? (
                              <span className='text-[var(--tm-muted)]'>no change</span>
                            ) : (
                              <span
                                className={
                                  n.delta_error_pts > 0
                                    ? 'font-medium text-[var(--tm-error-ink)]'
                                    : 'text-[var(--tm-fg-2)]'
                                }
                              >
                                {n.delta_error_pts > 0 ? '+' : '−'}
                                {Math.abs(n.delta_error_pts)} pts
                              </span>
                            )}
                          </td>
                          <td className={`${TD} text-right text-[var(--tm-fg-2)]`}>
                            {n.a.p95 || n.b.p95 ? `${fmtMs(n.a.p95)} → ${fmtMs(n.b.p95)}` : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <table className='w-full border-collapse text-[12px] tabular-nums'>
                    <thead className='sticky top-0'>
                      <tr className='border-b border-[var(--tm-line-2)] bg-[var(--tm-card-2)] text-left'>
                        <th scope='col' className={TH}>
                          Edge
                        </th>
                        <th scope='col' className={`${TH} text-right`}>
                          A /min
                        </th>
                        <th scope='col' className={`${TH} text-right`}>
                          B /min
                        </th>
                        <th scope='col' className={`${TH} text-right`}>
                          Change
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.edges.map((e) => (
                        <tr
                          key={e.key}
                          className='border-b border-[var(--tm-line-2)] last:border-0'
                          data-tm-diff-edge={e.key}
                        >
                          <td className={cn(TD, 'max-w-[300px] truncate')} data-tip={e.label}>
                            {e.label}
                            {e.only === 'a' && <Only>only in A</Only>}
                            {e.only === 'b' && <Only>only in B</Only>}
                          </td>
                          <td className={`${TD} text-right`}>{fmtRate(e.a_rpm)}</td>
                          <td className={`${TD} text-right`}>{fmtRate(e.b_rpm)}</td>
                          <td className={`${TD} text-right`}>
                            <Delta value={e.delta_rpm} pct={e.delta_pct} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
              <p className='px-3.5 py-2 text-[11.5px] text-[var(--tm-muted)]'>
                Edges cover each node's busiest callers and downstream nodes, as the snapshot kept
                them.{d.truncated ? ' Only the biggest changes are shown.' : ''}
              </p>
            </div>
          )}
        </div>
      )}
    </PanelCard>
  )
}

register(pagePanels, {
  id: 'snapshot-compare',
  order: 60,
  Component: inMapOnly(SnapshotComparePanel)
})
