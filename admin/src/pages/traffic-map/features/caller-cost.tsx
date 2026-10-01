import { fmtCount, fmtMs } from '../EventTicker'
import { Empty, Section } from '../Inspector'
import { inspectorPanels } from '../registry/inspectorPanels'
import { register } from '../registry/registry'
import { isObj, useTmRoute } from './ops-common'

/**
 * Cost per caller (#1122): per key or person, per hour — requests, database time (summed
 * statement time), rows the database returned, and AI spend. In-memory hours of this process;
 * AI spend comes from the AI call log.
 */

interface HourCost {
  hour: string
  req: number
  error: number
  ms: number
  db_ms: number
  queries: number
  rows: number
  ai_usd: number
  ai_calls: number
}
interface CostReport {
  key: string
  hours: HourCost[]
  totals: Omit<HourCost, 'hour'>
  ai_note: string | null
  since_process_start: string
}

export function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0'
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`
}
function fmtDb(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0 ms'
  return ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : fmtMs(ms)
}

const TH_BASE = 'whitespace-nowrap px-1.5 py-1 text-[11px] font-medium text-[var(--tm-muted)]'
const TH = `${TH_BASE} text-right`
const TD = 'whitespace-nowrap px-1.5 py-1 text-right'

export function CallerCostSection({ callerKey }: { callerKey: string }) {
  const { data, loading, error } = useTmRoute<CostReport>(
    ['caller-cost', callerKey],
    `/caller-cost?key=${encodeURIComponent(callerKey)}`,
    30_000
  )
  const r = isObj(data) && Array.isArray(data.hours) && isObj(data.totals) ? data : null
  const since = r ? new Date(r.since_process_start) : null
  return (
    <Section title='Cost per hour'>
      {!r ? (
        <Empty>
          {error ? 'Could not be read right now.' : loading ? 'Loading…' : 'Nothing yet.'}
        </Empty>
      ) : (
        <div className='grid gap-2 text-[12px]' data-tm-caller-cost={callerKey}>
          <div className='grid grid-cols-3 gap-2 tabular-nums'>
            <div>
              <div className='text-[11px] text-[var(--tm-muted)]'>Database time</div>
              <div className='font-semibold' data-testid='tm-cost-db'>
                {fmtDb(r.totals.db_ms)}
              </div>
            </div>
            <div>
              <div className='text-[11px] text-[var(--tm-muted)]'>Rows read</div>
              <div className='font-semibold'>{fmtCount(r.totals.rows)}</div>
            </div>
            <div>
              <div className='text-[11px] text-[var(--tm-muted)]'>AI spend</div>
              <div className='font-semibold' data-testid='tm-cost-ai'>
                {r.ai_note && callerKey.startsWith('k') ? '—' : fmtUsd(r.totals.ai_usd)}
              </div>
            </div>
          </div>
          {r.hours.length ? (
            <div className='max-h-[220px] overflow-auto'>
              <table className='w-full border-collapse tabular-nums'>
                <thead>
                  <tr className='border-b border-[var(--tm-line-2)]'>
                    <th scope='col' className={`${TH_BASE} text-left`}>
                      Hour
                    </th>
                    <th scope='col' className={TH}>
                      Calls
                    </th>
                    <th scope='col' className={TH}>
                      DB
                    </th>
                    <th scope='col' className={TH}>
                      Rows
                    </th>
                    <th scope='col' className={TH}>
                      AI
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {r.hours.map((h) => (
                    <tr key={h.hour} className='border-b border-[var(--tm-line-2)] last:border-0'>
                      <td className='whitespace-nowrap px-1.5 py-1 text-left text-[var(--tm-fg-2)]'>
                        {new Date(h.hour).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit'
                        })}
                      </td>
                      <td className={TD}>
                        {fmtCount(h.req)}
                        {h.error ? (
                          <span className='text-[var(--tm-error-ink)]'> · {h.error} err</span>
                        ) : null}
                      </td>
                      <td className={TD} title={`${fmtCount(h.queries)} round trips`}>
                        {fmtDb(h.db_ms)}
                      </td>
                      <td className={TD}>{fmtCount(h.rows)}</td>
                      <td className={TD} title={h.ai_calls ? `${h.ai_calls} AI calls` : undefined}>
                        {h.ai_calls ? fmtUsd(h.ai_usd) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>No calls in the last 24 hours on this node.</Empty>
          )}
          <p className='text-[11px] text-[var(--tm-muted)]'>
            Database time and rows since this node started
            {since && !Number.isNaN(since.getTime())
              ? ` (${since.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })})`
              : ''}
            .{r.ai_note ? ` ${r.ai_note}` : ''}
          </p>
        </div>
      )}
    </Section>
  )
}

const CALLER_RE = /^(k\d+|u[0-9A-F-]{36})$/

register(inspectorPanels, {
  id: 'caller-cost',
  order: 30,
  applies: (sel) => sel.kind === 'caller' && CALLER_RE.test(sel.id),
  Component: ({ sel }) => <CallerCostSection callerKey={sel.id} />
})
