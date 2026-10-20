import { useQuery } from '@tanstack/react-query'
import { DatabaseZap } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useTrafficMap } from '../context'
import { fmtCount } from '../EventTicker'
import { pagePanels } from '../registry/pagePanels'
import { register } from '../registry/registry'
import { toolbarItems } from '../registry/toolbarItems'
import { createStore, inPage, TAG, useStore } from './b1-shared'
import { BTN, ReadEmpty } from './shared'
import { useFrozenSnapshotId } from './snapshots'

/**
 * #2196 — HTTP caching per route (report only). For every GET route in the window: how many
 * answers were 304 Not Modified (browser cache hits the server revalidated), how many requests
 * were conditional, and which cache headers went out. Routes a browser could cache — static
 * content, or the same caller fetching the same URL again within a minute — that send no
 * Cache-Control, ETag or Last-Modified are flagged first.
 */
export interface CacheRoute {
  route: string
  n: number
  not_modified: number
  conditional: number
  cache_control: number
  no_store: number
  max_age: number
  etag: number
  last_modified: number
  repeat: number
  hit_rate: number
  cacheable: boolean
  no_headers: boolean
  unused_validators: boolean
}

export const httpCacheOpen = createStore(false)

const pct = (part: number, n: number) => (n ? `${Math.round((100 * part) / n)}%` : '—')

/** The header chips a route row shows: each header sent on some responses, with its share. */
export function headerChips(r: CacheRoute): string[] {
  const out: string[] = []
  if (r.cache_control) out.push(`Cache-Control ${pct(r.cache_control, r.n)}`)
  if (r.max_age) out.push(`max-age ${pct(r.max_age, r.n)}`)
  if (r.no_store) out.push(`no-store ${pct(r.no_store, r.n)}`)
  if (r.etag) out.push(`ETag ${pct(r.etag, r.n)}`)
  if (r.last_modified) out.push(`Last-Modified ${pct(r.last_modified, r.n)}`)
  return out
}

function HttpCacheMenuItem() {
  const open = useStore(httpCacheOpen)
  const frozen = useFrozenSnapshotId()
  if (frozen) return null
  return (
    <button
      type='button'
      id='tm-http-cache-toggle'
      aria-pressed={open}
      onClick={() => httpCacheOpen.set(!open)}
      data-tip='Browser caching per route: 304 rate and the cache headers each route sends'
      className={cn(
        BTN,
        open && 'border-[var(--tm-accent)] bg-[var(--tm-accent-soft)] text-[var(--tm-accent-ink)]'
      )}
    >
      <DatabaseZap className='h-3.5 w-3.5' aria-hidden='true' />
      HTTP caching
    </button>
  )
}

function HttpCachePanel() {
  const open = useStore(httpCacheOpen)
  const { win, ready, paused } = useTrafficMap()
  const q = useQuery({
    queryKey: ['traffic-map', 'security', 'http-cache', win],
    queryFn: async () =>
      (await api.get('/traffic-map/security/http-cache', { params: { window: win } })).data
        .data as { window_s: number; routes: CacheRoute[]; flagged: number },
    enabled: open && ready,
    refetchInterval: paused ? false : 15_000,
    staleTime: 10_000
  })
  if (!open) return null
  const d = q.data
  const TH = 'px-2 py-1.5 text-left text-[11px] font-medium text-[var(--tm-muted)]'
  const TD = 'px-2 py-1.5 align-top tabular-nums'
  return (
    <section
      className='min-w-0 rounded-lg border border-[var(--tm-line)] bg-[var(--tm-card)]'
      aria-label='HTTP caching'
      id='tm-http-cache'
    >
      <div className='flex flex-wrap items-start justify-between gap-3 border-b border-[var(--tm-line-2)] px-3.5 py-2'>
        <div className='min-w-0'>
          <h2 className='text-[13px] font-semibold'>HTTP caching</h2>
          <p className='text-[11.5px] text-[var(--tm-muted)]'>
            {d?.flagged
              ? `${d.flagged} cacheable ${d.flagged === 1 ? 'route sends' : 'routes send'} no cache headers.`
              : 'GET routes in the map window: 304 answers, conditional requests and the cache headers sent.'}
          </p>
        </div>
        <button type='button' className={BTN} onClick={() => httpCacheOpen.set(false)}>
          Close
        </button>
      </div>
      {!d?.routes.length ? (
        <div className='px-3.5 py-3'>
          <ReadEmpty loading={q.isLoading} error={q.isError}>
            No GET requests in this window.
          </ReadEmpty>
        </div>
      ) : (
        <div className='max-h-[420px] overflow-auto'>
          <table className='w-full text-[12px]' id='tm-http-cache-routes'>
            <thead className='sticky top-0 bg-[var(--tm-card)]'>
              <tr className='border-b border-[var(--tm-line-2)]'>
                <th className={TH}>Route</th>
                <th className={cn(TH, 'text-right')}>GETs</th>
                <th className={cn(TH, 'text-right')}>304</th>
                <th className={cn(TH, 'text-right')}>Conditional</th>
                <th className={cn(TH, 'text-right')}>Repeats</th>
                <th className={TH}>Headers sent</th>
              </tr>
            </thead>
            <tbody>
              {d.routes.map((r) => {
                const chips = headerChips(r)
                return (
                  <tr
                    key={r.route}
                    className='border-b border-[var(--tm-line-2)] last:border-b-0'
                    data-tm-http-cache-route={r.route}
                    data-tm-http-cache-flag={r.no_headers ? 'no-headers' : undefined}
                  >
                    <td className='max-w-[360px] px-2 py-1.5 align-top'>
                      <span className='block truncate font-mono text-[11px]' data-tip={r.route}>
                        {r.route}
                      </span>
                      {r.no_headers && (
                        <span className={cn(TAG, 'mt-0.5 text-[var(--tm-update)]')}>
                          cacheable, no cache headers
                        </span>
                      )}
                      {r.unused_validators && (
                        <span className={cn(TAG, 'mt-0.5')}>validators never used</span>
                      )}
                    </td>
                    <td className={cn(TD, 'text-right')}>{fmtCount(r.n)}</td>
                    <td className={cn(TD, 'text-right')}>{pct(r.not_modified, r.n)}</td>
                    <td className={cn(TD, 'text-right')}>{pct(r.conditional, r.n)}</td>
                    <td className={cn(TD, 'text-right')}>{pct(r.repeat, r.n)}</td>
                    <td className='px-2 py-1.5 align-top'>
                      {chips.length ? (
                        <div className='flex flex-wrap gap-1'>
                          {chips.map((c) => (
                            <span key={c} className={TAG}>
                              {c}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className='text-[var(--tm-muted)]'>none</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className='border-t border-[var(--tm-line-2)] px-3.5 py-2 text-[11.5px] text-[var(--tm-muted)]'>
        Report only: no header is changed. A 304 is a browser cache hit the server revalidated;
        fresh hits never reach the server. Repeats = the same caller fetching the same URL again
        within a minute.
      </p>
    </section>
  )
}

register(toolbarItems, {
  id: 'http-cache',
  order: 62,
  slot: 'menu',
  Component: inPage(HttpCacheMenuItem)
})
register(pagePanels, { id: 'http-cache', order: 7, wide: true, Component: inPage(HttpCachePanel) })
