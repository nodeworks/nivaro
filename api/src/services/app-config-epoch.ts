/**
 * Config epochs per app on a Hub shared deployment.
 *
 * Self-hosted, one number per database (db/config-epoch.ts, `nivaro_cache_epochs`) moves on every
 * configuration write and every other process polls it. A shared deployment serves many apps,
 * each with its own database: one poller per app per replica would cost a query per app every
 * few seconds, so the number is off there and, until now, another replica kept an app's old
 * field lists, relations or layouts until their TTL ran out.
 *
 * Here each app's configuration writes are announced on the deployment's Redis channel instead:
 *  - every app pool's driver notes a configuration write (db/config-epoch.ts
 *    attachAppConfigWriteSeam → onConfigWrite) inside the app's own async context;
 *  - the first write of a run is announced at once (other replicas drop what they hold early),
 *    and the run is announced again 2 s after its last write (so a replica that re-read during
 *    the run drops that too) — the same leading + trailing rule as the database number;
 *  - every OTHER process of the deployment (web, worker and realtime) hears `<app id>|<instance>`
 *    on the deployment's own channel and clears its caches for that app only (bustAllCaches in
 *    the app's context, as an app-only clear: per-app slots and hand-keyed metadata caches of the
 *    other apps stay).
 *
 * The process that made the edit clears its own caches itself, as self-hosted. A manual bust
 * (the cache console, a config restore) announces too (announceAppConfigChange). `CACHE_EPOCH=off`
 * turns it off. Without Redis nothing is announced and caches expire on their TTL, as before.
 * Nivaro Cloud and self-hosted never start it.
 */
import type { Redis } from 'ioredis'
import { attachAppConfigWriteSeam, onConfigWrite, runAppOnlyClear } from '../db/config-epoch.js'
import { onTenantPoolCreated, withTenant } from '../db/tenant-context.js'
import { registerAppKeyed } from './app-forget.js'
import { hubSharedConfig, perAppJobs } from './deployment-mode.js'
import { appReadyForRequests } from './tenancy/app-migrations.js'
import { getTenantRegistry } from './tenancy/registry.js'
import type { TenantRecord } from './tenancy/types.js'
import { currentTenantKey } from './tenant-rooms.js'

const TRAILING_MS = 2_000
const MIN_GAP_MS = 10_000

/** The deployment's own channel: two shared deployments on one Redis never hear each other. */
export const appConfigChannel = (): string =>
  `${process.env.REDIS_CHANNEL_PREFIX ?? ''}nvr:app-config:${hubSharedConfig()?.deployment ?? ''}`

/** One run of configuration writes per app (keyed by the app's id). */
interface AppRun {
  lastAt: number
  trailing: ReturnType<typeof setTimeout> | null
}
const runs = registerAppKeyed(new Map<string, AppRun>())

interface Wiring {
  publish: (channel: string, message: string) => Promise<unknown>
  instance: string
}
/** Set once at boot (startAppConfigEpochs); null = nothing to announce on. */
let wiring: Wiring | null = null
let announced = 0
let heard = 0

const epochOff = () => (process.env.CACHE_EPOCH ?? '').trim().toLowerCase() === 'off'

function publish(tenant: string): void {
  const w = wiring
  if (!w) return
  announced++
  w.publish(appConfigChannel(), `${tenant}|${w.instance}`).catch(() => {})
}

/**
 * A configuration write in the current app (or `tenant`): announce it at once when the app's
 * last announcement is 10 s old, and again 2 s after the run's last write.
 */
export function noteAppConfigWrite(tenant: string = currentTenantKey()): void {
  if (!tenant || !wiring || epochOff()) return
  let run = runs.get(tenant)
  if (!run) {
    run = { lastAt: 0, trailing: null }
    runs.set(tenant, run)
  }
  const now = Date.now()
  if (now - run.lastAt >= MIN_GAP_MS) {
    run.lastAt = now
    publish(tenant)
  }
  if (run.trailing) clearTimeout(run.trailing)
  const r = run
  r.trailing = setTimeout(() => {
    r.trailing = null
    r.lastAt = Date.now()
    publish(tenant)
  }, TRAILING_MS)
  r.trailing.unref?.()
}

/** A bust asked for by hand in the current app: tell the other processes now. */
export function announceAppConfigChange(tenant: string = currentTenantKey()): void {
  if (!tenant || !wiring || epochOff()) return
  publish(tenant)
}

