import { type ClientVersion, judgeable, onOlderApi } from './client-version.js'

/**
 * Sticky force refresh. `POST /realtime/force-refresh` reaches the tabs connected at that
 * moment; a tab that is not (laptop asleep, network drop, a discarded tab) never heard it and
 * stayed on the old build. So every instruction is also remembered here — per tenant in Redis,
 * for FORCE_REFRESH_REMEMBER_HOURS (default 24, 0 = off), the newest FORCE_REFRESH_REMEMBER_MAX
 * (default 20) — and a socket that signs in later is told when it still owes one.
 *
 * Also the optional minimum client build per app (off until an administrator sets one): any tab
 * of that app on an older build is told to reload, on connect and when the rule is saved.
 *
 * Never a loop:
 *  - an instruction reaches only tabs whose page loaded BEFORE it was issued; a tab that reloaded
 *    for it loads after, and also reports the ids it reloaded for (`obeyed` in client:hello,
 *    a sessionStorage marker the shared client keeps per tab);
 *  - every connect-time send is claimed per tab and page load in Redis: once per page load, and
 *    at most MAX_PAGE_LOADS page loads per tab — a tab still on the old bundle after reloading
 *    (a cached bundle, a rule above what is deployed) stops being told.
 *
 * Builds compare as versions when both read as dotted numbers (0.3.12 < 0.3.13); any other build
 * (a commit hash) is "older" only when it differs from the minimum AND its page loaded before
 * the rule was set — a tab loaded afterwards got what is served now.
 * Twin: packages/shared/src/lib/force-reload.ts (compareBuilds / buildBelow) — change both.
 */

/** What the server pushes on `client:force-refresh`. The fields after `message` are optional:
 *  a client that predates them treats every push as before. */
export interface RefreshPayload {
  seconds: number
  message: string
  /** The instruction (or `min-<app>-<set_at>` for a minimum-build rule). */
  id?: string
  /** When the instruction was issued (server clock, ms). */
  issued_at?: number
  /** push = sent live; sticky = remembered, sent on a later connect; min-build = below the minimum. */
  reason?: 'push' | 'sticky' | 'min-build'
  min_build?: string
  set_at?: number
}

export interface RefreshTarget {
  /** One app only (null = every app). */
  app: string | null
  /** Upper-cased user ids (empty = everyone). */
  user_ids: string[]
  /** Only tabs older than the build current when it was issued. */
  older: boolean
}

export interface StoredRefresh {
  id: string
  issued_at: number
  issuer: string | null
  issuer_name: string | null
  seconds: number
  message: string
  target: RefreshTarget
  /** older: app → the build that was current when issued. */
  builds?: Record<string, string>
  /** older: the API version every replica served when issued (null = mixed / unknown). */
  api?: string | null
  /** older: apps whose deploy was still rolling (never judged). */
  settling?: string[]
}

export interface MinBuildRule {
  app: string
  build: string
  seconds: number
  message: string
  set_at: number
  set_by: string | null
  set_by_name: string | null
}

/** Who connected — what the socket's sign-in and client:hello said. */
export interface ConnectingClient {
  user_id: string
  app: string | null
  version: ClientVersion | null
  /** Instruction ids this tab already reloaded for (client:hello `obeyed`). */
  obeyed: string[]
}

/** The Redis calls used here (ioredis satisfies it; tests pass a memory fake). */
export interface StickyRedis {
  lpush(key: string, ...values: string[]): Promise<unknown>
  ltrim(key: string, start: number, stop: number): Promise<unknown>
  lrange(key: string, start: number, stop: number): Promise<string[]>
  del(key: string): Promise<unknown>
  rpush(key: string, ...values: string[]): Promise<unknown>
  expire(key: string, seconds: number): Promise<unknown>
  hset(key: string, field: string, value: string): Promise<unknown>
  hget(key: string, field: string): Promise<string | null>
  hdel(key: string, field: string): Promise<unknown>
  hgetall(key: string): Promise<Record<string, string>>
  hsetnx(key: string, field: string, value: string): Promise<number>
  hlen(key: string): Promise<number>
}

/** A tab is told at most on this many page loads per instruction / rule. */
export const MAX_PAGE_LOADS = 2
export const MIN_SECONDS = 5
export const MAX_SECONDS = 300
export const DEFAULT_MIN_BUILD_SECONDS = 30

export function rememberHours(): number {
  const raw = process.env.FORCE_REFRESH_REMEMBER_HOURS
  if (raw == null || raw.trim() === '') return 24
  const n = Number(raw)
  return Number.isFinite(n) ? Math.min(168, Math.max(0, n)) : 24
}

export function rememberMax(): number {
  const n = Number(process.env.FORCE_REFRESH_REMEMBER_MAX)
  return Number.isFinite(n) && n >= 1 ? Math.min(100, Math.floor(n)) : 20
}

const ttlSeconds = () => Math.max(60, Math.round(rememberHours() * 3600))

