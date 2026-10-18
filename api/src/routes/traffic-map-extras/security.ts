/**
 * Traffic Map security lenses (#2154 #2204 #2235 #2236 #2257 #2196). Importing the tap modules
 * here registers them at boot. Routes land under /api/traffic-map, admin only, 404 in cloud mode
 * (the parent plugin's hooks). Addresses and user agents are only ever in these admin responses —
 * never on socket frames or stored snapshots.
 *
 * GET /security/summary?window=     caller key → flags (badges): two places, scripted, wrong
 *                                   environment, new place, bad data
 * GET /security/caller?caller=&window=  one caller: places, flagged sessions (addresses + user
 *                                   agents), wrong-environment findings, bad data it wrote
 * GET /security/sessions            every flagged session (scripted / two places)
 * GET /security/misconfigured?window=   wrong-environment findings against the Environments registry
 * GET /security/bad-data?days=      Data Integrity findings by the caller whose write made them
 * GET /security/http-cache?window=  per-route browser caching: 304 rate, headers sent, flags
 */
import type { FastifyInstance } from 'fastify'
import { db } from '../../db/index.js'
import { hasColumn } from '../../lib/column-probe.js'
import { selectInChunks } from '../../services/db-batch.js'
import { partitionSelf } from '../../services/environment-self.js'
import { geoStatus } from '../../services/traffic-geoip.js'
import { currentTrafficSec, seenCallerKeys } from '../../services/traffic-map.js'
import {
  attributeFindings,
  type BadDataCaller,
  cacheVerdicts,
  type EnvComponent,
  hostOf,
  type IntegrityRow,
  knownProxies,
  type MisconfigFinding,
  misconfigFindings,
  uaLabel,
  type WriteRow
} from '../../services/traffic-security.js'
import { enableTwoPlacesAlerts } from '../../services/traffic-security-alerts.js'
import { geoFlags, geoOf } from '../../services/traffic-taps/caller-geo.js'
import { cacheRows } from '../../services/traffic-taps/http-cache.js'
import { misconfigFacts } from '../../services/traffic-taps/misconfigured.js'
import { type Addr, flaggedSessions, type Sess } from '../../services/traffic-taps/session-guard.js'
import { tapState } from '../../services/traffic-taps.js'

const WINDOWS = new Set([60, 300, 900])
const CALLER_RE = /^(u[0-9A-Fa-f-]{36}|k\d{1,9}|anon|cron|src:[\w:.-]{1,80})$/
/** How long a new place keeps its badge. */
const NEW_PLACE_BADGE_S = 3600
const CACHE_MS = 60_000
const BAD_DATA_ROWS = 2000

function windowOf(q: { window?: string }): number {
  const w = Number(q.window ?? 300)
  return WINDOWS.has(w) ? w : 300
}

export interface Flag {
  kind: 'two-places' | 'scripted' | 'misconfigured' | 'new-place' | 'bad-data'
  tone: 'error' | 'warn' | 'info'
  text: string
}

// ── shared reads (cached per store for a minute) ──────────────────────────────
interface Cached<T> {
  at: number
  key: string
  v: T
}
function cachedRead<T>(id: string, key: string, read: () => Promise<T>): Promise<T> {
  const slot = tapState<{ c: Cached<Promise<T>> | null }>(`security-route:${id}`, () => ({
    c: null
  }))
  const now = Date.now()
  if (slot.c && slot.c.key === key && now - slot.c.at < CACHE_MS) return slot.c.v
  const v = read().catch((err) => {
    slot.c = null
    throw err
  })
  slot.c = { at: now, key, v }
  return v
}

interface Registry {
  components: EnvComponent[]
  self: string | null
  configured: boolean
}
function readRegistry(requestHost: string): Promise<Registry> {
  return cachedRead('registry', requestHost, async () => {
    const envs = (await db('nivaro_environments')
      .select('id', 'name')
      .catch(() => [])) as Array<{ id: number; name: string }>
    const comps = (await db('nivaro_environment_components')
      .whereNotNull('base_url')
      .select('name', 'environment', 'kind', 'base_url')
      .catch(() => [])) as Array<{
      name: string
      environment: number
      kind: string
      base_url: string | null
    }>
    const { selfEnvironment } = partitionSelf(comps, envs, requestHost)
    const components: EnvComponent[] = []
    for (const c of comps) {
      const host = hostOf(c.base_url)
      const env = envs.find((e) => e.id === c.environment)?.name
      if (host && env) components.push({ name: c.name, environment: env, kind: c.kind, host })
    }
    return { components, self: selfEnvironment, configured: comps.length > 0 }
  })
}