export interface AppConfigMessageDeps {
  /** The app a message names, or null when this process does not serve it (yet). */
  resolve: (tenantId: string) => Promise<TenantRecord | null>
  /** Runs `fn` inside the app (its async context). */
  inApp: <T>(t: TenantRecord, fn: () => Promise<T>) => Promise<T>
  /** Clears this process's caches (in the current app's context: that app's slots). */
  bust: () => string[]
}

/**
 * One announcement heard on the channel. Our own are skipped; an app this process does not serve
 * (or that is not active and ready) is skipped — it has nothing cached here that a request could
 * read. Answers the cache names cleared, or null when skipped.
 */
export async function onAppConfigMessage(
  raw: string,
  self: string,
  deps: AppConfigMessageDeps
): Promise<string[] | null> {
  const bar = raw.lastIndexOf('|')
  if (bar <= 0) return null
  const tenantId = raw.slice(0, bar)
  const from = raw.slice(bar + 1)
  if (!tenantId || from === self) return null
  let t: TenantRecord | null = null
  try {
    t = await deps.resolve(tenantId)
  } catch {
    return null
  }
  if (!t || t.status !== 'active' || !appReadyForRequests(t.id)) return null
  heard++
  // Inside the app, as an app-only clear: hand-keyed caches drop this app's entries only.
  return deps.inApp(t, async () => runAppOnlyClear(() => deps.bust()))
}

async function resolveApp(tenantId: string): Promise<TenantRecord | null> {
  const registry = getTenantRegistry()
  if (!registry) return null
  const byId = await registry.byId?.(tenantId)
  if (byId) return byId
  return (await registry.listActive()).find((x) => x.id === tenantId) ?? null
}

interface Log {
  info: (obj: object, msg: string) => void
  warn: (obj: object, msg: string) => void
}

/**
 * Boot (Hub shared deployment only): attach the write seam to every app pool, hear this process's
 * configuration writes, and subscribe to the other processes' announcements. Answers a stop
 * function (unsubscribe), or null when not started.
 */
export function startAppConfigEpochs(opts: {
  redis: Redis | null | undefined
  instance: string
  bust: () => string[]
  log: Log
}): (() => Promise<void>) | null {
  if (!perAppJobs() || epochOff()) return null
  const offSeam = onTenantPoolCreated(attachAppConfigWriteSeam)
  const offWrites = onConfigWrite(() => noteAppConfigWrite())
  const redis = opts.redis
  if (!redis) {
    opts.log.warn({}, 'Per-app config changes are not announced: no Redis (caches expire on TTL)')
    return async () => {
      offSeam()
      offWrites()
    }
  }
  wiring = {
    publish: (channel, message) => redis.publish(channel, message),
    instance: opts.instance
  }
  const channel = appConfigChannel()
  const sub = redis.duplicate()
  sub.on('error', () => {})
  sub.on('message', (ch: string, raw: string) => {
    if (ch !== channel) return
    void onAppConfigMessage(raw, opts.instance, {
      resolve: resolveApp,
      inApp: (t, fn) => withTenant(t, fn, t.origin),
      bust: opts.bust
    })
      .then((names) => {
        if (names)
          opts.log.info(
            { tenant: raw.slice(0, raw.lastIndexOf('|')), caches: names.length },
            "An app's configuration changed elsewhere — its caches cleared"
          )
      })
      .catch(() => {})
  })
  sub.subscribe(channel).catch((err: unknown) => {
    opts.log.warn({ err }, 'Per-app config announcements could not be subscribed to')
  })
  return async () => {
    offSeam()
    offWrites()
    wiring = null
    for (const r of runs.values()) if (r.trailing) clearTimeout(r.trailing)
    runs.clear()
    await sub.quit().catch(() => {})
  }
}

/** For the ops pages: what this process announced and heard since boot. */
export function appConfigEpochState(): { on: boolean; announced: number; heard: number } {
  return { on: wiring !== null, announced, heard }
}

/** Tests only. */
export function _setAppConfigWiringForTests(w: Wiring | null): void {
  wiring = w
  for (const r of runs.values()) if (r.trailing) clearTimeout(r.trailing)
  runs.clear()
  announced = 0
  heard = 0
}
