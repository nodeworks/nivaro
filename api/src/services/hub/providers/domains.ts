import { db } from '../../../db/index.js'
import { deliverHubNotice, hubEventRecipients } from '../notify-events.js'
import { dropCalendarEntry, putCalendarEntry } from '../security/seams.js'
import { contextFor, type OpenConnection, openConnection, regionFor } from './engine/plan.js'
import { type DomainRenewal, domainRenewalFor } from './hooks/domain-renewal.js'
import { ensureCoreProviders } from './index.js'
import { hubNotify } from './notify-hook.js'
import { findType } from './registry.js'
import { renewDaysOf } from './renewal-window.js'
import { type HubResourceRow, listResources } from './store.js'
import type { HealthAnswer } from './types.js'

/**
 * Hub providers, Wave 3 framework (Task 34): the domain expiry watch. Every managed resource whose
 * type is a registrar domain (`ResourceTypeSpec.registrar`, `<provider>.domain` in Tasks 40 and
 * 43) is asked for its `health`; its `details` say when the registration ends (`expiresAt`),
 * whether it renews by itself (`autoRenew`) and whether the transfer lock is on (`locked`). The
 * result lands in nivaro_hub_domain_checks and /hub/security lists it beside the TLS
 * certificates. Runs with the certificate watch (every 6 hours, `hub-security-tick`, and the
 * Check now button).
 *
 * Warnings go to the app's owners + Hub admins (in the Hub) and out through notify routes
 * (`domain.expiring`) once per threshold: 45 days, 14 days and when it has expired. A domain that
 * renews by itself skips the 45-day warning (the registrar renews it before then; a failed
 * renewal still warns at 14 days). A renewed domain (more than 45 days again) resets them.
 */

export const DOMAIN_CHECKS = 'nivaro_hub_domain_checks'
export const DOMAIN_WARN_DAYS = [45, 14] as const
export const DOMAIN_HEALTH_TIMEOUT_MS = 10_000
const CONCURRENCY = 4
const DAY = 86_400_000

export type DomainState = 'ok' | 'warning' | 'expired' | 'error'

export interface DomainFacts {
  expiresAt: Date | null
  autoRenew: boolean | null
  locked: boolean | null
  errorCode: string | null
}

const bool = (v: unknown): boolean | null =>
  v === true || v === 'true' ? true : v === false || v === 'false' ? false : null

/** What a registrar type's health answer says (pure). */
export function domainFactsOf(h: HealthAnswer | null): DomainFacts {
  const d = h?.details ?? {}
  const raw = d.expiresAt
  const exp = typeof raw === 'string' || typeof raw === 'number' ? new Date(raw) : null
  const expiresAt = exp && Number.isFinite(exp.getTime()) ? exp : null
  return {
    expiresAt,
    autoRenew: bool(d.autoRenew),
    locked: bool(d.locked),
    errorCode: expiresAt ? null : h ? 'NO_EXPIRY' : 'HEALTH_FAILED'
  }
}

/** State + the warning level now due (45 / 14 / 0 = expired) for one domain (pure). */
export function judgeDomain(
  f: DomainFacts,
  now: number
): { state: DomainState; level: number | null; days: number | null } {
  if (!f.expiresAt) return { state: 'error', level: null, days: null }
  const days = Math.floor((f.expiresAt.getTime() - now) / DAY)
  if (f.expiresAt.getTime() <= now) return { state: 'expired', level: 0, days }
  let level: number | null = [...DOMAIN_WARN_DAYS].reverse().find((d) => days < d) ?? null
  // Auto-renewing domains are renewed by the registrar before 45 days: only 14 days warns.
  if (level === 45 && f.autoRenew === true) level = null
  const warnZone = days < DOMAIN_WARN_DAYS[0]
  return { state: warnZone ? 'warning' : 'ok', level, days }
}

export interface DomainDeps {
  now?: () => Date
  /** The health answer of one domain resource (tests); default: the adapter, at most 10 s. */
  health?: (row: HubResourceRow) => Promise<HealthAnswer | null>
  notice?: typeof deliverHubNotice
  recipients?: (appId: number) => Promise<string[]>
  /** The outbound notify (Task 13 routes); default hubNotify. */
  notify?: typeof hubNotify
  /** Gap G-E: Hub auto-renew for a domain just read (tests); default hooks/domain-renewal.ts. */
  renew?: (row: HubResourceRow, name: string, expiresAt: Date | null) => Promise<DomainRenewal>
}