async function keyNames(
  callers: string[]
): Promise<Array<{ caller: string; name: string | null }>> {
  const ids = callers.filter((c) => /^k\d{1,9}$/.test(c)).map((c) => Number(c.slice(1)))
  if (ids.length === 0) return []
  const rows = (await selectInChunks(ids.slice(0, 500), 500, (chunk) =>
    db('nivaro_api_keys').whereIn('id', chunk).select('id', 'name')
  ).catch(() => [])) as Array<{ id: number; name: string | null }>
  return rows.map((r) => ({ caller: `k${r.id}`, name: r.name ?? null }))
}

async function misconfigured(windowS: number, requestHost: string) {
  const sec = currentTrafficSec()
  const facts = misconfigFacts(windowS, sec)
  const reg = await readRegistry(requestHost)
  const keys = await cachedRead('key-names', String(windowS), () =>
    keyNames([...new Set([...seenCallerKeys(), ...Object.keys(facts.referers)])])
  )
  return {
    findings: misconfigFindings({ ...facts, keys }, reg.components, reg.self),
    registry: { configured: reg.configured, self: reg.self, components: reg.components.length }
  }
}

function badData(days: number): Promise<BadDataCaller[]> {
  return cachedRead('bad-data', String(days), async () => {
    const since = new Date(Date.now() - days * 86_400_000)
    const rows = (await db('nivaro_record_integrity')
      .where('source', 'write')
      .where('checked_at', '>=', since)
      .whereNot('findings', '[]')
      .orderBy('checked_at', 'desc')
      .limit(BAD_DATA_ROWS)
      .select('collection', 'item_id', 'findings', 'checked_at')
      .catch(() => [])) as IntegrityRow[]
    if (rows.length === 0) return []
    const [hasKey, hasAuth, hasOrigin] = await Promise.all([
      hasColumn('nivaro_activity', 'api_key_id'),
      hasColumn('nivaro_activity', 'auth_method'),
      hasColumn('nivaro_activity', 'origin')
    ])
    const cols = ['collection', 'item', 'user', 'timestamp']
    if (hasKey) cols.push('api_key_id')
    if (hasAuth) cols.push('auth_method')
    if (hasOrigin) cols.push('origin')
    const byCol = new Map<string, string[]>()
    for (const r of rows) {
      const list = byCol.get(r.collection) ?? []
      list.push(String(r.item_id))
      byCol.set(r.collection, list)
    }
    const writeSince = new Date(since.getTime() - 86_400_000)
    const writes: WriteRow[] = []
    for (const [collection, items] of byCol) {
      const got = (await selectInChunks([...new Set(items)], 500, (chunk) =>
        db('nivaro_activity')
          .where('collection', collection)
          .whereIn('item', chunk)
          .whereIn('action', ['create', 'update'])
          .where('timestamp', '>=', writeSince)
          .select(cols)
      ).catch(() => [])) as Array<Partial<WriteRow> & { collection: string; item: string }>
      for (const w of got)
        writes.push({
          collection: w.collection,
          item: String(w.item),
          user: w.user ?? null,
          api_key_id: w.api_key_id ?? null,
          auth_method: w.auth_method ?? null,
          origin: w.origin ?? null,
          timestamp: w.timestamp as Date
        })
    }
    return attributeFindings(rows, writes)
  })
}

// ── views ────────────────────────────────────────────────────────────────────
function addrView(a: Addr) {
  return {
    ip: a.ip,
    network: a.net,
    country: a.country,
    ua: a.ua,
    browser: uaLabel(a.ua),
    n: a.n,
    first_at: new Date(a.first).toISOString(),
    last_at: new Date(a.last).toISOString()
  }
}
function sessionView(s: Sess) {
  return {
    id: s.id,
    caller: s.caller,
    last_at: new Date(s.lastAt).toISOString(),
    browser: uaLabel(s.ua),
    ua: s.ua,
    scripted: s.scripted
      ? {
          patterns: s.scripted.verdict.patterns,
          rate: s.scripted.verdict.rate,
          at: new Date(s.scripted.at).toISOString()
        }
      : null,
    two_places: s.twoPlaces
      ? {
          a: addrView(s.twoPlaces.a),
          b: addrView(s.twoPlaces.b),
          at: new Date(s.twoPlaces.at).toISOString(),
          confidence: s.twoPlaces.confidence
        }
      : null,
    addresses: [...s.addrs.values()].map(addrView)
  }
}

