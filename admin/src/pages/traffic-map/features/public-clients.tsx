import { fmtCount } from '../EventTicker'
import { t } from '../Inspector'
import { pagePanels } from '../registry/pagePanels'
import { register } from '../registry/registry'
import { inPage, TAG, useLens } from './b1-shared'

/**
 * #1152 — unknown clients on public routes (share pages, public forms, widget feeds, public
 * dashboard links): requests with no or an unrecognised user agent (scripts, scrapers, headless
 * browsers) and IPs seen for the first time since this API process started. IPs are masked.
 */
export const PUBLIC_CLIENTS_TAP = 'public-clients'

export interface PublicHit {
  at: string
  route: string
  status: number
  ip: string
  client: string
  unknown_client: boolean
  new_ip: boolean
}
interface PublicLens {
  routes: Array<{ route: string; n: number; unknown: number; new_ips: number }>
  recent: PublicHit[]
}

function PublicClientsPanel() {
  const { data, loading } = useLens<PublicLens>(PUBLIC_CLIENTS_TAP)
  const routes = data?.routes ?? []
  const recent = data?.recent ?? []
  return (
    <section
      className='min-w-0 rounded-lg border border-[var(--tm-line)] bg-[var(--tm-card)]'
      aria-label='Public routes'
      id='tm-public'
    >
      <div className='border-b border-[var(--tm-line-2)] px-3.5 py-2'>
        <h2 className='text-[13px] font-semibold'>Public routes</h2>
        <p className='text-[11.5px] text-[var(--tm-muted)]'>
          Share pages, public forms and widget feeds · unknown clients and first-seen IPs (masked)
        </p>
      </div>
      {routes.length ? (
        <div className='flex flex-wrap gap-1.5 border-b border-[var(--tm-line-2)] px-3.5 py-2'>
          {routes.map((r) => (
            <span key={r.route} className={TAG} data-tm-public-route={r.route}>
              <span className='font-mono'>{r.route}</span>
              <span className='tabular-nums text-[var(--tm-fg)]'>{fmtCount(r.n)}</span>
              {r.unknown ? (
                <span className='tabular-nums text-[var(--tm-update)]'>
                  {fmtCount(r.unknown)} unknown
                </span>
              ) : null}
            </span>
          ))}
        </div>
      ) : null}
      {recent.length === 0 ? (
        <p className='px-3.5 py-3 text-[12px] text-[var(--tm-muted)]'>
          {loading ? 'Loading…' : 'No unknown clients or new IPs on public routes in this window.'}
        </p>
      ) : (
        <div className='grid'>
          {recent.slice(0, 10).map((h, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: hits can share a timestamp
              key={`${h.at}-${i}`}
              className='grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-2 border-b border-[var(--tm-line-2)] px-3.5 py-1.5 text-[12px] last:border-0'
              data-tm-public-hit=''
            >
              <span className='font-mono text-[10.5px] tabular-nums text-[var(--tm-muted)]'>
                {t(h.at)}
              </span>
              <span className='min-w-0 truncate' title={h.route}>
                <span className='font-mono text-[11px]'>{h.ip}</span>
                <span className='text-[var(--tm-fg-2)]'> · {h.client}</span>
                <span className='text-[var(--tm-muted)]'> · {h.route}</span>
              </span>
              <span className='flex gap-1'>
                {h.unknown_client ? <span className={TAG}>unknown client</span> : null}
                {h.new_ip ? <span className={TAG}>new IP</span> : null}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

register(pagePanels, { id: 'public-clients', order: 30, Component: inPage(PublicClientsPanel) })
