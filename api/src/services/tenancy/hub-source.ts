import type { Redis } from 'ioredis'
import { cleanTenantHost, runWithoutTenant } from '../../db/tenant-context.js'
import { NIVARO_VERSION } from '../../version.js'
import { forgetAppState } from '../app-state.js'
import { hubSharedConfig } from '../deployment-mode.js'
import { INSTANCE_ID } from '../instance-roster.js'
import { resetAppHubLinksForTests, setAppHubLinks } from './app-hub-links.js'
import { resetAppKeysForTests, setAppKeys } from './app-keys.js'
import { fireAppLeft } from './app-lifecycle.js'
import { HUB_TENANTS_PATH, parseHubTenants } from './hub-contract.js'
import { HubBodyTooLargeError, hubFetch, readCappedText } from './hub-fetch.js'
import type {
  TenantRecord,
  TenantRegistry,
  TenantRegistryStatus,
  TenantResolution
} from './types.js'

/**
 * The Hub tenant source (Hub phase 5): a Hub shared deployment's list of apps, fetched from its
 * Hub (services/tenancy/hub-contract.ts) and refreshed every HUB_TENANTS_REFRESH_MS.
 *
 * A Hub outage never empties the deployment: a 5xx, a timeout, a refused token or a body that is
 * not a tenant list keeps the last good list. That list is also kept in Redis
 * (`nvr:tenancy:hub:<deployment>`, sealed with encryptForDeployment: it carries every app's
 * database connection and key), so a restart during an outage still serves. Without
 * ENCRYPTION_KEY the copy is memory-only (readiness warns). The token, connections and keys never
 * reach a log, an error or a readiness text.
 *
 * Phase 6: each list hands the apps' own ENCRYPTION_KEYs to tenancy/app-keys.ts (encryptValue
 * inside an app uses them), and a tenant the Hub listed without an `origin` gets its first
 * hostname's (`https://host[:listed port]`), the origin its jobs name. A request keeps the origin
 * of the host it came on (resolve).
 */

const FETCH_TIMEOUT_MS = 10_000
/** The largest tenants answer read; a bigger one is refused before parsing. */
export const HUB_BODY_MAX_BYTES = 2 * 1024 * 1024
const DEFAULT_REFRESH_MS = 30_000
const MIN_REFRESH_MS = 5_000
/** An unknown host forces at most one refresh per this window. */
const UNKNOWN_HOST_REFRESH_GAP_MS = 5_000

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|[a-z0-9.-]+\.localhost)(:\d+)?$/

export const hubCacheKey = (deployment: string) => `nvr:tenancy:hub:${deployment}`

/** Phase 6: a message on this channel makes every replica of the deployment refresh its list at
 *  once (the deployment link's POST /refresh publishes it). Pub/sub ignores the db index, so the
 *  channel carries REDIS_CHANNEL_PREFIX, and the deployment key, so two shared deployments on one
 *  Redis never kick each other. */
export const tenancyRefreshChannel = (deployment: string) =>
  `${process.env.REDIS_CHANNEL_PREFIX ?? ''}nvr:tenancy:refresh:${deployment}`

/** Refresh kicks closer together than this fold into one trailing refresh. */
const KICK_GAP_MS = 1_000

/** What the readiness check judges (services/tenancy/readiness.ts). */
export interface HubSourceDetails {
  /** Last time the Hub confirmed the list (200 or 304), or the stored copy's time after a boot. */
  confirmedAt: number | null
  /** The list was loaded at least once (from the Hub or the sealed copy). */
  loaded: boolean
  /** Apps in the current list (dropped ones not counted). */
  count: number
  /** The last fetch failed; plain text, never the token or a connection. */
  fetchError: string | null
  /** Tenants the Hub listed that this deployment cannot serve. */
  dropped: { id: string; why: string }[]
  /** The ETag of the list held (phase 6: the Hub tells replicas apart by it). */
  etag: string | null
  /** The last good list is kept in Redis (sealed); false = memory only. */
  sealedCopy: boolean
  /** Why there is no sealed copy, when there is none. */
  sealedCopyProblem: string | null
}