/** The managed registrar domains (live rows with a provider id). */
export async function domainResources(): Promise<HubResourceRow[]> {
  ensureCoreProviders()
  return (await listResources({})).filter(
    (r) => r.external_id && findType(r.type)?.type.registrar === true
  )
}

async function adapterHealth(
  row: HubResourceRow,
  conns: Map<number, Promise<OpenConnection | null>>
): Promise<HealthAnswer | null> {
  let c = conns.get(row.connection_id)
  if (!c) {
    c = openConnection(row.connection_id).catch(() => null)
    conns.set(row.connection_id, c)
  }
  const conn = await c
  if (!conn?.adapter.health || conn.row.status === 'disabled' || !row.external_id) return null
  const ac = new AbortController()
  const ctx = contextFor(conn, regionFor(conn.row.config, row.desired, row.observed), {
    signal: ac.signal
  })
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      conn.adapter.health(ctx, row.type, row.external_id),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          ac.abort()
          resolve(null)
        }, DOMAIN_HEALTH_TIMEOUT_MS)
      })
    ])
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

const domainName = (r: HubResourceRow) =>
  String(r.observed?.name ?? r.name ?? r.external_id ?? `#${r.id}`).slice(0, 253)

async function warn(
  row: HubResourceRow,
  name: string,
  j: { level: number; days: number | null },
  f: DomainFacts,
  deps: DomainDeps
): Promise<void> {
  const when = f.expiresAt ? f.expiresAt.toISOString().slice(0, 10) : '?'
  const subject =
    j.level === 0 ? `Domain expired: ${name}` : `Domain expires in ${j.days} days: ${name}`
  const message =
    j.level === 0
      ? `The registration of ${name} ended on ${when}. Renew it at the registrar now.`
      : `The registration of ${name} ends on ${when}${f.autoRenew === true ? ' and has not renewed by itself yet' : ''}. Renew it before then.`
  try {
    const people = await (deps.recipients ?? hubEventRecipients)(row.app_id ?? -1)
    await (deps.notice ?? deliverHubNotice)(people, {
      subject,
      message,
      path: '/hub/security',
      urgent: j.level <= 14,
      source: { kind: 'hub_domain', label: 'Domain watch', id: row.id },
      why: 'You are a Hub administrator or an owner of this app; the Hub watches its domains.'
    })
  } catch {
    // never stops the watch
  }
  ;(deps.notify ?? hubNotify)('domain.expiring', {
    appId: row.app_id,
    detail: j.level === 0 ? `${name} expired` : `${name} expires in ${j.days} days`,
    link: '/hub/security',
    severity: j.level <= 14 ? 'critical' : 'warning',
    dedupKey: `domain:${row.id}:${j.level}`
  })
}

/** Records one domain; answers 1 when it warned. */
async function record(
  row: HubResourceRow,
  f: DomainFacts,
  now: Date,
  deps: DomainDeps
): Promise<number> {
  const name = domainName(row)
  const prev = (await db(DOMAIN_CHECKS)
    .where({ resource_id: row.id })
    .first('id', 'warned_level')) as { id: unknown; warned_level: unknown } | undefined
  const j = judgeDomain(f, now.getTime())
  const prevLevel = prev?.warned_level == null ? null : Number(prev.warned_level)
  let level = prevLevel
  let warned = 0
  // Renewed (out of every warning window again) → the thresholds start over.
  if (j.level == null && f.expiresAt && j.state === 'ok') level = null
  if (j.level != null && (prevLevel == null || j.level < prevLevel)) {
    level = j.level
    warned = 1
    await warn(row, name, { level: j.level, days: j.days }, f, deps)
  }
  const values = {
    connection_id: row.connection_id,
    app_id: row.app_id,
    domain: name,
    expires_at: f.expiresAt,
    auto_renew: f.autoRenew,
    locked: f.locked,
    state: j.state,
    error_code: f.errorCode,
    warned_level: level,
    checked_at: now
  }
  if (prev) await db(DOMAIN_CHECKS).where({ id: prev.id }).update(values)
  else await db(DOMAIN_CHECKS).insert({ resource_id: row.id, ...values })
  // Gap G-E: a domain the Hub renews by itself (off by default) is renewed from this fresh read.
  await (deps.renew ?? ((r, n, e) => domainRenewalFor(r, n, e)))(row, name, f.expiresAt).catch(
    () => undefined
  )
  if (f.expiresAt)
    await putCalendarEntry({
      source: 'domain',
      key: String(row.id),
      kind: 'tls',
      title: `Domain ${name} registration ends`,
      description: f.autoRenew === true ? 'Renews by itself' : 'Does not renew by itself',
      app_id: row.app_id,
      environment_id: row.environment_id,
      starts_at: f.expiresAt
    })
  return warned
}

