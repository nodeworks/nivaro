import type { FastifyInstance } from 'fastify'
import { runInBackgroundPool } from '../db/pool-context.js'
import { perAppJobs } from './deployment-mode.js'
import { onAppReady } from './tenancy/app-lifecycle.js'
import { currentTenantKey } from './tenant-rooms.js'

// The boot passes that read or write an app's database: warms, the db-tuning twin sweep, the REST
// route inventory, extension registry versions and the portal-URL warning. Self-hosted, server.ts
// calls each at boot against its one database (same order and timers as before). A Hub shared
// deployment has no database outside an app: registerAppBootPasses runs them once per app when
// that app becomes ready, inside it. Nivaro Cloud runs none.

/** Wraps one named piece of work (self-hosted: a background boot phase). */
export type BootPhaseRunner = <T>(name: string, fn: () => Promise<T>) => Promise<T>

const inBackground: BootPhaseRunner = (_name, fn) => runInBackgroundPool(fn)

/** On a shared deployment, outside any app there is no database to read: every pass skips. */
function noDatabase(): boolean {
  return perAppJobs() && !currentTenantKey()
}

/** Owner groups for every bound template (#481): the first queue read after a deploy used to
 *  fetch ~1.9MB of group filters cold (~3s). */
export async function warmOwnerGroups(app: FastifyInstance): Promise<void> {
  if (noDatabase()) return
  const m = await import('./pipeline-engine.js')
  const n = await m.warmOwnerGroupCache()
  app.log.info(`owners: warmed owner groups for ${n} state(s)`)
}

/** The compiled integrity checks of every laid-out collection, so the first record form gets a
 *  sub-second live check instead of paying the ~6s compile. */
export async function warmIntegrityChecks(app: FastifyInstance): Promise<void> {
  if (noDatabase()) return
  const m = await import('./config-conformance.js')
  const n = await m.warmCompiledChecks()
  app.log.info(`integrity: warmed checks for ${n} collection(s)`)
}

/** The phase name of the query warm (the part of warmCaches that holds the heavy slot). */
const QUERY_WARM_PHASE = 'Warm query caches'

/**
 * #2445 — metadata, then the query caches and the buffer pool behind them once per cluster per
 * version (nvr:warm:<version>; on a shared deployment once per app per version). The query warm
 * holds the heavy-job slot (on shared, the app's own), like the 06:30 cron.
 */
export async function warmCaches(
  app: FastifyInstance,
  phase: BootPhaseRunner = inBackground,
  opts: {
    /** Hub shared deployment: hand the query warm (it waits on the app's heavy slot, up to two
     *  hours) to the caller to start later instead of awaiting it here. */
    deferQueryWarm?: (start: () => Promise<void>) => void
  } = {}
): Promise<void> {
  if (noDatabase()) return
  const m = await import('./cache-warm.js')
  if (!m.cacheWarmAllowed()) return
  await phase('Warm metadata', () => m.warmMetadata())
  const { NIVARO_VERSION } = await import('../version.js')
  const { INSTANCE_ID } = await import('./instance-roster.js')
  if (!(await m.takeBootWarm(app.redis, NIVARO_VERSION, INSTANCE_ID))) return
  const appKey = currentTenantKey() || undefined
  const queryWarm = () =>
    app.cron.withHeavySlot(
      'cache-warm (boot)',
      async () => {
        await phase(QUERY_WARM_PHASE, () =>
          m.runCacheWarm({
            redis: app.redis,
            log: (summary, line) => app.log.info(summary, line)
          })
        )
      },
      appKey
    )
  if (opts.deferQueryWarm) opts.deferQueryWarm(queryWarm)
  else await queryWarm()
}

/** Readiness results for this version (the cache is keyed by version, so a deploy starts empty):
 *  evaluated once so the first dashboard reads a scorecard instead of 'pending'. Same switch as
 *  the cache warm — dev never runs the heavy checks unprompted. */
export async function warmReadinessResults(app: FastifyInstance): Promise<void> {
  if (noDatabase()) return
  const { cacheWarmAllowed } = await import('./cache-warm.js')
  if (!cacheWarmAllowed()) return
  const { warmReadiness } = await import('./readiness.js')
  const n = await warmReadiness()
  if (n > 0) app.log.info(`readiness: evaluated ${n} check(s) for this version`)
}