export interface HubTenantRegistry extends TenantRegistry {
  details(): HubSourceDetails
  refresh(): Promise<void>
  /** A refresh asked for by the Hub (a channel message, or POST /refresh with no Redis): folded,
   *  at least KICK_GAP_MS apart, and always a fetch that starts after the kick. */
  kick(): void
  byId(id: string): Promise<TenantRecord | null>
  listAll(): Promise<TenantRecord[]>
}

interface Deps {
  redis: Redis | null
  fetch?: typeof fetch
  now?: () => number
  refreshMs?: number
}

let active: { registry: HubTenantRegistry; stop: () => void } | null = null

/** The running Hub source, or null (not a Hub shared deployment, or not started yet). */
export function getHubTenantSource(): HubTenantRegistry | null {
  return active?.registry ?? null
}

function refreshInterval(explicit?: number): number {
  const raw = explicit ?? Number(process.env.HUB_TENANTS_REFRESH_MS || DEFAULT_REFRESH_MS)
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_REFRESH_MS
  return Math.max(MIN_REFRESH_MS, Math.floor(raw))
}

/** A valid ENCRYPTION_KEY: the sealed copy needs one (services/encryption.ts). */
function sealKeyProblem(): string | null {
  const hex = process.env.ENCRYPTION_KEY
  if (!hex) return 'ENCRYPTION_KEY is not set'
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return 'ENCRYPTION_KEY is not a 64-character hex key'
  return null
}

/** The request host as the list holds it (hubHostname: lower case, no port), plus the cleaned
 *  host with its port for a local origin. */
function lookupHost(host: string): { bare: string; clean: string } | null {
  const clean = cleanTenantHost(host)
  return clean ? { bare: clean.replace(/:\d+$/, ''), clean } : null
}

/** https://<listed host>[:<listed non-default port>]; a local development host keeps the
 *  request's port, over http. */
function originOf(h: { bare: string; clean: string }, t: TenantRecord): string {
  if (LOCAL_HOST.test(h.bare)) return `http://${h.clean}`
  const port = t.originPorts?.[h.bare]
  return `https://${h.bare}${port ? `:${port}` : ''}`
}

/** The tenant with its origin: the Hub's, else its first listed hostname's (the same rule as a
 *  request on that host). A local host keeps its listed port (a request would carry its own). */
function withListedOrigin(t: TenantRecord): TenantRecord {
  if (t.origin || !t.hostnames[0]) return t
  const h = t.hostnames[0]
  const port = t.originPorts?.[h]
  return { ...t, origin: originOf({ bare: h, clean: port ? `${h}:${port}` : h }, t) }
}

/** Plain text for a failed fetch: the error's kind only, never its message. */
function fetchFailureText(err: unknown): string {
  const name = (err as { name?: unknown } | null)?.name
  if (name === 'TimeoutError' || name === 'AbortError')
    return `the Hub did not answer within ${FETCH_TIMEOUT_MS / 1000} s`
  if (name === 'HubRedirectError') return 'the Hub answered with a redirect'
  if (name === 'HubStatusError') return 'the Hub answered an invalid HTTP status'
  return 'the Hub could not be reached'
}

