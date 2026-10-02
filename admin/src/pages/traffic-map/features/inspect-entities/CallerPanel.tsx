/**
 * #1199 — a caller in the investigation panel: who it is, its requests in the window grouped by
 * route and status, error rate, p95, refused credentials, the key's limits and scopes, open
 * breakers, the recent requests (each opens its request) and — loaded on demand — the fields it
 * depends on. People also get "Follow" (the follow-person feature) and "Watch recording".
 */
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '@/lib/api'
import { fmtCount, fmtMs, fmtTime } from '../../EventTicker'
import { useInspectDetail } from '../../inspect/api'
import { InspectLink } from '../../inspect/InspectLink'
import type { InspectPanelProps } from '../../registry/inspectables'
import { following } from '../follow-person'
import { BTN, SafeLink } from '../shared'
import { fmtRate, parseRecordingFor } from './logic'
import {
  Block,
  collectionEntityId,
  Facts,
  Figure,
  Figures,
  Muted,
  PanelError,
  PanelLoading,
  type RequestLine,
  RequestList,
  Spark,
  Status,
  useCatalog
} from './parts'

interface RouteRow {
  route: string
  status: number
  n: number
  p95: number
}
interface CallerDetail {
  key: string
  kind: 'key' | 'person' | 'machine' | 'source' | 'cron' | 'anon'
  label: string
  note: string | null
  range: { from: number; to: number }
  logged: boolean
  truncated: boolean
  summary: {
    total: number
    errors: number
    error_rate: number
    p95: number
    routes: RouteRow[]
  } | null
  series: number[] | null
  auth_failures: Array<{ code: string; status: number; message: string | null; n: number }>
  recent: RequestLine[]
  request_ids_logged: boolean
  key_info: {
    id: number
    name: string
    prefix: string | null
    owner: { id: string; name: string | null } | null
    scopes: unknown[] | null
    scope_restrictions: unknown[] | null
    rate_limit_per_minute: number | null
    ip_allowlist: string[]
    expires_at: string | null
    last_used_at: string | null
    active: boolean
    sandbox: boolean
    graphql_max_depth: number | null
  } | null
  person: {
    id: string
    name: string | null
    email: string | null
    title: string | null
    department: string | null
    status: string | null
    account_kind: string | null
    role: string | null
    last_access: string | null
    out_of_office: boolean
  } | null
  runs: {
    kind: 'job' | 'flow'
    label: string | null
    runs: Array<{
      id: string
      status: string
      at: string | null
      ms: number | null
      note: string | null
      error: string | null
    }>
  } | null
  breakers: Array<{
    mode: string
    limit: number | null
    until: number
    reason: string
    by_name: string | null
  }>
  has_dependencies: boolean
}

const KIND_TEXT: Record<CallerDetail['kind'], string> = {
  key: 'API key',
  person: 'Person',
  machine: 'Machine account',
  source: 'Background source',
  cron: 'Crons & flows (all)',
  anon: 'No credential'
}

function scopeText(s: unknown): string {
  if (!s || typeof s !== 'object') return String(s)
  const o = s as { collection?: unknown; actions?: unknown }
  const actions = Array.isArray(o.actions) ? o.actions.join(', ') : '?'
  return `${String(o.collection ?? '?')}: ${actions}`
}

function rangeText(r: { from: number; to: number }): string {
  return `${fmtTime(r.from)} – ${fmtTime(r.to)}`
}

/** "Watch recording" — Task 4's helper route; nothing at all when that route is not there. */
function WatchRecording({ userId, at }: { userId: string; at: number }) {
  const q = useQuery({
    queryKey: ['tm-inspect', 'recording-for', userId, Math.round(at / 60_000)],
    queryFn: async () =>
      (await api.get('/traffic-map/inspect/recording-for', { params: { user: userId, at } })).data
        ?.data ?? null,
    staleTime: 60_000,
    retry: false
  })
  if (q.isLoading || q.isError) return null
  const r = parseRecordingFor(q.data)
  if (!r) return null
  if (r.kind === 'none')
    return (
      <span
        className='text-[11.5px] text-[var(--tm-muted)]'
        data-tm-inspect-caller-recording='none'
      >
        {r.reason}
      </span>
    )
  return (
    <InspectLink
      inspectRef={{
        kind: 'recording',
        id: r.id,
        at: r.at ?? at,
        label: r.clip ? 'Error clip' : 'Recording'
      }}
      className='text-[12px]'
    >
      <span data-tm-inspect-caller-recording={r.id}>
        {r.clip ? 'Watch error clip' : 'Watch recording'}
      </span>
    </InspectLink>
  )
}