/** #996 — a killed proof leaves its `<proc>__tune_<hex>` twin behind; drop the ones older than
 *  any live proof. */
export async function sweepTuningTwins(app: FastifyInstance): Promise<void> {
  if (noDatabase()) return
  const [{ sweepTwinLeftovers }, { readTuningSettings }] = await Promise.all([
    import('./db-tuning/twin.js'),
    import('./db-tuning/settings.js')
  ])
  const dropped = await sweepTwinLeftovers((await readTuningSettings()).proc_timeout_minutes)
  if (dropped.length)
    app.log.warn(`db-tuning: dropped leftover twin procedure(s) ${dropped.join(', ')}`)
}

/** REST API changelog (#315): this release's route inventory, diffed against the previous
 *  release (removed routes = breaking). */
export async function recordRestRouteInventory(routes: string[]): Promise<void> {
  if (noDatabase()) return
  const { recordRestRoutes } = await import('./api-changelog.js')
  const { NIVARO_VERSION } = await import('../version.js')
  await recordRestRoutes(NIVARO_VERSION, routes)
}

/** #530 — fingerprint what each extension registered; a changed ledger becomes a new version so
 *  "when did this check appear?" has an answer. */
export async function recordExtensionRegistryVersions(app: FastifyInstance): Promise<void> {
  if (noDatabase()) return
  const { extensionRegistry, describeExtensionRegistry } = await import('../extensions/loader.js')
  const { recordRegistryVersion } = await import('./extension-registry-versions.js')
  for (const id of extensionRegistry.keys()) {
    const desc = await describeExtensionRegistry(id, app.cron).catch(() => null)
    if (!desc) continue
    const r = await recordRegistryVersion(id, desc)
    if (r?.changed)
      app.log.info(
        { extension: id, version: r.version },
        '[extension-registry] new registry version'
      )
  }
}

/**
 * Admin links (replay button, task/approval notifications, record_url fallbacks) resolve through
 * the admin base. When that answer IS the registered portal, every such link lands on the
 * headless frontend's router instead of the admin page — say so once, since no env rule can tell
 * a genuine admin host from a mis-pointed ADMIN_URL. On a shared deployment: the app's own
 * portal_url against its own admin origin.
 */
export async function warnIfPortalIsAdmin(app: FastifyInstance): Promise<void> {
  if (noDatabase()) return
  const { adminPageBase, portalRegistration } = await import('./app-links.js')
  const portal = (await portalRegistration())?.base?.replace(/\/$/, '')
  const tenant = currentTenantKey()
  const admin = tenant ? adminPageBase() : (await import('../admin-base.js')).adminBaseUrl()
  if (portal && admin && portal === admin)
    app.log.warn(
      tenant
        ? { app: tenant, admin_url: admin, portal_url: portal }
        : { admin_url: admin, portal_url: portal },
      tenant
        ? "adminBaseUrl() resolves to the registered portal — set this app's portal_url (Settings → Frontend app) to its frontend, or its admin links will open the portal"
        : 'adminBaseUrl() resolves to the registered portal — set ADMIN_URL to the host that serves the admin build or admin links will open the portal'
    )
}

/** How long after the server is ready the per-app boot passes start (self-hosted waits as long
 *  before its readiness warm), so they never compete with the first requests. */
export const APP_BOOT_PASS_DELAY_MS = 15_000
/** At most this many apps run their boot passes at once in one process, and at most this many
 *  boot query warms run at once. */
const APP_BOOT_PASS_PARALLEL = 2

/** A process-wide turn queue: `running` holders at most `limit`, the rest wait in arrival order. */
interface TurnQueue {
  running: number
  waiting: Array<() => void>
}
// Hub shared deployment: one queue for every app's boot passes and one for the boot query warms
// on this process (code scheduling; the work itself runs inside each app).
const bootPassQueue: TurnQueue = { running: 0, waiting: [] }
const bootQueryWarmQueue: TurnQueue = { running: 0, waiting: [] }