function flagsFor(
  sessions: Sess[],
  mis: MisconfigFinding[],
  newPlaces: Record<string, string>,
  bad: BadDataCaller[]
): Record<string, Flag[]> {
  const out: Record<string, Flag[]> = {}
  const add = (caller: string, f: Flag) => {
    const list = out[caller] ?? []
    if (!list.some((x) => x.kind === f.kind)) list.push(f)
    out[caller] = list
  }
  for (const s of sessions) {
    if (s.twoPlaces)
      add(s.caller, {
        kind: 'two-places',
        tone: s.twoPlaces.confidence === 'high' ? 'error' : 'warn',
        text: 'session from two places'
      })
    if (s.scripted) add(s.caller, { kind: 'scripted', tone: 'warn', text: 'scripted session' })
  }
  for (const m of mis)
    add(m.caller, {
      kind: 'misconfigured',
      tone: 'warn',
      text: m.environment ? `${m.environment} client` : 'unknown key'
    })
  for (const [caller, place] of Object.entries(newPlaces))
    add(caller, { kind: 'new-place', tone: 'info', text: `new place ${place}` })
  for (const b of bad)
    add(b.caller, { kind: 'bad-data', tone: 'warn', text: `${b.records} bad records` })
  const rank = { error: 0, warn: 1, info: 2 }
  for (const list of Object.values(out)) list.sort((a, b) => rank[a.tone] - rank[b.tone])
  return out
}

export async function securityRoutes(app: FastifyInstance): Promise<void> {
  enableTwoPlacesAlerts(app)

  app.get<{ Querystring: { window?: string } }>('/security/summary', async (req) => {
    const windowS = windowOf(req.query)
    const now = Date.now()
    const [mis, bad] = await Promise.all([
      misconfigured(windowS, req.host).catch(() => ({ findings: [] as MisconfigFinding[] })),
      badData(7).catch(() => [] as BadDataCaller[])
    ])
    const flags = flagsFor(
      flaggedSessions(now),
      mis.findings,
      geoFlags(NEW_PLACE_BADGE_S, now),
      bad
    )
    return { data: { at: new Date(now).toISOString(), window_s: windowS, flags } }
  })

  app.get<{ Querystring: { caller?: string; window?: string } }>(
    '/security/caller',
    async (req, reply) => {
      const caller = String(req.query.caller ?? '')
      if (!CALLER_RE.test(caller))
        return reply.code(400).send({ error: 'caller must be a caller key', code: 'BAD_CALLER' })
      const windowS = windowOf(req.query)
      const sec = currentTrafficSec()
      const key = caller.startsWith('u') ? `u${caller.slice(1).toUpperCase()}` : caller
      const [mis, bad] = await Promise.all([
        misconfigured(windowS, req.host).catch(() => ({ findings: [] as MisconfigFinding[] })),
        badData(7).catch(() => [] as BadDataCaller[])
      ])
      return {
        data: {
          caller: key,
          window_s: windowS,
          geo: { status: geoStatus(), view: geoOf(key, windowS, sec) },
          sessions: flaggedSessions(Date.now())
            .filter((s) => s.caller === key)
            .slice(0, 10)
            .map(sessionView),
          misconfigured: mis.findings.filter((f) => f.caller === key),
          bad_data: bad.find((b) => b.caller === key) ?? null
        }
      }
    }
  )

  app.get('/security/sessions', async () => {
    const sessions = flaggedSessions(Date.now()).slice(0, 100).map(sessionView)
    return {
      data: {
        sessions,
        known_proxies: knownProxies().length,
        geo: geoStatus()
      }
    }
  })

  app.get<{ Querystring: { window?: string } }>('/security/misconfigured', async (req) => {
    const windowS = windowOf(req.query)
    return { data: { window_s: windowS, ...(await misconfigured(windowS, req.host)) } }
  })

  app.get<{ Querystring: { days?: string } }>('/security/bad-data', async (req) => {
    const d = Number(req.query.days ?? 7)
    const days = Number.isFinite(d) ? Math.min(30, Math.max(1, Math.round(d))) : 7
    return { data: { days, callers: (await badData(days)).slice(0, 50) } }
  })

  app.get<{ Querystring: { window?: string } }>('/security/http-cache', async (req) => {
    const windowS = windowOf(req.query)
    const routes = cacheVerdicts(cacheRows(windowS, currentTrafficSec()))
    return {
      data: {
        window_s: windowS,
        routes: routes.slice(0, 150),
        flagged: routes.filter((r) => r.no_headers).length
      }
    }
  })
}