export async function startHubTenantSource(deps: Deps): Promise<TenantRegistry> {
  const cfg = hubSharedConfig()
  if (!cfg) throw new Error('The Hub tenant source runs only on a Hub shared deployment.')
  active?.stop()

  const { deployment, token } = cfg
  const url = `${cfg.hubUrl.replace(/\/+$/, '')}${HUB_TENANTS_PATH(deployment)}`
  const doFetch = deps.fetch ?? hubFetch
  const now = deps.now ?? Date.now
  const redis = deps.redis

  let tenants: TenantRecord[] = []
  let byHost = new Map<string, TenantRecord>()
  let loaded = false
  let confirmedAt: number | null = null
  let etag: string | null = null
  let fetchError: string | null = null
  let dropped: { id: string; why: string }[] = []
  // Why the last good list cannot be kept sealed in Redis (fixed for the process), and whether
  // the last write failed (clears on the next good write).
  const sealProblem: string | null = redis ? sealKeyProblem() : 'no Redis'
  let writeFailed = false
  let inFlight: Promise<void> | null = null
  let lastForced = Number.NEGATIVE_INFINITY

  const setList = (list: TenantRecord[]) => {
    // Task 22 M-2 (via Task 16): an app no longer listed has left this process (unplaced, or
    // moved away at retire_source): its per-app module state goes with it.
    const listed = new Set(list.map((t) => t.id))
    for (const t of tenants) {
      if (listed.has(t.id)) continue
      forgetAppState(t.id)
      fireAppLeft(t.id)
    }
    // Final review I-1: an app that (re)appears starts clean too, so a leave this process never
    // saw (it was not listed in between) cannot hand a returning app its old cached state.
    const before = new Set(tenants.map((t) => t.id))
    for (const t of list) if (!before.has(t.id)) forgetAppState(t.id)
    tenants = list.map(withListedOrigin)
    setAppKeys(tenants)
    setAppHubLinks(tenants)
    const m = new Map<string, TenantRecord>()
    for (const t of tenants) for (const h of t.hostnames) m.set(h, t)
    byHost = m
    loaded = true
  }

  // One log line per change of state, not per refresh.
  const onceWarner = () => {
    let last: string | null = null
    return (text: string | null) => {
      // biome-ignore lint/suspicious/noConsole: an operator must see a Hub outage in the server log
      if (text && text !== last) console.warn(`[tenancy] Hub tenant list: ${text}`)
      last = text
    }
  }
  const warnFetch = onceWarner()
  const warnDropped = onceWarner()

  const readCopy = async () => {
    if (!redis || sealProblem) return
    try {
      const raw = await redis.get(hubCacheKey(deployment))
      if (!raw) return
      const { decryptForDeployment, isEncrypted } = await import('../encryption.js')
      if (!isEncrypted(raw)) return // never trust a plaintext copy
      // The deployment's own key, never an app's (decryptValue inside an app would use the app's).
      const copy = JSON.parse(decryptForDeployment(raw)) as {
        tenants?: TenantRecord[]
        etag?: string | null
        confirmedAt?: number
        dropped?: { id: string; why: string }[]
      }
      if (!Array.isArray(copy.tenants)) return
      setList(copy.tenants)
      etag = copy.etag ?? null
      // A copy without a time is "confirmed at an unknown time" (readiness warns), not an age.
      confirmedAt = typeof copy.confirmedAt === 'number' ? copy.confirmedAt : null
      dropped = Array.isArray(copy.dropped) ? copy.dropped : []
    } catch {
      // An unreadable copy (another key, corrupt) is ignored: the fetch decides.
    }
  }

  const writeCopy = async () => {
    if (!redis || sealProblem) return
    try {
      const { encryptForDeployment } = await import('../encryption.js')
      const sealed = encryptForDeployment(JSON.stringify({ tenants, etag, confirmedAt, dropped }))
      await redis.set(hubCacheKey(deployment), sealed)
      writeFailed = false
    } catch {
      writeFailed = true
    }
  }

  const fetchOnce = async (): Promise<void> => {
    let res: Response
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        // Phase 6: the Hub keeps a sighting per process (version, list held), so it can wait
        // until every live replica holds a new list. INSTANCE_ID is per process (ruling B4).
        'X-Nivaro-Version': NIVARO_VERSION,
        'X-Nivaro-Instance': INSTANCE_ID
      }
      if (etag && loaded) headers['If-None-Match'] = etag
      // The signal ends a normal request; the race is the backstop for one that ignores it, so a
      // refresh (and every unknown-host lookup waiting on it) always settles.
      let backstop: ReturnType<typeof setTimeout> | undefined
      res = await Promise.race([
        doFetch(url, {
          method: 'GET',
          headers,
          redirect: 'error',
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
        }),
        new Promise<never>((_, reject) => {
          backstop = setTimeout(
            () => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })),
            FETCH_TIMEOUT_MS + 1_000
          )
          backstop.unref?.()
        })
      ]).finally(() => clearTimeout(backstop))
    } catch (err) {
      fetchError = fetchFailureText(err)
      return
    }
    if (res.status === 304 && loaded) {
      confirmedAt = now()
      fetchError = null
      return
    }
    if (res.status === 401 || res.status === 403) {
      fetchError = `the Hub refused this deployment's token (${res.status})`
      return
    }
    if (res.status < 200 || res.status >= 300) {
      fetchError = `the Hub answered ${res.status}`
      return
    }
    let body: unknown
    try {
      body = JSON.parse(await readCappedText(res, HUB_BODY_MAX_BYTES))
    } catch (err) {
      fetchError =
        err instanceof HubBodyTooLargeError
          ? `the Hub sent more than ${HUB_BODY_MAX_BYTES / 1024 / 1024} MB`
          : 'the Hub sent a body that is not a tenant list'
      return
    }
    const parsed = parseHubTenants(body, deployment)
    if (!parsed) {
      fetchError = 'the Hub sent a body that is not a tenant list'
      return
    }
    // Another deployment's list (even an empty one) never replaces this deployment's.
    if ((body as { data: { deployment: unknown } }).data.deployment !== deployment) {
      fetchError = 'the Hub answered for another deployment'
      return
    }
    setList(parsed.tenants)
    dropped = parsed.dropped
    etag = res.headers.get('etag')
    confirmedAt = now()
    fetchError = null
    await writeCopy()
  }

  const refresh = (): Promise<void> => {
    if (!inFlight) {
      // Never inside an app: the sealed copy (every app's connection and key) is sealed with the
      // deployment's own key, whichever request or job asked for the refresh (review minor 7).
      inFlight = runWithoutTenant(() => fetchOnce())
        .catch(() => {
          fetchError = 'the tenant list could not be read'
        })
        .finally(() => {
          inFlight = null
          warnFetch(fetchError)
          warnDropped(
            dropped.length
              ? `not serving ${dropped.map((d) => `${d.id} (${d.why})`).join('; ')}`
              : null
          )
        })
    }
    return inFlight
  }

  // A fetch that starts AFTER now: one already in flight may predate the Hub's change, so the
  // kick waits for it and fetches once more (one follow-up however many kicks meet it).
  let followUp: Promise<void> | null = null
  const freshRefresh = (): Promise<void> => {
    if (!inFlight) return refresh()
    followUp ??= inFlight.then(() => {
      followUp = null
      return refresh()
    })
    return followUp
  }

  // Kicks at least KICK_GAP_MS apart each refresh at once; kicks inside the gap fold into ONE
  // trailing refresh at the gap's end, so a change made just after a refresh started is not left
  // to the timer.
  let lastKick = Number.NEGATIVE_INFINITY
  let trailing: ReturnType<typeof setTimeout> | null = null
  let kicksStopped = false
  const kick = () => {
    if (kicksStopped) return
    const since = now() - lastKick
    if (since >= KICK_GAP_MS) {
      lastKick = now()
      void freshRefresh().catch(() => {})
      return
    }
    if (trailing) return
    trailing = setTimeout(() => {
      trailing = null
      if (kicksStopped) return
      lastKick = now()
      void freshRefresh().catch(() => {})
    }, KICK_GAP_MS - since)
    trailing.unref?.()
  }
  const stopKicking = () => {
    kicksStopped = true
    if (trailing) clearTimeout(trailing)
    trailing = null
  }

  const find = (host: string): TenantResolution | null => {
    const h = lookupHost(host)
    const t = h ? byHost.get(h.bare) : undefined
    return h && t ? { tenant: t, origin: originOf(h, t) } : null
  }

  const registry: HubTenantRegistry = {
    source: 'hub',
    async resolve(host: string): Promise<TenantResolution | null> {
      let hit = find(host)
      if (!hit && lookupHost(host)) {
        // A new app may have been added since the last refresh: ask the Hub, at most once per 5 s.
        if (inFlight) await inFlight
        else if (now() - lastForced >= UNKNOWN_HOST_REFRESH_GAP_MS) {
          lastForced = now()
          await refresh()
        }
        hit = find(host)
      }
      return hit
    },
    async listActive(): Promise<TenantRecord[]> {
      return tenants.filter((t) => t.status === 'active' || t.status === 'maintenance')
    },
    async byId(id: string): Promise<TenantRecord | null> {
      return tenants.find((t) => t.id === id) ?? null
    },
    async listAll(): Promise<TenantRecord[]> {
      return [...tenants]
    },
    status(): TenantRegistryStatus {
      const age = confirmedAt === null ? null : now() - confirmedAt
      const droppedText = dropped.length
        ? `not serving ${dropped.map((d) => `${d.id} (${d.why})`).join('; ')}`
        : null
      return {
        source: 'hub',
        count: tenants.length,
        // null exactly while nothing was ever loaded (the tenant hook answers 503 then)
        loadedAt: loaded ? new Date(confirmedAt ?? 0).toISOString() : null,
        stale: !loaded || fetchError !== null || (age !== null && age > 5 * 60_000),
        lastError: [fetchError, droppedText].filter(Boolean).join('; ') || null
      }
    },
    details(): HubSourceDetails {
      return {
        confirmedAt,
        loaded,
        count: tenants.length,
        fetchError,
        dropped: [...dropped],
        etag,
        sealedCopy: !sealProblem && !writeFailed,
        sealedCopyProblem:
          sealProblem ?? (writeFailed ? 'the last copy could not be written to Redis' : null)
      }
    },
    refresh,
    kick
  }

  // Boot: the sealed copy first (a Hub that is down still leaves the apps served), then the Hub.
  await readCopy()
  await refresh()

  const timer = setInterval(() => void refresh(), refreshInterval(deps.refreshMs))
  timer.unref?.()
  const stopListening = listenForRefreshKicks(redis, tenancyRefreshChannel(deployment), kick)
  active = {
    registry,
    stop: () => {
      clearInterval(timer)
      stopKicking()
      stopListening()
    }
  }

  const { registerTenantRegistryReadiness } = await import('./readiness.js')
  registerTenantRegistryReadiness()
  return registry
}

