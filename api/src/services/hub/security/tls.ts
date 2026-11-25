import { promises as dnsPromises } from 'node:dns'
import { type PeerCertificate, connect as tlsConnect } from 'node:tls'
import { db } from '../../../db/index.js'
import { parseJson } from '../../pipeline-engine.js'
import { deliverHubNotice, hubEventRecipients } from '../notify-events.js'
import { dropCalendarEntry, putCalendarEntry } from './seams.js'

/**
 * TLS / domain watch (Hub enhancement 44): for every environment's address (base_url) and every
 * extra hostname it answers on, the Hub resolves the name (DNS) and reads the certificate the
 * server presents (a TLS handshake only — nothing is sent after it), each bounded by
 * TLS_TIMEOUT_MS. The certificate is read even when it does not verify (expired, wrong name,
 * private CA): `authorized` and the error code say so.
 *
 * Warnings go to the app's owners + Hub admins (deliverHubNotice) once per threshold — 30, 14
 * and 3 days before expiry, and when it has expired — and once when a name stops resolving; a
 * renewed certificate (more than 30 days again) resets them. Each certificate expiry is also a
 * change-calendar entry (kind `tls`, services/hub/changes/calendar.ts).
 *
 * The names are the Hub's own environments (admin-entered), the same hosts the fleet probe
 * calls; plain-http addresses and IP literals are checked for DNS only (no certificate).
 */

export const CERTS = 'nivaro_hub_cert_checks'
export const TLS_TIMEOUT_MS = 8_000
export const WARN_DAYS = [30, 14, 3] as const
const CONCURRENCY = 6
const DAY = 86_400_000

export interface HostTarget {
  environment_id: number
  app_id: number
  env_key: string
  hostname: string
  port: number
  tls: boolean
}

export interface CertFacts {
  dns_ok: boolean
  addresses: string[]
  expires_at: Date | null
  issuer: string | null
  subject: string | null
  authorized: boolean | null
  error_code: string | null
}

export interface TlsDeps {
  now?: () => Date
  probe?: (t: HostTarget) => Promise<CertFacts>
  notice?: typeof deliverHubNotice
  recipients?: (appId: number) => Promise<string[]>
}

const IP_RE = /^(\d{1,3}(\.\d{1,3}){3}|\[?[0-9a-f:]+\]?)$/i
const HOST_RE =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i

/** Every (environment, hostname) the watch covers. Pure over the rows. */
export function hostTargets(
  envs: Array<{ id: unknown; app_id: unknown; key: unknown; base_url: unknown; hostnames: unknown }>
): HostTarget[] {
  const out: HostTarget[] = []
  for (const e of envs) {
    const seen = new Set<string>()
    const add = (hostname: string, port: number, tls: boolean) => {
      const h = hostname.toLowerCase().replace(/\.$/, '')
      if (!h || seen.has(h) || (!HOST_RE.test(h) && !IP_RE.test(h))) return
      seen.add(h)
      out.push({
        environment_id: Number(e.id),
        app_id: Number(e.app_id),
        env_key: String(e.key),
        hostname: h,
        port,
        tls: tls && !IP_RE.test(h)
      })
    }
    try {
      const u = new URL(String(e.base_url ?? ''))
      const https = u.protocol === 'https:'
      add(u.hostname, u.port ? Number(u.port) : https ? 443 : 80, https)
    } catch {
      // no usable base URL
    }
    const raw = typeof e.hostnames === 'string' ? parseJson(e.hostnames) : e.hostnames
    if (Array.isArray(raw)) for (const h of raw) if (typeof h === 'string') add(h.trim(), 443, true)
  }
  return out
}

function nameOf(v: unknown): string | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const cn = Array.isArray(o.CN) ? o.CN[0] : o.CN
  const org = Array.isArray(o.O) ? o.O[0] : o.O
  const s = [cn, org].filter((x) => typeof x === 'string' && x).join(' · ')
  return s ? s.slice(0, 300) : null
}

function withTimeout<T>(p: Promise<T>, ms: number, code: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    p,
    new Promise<T>((_r, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(code), { code })), ms)
    })
  ]).finally(() => clearTimeout(timer))
}

