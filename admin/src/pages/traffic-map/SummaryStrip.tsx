import type { ReactNode } from 'react'
import { fmtCount, fmtRate } from './EventTicker'
import { Sparkline } from './Sparkline'

export interface StripData {
  /** Requests per second over the window (null = no data yet). */
  rps: number
  series: number[]
  /** p95 / p50 in ms; 0 = no figure. */
  p95: number
  p50: number
  req: number
  errN: number
  lastError: string | null
  writesPerMin: number
  writesMix: { create: number; update: number; delete: number }
  outboundPerMin: number
  outboundErr: number
  partners: string[]
  sockets: number
  users: number
  peak: number
}

function Tile({
  label,
  value,
  unit,
  bad,
  testId,
  children
}: {
  label: string
  value: string
  unit?: string
  bad?: boolean
  testId: string
  children: ReactNode
}) {
  return (
    <div className='min-w-0 bg-[var(--tm-card)] px-3.5 pb-2.5 pt-2.5'>
      <div className='text-[12px] font-medium text-[var(--tm-muted)]'>{label}</div>
      <div
        className={`mt-0.5 flex items-baseline gap-1.5 text-[22px] font-semibold leading-tight tracking-tight tabular-nums ${
          bad ? 'text-[var(--tm-error-ink)]' : ''
        }`}
      >
        <span data-testid={testId}>{value}</span>
        {unit && value !== '—' && (
          <small className='text-[11.5px] font-medium tracking-normal text-[var(--tm-muted)]'>
            {unit}
          </small>
        )}
      </div>
      <div className='mt-1 flex min-w-0 items-center gap-2 text-[11.5px] text-[var(--tm-muted)]'>
        {children}
      </div>
    </div>
  )
}

function SkeletonTile() {
  return (
    <div className='min-w-0 bg-[var(--tm-card)] px-3.5 py-2.5' aria-hidden='true'>
      <div className='h-3 w-20 animate-pulse rounded bg-[var(--tm-skeleton)] motion-reduce:animate-none' />
      <div className='mt-2 h-6 w-16 animate-pulse rounded bg-[var(--tm-skeleton)] motion-reduce:animate-none' />
      <div className='mt-2 h-3 w-28 animate-pulse rounded bg-[var(--tm-skeleton)] motion-reduce:animate-none' />
    </div>
  )
}

const STRIP_CLS =
  'grid grid-cols-2 gap-px md:grid-cols-3 min-[1280px]:grid-cols-6 overflow-hidden rounded-lg border border-[var(--tm-line)] bg-[var(--tm-line)]'

export function SummaryStrip({ d }: { d: StripData | null }) {
  if (!d)
    return (
      <section aria-label='Summary' aria-busy='true' className={STRIP_CLS} id='tm-strip'>
        {Array.from({ length: 6 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder tiles
          <SkeletonTile key={i} />
        ))}
      </section>
    )
  const errPct = d.req > 0 ? (100 * d.errN) / d.req : Number.NaN
  const p95Unit = d.p95 >= 1000 ? 's' : 'ms'
  const p95 =
    d.p95 > 0 ? (d.p95 >= 1000 ? (d.p95 / 1000).toFixed(1) : String(Math.round(d.p95))) : '—'
  const partners = d.partners.length ? d.partners.join(', ') : 'none in window'
  return (
    <section aria-label='Summary' className={STRIP_CLS} id='tm-strip'>
      <Tile label='Requests' value={fmtRate(d.rps)} unit='/s' testId='tm-strip-rps'>
        <Sparkline data={d.series} className='h-[18px] min-w-0 flex-1' />
      </Tile>
      <Tile label='p95 latency' value={p95} unit={p95Unit} testId='tm-strip-p95'>
        <span className='truncate tabular-nums'>
          p50 {d.p50 > 0 ? `${Math.round(d.p50).toLocaleString()} ms` : '—'}
        </span>
      </Tile>
      <Tile
        label='Error rate'
        value={Number.isFinite(errPct) ? errPct.toFixed(1) : '—'}
        unit='%'
        bad={errPct >= 3}
        testId='tm-strip-err'
      >
        <span className='truncate tabular-nums'>
          {fmtCount(d.errN)} in window
          {d.lastError ? (
            <>
              {' · '}
              <span className='font-mono text-[11px]'>{d.lastError}</span>
            </>
          ) : null}
        </span>
      </Tile>
      <Tile label='Writes' value={fmtRate(d.writesPerMin)} unit='/min' testId='tm-strip-writes'>
        <span className='truncate tabular-nums'>
          {fmtCount(d.writesMix.create)} created · {fmtCount(d.writesMix.update)} updated ·{' '}
          {fmtCount(d.writesMix.delete)} deleted
        </span>
      </Tile>
      <Tile
        label='Partner calls'
        value={fmtRate(d.outboundPerMin)}
        unit='/min'
        testId='tm-strip-out'
      >
        <span className='truncate tabular-nums'>
          {d.outboundErr ? (
            <span className='text-[var(--tm-error-ink)]'>{fmtCount(d.outboundErr)} failed</span>
          ) : (
            'all landed'
          )}{' '}
          · {partners}
        </span>
      </Tile>
      <Tile label='Sockets' value={fmtCount(d.sockets)} testId='tm-strip-sockets'>
        <span className='truncate tabular-nums'>
          {fmtCount(d.users)} {Math.round(d.users) === 1 ? 'person' : 'people'} · peak{' '}
          {fmtCount(d.peak)}
        </span>
      </Tile>
    </section>
  )
}