/** Wait for a turn. The caller's async context (the app it runs in) is kept across the wait. */
async function takeTurn(q: TurnQueue): Promise<void> {
  if (q.running < APP_BOOT_PASS_PARALLEL) {
    q.running++
    return
  }
  // The turn is handed over by giveTurn (running stays the same).
  await new Promise<void>((resolve) => q.waiting.push(resolve))
}
function giveTurn(q: TurnQueue): void {
  const next = q.waiting.shift()
  if (next) next()
  else q.running--
}

/** Test seam: the boot-pass queue as it stands. */
export function _bootPassQueueForTests(): { running: number; waiting: number } {
  return { running: bootPassQueue.running, waiting: bootPassQueue.waiting.length }
}
/** Test seam: empty both queues. */
export function _resetBootPassQueueForTests(): void {
  bootPassQueue.running = 0
  bootPassQueue.waiting = []
  bootQueryWarmQueue.running = 0
  bootQueryWarmQueue.waiting = []
}

/**
 * Hub shared deployment: run every boot pass once per app when the app becomes ready, inside it,
 * in order — each on its own, one warn line naming a pass that fails. The passes start a short
 * while (APP_BOOT_PASS_DELAY_MS) after this process is ready (every route registered: the REST
 * inventory is complete), and go through one process-wide queue: at most two apps run theirs at
 * once, however many become ready together. The boot query warm waits on the app's heavy slot
 * (up to two hours), so it is started last and not awaited — it never holds a turn in the queue
 * nor blocks the app's other passes; it takes a turn in a queue of its own (at most two query
 * warms at once) only once it holds that heavy slot. Registers nothing elsewhere. Call it before the app migrations start: an
 * app that is ready already never fires its ready event again.
 */
export function registerAppBootPasses(
  app: FastifyInstance,
  opts: { restRoutes: string[]; startDelayMs?: number }
): void {
  if (!perAppJobs()) return
  const delayMs = opts.startDelayMs ?? APP_BOOT_PASS_DELAY_MS
  let markReady: () => void = () => {}
  const serverReady = new Promise<void>((resolve) => {
    markReady = resolve
  })
  const started = serverReady.then(
    () =>
      new Promise<void>((resolve) => {
        if (delayMs <= 0) return resolve()
        setTimeout(resolve, delayMs).unref()
      })
  )
  app.addHook('onReady', async () => markReady())

  // The query warm takes a turn of its own once it holds the app's heavy slot: waiting for the
  // slot holds no turn, and at most two apps' query warms run at once.
  const warmPhase: BootPhaseRunner = async (name, fn) => {
    if (name !== QUERY_WARM_PHASE) return runInBackgroundPool(fn)
    await takeTurn(bootQueryWarmQueue)
    try {
      return await runInBackgroundPool(fn)
    } finally {
      giveTurn(bootQueryWarmQueue)
    }
  }

  onAppReady('boot-passes', async (t) => {
    await started
    const warn = (name: string, err: unknown) =>
      app.log.warn(
        { app: t.id, err: err instanceof Error ? err.message : String(err) },
        `[boot-passes] app ${t.id}: ${name} failed`
      )
    let queryWarm: (() => Promise<void>) | null = null
    const passes: Array<[string, () => Promise<void>]> = [
      ['owner-groups', () => runInBackgroundPool(() => warmOwnerGroups(app))],
      ['integrity-checks', () => runInBackgroundPool(() => warmIntegrityChecks(app))],
      [
        'cache-warm',
        () =>
          warmCaches(app, warmPhase, {
            deferQueryWarm: (start) => {
              queryWarm = start
            }
          })
      ],
      ['readiness', () => runInBackgroundPool(() => warmReadinessResults(app))],
      ['db-tuning-twins', () => runInBackgroundPool(() => sweepTuningTwins(app))],
      ['rest-routes', () => recordRestRouteInventory(opts.restRoutes)],
      ['extension-registry', () => recordExtensionRegistryVersions(app)],
      ['portal-url', () => warnIfPortalIsAdmin(app)]
    ]
    await takeTurn(bootPassQueue)
    try {
      for (const [name, run] of passes) {
        try {
          await run()
        } catch (err) {
          warn(name, err)
        }
      }
    } finally {
      giveTurn(bootPassQueue)
    }
    const start = queryWarm as (() => Promise<void>) | null
    if (start) void start().catch((err) => warn('cache-warm (query caches)', err))
  })
}
