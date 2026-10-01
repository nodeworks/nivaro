import { useQuery } from '@tanstack/react-query'
import { useEffect, useSyncExternalStore } from 'react'
import { api } from '@/lib/api'
import { useTrafficMap } from '../context'
import { t as clock, Section } from '../Inspector'
import { requestCanvasRepaint, sideBadges } from '../registry/canvasLayers'
import { inspectorPanels } from '../registry/inspectorPanels'
import { register } from '../registry/registry'
import { toolbarItems } from '../registry/toolbarItems'
import type { Selection } from '../types'
import { ago, inPage } from './b1-shared'
import { LINK, SafeLink } from './shared'
import { useFrozenSnapshotId } from './snapshots'

/**
 * #1172 — credentials about to fail. Badges on caller nodes for API keys that expire within a
 * week or run at 85%+ of their per-minute limit (the limiter's own Redis counters), and on
 * partner nodes whose OAuth token exchanges keep failing. Polled once a minute; the inspector of
 * the node says what is wrong and where to fix it.
 */
export interface KeyVerdict {
  name: string | null
  expires_in_days: number | null
  expires_at: string | null
  limit: number | null
  used: number | null
  pct: number | null
}
export interface TokenVerdict {
  streak: number
  last_error: string | null
  last_status: number | null
  last_at: string
  last_ok_at: string | null
}
export interface Credentials {
  at: string
  callers: Record<string, KeyVerdict>
  partners: Record<string, TokenVerdict>
  near_limit_pct: number
  expiry_days: number
}

let current: Credentials | null = null
let version = 0
const subs = new Set<() => void>()
export function setCredentials(c: Credentials | null): void {
  current = c
  version++
  for (const fn of subs) fn()
  requestCanvasRepaint()
}
export function credentialsNow(): Credentials | null {
  return current
}
function useCredentials(): Credentials | null {
  useSyncExternalStore(
    (fn) => {
      subs.add(fn)
      return () => {
        subs.delete(fn)
      }
    },
    () => version,
    () => version
  )
  return current
}

/** The badge a caller key gets: expiry beats rate (an expired key is the harder failure). */
export function keyBadge(v: KeyVerdict): { text: string; tone: 'warn' | 'error' } | null {
  if (v.expires_in_days != null) {
    if (v.expires_in_days <= 0) return { text: 'key expired', tone: 'error' }
    const d = Math.max(1, Math.round(v.expires_in_days))
    return { text: `expires in ${d} d`, tone: d <= 2 ? 'error' : 'warn' }
  }
  if (v.pct != null) return { text: `limit ${v.pct}%`, tone: v.pct >= 100 ? 'error' : 'warn' }
  return null
}

function Poller() {
  const frozen = useFrozenSnapshotId()
  const { ready } = useTrafficMap()
  const q = useQuery({
    queryKey: ['traffic-map', 'credentials'],
    queryFn: async () => (await api.get('/traffic-map/credentials')).data.data as Credentials,
    enabled: ready && !frozen,
    refetchInterval: 60_000,
    staleTime: 55_000
  })
  useEffect(() => {
    if (q.data) setCredentials(q.data)
  }, [q.data])
  useEffect(() => () => setCredentials(null), [])
  return null
}

register(toolbarItems, { id: 'credentials-poller', order: 997, Component: inPage(Poller) })

register(sideBadges, {
  id: 'credentials',
  badge(kind, id) {
    const c = current
    if (!c) return null
    if (kind === 'caller') {
      const v = c.callers[id]
      return v ? keyBadge(v) : null
    }
    const p = c.partners[id]
    return p ? { text: `token failing ×${p.streak}`, tone: 'error' } : null
  }
})

function KeyPanel({ sel }: { sel: Selection }) {
  const c = useCredentials()
  const v = c?.callers[sel.id]
  if (!v) return null
  return (
    <Section title='Credentials'>
      <div className='grid gap-1 text-[12px]' id='tm-credentials' data-tm-credentials={sel.id}>
        {v.expires_in_days != null && v.expires_at && (
          <p data-tm-credential='expiry'>
            {v.expires_in_days <= 0 ? (
              <span className='font-semibold text-[var(--tm-error-ink)]'>This key has expired</span>
            ) : (
              <>
                <span className='font-semibold'>
                  Expires {new Date(v.expires_at).toLocaleDateString()}
                </span>
                <span className='text-[var(--tm-fg-2)]'>
                  {' '}
                  · {Math.max(1, Math.round(v.expires_in_days))} days left
                </span>
              </>
            )}
            . Calls start failing with API_KEY_EXPIRED once it lapses.
          </p>
        )}
        {v.pct != null && v.limit != null && (
          <p data-tm-credential='rate'>
            <span className='font-semibold tabular-nums'>
              {v.used} of {v.limit}
            </span>{' '}
            requests this minute ({v.pct}%). Past {v.limit} the key gets 429 API_KEY_RATE_LIMITED.
          </p>
        )}
        <SafeLink to='/api-keys' className={LINK} data-tm-credential-fix=''>
          Open API keys
        </SafeLink>
      </div>
    </Section>
  )
}

function PartnerPanel({ sel }: { sel: Selection }) {
  const c = useCredentials()
  const p = c?.partners[sel.id]
  if (!p) return null
  const apiId = sel.id.slice(4)
  return (
    <Section title='Credentials'>
      <div className='grid gap-1 text-[12px]' id='tm-credentials' data-tm-credentials={sel.id}>
        <p data-tm-credential='token'>
          <span className='font-semibold text-[var(--tm-error-ink)]'>
            The last {p.streak} token exchanges failed
          </span>
          {p.last_status != null ? ` (HTTP ${p.last_status})` : ''}, newest {ago(p.last_at)} at{' '}
          {clock(p.last_at)}. Every call to this partner fails until one succeeds.
        </p>
        {p.last_error && (
          <p className='break-words font-mono text-[11px] text-[var(--tm-fg-2)]'>{p.last_error}</p>
        )}
        <p className='text-[11.5px] text-[var(--tm-muted)]'>
          {p.last_ok_at
            ? `Last successful exchange ${ago(p.last_ok_at)}.`
            : 'No successful exchange in the last 24 hours.'}
        </p>
        {/^\d+$/.test(apiId) && (
          <SafeLink to={`/external-apis/${apiId}`} className={LINK} data-tm-credential-fix=''>
            Open the external API
          </SafeLink>
        )}
      </div>
    </Section>
  )
}

register(inspectorPanels, {
  id: 'credentials-key',
  order: 15,
  applies: (sel) => sel.kind === 'caller' && /^k\d+$/.test(sel.id),
  Component: inPage(KeyPanel)
})
register(inspectorPanels, {
  id: 'credentials-partner',
  order: 15,
  applies: (sel) => sel.kind === 'down' && sel.id.startsWith('ext:'),
  Component: inPage(PartnerPanel)
})
