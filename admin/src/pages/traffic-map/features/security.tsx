import { useQuery } from '@tanstack/react-query'
import { ShieldAlert } from 'lucide-react'
import { useEffect, useSyncExternalStore } from 'react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useTrafficMap } from '../context'
import { fmtCount } from '../EventTicker'
import { t as clock, Empty, Section } from '../Inspector'
import { requestCanvasRepaint, sideBadges } from '../registry/canvasLayers'
import { inspectorPanels } from '../registry/inspectorPanels'
import { pagePanels } from '../registry/pagePanels'
import { register } from '../registry/registry'
import { toolbarItems } from '../registry/toolbarItems'
import type { Selection } from '../types'
import { ago, createStore, inPage, TAG, useStore } from './b1-shared'
import { usePeopleNames } from './people-names'
import { BTN, LINK, Note, SafeLink } from './shared'
import { useFrozenSnapshotId } from './snapshots'

/**
 * Traffic Map security lenses on callers and sessions:
 *  - #2154 caller geography (places by country / region, places a caller had not called from)
 *  - #2204 scripted sessions (machine pace or a fixed loop from outside the app, scripting tools)
 *  - #2235 one session from two places (a possible copied cookie; raised to admins)
 *  - #2236 misconfigured clients (another environment's frontend, keys minted elsewhere)
 *  - #2257 bad data by caller (Data Integrity findings by the caller whose write made them)
 * Badges on caller nodes come from one summary poll; the caller's inspector and the Security
 * panel (More menu) read the detail. Addresses are only in these admin reads.
 */
export interface SecurityFlag {
  kind: 'two-places' | 'scripted' | 'misconfigured' | 'new-place' | 'bad-data'
  tone: 'error' | 'warn' | 'info'
  text: string
}
export interface SecuritySummary {
  at: string
  window_s: number
  flags: Record<string, SecurityFlag[]>
}
interface AddrView {
  ip: string
  network: string
  country: string | null
  ua: string | null
  browser: string
  n: number
  first_at: string
  last_at: string
}
export interface SessionView {
  id: string
  caller: string
  last_at: string
  browser: string
  ua: string | null
  scripted: { patterns: Array<{ kind: string; text: string }>; rate: number; at: string } | null
  two_places: { a: AddrView; b: AddrView; at: string; confidence: 'high' | 'low' } | null
  addresses: AddrView[]
}
interface MisconfigFinding {
  caller: string
  kind: 'referer' | 'unknown-key' | 'key-name'
  environment: string | null
  text: string
  n: number
}
interface BadDataCaller {
  caller: string
  records: number
  findings: number
  by_rule: Array<{ rule: string; n: number }>
  by_collection: Array<{ collection: string; n: number }>
  samples: Array<{ collection: string; item: string; rule: string; message: string; at: string }>
}
interface GeoStatus {
  enabled: boolean
  configured: boolean
  database: string | null
  error: string | null
}
interface CallerSecurity {
  caller: string
  geo: {
    status: GeoStatus
    view: {
      places: Array<{ place: string; country_name: string | null; n: number }>
      new_places: Array<{ place: string; city: string | null; ip: string; first_at: string }>
      learning: boolean
      since: string
    } | null
  }
  sessions: SessionView[]
  misconfigured: MisconfigFinding[]
  bad_data: BadDataCaller | null
}

