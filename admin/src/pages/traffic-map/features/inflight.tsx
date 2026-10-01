import { useState } from 'react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useTrafficMap } from '../context'
import { callerLabel } from '../EventTicker'
import { pagePanels } from '../registry/pagePanels'
import { register } from '../registry/registry'
import {
  apiError,
  BTN,
  INPUT,
  inMapOnly,
  isObj,
  PanelCard,
  TwoClickButton,
  useTmRoute
} from './ops-common'

/**
 * In-flight requests (#1147): requests this node has not finished, oldest first — age, route,
 * caller and the SQL they are running. Cancel (#1156) kills the database session running that
 * statement: a reason, then two clicks; logged as activity.
 */

interface InflightRow {
  id: string
  method: string
  route: string
  caller: string
  started_at: number
  age_ms: number
  queries: number
  sql_ms: number
  rows: number
  running: Array<{ sql: string; age_ms: number }>
}
interface InflightList {
  rows: InflightRow[]
  total: number
  at: string
}

/** Older than this reads as long-running. */
const SLOW_MS = 5000

export function fmtAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`
}

function KillSql({ row, onDone }: { row: InflightRow; onDone: () => void }) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const run = async () => {
    setBusy(true)
    try {
      const res = await api.post(`/traffic-map/inflight/${row.id}/kill-sql`, { reason })
      const d = res?.data?.data as { killed?: number } | undefined
      toast.success(`Database session ${d?.killed ?? ''} ended — the request will fail`)
      onDone()
    } catch (e) {
      toast.error(apiError(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className='flex flex-wrap items-center gap-1.5 pt-1.5' data-tm-kill={row.id}>
      <label className='sr-only' htmlFor={`tm-kill-reason-${row.id}`}>
        Reason
      </label>
      <input
        id={`tm-kill-reason-${row.id}`}
        className={cn(INPUT, 'min-w-[180px] flex-1')}
        placeholder='Why end it (kept in the activity log)'
        value={reason}
        maxLength={300}
        onChange={(e) => setReason(e.target.value)}
      />
      <TwoClickButton
        id={`tm-kill-${row.id}`}
        label='End its SQL'
        armedLabel='Click again to KILL the session'
        disabled={busy || !reason.trim()}
        onConfirm={() => void run()}
      />
    </div>
  )
}

export function InflightPanel() {
  const { catalog } = useTrafficMap()
  const { data, refetch } = useTmRoute<InflightList>(['inflight'], '/inflight', 2000)
  const [open, setOpen] = useState<string | null>(null)
  const list = isObj(data) && Array.isArray(data.rows) ? data : null
  return (
    <PanelCard
      title='In flight'
      id='tm-inflight'
      hint='Requests this node has not finished · oldest first, with the SQL they are running'
      actions={
        list && list.total > list.rows.length ? (
          <span className='text-[11.5px] text-[var(--tm-muted)]'>
            {list.rows.length} of {list.total}
          </span>
        ) : null
      }
    >
      {!list ? (
        <p className='px-3.5 py-3 text-[12px] text-[var(--tm-muted)]'>Loading…</p>
      ) : list.rows.length === 0 ? (
        <p className='px-3.5 py-3 text-[12px] text-[var(--tm-muted)]' id='tm-inflight-empty'>
          Nothing in flight — every request on this node has answered.
        </p>
      ) : (
        <ul className='max-h-[340px] divide-y divide-[var(--tm-line-2)] overflow-auto'>
          {list.rows.map((r) => {
            const slow = r.age_ms >= SLOW_MS
            const sql = r.running[0]
            const isOpen = open === r.id
            return (
              <li key={r.id} className='px-3.5 py-2 text-[12px]' data-tm-inflight={r.id}>
                <div className='flex min-w-0 items-baseline gap-2'>
                  <span
                    className={cn(
                      'w-[64px] shrink-0 tabular-nums',
                      slow ? 'font-semibold text-[var(--tm-update)]' : 'text-[var(--tm-fg-2)]'
                    )}
                  >
                    {fmtAge(r.age_ms)}
                  </span>
                  <span className='min-w-0 flex-1 truncate font-mono text-[11px]' title={r.route}>
                    {r.method} {r.route}
                  </span>
                  <span className='max-w-[30%] shrink-0 truncate text-[var(--tm-muted)]'>
                    {callerLabel(catalog, r.caller)}
                  </span>
                </div>
                <div className='mt-0.5 flex min-w-0 items-baseline gap-2 pl-[72px] text-[11.5px] text-[var(--tm-muted)]'>
                  <span className='min-w-0 flex-1 truncate tabular-nums'>
                    {sql ? (
                      <>
                        Running SQL {fmtAge(sql.age_ms)} ·{' '}
                        <span className='font-mono text-[11px]' title={sql.sql}>
                          {sql.sql}
                        </span>
                      </>
                    ) : (
                      `In the handler · ${r.queries} statements so far, ${fmtAge(r.sql_ms)} in SQL`
                    )}
                  </span>
                  {sql && (
                    <button
                      type='button'
                      className={cn(BTN, 'shrink-0')}
                      aria-expanded={isOpen}
                      onClick={() => setOpen(isOpen ? null : r.id)}
                    >
                      {isOpen ? 'Keep it' : 'Cancel…'}
                    </button>
                  )}
                </div>
                {isOpen && sql && (
                  <div className='pl-[72px]'>
                    <p className='pt-1 text-[11.5px] text-[var(--tm-fg-2)]'>
                      Ends the database session running this statement. The request fails, and any
                      open transaction on that session rolls back.
                    </p>
                    <KillSql
                      row={r}
                      onDone={() => {
                        setOpen(null)
                        refetch()
                      }}
                    />
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </PanelCard>
  )
}

register(pagePanels, { id: 'ops-inflight', order: 10, Component: inMapOnly(InflightPanel) })