/** The fields, endpoints and operations a caller depends on (loaded on demand). */
function Dependencies({ callerKey }: { callerKey: string }) {
  const [on, setOn] = useState(false)
  const q = useQuery({
    queryKey: ['tm-inspect', 'caller-deps', callerKey],
    queryFn: async () =>
      (await api.get('/traffic-map/inspect/caller-deps', { params: { key: callerKey } })).data
        ?.data ?? null,
    enabled: on,
    staleTime: 3 * 60_000,
    retry: false
  })
  if (!on)
    return (
      <button
        type='button'
        className={BTN}
        onClick={() => setOn(true)}
        data-tm-inspect-caller-deps-load=''
        data-tip='Reads 14 days of this caller’s requests — the first look can take a few seconds'
      >
        Show the fields it depends on
      </button>
    )
  if (q.isLoading) return <PanelLoading />
  if (q.isError) return <PanelError error={q.error} what='dependency map' />
  const d = q.data as {
    found: boolean
    calls?: number
    collections?: Array<{
      collection: string
      calls: number
      read_all: boolean
      read: string[]
      written: string[]
    }>
    endpoints?: Array<{ method: string; path: string; calls: number; errors: number }>
    operations?: Array<{ name: string; kind: string; calls: number; errors: number }>
  } | null
  if (!d?.found)
    return (
      <Muted hook='deps-none'>
        No dependency map for this caller — it made no token or API-key requests in the last 14 days
        (session callers are not mapped).
      </Muted>
    )
  return (
    <div className='grid gap-2' data-tm-inspect-caller-deps=''>
      {(d.collections ?? []).map((c) => (
        <div key={c.collection} className='grid gap-0.5 text-[12px]'>
          <InspectLink
            inspectRef={{ kind: 'entity', id: collectionEntityId(c.collection) }}
            className='font-medium'
          >
            {c.collection}
          </InspectLink>
          <span className='text-[11.5px] text-[var(--tm-fg-2)]'>
            {c.read_all
              ? 'Reads every field'
              : c.read.length
                ? `Reads ${c.read.join(', ')}`
                : 'No reads'}
            {c.written.length ? ` · writes ${c.written.join(', ')}` : ''}
          </span>
        </div>
      ))}
      {!!d.operations?.length && (
        <Facts
          rows={d.operations
            .slice(0, 8)
            .map((o) => [o.name, `${o.kind} · ${fmtCount(o.calls)} calls`] as [string, string])}
        />
      )}
    </div>
  )
}