/** One pass over every managed registrar domain. Never throws for one domain's failure. */
export async function domainWatchTick(
  deps: DomainDeps = {}
): Promise<{ checked: number; warned: number }> {
  const now = (deps.now ?? (() => new Date()))()
  const rows = await domainResources()
  const conns = new Map<number, Promise<OpenConnection | null>>()
  const health = deps.health ?? ((r: HubResourceRow) => adapterHealth(r, conns))
  let warned = 0
  let next = 0
  const work = async () => {
    while (next < rows.length) {
      const r = rows[next++]
      const h = await health(r).catch(() => null)
      warned += await record(r, domainFactsOf(h), now, deps).catch(() => 0)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, work))
  // Domains no longer managed: their rows and calendar entries go.
  const keep = new Set(rows.map((r) => r.id))
  const stored = (await db(DOMAIN_CHECKS).select('id', 'resource_id')) as Array<{
    id: unknown
    resource_id: unknown
  }>
  for (const s of stored) {
    if (keep.has(Number(s.resource_id))) continue
    await db(DOMAIN_CHECKS).where({ id: s.id }).delete()
    await dropCalendarEntry('domain', String(s.resource_id))
  }
  return { checked: rows.length, warned }
}

export interface DomainRow {
  id: number
  resource_id: number
  connection_id: number
  app_id: number | null
  domain: string
  state: DomainState
  expires_at: string | null
  days_left: number | null
  auto_renew: boolean | null
  locked: boolean | null
  /** Gap G-E: days before the end the Hub renews this domain by itself (null = it does not). */
  hub_renew_days: number | null
  /** Namecheap's own auto-renew cannot be changed through its API (shown read only). */
  renew_read_only: boolean
  error_code: string | null
  checked_at: string | null
}

const iso = (v: unknown): string | null => {
  if (v == null || v === '') return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isFinite(d.getTime()) ? d.toISOString() : null
}
const flag = (v: unknown) => (v == null ? null : v === true || v === 1 || v === '1')

/** Domain rows for /hub/security: `appIds` null = every one (admins); owners see their apps'. */
export async function listDomains(appIds: number[] | null, now = new Date()): Promise<DomainRow[]> {
  try {
    if (!(await db.schema.hasTable(DOMAIN_CHECKS))) return []
    const q = db(DOMAIN_CHECKS).orderBy([
      { column: 'expires_at', order: 'asc' },
      { column: 'domain', order: 'asc' }
    ])
    if (appIds) {
      if (!appIds.length) return []
      q.whereIn('app_id', appIds.slice(0, 2000))
    }
    const rows = (await q.select()) as Array<Record<string, unknown>>
    const res = new Map<number, HubResourceRow>()
    const ids = rows.map((r) => Number(r.resource_id)).filter((x) => Number.isFinite(x))
    if (ids.length)
      for (const r of await listResources({ ids: ids.slice(0, 2000) })) res.set(r.id, r)
    return rows.map((r) => {
      const hub = res.get(Number(r.resource_id))
      const exp = iso(r.expires_at)
      return {
        id: Number(r.id),
        resource_id: Number(r.resource_id),
        connection_id: Number(r.connection_id),
        app_id: r.app_id == null ? null : Number(r.app_id),
        domain: String(r.domain),
        state: String(r.state) as DomainState,
        expires_at: exp,
        days_left: exp ? Math.floor((Date.parse(exp) - now.getTime()) / DAY) : null,
        auto_renew: flag(r.auto_renew),
        locked: flag(r.locked),
        hub_renew_days: hub?.desired?.hub_auto_renew === true ? renewDaysOf(hub.desired) : null,
        renew_read_only: hub?.type === 'namecheap.domain',
        error_code: r.error_code == null ? null : String(r.error_code),
        checked_at: iso(r.checked_at)
      }
    })
  } catch {
    return []
  }
}