// Cloud: every key carries the tenant ('-' = self-hosted), so one tenant never reads another's.
const tenantPart = (tenant: string | null | undefined) => (tenant ? tenant : '-')
const listKey = (t: string | null) => `nvr:fr:${tenantPart(t)}:list`
const minKey = (t: string | null) => `nvr:fr:${tenantPart(t)}:min`
const sentKey = (t: string | null, rule: string, tab: string) =>
  `nvr:fr:${tenantPart(t)}:sent:${rule}:${tab}`

export function clampSeconds(v: unknown, fallback: number): number {
  return Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, Number(v) || fallback))
}

/** Remember an instruction (newest first, the last `rememberMax()` kept). False when off. */
export async function rememberRefresh(
  redis: StickyRedis | null,
  tenant: string | null,
  instr: StoredRefresh
): Promise<boolean> {
  if (!redis || rememberHours() <= 0) return false
  const key = listKey(tenant)
  try {
    await redis.lpush(key, JSON.stringify(instr))
    await redis.ltrim(key, 0, rememberMax() - 1)
    await redis.expire(key, ttlSeconds())
    return true
  } catch {
    return false
  }
}

function parseInstr(raw: string): StoredRefresh | null {
  try {
    const v = JSON.parse(raw) as StoredRefresh
    if (!v || typeof v.id !== 'string' || typeof v.issued_at !== 'number' || !v.target) return null
    return v
  } catch {
    return null
  }
}

/** Remembered instructions still inside the window, newest first. */
export async function listRemembered(
  redis: StickyRedis | null,
  tenant: string | null,
  now = Date.now()
): Promise<StoredRefresh[]> {
  if (!redis || rememberHours() <= 0) return []
  try {
    const rows = await redis.lrange(listKey(tenant), 0, rememberMax() - 1)
    const since = now - ttlSeconds() * 1000
    return rows
      .map(parseInstr)
      .filter((r): r is StoredRefresh => !!r && r.issued_at >= since)
      .sort((a, b) => b.issued_at - a.issued_at)
  } catch {
    return []
  }
}

/** Stop delivering one remembered instruction (id) or all of them (null). Returns how many. */
export async function forgetRemembered(
  redis: StickyRedis | null,
  tenant: string | null,
  id: string | null
): Promise<number> {
  if (!redis) return 0
  const key = listKey(tenant)
  const rows = await redis.lrange(key, 0, -1)
  const keep = id == null ? [] : rows.filter((r) => parseInstr(r)?.id !== id)
  const removed = rows.length - keep.length
  if (!removed) return 0
  await redis.del(key)
  if (keep.length) {
    await redis.rpush(key, ...keep)
    await redis.expire(key, ttlSeconds())
  }
  return removed
}

function parseRule(raw: string | null | undefined): MinBuildRule | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as MinBuildRule
    return v && typeof v.app === 'string' && typeof v.build === 'string' ? v : null
  } catch {
    return null
  }
}

/** Every app's minimum build (none set = no gate). */
export async function getMinBuilds(
  redis: StickyRedis | null,
  tenant: string | null
): Promise<MinBuildRule[]> {
  if (!redis) return []
  try {
    const all = await redis.hgetall(minKey(tenant))
    return Object.values(all ?? {})
      .map(parseRule)
      .filter((r): r is MinBuildRule => !!r)
      .sort((a, b) => a.app.localeCompare(b.app))
  } catch {
    return []
  }
}

export async function getMinBuild(
  redis: StickyRedis | null,
  tenant: string | null,
  app: string
): Promise<MinBuildRule | null> {
  if (!redis) return null
  return parseRule(await redis.hget(minKey(tenant), app))
}

export async function setMinBuild(
  redis: StickyRedis,
  tenant: string | null,
  rule: MinBuildRule
): Promise<void> {
  await redis.hset(minKey(tenant), rule.app, JSON.stringify(rule))
}

export async function clearMinBuild(
  redis: StickyRedis,
  tenant: string | null,
  app: string
): Promise<MinBuildRule | null> {
  const prev = await getMinBuild(redis, tenant, app)
  await redis.hdel(minKey(tenant), app)
  return prev
}

/** A cleaned build / app name (the same characters client-version.ts keeps). */
export function cleanBuild(v: unknown, max = 60): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null
  const s = String(v)
    .trim()
    .replace(/[^\w.+@-]/g, '')
  return s ? s.slice(0, max) : null
}

const VERSION_RE = /^v?(\d+(?:\.\d+){0,3})(?:[-+][\w.+-]*)?$/i