export function CallerPanel({ inspectRef, anchor, windowSec }: InspectPanelProps) {
  const cat = useCatalog()
  const q = useInspectDetail<CallerDetail>(inspectRef, anchor, windowSec)
  if (q.isLoading) return <PanelLoading />
  if (q.isError || !q.data) return <PanelError error={q.error} what='caller' />
  const d = q.data
  const at = inspectRef.at ?? anchor ?? d.range.to
  const s = d.summary
  const person = d.person
  const key = d.key_info
  return (
    <div className='grid min-w-0 gap-3.5' data-tm-inspect-caller={d.key}>
      <div className='grid gap-1'>
        <p className='text-[14px] font-semibold text-[var(--tm-fg)]'>{d.label}</p>
        <p className='text-[12px] text-[var(--tm-fg-2)]'>
          {KIND_TEXT[d.kind]} · {rangeText(d.range)}
        </p>
        {d.note && <Muted>{d.note}</Muted>}
      </div>

      {person && (
        <div className='flex flex-wrap items-center gap-2'>
          {d.kind === 'person' && (
            <button
              type='button'
              className={BTN}
              data-tm-inspect-caller-follow={d.key}
              data-tip='Mark this person’s requests on the map as they move page to page'
              onClick={() => following.set({ key: d.key, name: person.name ?? d.label })}
            >
              Follow
            </button>
          )}
          <WatchRecording userId={person.id} at={at} />
          <SafeLink
            to={`/users/${person.id}`}
            className='text-[12px] text-[var(--tm-muted)] hover:underline'
          >
            Open full profile
          </SafeLink>
        </div>
      )}

      {s && (
        <Figures>
          <Figure label='Requests' value={fmtCount(s.total)} />
          <Figure
            label='Error rate'
            value={fmtRate(s.error_rate)}
            tone={s.errors ? 'error' : undefined}
          />
          <Figure label='p95' value={fmtMs(s.p95)} />
        </Figures>
      )}
      {d.series && <Spark data={d.series} caption='Requests across the window (API log)' />}
      {d.truncated && (
        <Muted hook='truncated'>Only the newest 5,000 requests in the window were read.</Muted>
      )}

      {person && (
        <Block title='Profile' hook='profile'>
          <Facts
            rows={[
              ['Role', person.role ?? 'None'],
              person.email ? ['Email', person.email] : null,
              person.title ? ['Title', person.title] : null,
              person.department ? ['Department', person.department] : null,
              [
                'Status',
                `${person.status ?? 'unknown'}${person.out_of_office ? ' · out of office' : ''}`
              ],
              person.account_kind ? ['Account', person.account_kind] : null,
              person.last_access
                ? ['Last active', new Date(person.last_access).toLocaleString()]
                : null
            ]}
          />
        </Block>
      )}

      {key && (
        <Block
          title='Key'
          hook='key'
          aside={
            <SafeLink to='/api-keys' className='hover:underline'>
              Open API keys
            </SafeLink>
          }
        >
          <Facts
            rows={[
              ['State', `${key.active ? 'Active' : 'Revoked'}${key.sandbox ? ' · sandbox' : ''}`],
              key.owner
                ? [
                    'Owner',
                    <InspectLink
                      key='owner'
                      inspectRef={{
                        kind: 'caller',
                        id: `u${key.owner.id}`,
                        label: key.owner.name ?? undefined
                      }}
                    >
                      {key.owner.name ?? 'Owner'}
                    </InspectLink>
                  ]
                : null,
              [
                'Rate limit',
                key.rate_limit_per_minute ? `${key.rate_limit_per_minute} / minute` : 'None per key'
              ],
              [
                'IP allowlist',
                key.ip_allowlist.length ? key.ip_allowlist.join(', ') : 'Any address'
              ],
              [
                'Scopes',
                key.scopes?.length
                  ? key.scopes.map(scopeText).join(' · ')
                  : 'Everything the owner may do'
              ],
              key.scope_restrictions?.length
                ? ['Row scope', `${key.scope_restrictions.length} restriction(s)`]
                : null,
              key.expires_at ? ['Expires', new Date(key.expires_at).toLocaleDateString()] : null,
              key.graphql_max_depth ? ['GraphQL depth', String(key.graphql_max_depth)] : null
            ]}
          />
        </Block>
      )}

      {d.breakers.length > 0 && (
        <Block title='Circuit breakers on this caller' hook='breakers'>
          <ul className='grid gap-1 text-[12px]'>
            {d.breakers.map((b) => (
              <li key={b.until} data-tm-inspect-caller-breaker={b.mode}>
                {b.mode === 'refuse' ? 'Refusing every request' : `Limited to ${b.limit}/min`} until{' '}
                {fmtTime(b.until)} — “{b.reason}”{b.by_name ? ` (${b.by_name})` : ''}
              </li>
            ))}
          </ul>
        </Block>
      )}

      {s && (
        <Block title='Routes in the window' aside={`top ${s.routes.length}`} hook='routes'>
          {s.routes.length ? (
            <ul className='grid gap-0.5 text-[12px]'>
              {s.routes.map((r) => (
                <li
                  key={`${r.route}|${r.status}`}
                  className='grid grid-cols-[minmax(0,1fr)_auto_auto_auto] gap-x-2'
                  data-tm-inspect-caller-route={r.route}
                >
                  <span className='truncate font-mono text-[11px]' data-tip={r.route}>
                    {r.route}
                  </span>
                  <Status status={r.status} />
                  <span className='tabular-nums text-[var(--tm-fg-2)]'>{fmtCount(r.n)}</span>
                  <span className='tabular-nums text-[11px] text-[var(--tm-muted)]'>
                    {fmtMs(r.p95)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Muted>No requests from this caller in the window.</Muted>
          )}
        </Block>
      )}

      {d.auth_failures.length > 0 && (
        <Block title='Refused credentials' hook='auth-failures'>
          <Facts
            rows={d.auth_failures.map(
              (f) =>
                [
                  `${f.code} (${f.status})`,
                  `${fmtCount(f.n)}×${f.message ? ` — ${f.message}` : ''}`
                ] as [string, string]
            )}
          />
        </Block>
      )}

      {d.runs && (
        <Block title={d.runs.kind === 'job' ? 'Recent runs' : 'Recent flow runs'} hook='runs'>
          {d.runs.runs.length ? (
            <ul className='grid gap-0.5 text-[12px]'>
              {d.runs.runs.map((r) => (
                <li key={r.id} className='grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-2'>
                  <span className='tabular-nums text-[11px] text-[var(--tm-muted)]'>
                    {fmtTime(r.at ?? '')}
                  </span>
                  <InspectLink
                    inspectRef={{ kind: d.runs?.kind === 'job' ? 'job' : 'flow', id: r.id }}
                  >
                    {r.status}
                    {r.error ? ` — ${r.error}` : ''}
                  </InspectLink>
                  <span className='tabular-nums text-[11px] text-[var(--tm-muted)]'>
                    {fmtMs(r.ms ?? 0)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Muted>No runs recorded.</Muted>
          )}
        </Block>
      )}

      {d.logged && (
        <Block title='Recent requests' hook='recent'>
          <RequestList
            rows={d.recent}
            cat={cat}
            empty='No requests from this caller in the window (older than the API log keeps — 14 days — or none made).'
            idsLogged={d.request_ids_logged}
          />
        </Block>
      )}
      {!d.logged && d.kind !== 'source' && (
        <Muted hook='no-log'>The API log has no rows of its own for this caller.</Muted>
      )}

      {d.has_dependencies && (
        <Block title='Fields it depends on' hook='deps'>
          <Dependencies callerKey={d.key} />
        </Block>
      )}
    </div>
  )
}
