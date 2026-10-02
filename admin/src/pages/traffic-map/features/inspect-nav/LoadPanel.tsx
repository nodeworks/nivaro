/**
 * Page load (#1205): every call one page load made, as a waterfall — bars placed by start offset,
 * sized by duration — with the total, the slowest call, repeated routes and the page's real-user
 * timings beside it. Each bar opens its request.
 */
import { inspectErrorOf, useInspectDetail } from '../../inspect/api'
import { fmtClock } from '../../inspect/format'
import { InspectLink } from '../../inspect/InspectLink'
import type { InspectPanelProps } from '../../registry/inspectables'
import type { LoadDetail } from './api'
import { barGeometry, fmtDur } from './logic'
import { Fact, PanelSkeleton, Section } from './parts'

export function LoadPanel({ inspectRef, anchor, windowSec }: InspectPanelProps) {
  const q = useInspectDetail<LoadDetail>(inspectRef, anchor, windowSec)
  if (q.isLoading) return <PanelSkeleton />
  if (q.isError) {
    const e = inspectErrorOf(q.error)
    return (
      <p className='text-[12.5px] text-[var(--tm-muted)]' data-tm-inspect-load-missing=''>
        {e.status === 404
          ? 'This page load is no longer kept. The API keeps the calls of the newest 200 page loads in memory, on the API process that served them, and forgets them on restart — page load ids are not written to the API log.'
          : `Could not read this page load: ${e.message}`}
      </p>
    )
  }
  const d = q.data
  if (!d) return null
  const w = d.waterfall
  const rum = d.rum
  return (
    <div className='grid gap-3' data-tm-inspect-load={d.load}>
      <div>
        <p
          className='font-mono text-[12.5px] font-semibold text-[var(--tm-fg)]'
          data-tip={d.screen}
        >
          {d.page}
        </p>
        <p className='text-[11.5px] text-[var(--tm-muted)]'>
          {d.app ? `${d.app} · ` : ''}page load started {fmtClock(d.started_at)} by{' '}
          <InspectLink
            inspectRef={{ kind: 'caller', id: d.caller, label: d.user_name ?? d.caller_label }}
          >
            {d.user_name ?? d.caller_label}
          </InspectLink>
        </p>
      </div>

      <dl className='grid grid-cols-2 gap-px overflow-hidden rounded-md border border-[var(--tm-line)] bg-[var(--tm-line)] sm:grid-cols-4'>
        <Fact label='Calls' value={d.calls.toLocaleString()} hook='calls' />
        <Fact label='Total' value={fmtDur(w.total_ms)} hook='total' />
        <Fact
          label='Errors'
          value={String(w.errors)}
          hook='errors'
          tone={w.errors ? 'error' : undefined}
        />
        <Fact
          label='Slowest'
          hook='slowest'
          value={
            w.slowest ? (
              w.slowest.rid ? (
                <InspectLink
                  inspectRef={{
                    kind: 'request',
                    id: w.slowest.rid,
                    label: w.slowest.route,
                    at: w.slowest.start
                  }}
                >
                  {fmtDur(w.slowest.ms)}
                </InspectLink>
              ) : (
                fmtDur(w.slowest.ms)
              )
            ) : (
              '—'
            )
          }
        />
      </dl>

      <Section title='Real users on this page' hook='rum'>
        {rum ? (
          <p className='text-[12px] text-[var(--tm-fg-2)]' data-tm-inspect-load-rum=''>
            75th percentile over {rum.samples.toLocaleString()} samples (7 days): first paint{' '}
            {fmtDur(rum.fcp_p75)} · largest paint {fmtDur(rum.lcp_p75)} · server first byte{' '}
            {fmtDur(rum.ttfb_p75)} · in-app navigation {fmtDur(rum.nav_p75)}
          </p>
        ) : (
          <p className='text-[12px] text-[var(--tm-muted)]' data-tm-inspect-load-rum='none'>
            No real-user timings for this page in the last 7 days (browsers report them on full
            loads and navigations of the admin app only).
          </p>
        )}
      </Section>

      <Section title={`Calls (${w.rows.length})`} hook='waterfall'>
        {w.rows.length === 0 ? (
          <p className='text-[12px] text-[var(--tm-muted)]'>No calls kept for this load.</p>
        ) : (
          <ol className='grid gap-0.5' data-tm-inspect-waterfall=''>
            {w.rows.map((r, i) => {
              const g = barGeometry(r.offset_ms, r.ms, w.total_ms)
              const err = r.status >= 400
              const tip = `${r.route} · ${r.status} · starts +${fmtDur(r.offset_ms)} · ${fmtDur(r.ms)}`
              return (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: calls repeat routes and may lack ids
                  key={`${r.rid ?? 'x'}:${i}`}
                  className='grid grid-cols-[minmax(0,42%)_minmax(0,1fr)_56px] items-center gap-2 text-[11.5px]'
                  data-tm-inspect-waterfall-row={r.rid ?? ''}
                >
                  <span className='min-w-0 truncate font-mono'>
                    {r.rid ? (
                      <InspectLink
                        inspectRef={{ kind: 'request', id: r.rid, label: r.route, at: r.start }}
                      >
                        {r.route}
                      </InspectLink>
                    ) : (
                      <span
                        className='text-[var(--tm-fg-2)]'
                        data-tip='This call carries no request id, so it cannot be opened'
                      >
                        {r.route}
                      </span>
                    )}
                  </span>
                  <span className='relative h-3 rounded-sm bg-[var(--tm-card-2)]' data-tip={tip}>
                    <span
                      className='absolute inset-y-0 rounded-sm'
                      style={{
                        left: `${g.left}%`,
                        width: `${g.width}%`,
                        background: err ? 'var(--tm-error)' : 'var(--tm-read)'
                      }}
                      data-tm-inspect-waterfall-bar={err ? 'error' : 'ok'}
                    />
                  </span>
                  <span
                    className={`text-right tabular-nums ${err ? 'text-[var(--tm-error-ink)]' : 'text-[var(--tm-fg-2)]'}`}
                  >
                    {fmtDur(r.ms)}
                  </span>
                </li>
              )
            })}
          </ol>
        )}
        {d.dropped > 0 && (
          <p className='mt-1 text-[11.5px] text-[var(--tm-muted)]' data-tm-inspect-load-dropped=''>
            {d.dropped} later calls are counted but not kept (the first 300 calls of a load are).
          </p>
        )}
      </Section>

      {w.duplicates.length > 0 && (
        <Section title='Called more than once' hook='duplicates'>
          <ul className='grid gap-0.5 text-[12px]' data-tm-inspect-load-duplicates=''>
            {w.duplicates.map((x) => (
              <li key={x.route} className='flex items-baseline justify-between gap-2'>
                <span className='min-w-0 truncate font-mono text-[11.5px]'>{x.route}</span>
                <span className='shrink-0 tabular-nums text-[var(--tm-fg-2)]'>×{x.n}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <p className='text-[11px] text-[var(--tm-muted)]'>
        Held in memory by API process {d.node} ({d.instance}); page load ids are not written to the
        API log.
      </p>
    </div>
  )
}