/**
 * Phase 6: kick the source when the Hub publishes on its channel, on a connection of its own (a
 * subscribed connection can do nothing else). No Redis (or one that cannot duplicate) = no
 * listener: POST /refresh then kicks this process only, and the timer still refreshes. A failed
 * subscribe is warned about once (the link's /refresh sees no subscriber and says so).
 */
function listenForRefreshKicks(redis: Redis | null, channel: string, kick: () => void): () => void {
  if (!redis || typeof (redis as { duplicate?: unknown }).duplicate !== 'function') return () => {}
  let sub: Redis
  try {
    sub = redis.duplicate()
  } catch {
    return () => {}
  }
  let warned = false
  const warnOnce = () => {
    if (warned) return
    warned = true
    // biome-ignore lint/suspicious/noConsole: an operator must know the Hub's kicks are not heard
    console.warn(
      '[tenancy] Hub refresh kicks: could not subscribe; the list refreshes on its timer'
    )
  }
  sub.on('message', (ch: string) => {
    if (ch === channel) kick()
  })
  sub.on('error', () => {})
  Promise.resolve()
    .then(() => sub.subscribe(channel))
    .catch(warnOnce)
  return () => {
    Promise.resolve()
      .then(() => sub.quit())
      .catch(() => {})
  }
}

/** Stops the refresh timer only: work during shutdown (preClose) still resolves from the list. */
export function stopHubTenantSource(): void {
  active?.stop()
}

/** Test seam: forget the running source entirely. */
export function resetHubTenantSourceForTests(): void {
  active?.stop()
  active = null
  resetAppKeysForTests()
  resetAppHubLinksForTests()
}