/** -1 / 0 / 1 when both builds read as dotted versions; null when either does not. */
export function compareBuilds(a: string, b: string): number | null {
  const ma = VERSION_RE.exec(a.trim())
  const mb = VERSION_RE.exec(b.trim())
  if (!ma || !mb) return null
  const pa = ma[1].split('.').map(Number)
  const pb = mb[1].split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

/**
 * Is a tab on `build` (page loaded at `loaded`) below the minimum? Unknown and dev builds never
 * are. Versions compare as versions; anything else is below when it differs from the minimum
 * and the page loaded before the rule was set.
 */
export function buildBelow(
  build: string | null | undefined,
  min: string,
  loaded: number | null | undefined,
  setAt: number
): boolean {
  if (!judgeable(build) || !judgeable(min)) return false
  const cmp = compareBuilds(build, min)
  if (cmp != null) return cmp < 0
  return build !== min && loaded != null && loaded < setAt
}

/** The rule this tab is below, or null. */
export function matchMinBuild(
  client: Pick<ConnectingClient, 'app' | 'version'>,
  rules: MinBuildRule[]
): MinBuildRule | null {
  const v = client.version
  if (!v || !client.app) return null
  const rule = rules.find((r) => r.app === client.app)
  if (!rule) return null
  return buildBelow(v.build, rule.build, v.loaded, rule.set_at) ? rule : null
}

/** Does a remembered instruction still apply to this tab? */
export function instructionApplies(instr: StoredRefresh, client: ConnectingClient): boolean {
  const v = client.version
  // Without a page-load time there is no telling whether it already obeyed: never sent.
  if (!v || v.loaded == null || v.loaded >= instr.issued_at) return false
  if (client.obeyed.includes(instr.id)) return false
  const t = instr.target
  if (t.user_ids.length && !t.user_ids.includes(String(client.user_id).toUpperCase())) return false
  if (t.app && client.app !== t.app) return false
  if (t.older) {
    const app = client.app ?? 'app'
    if (instr.settling?.includes(app)) return false
    const cur = instr.builds?.[app]
    if (judgeable(v.build) && cur && v.build !== cur) return true
    if (instr.api && judgeable(v.api) && v.api !== instr.api) return true
    // No build recorded for the app when issued: fall back to "older than this API".
    return !cur && !instr.api && onOlderApi(v)
  }
  return true
}

/** The newest remembered instruction this tab still owes, or null. */
export function matchRemembered(
  client: ConnectingClient,
  instrs: StoredRefresh[]
): StoredRefresh | null {
  let best: StoredRefresh | null = null
  for (const i of instrs) {
    if (!instructionApplies(i, client)) continue
    if (!best || i.issued_at > best.issued_at) best = i
  }
  return best
}

/**
 * Claim one connect-time send for (rule, tab, page load): false when this page load was already
 * told, or the tab was already told on MAX_PAGE_LOADS page loads. A tab with no id can't be
 * tracked — the caller decides whether it may be sent anyway.
 */
export async function claimDelivery(
  redis: StickyRedis,
  tenant: string | null,
  rule: string,
  tab: string,
  loaded: number
): Promise<boolean> {
  const key = sentKey(tenant, rule, tab)
  try {
    const fresh = await redis.hsetnx(key, String(loaded), '1')
    await redis.expire(key, ttlSeconds())
    if (!fresh) return false
    return (await redis.hlen(key)) <= MAX_PAGE_LOADS
  } catch {
    // Redis trouble: don't send rather than risk a loop.
    return false
  }
}

export function minBuildPayload(rule: MinBuildRule, reason: 'min-build' = 'min-build') {
  return {
    seconds: clampSeconds(rule.seconds, DEFAULT_MIN_BUILD_SECONDS),
    message: rule.message,
    id: minBuildId(rule),
    issued_at: rule.set_at,
    reason,
    min_build: rule.build,
    set_at: rule.set_at
  } satisfies RefreshPayload
}

/** The id a minimum-build reload carries (the client's per-tab marker key). */
export function minBuildId(rule: Pick<MinBuildRule, 'app' | 'set_at'>): string {
  return `min-${cleanBuild(rule.app, 40) ?? 'app'}-${rule.set_at}`
}

/**
 * What a tab that just signed in (and said client:hello) is owed: a reload for a minimum-build
 * rule it is below, else the newest remembered instruction it never obeyed — or null.
 */
export async function refreshOwedOnConnect(
  redis: StickyRedis | null,
  tenant: string | null,
  client: ConnectingClient
): Promise<RefreshPayload | null> {
  if (!redis) return null
  const v = client.version
  if (!v || v.loaded == null) return null
  const [rules, instrs] = await Promise.all([
    client.app ? getMinBuilds(redis, tenant) : Promise.resolve([]),
    listRemembered(redis, tenant)
  ])
  const rule = matchMinBuild(client, rules)
  if (rule) {
    const id = minBuildId(rule)
    // A min-build reload needs a tab id to stay bounded (the build can still be old after it).
    if (v.tab && (await claimDelivery(redis, tenant, id, v.tab, v.loaded)))
      return minBuildPayload(rule)
  }
  const instr = matchRemembered(client, instrs)
  if (!instr) return null
  if (v.tab && !(await claimDelivery(redis, tenant, instr.id, v.tab, v.loaded))) return null
  return {
    seconds: instr.seconds,
    message: instr.message,
    id: instr.id,
    issued_at: instr.issued_at,
    reason: 'sticky'
  }
}