/** DNS + the presented certificate of one host (see the header). Never throws. */
export async function probeHost(t: HostTarget): Promise<CertFacts> {
  const facts: CertFacts = {
    dns_ok: false,
    addresses: [],
    expires_at: null,
    issuer: null,
    subject: null,
    authorized: null,
    error_code: null
  }
  try {
    const found = await withTimeout(
      dnsPromises.lookup(t.hostname.replace(/^\[|\]$/g, ''), { all: true }),
      TLS_TIMEOUT_MS,
      'DNS_TIMEOUT'
    )
    facts.addresses = found.map((a) => a.address).slice(0, 8)
    facts.dns_ok = facts.addresses.length > 0
  } catch (err) {
    facts.error_code = String((err as { code?: unknown }).code ?? 'DNS_FAILED').slice(0, 64)
    return facts
  }
  if (!t.tls) return facts
  try {
    const cert = await withTimeout(
      new Promise<{ cert: PeerCertificate; authorized: boolean; error: string | null }>(
        (resolve, reject) => {
          const socket = tlsConnect({
            host: facts.addresses[0],
            port: t.port,
            servername: t.hostname,
            rejectUnauthorized: false,
            timeout: TLS_TIMEOUT_MS
          })
          socket.once('secureConnect', () => {
            const c = socket.getPeerCertificate()
            const error = socket.authorizationError ? String(socket.authorizationError) : null
            const authorized = socket.authorized
            socket.destroy()
            resolve({ cert: c, authorized, error })
          })
          socket.once('timeout', () => {
            socket.destroy()
            reject(Object.assign(new Error('TLS_TIMEOUT'), { code: 'TLS_TIMEOUT' }))
          })
          socket.once('error', (err) => {
            socket.destroy()
            reject(err)
          })
        }
      ),
      TLS_TIMEOUT_MS + 1000,
      'TLS_TIMEOUT'
    )
    const exp = cert.cert?.valid_to ? new Date(cert.cert.valid_to) : null
    facts.expires_at = exp && Number.isFinite(exp.getTime()) ? exp : null
    facts.issuer = nameOf(cert.cert?.issuer)
    facts.subject = nameOf(cert.cert?.subject)
    facts.authorized = cert.authorized
    if (!cert.authorized && cert.error) facts.error_code = cert.error.slice(0, 64)
    if (!facts.expires_at) facts.error_code = facts.error_code ?? 'NO_CERTIFICATE'
  } catch (err) {
    facts.error_code = String((err as { code?: unknown }).code ?? 'TLS_FAILED').slice(0, 64)
  }
  return facts
}

export type CertState = 'ok' | 'warning' | 'expired' | 'error'

/** State + the warning level now due (30/14/3/0) for one result. Pure. */
export function judgeCert(
  f: CertFacts,
  tls: boolean,
  now: number
): { state: CertState; level: number | null; days: number | null } {
  if (!f.dns_ok) return { state: 'error', level: null, days: null }
  if (!tls) return { state: 'ok', level: null, days: null }
  if (!f.expires_at) return { state: 'error', level: null, days: null }
  const days = Math.floor((f.expires_at.getTime() - now) / DAY)
  if (f.expires_at.getTime() <= now) return { state: 'expired', level: 0, days }
  const level = [...WARN_DAYS].reverse().find((d) => days < d) ?? null
  // Not verifying (wrong name, private CA) is an error even with time left.
  if (f.authorized === false) return { state: 'error', level, days }
  return { state: level == null ? 'ok' : 'warning', level, days }
}

async function warn(
  t: HostTarget,
  subject: string,
  message: string,
  urgent: boolean,
  deps: TlsDeps
): Promise<void> {
  try {
    const people = await (deps.recipients ?? hubEventRecipients)(t.app_id)
    await (deps.notice ?? deliverHubNotice)(people, {
      subject,
      message,
      path: '/hub/security',
      urgent,
      source: { kind: 'hub_tls', label: 'Certificate watch', id: t.environment_id },
      why: 'You are a Hub administrator or an owner of this app; the Hub watches its certificates.'
    })
  } catch {
    // never stops the watch
  }
}

/** One full pass over every environment (the security tick). */
export async function tlsWatchTick(
  deps: TlsDeps = {}
): Promise<{ checked: number; warned: number }> {
  const now = (deps.now ?? (() => new Date()))()
  const envs = (await db('nivaro_hub_environments')
    .whereNot('status', 'archived')
    .select('id', 'app_id', 'key', 'base_url', 'hostnames')) as Array<Record<string, unknown>>
  const targets = hostTargets(
    envs as Array<{
      id: unknown
      app_id: unknown
      key: unknown
      base_url: unknown
      hostnames: unknown
    }>
  )
  const probe = deps.probe ?? probeHost
  let warned = 0
  let next = 0
  const work = async () => {
    while (next < targets.length) {
      const t = targets[next++]
      const f = await probe(t).catch(
        (): CertFacts => ({
          dns_ok: false,
          addresses: [],
          expires_at: null,
          issuer: null,
          subject: null,
          authorized: null,
          error_code: 'PROBE_FAILED'
        })
      )
      const n = await record(t, f, now, deps)
      warned += n
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, work))
  // Hosts no longer listed (environment removed, name dropped): their rows and calendar entries go.
  const keep = new Set(targets.map((t) => `${t.environment_id}:${t.hostname}`))
  const rows = (await db(CERTS).select('id', 'environment_id', 'hostname')) as Array<{
    id: unknown
    environment_id: unknown
    hostname: unknown
  }>
  for (const r of rows) {
    const key = `${r.environment_id}:${r.hostname}`
    if (keep.has(key)) continue
    await db(CERTS).where({ id: r.id }).delete()
    await dropCalendarEntry('tls', key)
  }
  return { checked: targets.length, warned }
}

