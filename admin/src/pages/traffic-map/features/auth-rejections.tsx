import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useTrafficMap } from '../context'
import { callerLabel, fmtCount } from '../EventTicker'
import { Empty, Section } from '../Inspector'
import { inspectorPanels } from '../registry/inspectorPanels'
import { pagePanels } from '../registry/pagePanels'
import { register } from '../registry/registry'
import { Sparkline } from '../Sparkline'
import type { Selection } from '../types'
import { inPage, TAG, useLens } from './b1-shared'

/**
 * #1099 — rejected requests lens: 401 / 403 / 429 per caller with the reason code the API gave
 * (API_KEY_SCOPE_MISSING, API_KEY_RATE_LIMITED, TOKEN_INVALID …), beside the key's configured
 * scopes and rate limit.
 */
export const AUTH_REJECTIONS_TAP = 'auth-rejections'

export interface RejectionRow {
  key: string
  n: number
  codes: Array<{ status: number; code: string; n: number }>
  series: number[]
}
interface CallerAuth {
  caller: string
  key: {
    id: number
    name: string
    is_active: boolean
    sandbox: boolean
    expires_at: string | null
    rate_limit_per_minute: number | null
    scopes: Array<{ collection?: string; actions?: string[] }>
    ip_allowlist: string[]
  } | null
  refusals_24h: Array<{ status: number; code: string; n: number }>
}

export function CodeChips({ codes }: { codes: RejectionRow['codes'] }) {
  return (
    <span className='flex flex-wrap gap-1'>
      {codes.map((c) => (
        <span key={`${c.status}|${c.code}`} className={TAG} data-tm-reject-code={c.code}>
          <span className='font-mono text-[var(--tm-error-ink)]'>{c.status}</span>
          <span className='font-mono'>{c.code}</span>
          <span className='tabular-nums text-[var(--tm-muted)]'>×{fmtCount(c.n)}</span>
        </span>
      ))}
    </span>
  )
}

function RejectionsPanel() {
  const { catalog, setSelection, win } = useTrafficMap()
  const { data, loading } = useLens<{ callers: RejectionRow[] }>(AUTH_REJECTIONS_TAP)
  const rows = data?.callers ?? []
  return (
    <section
      className='min-w-0 rounded-lg border border-[var(--tm-line)] bg-[var(--tm-card)]'
      aria-label='Rejected requests'
      id='tm-rejections'
    >
      <div className='border-b border-[var(--tm-line-2)] px-3.5 py-2'>
        <h2 className='text-[13px] font-semibold'>Rejected requests</h2>
        <p className='text-[11.5px] text-[var(--tm-muted)]'>
          401, 403 and 429 by caller in the last {win >= 300 ? `${win / 60} min` : `${win} s`}, with
          the reason the API gave · select a caller for its key settings
        </p>
      </div>
      <div className='grid gap-0'>
        {rows.length === 0 ? (
          <p className='px-3.5 py-3 text-[12px] text-[var(--tm-muted)]'>
            {loading ? 'Loading…' : 'No rejected requests in this window.'}
          </p>
        ) : (
          rows.map((r) => (
            <button
              type='button'
              key={r.key}
              data-tm-reject-caller={r.key}
              onClick={() => setSelection({ kind: 'caller', id: r.key })}
              className='grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-b border-[var(--tm-line-2)] px-3.5 py-2 text-left text-[12px] transition-colors duration-150 ease-out last:border-0 hover:bg-[var(--tm-card-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan'
            >
              <span className='min-w-0 truncate font-medium'>
                {r.key === '__other__' ? 'Other callers' : callerLabel(catalog, r.key)}
              </span>
              <span className='flex items-center gap-2'>
                <Sparkline data={r.series} color='var(--tm-error)' className='block h-4 w-[64px]' />
                <span className='font-semibold tabular-nums text-[var(--tm-error-ink)]'>
                  {fmtCount(r.n)}
                </span>
              </span>
              <span className='col-span-2'>
                <CodeChips codes={r.codes} />
              </span>
            </button>
          ))
        )}
      </div>
    </section>
  )
}

function scopeText(s: { collection?: string; actions?: string[] }): string {
  return `${s.collection ?? '*'} (${(s.actions ?? []).join(', ') || 'none'})`
}

function CallerRejections({ sel }: { sel: Selection }) {
  const caller = sel.id
  const { data } = useLens<{ callers: RejectionRow[] }>(AUTH_REJECTIONS_TAP)
  const live = data?.callers.find((r) => r.key === caller)
  const askable = /^k\d+$/.test(caller) || /^u[0-9A-F-]{36}$/i.test(caller)
  const auth = useQuery({
    queryKey: ['traffic-map', 'caller-auth', caller],
    queryFn: async () => {
      const res = await api.get(`/traffic-map/caller-auth?caller=${encodeURIComponent(caller)}`)
      return res.data.data as CallerAuth
    },
    enabled: askable,
    staleTime: 60_000
  })
  const key = auth.data?.key
  return (
    <Section title='Rejected requests'>
      <div className='grid gap-2 text-[12px]' data-tm-caller-auth={caller}>
        {live?.n ? (
          <div className='grid gap-1'>
            <span className='tabular-nums'>
              <span className='font-semibold text-[var(--tm-error-ink)]'>{fmtCount(live.n)}</span>{' '}
              in this window
            </span>
            <CodeChips codes={live.codes} />
          </div>
        ) : (
          <Empty>None in this window.</Empty>
        )}
        {key ? (
          <dl className='grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-[11.5px]'>
            <dt className='text-[var(--tm-muted)]'>API key</dt>
            <dd className='min-w-0 truncate'>
              {key.name}
              {!key.is_active ? ' · revoked' : ''}
              {key.sandbox ? ' · sandbox' : ''}
            </dd>
            <dt className='text-[var(--tm-muted)]'>Rate limit</dt>
            <dd data-tm-key-rate>
              {key.rate_limit_per_minute
                ? `${fmtCount(key.rate_limit_per_minute)} per minute`
                : 'none'}
            </dd>
            <dt className='text-[var(--tm-muted)]'>Scopes</dt>
            <dd className='min-w-0 break-words' data-tm-key-scopes>
              {key.scopes.length ? key.scopes.map(scopeText).join(' · ') : 'full access'}
            </dd>
            {key.ip_allowlist.length ? (
              <>
                <dt className='text-[var(--tm-muted)]'>IP allowlist</dt>
                <dd className='min-w-0 truncate font-mono'>{key.ip_allowlist.join(', ')}</dd>
              </>
            ) : null}
            {key.expires_at ? (
              <>
                <dt className='text-[var(--tm-muted)]'>Expires</dt>
                <dd>{String(key.expires_at).slice(0, 10)}</dd>
              </>
            ) : null}
          </dl>
        ) : askable && auth.data && caller.startsWith('u') ? (
          <p className='text-[11.5px] text-[var(--tm-muted)]'>
            A person or token account — no API key settings.
          </p>
        ) : null}
        {auth.data?.refusals_24h.length ? (
          <div className='grid gap-1'>
            <span className='text-[11.5px] text-[var(--tm-muted)]'>
              Last 24 hours (request log)
            </span>
            <CodeChips codes={auth.data.refusals_24h.slice(0, 6)} />
          </div>
        ) : null}
      </div>
    </Section>
  )
}

register(pagePanels, { id: 'auth-rejections', order: 20, Component: inPage(RejectionsPanel) })
register(inspectorPanels, {
  id: 'auth-rejections',
  order: 20,
  applies: (sel) => sel.kind === 'caller',
  Component: inPage(CallerRejections)
})
