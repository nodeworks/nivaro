import { entityLabel, fmtCount, fmtMs, fmtPct, fmtRate } from './EventTicker'
import { Sparkline } from './Sparkline'
import type { Lane, TrafficCatalog } from './types'
import { LANE_LABEL } from './types'

export interface HotRow {
  key: string
  lane: Lane
  entity: string
  rps: number
  wpm: number
  p95: number
  errPct: number
  series: number[]
}

export function hotRowId(key: string): string {
  return `tm-hot-${key.replace(/[^a-zA-Z0-9_-]/g, '_')}`
}

const TH = 'whitespace-nowrap px-2.5 py-1.5 text-[11.5px] font-medium text-[var(--tm-muted)]'

export function HotEntities({
  rows,
  catalog,
  selectedKey,
  onSelect,
  loading
}: {
  rows: HotRow[]
  catalog: TrafficCatalog | null
  selectedKey: string | null
  onSelect: (key: string) => void
  loading: boolean
}) {
  return (
    <section
      className='min-w-0 rounded-lg border border-[var(--tm-line)] bg-[var(--tm-card)]'
      aria-label='Hot entities'
      id='tm-hot'
    >
      <div className='border-b border-[var(--tm-line-2)] px-3.5 py-2'>
        <h2 className='text-[13px] font-semibold'>Hot entities</h2>
        <p className='text-[11.5px] text-[var(--tm-muted)]'>
          Ranked by requests in the window · select a row to inspect it
        </p>
      </div>
      <div className='overflow-x-auto'>
        <table className='w-full border-collapse text-[12px] tabular-nums'>
          <thead>
            <tr className='border-b border-[var(--tm-line-2)] bg-[var(--tm-card-2)] text-left'>
              <th scope='col' className={TH}>
                Entity
              </th>
              <th scope='col' className={`${TH} text-right`}>
                Requests/s
              </th>
              <th scope='col' className={`${TH} text-right`}>
                Writes/min
              </th>
              <th scope='col' className={`${TH} text-right`}>
                p95
              </th>
              <th scope='col' className={`${TH} text-right`}>
                Errors
              </th>
              <th scope='col' className={TH}>
                Last 60 s
              </th>
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0
              ? Array.from({ length: 6 }, (_, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
                  <tr key={i} className='border-b border-[var(--tm-line-2)]'>
                    <td colSpan={6} className='px-2.5 py-2'>
                      <div
                        aria-hidden='true'
                        className='h-3.5 animate-pulse rounded bg-[var(--tm-skeleton)] motion-reduce:animate-none'
                      />
                    </td>
                  </tr>
                ))
              : null}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={6} className='px-3.5 py-3 text-[12px] text-[var(--tm-muted)]'>
                  No traffic in this window for the selected types and kinds.
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const sel = r.key === selectedKey
              const hotErr = r.errPct >= 3
              return (
                <tr
                  key={r.key}
                  id={hotRowId(r.key)}
                  data-testid='tm-hot-row'
                  data-tm-hot={r.key}
                  tabIndex={0}
                  aria-selected={sel}
                  onClick={() => onSelect(r.key)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onSelect(r.key)
                    }
                  }}
                  className={`cursor-pointer border-b border-[var(--tm-line-2)] outline-none transition-colors duration-150 ease-out last:border-0 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan ${
                    sel ? 'bg-[var(--tm-accent-soft)]' : 'hover:bg-[var(--tm-card-2)]'
                  }`}
                >
                  <td className='max-w-[260px] truncate whitespace-nowrap px-2.5 py-1.5'>
                    <span
                      className={`font-mono text-[11px] font-medium ${
                        sel ? 'text-[var(--tm-accent-ink)]' : ''
                      }`}
                    >
                      {entityLabel(catalog, r.lane, r.entity)}
                    </span>
                    <span
                      className={`ml-1.5 text-[11px] ${sel ? 'text-[var(--tm-fg-2)]' : 'text-[var(--tm-muted)]'}`}
                    >
                      {LANE_LABEL[r.lane] ?? r.lane}
                    </span>
                  </td>
                  <td className='px-2.5 py-1.5 text-right'>{fmtRate(r.rps)}</td>
                  <td className='px-2.5 py-1.5 text-right'>{fmtCount(r.wpm)}</td>
                  <td className='whitespace-nowrap px-2.5 py-1.5 text-right'>{fmtMs(r.p95)}</td>
                  <td
                    className={`px-2.5 py-1.5 text-right ${
                      hotErr ? 'font-semibold text-[var(--tm-error-ink)]' : ''
                    }`}
                  >
                    {fmtPct(r.errPct)}
                  </td>
                  <td className='px-2.5 py-1.5'>
                    <Sparkline
                      data={r.series}
                      color={hotErr ? 'var(--tm-error)' : 'var(--tm-accent)'}
                      className='block h-5 w-[84px]'
                    />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}