async function record(t: HostTarget, f: CertFacts, now: Date, deps: TlsDeps): Promise<number> {
  const key = `${t.environment_id}:${t.hostname}`
  const prev = (await db(CERTS)
    .where({ environment_id: t.environment_id, hostname: t.hostname })
    .first('id', 'warned_level', 'dns_warned', 'expires_at')) as
    | { id: unknown; warned_level: unknown; dns_warned: unknown; expires_at: unknown }
    | undefined
  const j = judgeCert(f, t.tls, now.getTime())
  const prevLevel = prev?.warned_level == null ? null : Number(prev.warned_level)
  let level = prevLevel
  let warned = 0
  // Renewed: more than 30 days again → the thresholds start over.
  if (j.level == null && f.expires_at) level = null
  if (j.level != null && (prevLevel == null || j.level < prevLevel)) {
    level = j.level
    warned++
    const where = `${t.hostname} (${t.env_key})`
    const when = f.expires_at ? f.expires_at.toISOString().slice(0, 10) : '?'
    await warn(
      t,
      j.level === 0
        ? `Certificate expired: ${where}`
        : `Certificate expires in ${j.days} days: ${where}`,
      j.level === 0
        ? `The certificate of ${t.hostname} expired on ${when}. Renew it now.`
        : `The certificate of ${t.hostname} expires on ${when}. Renew it before then.`,
      j.level <= 3,
      deps
    )
  }
  const dnsWarnedBefore = prev?.dns_warned === true || prev?.dns_warned === 1
  let dnsWarned = dnsWarnedBefore
  if (!f.dns_ok && !dnsWarnedBefore) {
    dnsWarned = true
    warned++
    await warn(
      t,
      `Name does not resolve: ${t.hostname} (${t.env_key})`,
      `${t.hostname} did not resolve (${f.error_code ?? 'DNS'}). Check its DNS record.`,
      true,
      deps
    )
  } else if (f.dns_ok) dnsWarned = false
  const row = {
    port: t.port,
    state: j.state,
    expires_at: f.expires_at,
    issuer: f.issuer,
    subject: f.subject,
    authorized: f.authorized,
    dns_ok: f.dns_ok,
    addresses: f.addresses.join(', ').slice(0, 500) || null,
    error_code: f.error_code,
    warned_level: level,
    dns_warned: dnsWarned,
    checked_at: now
  }
  if (prev) await db(CERTS).where({ id: prev.id }).update(row)
  else await db(CERTS).insert({ environment_id: t.environment_id, hostname: t.hostname, ...row })
  if (f.expires_at)
    await putCalendarEntry({
      source: 'tls',
      key,
      kind: 'tls',
      title: `Certificate of ${t.hostname} expires`,
      description: f.issuer ? `Issued by ${f.issuer}` : null,
      app_id: t.app_id,
      environment_id: t.environment_id,
      starts_at: f.expires_at
    })
  return warned
}

export interface CertRow {
  id: number
  environment_id: number
  hostname: string
  port: number
  state: CertState
  expires_at: string | null
  days_left: number | null
  issuer: string | null
  subject: string | null
  authorized: boolean | null
  dns_ok: boolean | null
  addresses: string | null
  error_code: string | null
  checked_at: string | null
}

const iso = (v: unknown): string | null => {
  if (v == null || v === '') return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isFinite(d.getTime()) ? d.toISOString() : null
}
const flag = (v: unknown) => (v == null ? null : v === true || v === 1 || v === '1')

export async function listCerts(envIds: number[] | null, now = new Date()): Promise<CertRow[]> {
  const q = db(CERTS).orderBy([
    { column: 'expires_at', order: 'asc' },
    { column: 'hostname', order: 'asc' }
  ])
  if (envIds) {
    if (!envIds.length) return []
    q.whereIn('environment_id', envIds.slice(0, 2000))
  }
  const rows = (await q.select()) as Array<Record<string, unknown>>
  return rows.map((r) => {
    const exp = iso(r.expires_at)
    return {
      id: Number(r.id),
      environment_id: Number(r.environment_id),
      hostname: String(r.hostname),
      port: Number(r.port ?? 443),
      state: String(r.state) as CertState,
      expires_at: exp,
      days_left: exp ? Math.floor((Date.parse(exp) - now.getTime()) / DAY) : null,
      issuer: r.issuer == null ? null : String(r.issuer),
      subject: r.subject == null ? null : String(r.subject),
      authorized: flag(r.authorized),
      dns_ok: flag(r.dns_ok),
      addresses: r.addresses == null ? null : String(r.addresses),
      error_code: r.error_code == null ? null : String(r.error_code),
      checked_at: iso(r.checked_at)
    }
  })
}