// ── summary store (badges) ───────────────────────────────────────────────────
let current: SecuritySummary | null = null
let version = 0
const subs = new Set<() => void>()
export function setSecuritySummary(s: SecuritySummary | null): void {
  current = s
  version++
  for (const fn of subs) fn()
  requestCanvasRepaint()
}
function useSummary(): SecuritySummary | null {
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

/** The badge a caller node gets: its most severe flag. */
export function securityBadge(
  flags: SecurityFlag[] | undefined
): { text: string; tone: 'error' | 'warn' | 'info' } | null {
  const f = flags?.[0]
  return f ? { text: f.text, tone: f.tone } : null
}

function Poller() {
  const frozen = useFrozenSnapshotId()
  const { ready, win } = useTrafficMap()
  const q = useQuery({
    queryKey: ['traffic-map', 'security', 'summary', win],
    queryFn: async () =>
      (await api.get('/traffic-map/security/summary', { params: { window: win } })).data
        .data as SecuritySummary,
    enabled: ready && !frozen,
    refetchInterval: 30_000,
    staleTime: 25_000
  })
  useEffect(() => {
    if (q.data) setSecuritySummary(q.data)
  }, [q.data])
  useEffect(() => () => setSecuritySummary(null), [])
  return null
}

register(toolbarItems, { id: 'security-poller', order: 996, Component: inPage(Poller) })
register(sideBadges, {
  id: 'security',
  order: 50,
  badge(kind, id) {
    if (kind !== 'caller' || !current) return null
    return securityBadge(current.flags[id])
  }
})

// ── shared bits ──────────────────────────────────────────────────────────────
const MONO = 'font-mono text-[11px]'

function AddrLine({ a, label }: { a: AddrView; label: string }) {
  return (
    <li className='min-w-0 text-[12px]' data-tm-security-addr={a.network}>
      <div className='flex min-w-0 items-baseline justify-between gap-2'>
        <span className='min-w-0 truncate'>
          <span className='text-[var(--tm-muted)]'>{label} </span>
          <span className={MONO}>{a.ip}</span>
          {a.country ? <span className='text-[var(--tm-fg-2)]'> · {a.country}</span> : null}
        </span>
        <span className='shrink-0 tabular-nums text-[var(--tm-fg-2)]'>
          {fmtCount(a.n)} · {ago(a.last_at)}
        </span>
      </div>
      <p className='truncate text-[11.5px] text-[var(--tm-fg-2)]' data-tip={a.ua ?? undefined}>
        {a.browser}
      </p>
    </li>
  )
}

function SessionCard({ s, name }: { s: SessionView; name?: string }) {
  const tp = s.two_places
  return (
    <div className='grid gap-1.5' data-tm-security-session={s.id}>
      {name ? <p className='text-[12px] font-semibold'>{name}</p> : null}
      {tp && (
        <div data-tm-security-two-places={tp.confidence}>
          <p
            className={cn(
              'text-[12px] font-semibold',
              tp.confidence === 'high' ? 'text-[var(--tm-error-ink)]' : 'text-[var(--tm-fg)]'
            )}
          >
            One session used from two places at {clock(tp.at)}
          </p>
          <ul className='mt-1 grid gap-1'>
            <AddrLine a={tp.a} label='A' />
            <AddrLine a={tp.b} label='B' />
          </ul>
          <p className='mt-1 text-[11.5px] text-[var(--tm-muted)]'>
            {tp.confidence === 'high'
              ? 'Different browsers or countries on the two sides: it may be a copied session cookie. Admins were notified.'
              : 'Same browser on both sides: often a phone network handing out a new address per connection.'}
          </p>
        </div>
      )}
      {s.scripted && (
        <div data-tm-security-scripted=''>
          <p className='text-[12px] font-semibold'>
            Scripted use of a session
            <span className='font-normal text-[var(--tm-fg-2)]'>
              {' '}
              · {s.scripted.rate} req/s · {s.browser}
            </span>
          </p>
          <ul className='mt-0.5 grid gap-0.5 text-[11.5px] text-[var(--tm-fg-2)]'>
            {s.scripted.patterns.map((p) => (
              <li key={p.kind} className='break-words' data-tm-security-pattern={p.kind}>
                {p.text}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function personHref(caller: string): string | null {
  return /^u[0-9A-Fa-f-]{36}$/.test(caller) ? `/users/${caller.slice(1).toLowerCase()}` : null
}

// ── caller inspector ─────────────────────────────────────────────────────────
function GeoSection({ geo }: { geo: CallerSecurity['geo'] }) {
  if (!geo.status.enabled) {
    return (
      <Section title='Places'>
        <p className='text-[11.5px] text-[var(--tm-muted)]' data-tm-security-geo='off'>
          {geo.status.configured ? (
            `The geo database could not be read${geo.status.error ? ` (${geo.status.error})` : ''}.`
          ) : (
            <>
              Off. To see where callers call from, set{' '}
              <code className={MONO}>TRAFFIC_GEOIP_DB</code> on the API server to a GeoLite2 Country
              or City .mmdb file. Addresses are looked up on the server only.
            </>
          )}
        </p>
      </Section>
    )
  }
  const v = geo.view
  if (!v?.places.length) return null
  const max = Math.max(1, ...v.places.map((p) => p.n))
  return (
    <Section title='Places'>
      <ul className='grid gap-1' id='tm-security-places'>
        {v.places.map((p) => (
          <li key={p.place} className='text-[12px]' data-tm-security-place={p.place}>
            <div className='flex items-baseline justify-between gap-2'>
              <span className='min-w-0 truncate' data-tip={p.country_name ?? undefined}>
                {p.place}
              </span>
              <span className='shrink-0 tabular-nums text-[var(--tm-fg-2)]'>{fmtCount(p.n)}</span>
            </div>
            <span className='mt-0.5 block h-1 overflow-hidden rounded-sm bg-[var(--tm-accent-soft)]'>
              <i
                className='block h-full bg-[var(--tm-accent)]'
                style={{ width: `${(100 * p.n) / max}%` }}
              />
            </span>
          </li>
        ))}
      </ul>
      {v.new_places.length > 0 && (
        <div className='mt-2 grid gap-0.5' data-tm-security-new-places=''>
          <p className='text-[12px] font-semibold'>New places</p>
          {v.new_places.map((n) => (
            <p key={`${n.place}-${n.first_at}`} className='text-[11.5px] text-[var(--tm-fg-2)]'>
              {n.place}
              {n.city ? ` (${n.city})` : ''} · first {ago(n.first_at)} from{' '}
              <span className={MONO}>{n.ip}</span>
            </p>
          ))}
        </div>
      )}
      <p className='mt-1.5 text-[11.5px] text-[var(--tm-muted)]'>
        {v.learning
          ? 'Still learning this caller’s usual places.'
          : `Places learned since ${ago(v.since)}; a place first seen after that is new.`}
      </p>
    </Section>
  )
}

function BadDataBlock({ b }: { b: BadDataCaller }) {
  return (
    <div className='grid gap-1' data-tm-security-bad-data={b.caller}>
      <p className='text-[12px]'>
        <span className='font-semibold tabular-nums'>{fmtCount(b.records)}</span> records with{' '}
        {fmtCount(b.findings)} integrity findings after this caller’s writes
      </p>
      <div className='flex flex-wrap gap-1'>
        {b.by_rule.map((r) => (
          <span key={r.rule} className={TAG}>
            {r.rule} {r.n}
          </span>
        ))}
        {b.by_collection.map((c) => (
          <span key={c.collection} className={cn(TAG, 'font-mono')}>
            {c.collection} {c.n}
          </span>
        ))}
      </div>
      <ul className='grid gap-0.5 text-[11.5px] text-[var(--tm-fg-2)]'>
        {b.samples.map((s) => (
          <li key={`${s.collection}/${s.item}`} className='truncate'>
            <SafeLink
              to={`/collections/${encodeURIComponent(s.collection)}/${encodeURIComponent(s.item)}`}
              className={LINK}
            >
              <span className={MONO}>
                {s.collection}/{s.item}
              </span>
            </SafeLink>{' '}
            {s.message || s.rule}
          </li>
        ))}
      </ul>
    </div>
  )
}

function CallerSecurityPanel({ sel }: { sel: Selection }) {
  const { win, ready, paused } = useTrafficMap()
  const q = useQuery({
    queryKey: ['traffic-map', 'security', 'caller', sel.id, win],
    queryFn: async () =>
      (await api.get('/traffic-map/security/caller', { params: { caller: sel.id, window: win } }))
        .data.data as CallerSecurity,
    enabled: ready,
    refetchInterval: paused ? false : 30_000,
    staleTime: 20_000
  })
  const d = q.data
  if (!d) return null
  const href = personHref(sel.id)
  return (
    <>
      <GeoSection geo={d.geo} />
      {d.sessions.length > 0 && (
        <Section title='Sessions'>
          <div className='grid gap-3' id='tm-security-sessions'>
            {d.sessions.map((s) => (
              <SessionCard key={s.id} s={s} />
            ))}
          </div>
          {href && (
            <SafeLink to={href} className={cn(LINK, 'mt-2 inline-block text-[12px]')}>
              Open this person
            </SafeLink>
          )}
        </Section>
      )}
      {d.misconfigured.length > 0 && (
        <Section title='Wrong environment'>
          <ul className='grid gap-1 text-[12px]' id='tm-security-misconfigured'>
            {d.misconfigured.map((m) => (
              <li key={`${m.kind}-${m.text}`} data-tm-security-misconfig={m.kind}>
                {m.text}
                {m.n ? (
                  <span className='text-[var(--tm-fg-2)]'> · {fmtCount(m.n)} calls</span>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {d.bad_data && (
        <Section title='Bad data written'>
          <BadDataBlock b={d.bad_data} />
          <p className='mt-1 text-[11.5px] text-[var(--tm-muted)]'>
            The last 7 days of after-write integrity checks.{' '}
            <SafeLink to='/data-integrity' className={LINK}>
              Open Data Integrity
            </SafeLink>
          </p>
        </Section>
      )}
    </>
  )
}

register(inspectorPanels, {
  id: 'security-caller',
  order: 16,
  applies: (sel) => sel.kind === 'caller',
  Component: inPage(CallerSecurityPanel)
})

// ── Security page panel ──────────────────────────────────────────────────────
export const securityOpen = createStore(false)

function SecurityMenuItem() {
  const open = useStore(securityOpen)
  const frozen = useFrozenSnapshotId()
  const summary = useSummary()
  if (frozen) return null
  const n = Object.keys(summary?.flags ?? {}).length
  return (
    <button
      type='button'
      id='tm-security-toggle'
      aria-pressed={open}
      onClick={() => securityOpen.set(!open)}
      data-tip='Flagged sessions, wrong-environment clients and bad data, by caller'
      className={cn(
        BTN,
        open && 'border-[var(--tm-accent)] bg-[var(--tm-accent-soft)] text-[var(--tm-accent-ink)]'
      )}
    >
      <ShieldAlert className='h-3.5 w-3.5' aria-hidden='true' />
      Security
      {n > 0 ? <span className='tabular-nums text-[var(--tm-update)]'>{n}</span> : null}
    </button>
  )
}

function CallerButton({ caller, name }: { caller: string; name: string }) {
  const { setSelection } = useTrafficMap()
  // job / import writers (src:…, cron) have no caller node to open
  if (!/^(u[0-9A-Fa-f-]{36}|k\d+|anon)$/.test(caller))
    return <span className='block truncate text-[12px] font-semibold'>{name}</span>
  return (
    <button
      type='button'
      className='min-w-0 truncate text-left text-[12px] font-semibold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
      onClick={() => setSelection({ kind: 'caller', id: caller })}
    >
      {name}
    </button>
  )
}

function SecurityPanel() {
  const open = useStore(securityOpen)
  const { win, ready, paused } = useTrafficMap()
  const live = open && ready
  const sessions = useQuery({
    queryKey: ['traffic-map', 'security', 'sessions'],
    queryFn: async () =>
      (await api.get('/traffic-map/security/sessions')).data.data as {
        sessions: SessionView[]
        known_proxies: number
        geo: GeoStatus
      },
    enabled: live,
    refetchInterval: paused ? false : 15_000
  })
  const mis = useQuery({
    queryKey: ['traffic-map', 'security', 'misconfigured', win],
    queryFn: async () =>
      (await api.get('/traffic-map/security/misconfigured', { params: { window: win } })).data
        .data as {
        findings: MisconfigFinding[]
        registry: { configured: boolean; self: string | null; components: number }
      },
    enabled: live,
    refetchInterval: paused ? false : 30_000
  })
  const bad = useQuery({
    queryKey: ['traffic-map', 'security', 'bad-data'],
    queryFn: async () =>
      (await api.get('/traffic-map/security/bad-data')).data.data as {
        callers: BadDataCaller[]
      },
    enabled: live,
    refetchInterval: paused ? false : 60_000
  })
  const name = usePeopleNames([
    ...(sessions.data?.sessions ?? []).map((s) => s.caller),
    ...(mis.data?.findings ?? []).map((f) => f.caller),
    ...(bad.data?.callers ?? []).map((b) => b.caller)
  ])
  if (!open) return null
  const H3 = 'mb-1.5 text-[12px] font-medium text-[var(--tm-muted)]'
  const NOTE = 'mt-2 text-[11.5px] text-[var(--tm-muted)]'
  return (
    <section
      className='min-w-0 rounded-lg border border-[var(--tm-line)] bg-[var(--tm-card)]'
      aria-label='Security'
      id='tm-security'
    >
      <div className='flex flex-wrap items-start justify-between gap-3 border-b border-[var(--tm-line-2)] px-3.5 py-2'>
        <div className='min-w-0'>
          <h2 className='text-[13px] font-semibold'>Security</h2>
          <p className='text-[11.5px] text-[var(--tm-muted)]'>
            Sessions that look scripted or used from two places, clients aimed at the wrong
            environment, and bad data by the caller that wrote it.
          </p>
        </div>
        <button type='button' className={BTN} onClick={() => securityOpen.set(false)}>
          Close
        </button>
      </div>
      <div className='grid gap-4 px-3.5 py-3 min-[1100px]:grid-cols-3'>
        <div className='min-w-0'>
          <h3 className={H3}>Flagged sessions</h3>
          {sessions.isLoading ? (
            <Empty>Loading…</Empty>
          ) : sessions.isError ? (
            <Note tone='error'>Could not be read.</Note>
          ) : !sessions.data?.sessions.length ? (
            <Empty>No session looks scripted or shared in the last 30 minutes.</Empty>
          ) : (
            <ul className='grid gap-3' id='tm-security-flagged'>
              {sessions.data.sessions.map((s) => (
                <li key={s.id} className='min-w-0'>
                  <CallerButton caller={s.caller} name={name(s.caller)} />
                  <SessionCard s={s} />
                </li>
              ))}
            </ul>
          )}
          <p className={NOTE}>
            Cookie sessions only. Private addresses
            {sessions.data?.known_proxies
              ? ` and ${sessions.data.known_proxies} known proxy ranges`
              : ''}{' '}
            are left out; <code className={MONO}>TRAFFIC_KNOWN_PROXIES</code> lists shared gateways.
          </p>
        </div>
        <div className='min-w-0'>
          <h3 className={H3}>Wrong environment</h3>
          {mis.isLoading ? (
            <Empty>Loading…</Empty>
          ) : mis.isError ? (
            <Note tone='error'>Could not be read.</Note>
          ) : !mis.data?.findings.length ? (
            <Empty>
              {mis.data?.registry.configured === false
                ? 'Register your environments (Environments page) to check clients against them.'
                : 'No client looks aimed at another environment.'}
            </Empty>
          ) : (
            <ul className='grid gap-2' id='tm-security-env'>
              {mis.data.findings.map((f) => (
                <li key={`${f.caller}-${f.kind}-${f.text}`} className='min-w-0 text-[12px]'>
                  <CallerButton
                    caller={f.caller}
                    name={f.caller === 'anon' ? 'Not signed in' : name(f.caller)}
                  />
                  <p className='break-words text-[var(--tm-fg-2)]'>{f.text}</p>
                </li>
              ))}
            </ul>
          )}
          {mis.data?.registry.self ? (
            <p className={NOTE}>This instance is {mis.data.registry.self} in the registry.</p>
          ) : null}
        </div>
        <div className='min-w-0'>
          <h3 className={H3}>Bad data by caller</h3>
          {bad.isLoading ? (
            <Empty>Loading…</Empty>
          ) : bad.isError ? (
            <Note tone='error'>Could not be read.</Note>
          ) : !bad.data?.callers.length ? (
            <Empty>No after-write integrity findings in the last 7 days.</Empty>
          ) : (
            <ul className='grid gap-3' id='tm-security-bad'>
              {bad.data.callers.slice(0, 8).map((b) => (
                <li key={b.caller} className='min-w-0'>
                  <CallerButton
                    caller={b.caller}
                    name={b.caller.startsWith('src:') ? b.caller.slice(4) : name(b.caller)}
                  />
                  <BadDataBlock b={b} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  )
}

register(toolbarItems, {
  id: 'security',
  order: 61,
  slot: 'menu',
  Component: inPage(SecurityMenuItem)
})
register(pagePanels, { id: 'security', order: 6, wide: true, Component: inPage(SecurityPanel) })
