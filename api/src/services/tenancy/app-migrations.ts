import { createHmac } from 'node:crypto'
import type { ReadinessResult } from '@nivaro/extension-kit'
import type { Knex } from 'knex'
import { parseDbUrl } from '../../db/connection-url.js'
import type { runMigrationsOn } from '../../db/index.js'
import { getTenantDb, getTenantId, runWithoutTenant, withTenant } from '../../db/tenant-context.js'
import { NIVARO_VERSION } from '../../version.js'
import { forgetAppState } from '../app-state.js'
import { hubSharedConfig, perAppJobs, tenantSource } from '../deployment-mode.js'
import type { runSchemaSteps } from '../extension-schema-steps.js'
import { scrubDbError } from '../hub/db/connection.js'
import { fireAppReady } from './app-lifecycle.js'
import type { AppSchemaState } from './app-status.js'
import type { TenantRecord, TenantRegistry } from './types.js'

export type { AppSchemaState }

/**
 * Per-app migrations on a Hub shared deployment (Hub phase 6, Decision 14).
 *
 * One process serves many apps, each on its own database. When an app enters the Hub's list, or
 * the deployment runs a new version, this process migrates that app's database: the core
 * migrations under the database's advisory lock (db/index.ts runMigrationsOn, always safe), then
 * the default workspace row, then every loaded extension's schema steps, all inside the app's
 * tenant context. At most `concurrency` apps (default 2) migrate at once. Until an app is done
 * it answers 503 APP_NOT_READY (middleware/tenant.ts); its jobs are skipped (plugins/cron.ts,
 * why 'not_ready'). A failure blocks only that app and is retried at most once every 5 min.
 *
 * Every replica runs the loop. The state of an app at this version is kept in Redis
 * (`nvr:tenancy:schema:<tenantId>:<version>`, ruling R18: per version, so the old and new
 * replicas of a rolling update never overwrite each other), so a replica that finds `ok` there for
 * the same database adopts it without migrating; the advisory lock serialises replicas that do
 * migrate together. The stored value carries a fingerprint of the connection (HMAC with the
 * deployment token), never the connection itself.
 *
 * Self-hosted and Nivaro Cloud never start the loop: `appReadyForRequests` is true there.
 */

export interface AppSchemaStatus {
  state: AppSchemaState
  version: string | null
  at: string | null
  error: string | null
}

interface RedisLike {
  get(key: string): Promise<string | null>
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>
}

interface Entry extends AppSchemaStatus {
  /** Fingerprint of the database this state is about. */
  conn: string
  /** Not tried again before this time (a failure, a busy lock). */
  nextTry: number
  /** `ok` only: when the app's ledger is next checked against the newest migration file. */
  verifyAt?: number
}

interface StoredState {
  version?: unknown
  state?: unknown
  at?: unknown
  error?: unknown
  conn?: unknown
}

export interface AppSchemaDeps {
  migrate?: typeof runMigrationsOn
  schemaSteps?: typeof runSchemaSteps
  /** The default workspace ensure (middleware/workspace.ts), run inside the app. */
  workspace?: () => Promise<void>
  /** Extensions whose schema steps run (default: every extension that declared one). */
  extensions?: () => string[]
  /** The per-app seeds (services/app-seeds.ts), run inside the app after its migrations and when
   *  a migrated app is adopted here. */
  seeds?: () => Promise<unknown>
  /** Does the app's database hold the newest migration? true / false, or null when it could not
   *  be read (default: one read of its nivaro_migrations ledger, `ledgerHasMigration`). */
  schemaCurrent?: (t: TenantRecord) => Promise<boolean | null>
}

interface LoopOptions extends AppSchemaDeps {
  concurrency?: number
  intervalMs?: number
  redis?: RedisLike | null
  now?: () => number
}

/** A failed app is tried again after this long. */
export const APP_SCHEMA_RETRY_MS = 5 * 60_000
/** An `ok` app's ledger is checked against the newest migration file this often (P6-8 I-3). */
export const APP_SCHEMA_VERIFY_MS = 5 * 60_000
/** Up to this much earlier, at random, so apps adopted together do not all come due on one pass. */
export const APP_SCHEMA_VERIFY_JITTER_MS = 30_000
/** Ledger checks run at once in one pass, and the most one pass starts (the rest stay due and are
 *  taken by the next pass, 5 s later): an unreachable database holds one lane, not the pass. */
export const APP_SCHEMA_VERIFY_CONCURRENCY = 3
export const APP_SCHEMA_VERIFY_PER_PASS = 12
/** Another process held the migration lock: tried again after this long. */
const BUSY_RETRY_MS = 30_000
const DEFAULT_INTERVAL_MS = 5_000
const DEFAULT_CONCURRENCY = 2
/** How long a stored state outlives its version (old versions' keys expire by themselves). */
const STORED_TTL_S = 30 * 24 * 3600
const MIGRATED_STATUSES = new Set(['active', 'maintenance', 'provisioning'])

const states = new Map<string, Entry>()
const inFlight = new Map<string, Promise<AppSchemaStatus>>()
/** Apps whose ledger is being read now (one check at a time per app). */
const verifying = new Set<string>()
/** On once the loop started: from then on an app without an `ok` state is not ready. */
let gateOn = false
let redisRef: RedisLike | null = null
let nowFn: () => number = Date.now
let randomFn: () => number = Math.random
let loop: {
  registry: TenantRegistry
  opts: LoopOptions
  timer: ReturnType<typeof setInterval>
  kick: ReturnType<typeof setTimeout> | null
} | null = null

export const appSchemaKey = (tenantId: string, version = NIVARO_VERSION) =>
  `nvr:tenancy:schema:${tenantId}:${version}`

const PENDING: AppSchemaStatus = { state: 'pending', version: null, at: null, error: null }

/** What this process knows of one app's schema at this version. */
export function appSchemaStatus(tenantId: string): AppSchemaStatus {
  const e = states.get(tenantId)
  if (!e) return { ...PENDING }
  return { state: e.state, version: e.version, at: e.at, error: e.error }
}

/** May this app serve requests (and run jobs)? Always true unless this process migrates apps
 *  (a Hub shared deployment), and then only once its schema is `ok` at this version. */
export function appReadyForRequests(tenantId: string): boolean {
  if (!gateOn) return true
  const e = states.get(tenantId)
  return e?.state === 'ok' && e.version === NIVARO_VERSION
}

/**
 * Task 14: is this app's schema `ok` at this version by the state the migrating replicas keep in
 * Redis (appSchemaKey), for this app's database (its connection fingerprint)? For a process that
 * runs no migration loop of its own (an importer). Nothing stored, another version or database,
 * no Redis, or anything unreadable: false.
 */
export async function storedAppSchemaOk(
  t: TenantRecord,
  redis: Pick<RedisLike, 'get'> | null
): Promise<boolean> {
  if (!redis) return false
  try {
    const raw = await redis.get(appSchemaKey(t.id))
    if (!raw) return false
    const s = JSON.parse(raw) as Partial<StoredState> | null
    return s?.state === 'ok' && s.version === NIVARO_VERSION && s.conn === connFingerprint(t)
  } catch {
    return false
  }
}

/** The database an app's state is about (connFingerprint), for the stored-state readers. */
export function appConnFingerprint(t: TenantRecord): string {
  return connFingerprint(t)
}

/** The database an app's state is about: an HMAC of client + connection (never the connection). */
function connFingerprint(t: TenantRecord): string {
  // Keyed by the deployment's ENCRYPTION_KEY (required on a shared deployment, rarely rotated),
  // so rotating HUB_DEPLOYMENT_TOKEN does not make every app migrate again (review minor 5).
  const key = process.env.ENCRYPTION_KEY || hubSharedConfig()?.token || 'nivaro-app-schema'
  return createHmac('sha256', key)
    .update(`${t.dbClient}\n${t.dbConnection}`)
    .digest('hex')
    .slice(0, 32)
}

function secretsOf(t: TenantRecord): string[] {
  const out = [t.dbConnection]
  try {
    const pw = parseDbUrl(t.dbConnection).password
    if (pw) out.push(pw)
  } catch {
    // not a URL: the connection text itself is scrubbed
  }
  return out
}

/** The lock held by another process (not this app's failure): runMigrationsOn's own text. */
function lockBusy(err: unknown): boolean {
  return /could not acquire the migration advisory lock/i.test(
    err instanceof Error ? err.message : String(err)
  )
}

async function readStored(tenantId: string): Promise<StoredState | null> {
  if (!redisRef) return null
  try {
    const raw = await redisRef.get(appSchemaKey(tenantId))
    return raw ? (JSON.parse(raw) as StoredState) : null
  } catch {
    return null
  }
}

async function writeStored(tenantId: string, e: Entry): Promise<void> {
  if (!redisRef) return
  const value = JSON.stringify({
    version: e.version,
    state: e.state,
    at: e.at,
    error: e.error,
    conn: e.conn
  })
  await redisRef.set(appSchemaKey(tenantId), value, 'EX', STORED_TTL_S).catch(() => {})
}

function setState(tenantId: string, e: Entry): AppSchemaStatus {
  states.set(tenantId, e)
  return { state: e.state, version: e.version, at: e.at, error: e.error }
}

async function defaultWorkspace(): Promise<void> {
  const { ensureDefaultWorkspace } = await import('../../middleware/workspace.js')
  await ensureDefaultWorkspace()
}

async function defaultSeeds(): Promise<unknown> {
  const { runAppSeeds } = await import('../app-seeds.js')
  return runAppSeeds()
}

/** The per-app seeds inside the app; a failure is logged (runAppSeeds), never thrown. */
async function seedApp(t: TenantRecord, deps: AppSchemaDeps): Promise<void> {
  try {
    await withTenant(t, async () => void (await (deps.seeds ?? defaultSeeds)()), t.origin)
  } catch (err) {
    // biome-ignore lint/suspicious/noConsole: an operator must see a failed seed in the server log
    console.warn(`[tenancy] app ${t.id}: seeds failed — ${scrubDbError(err, secretsOf(t))}`)
  }
}

async function defaultExtensions(): Promise<string[]> {
  const { extensionsWithSchemaSteps } = await import('../extension-schema-steps.js')
  return extensionsWithSchemaSteps()
}

/** The newest migration file this build ships, as the ledger names it (cached per process). */
let newestMigration: Promise<string | null> | null = null
function newestMigrationName(): Promise<string | null> {
  newestMigration ??= import('../../db/index.js')
    .then(async ({ migrationSource }) => {
      const files = await migrationSource.getMigrations()
      const last = files[files.length - 1]
      return last ? migrationSource.getMigrationName(last) : null
    })
    .catch(() => {
      newestMigration = null
      return null
    })
  return newestMigration
}

/**
 * Does this database's ledger name the migration? One read; only when that read fails is the
 * ledger's existence asked (no ledger = an empty or replaced database = false). Any other failure
 * throws (the caller treats it as "unknown").
 */
export async function ledgerHasMigration(k: Knex, name: string): Promise<boolean> {
  try {
    return Boolean(await k('nivaro_migrations').where({ name }).first('name'))
  } catch (err) {
    if (!(await k.schema.hasTable('nivaro_migrations'))) return false
    throw err
  }
}

/** The default `schemaCurrent`: the app's own ledger, read inside the app. Null when unknown. */
async function defaultSchemaCurrent(t: TenantRecord): Promise<boolean | null> {
  const newest = await newestMigrationName()
  if (!newest) return null
  try {
    return await withTenant(t, () => ledgerHasMigration(getTenantDb() as Knex, newest), t.origin)
  } catch {
    return null
  }
}

/** One ledger check for an app: true / false, null when it could not be read. `undefined` when
 *  another check is reading this app's ledger right now — not decided, and never taken as "could
 *  not be read" (final review M2: an overlapping pass adopted such an app without the I-3 check). */
async function checkCurrent(
  t: TenantRecord,
  deps: AppSchemaDeps
): Promise<boolean | null | undefined> {
  if (verifying.has(t.id)) return undefined
  verifying.add(t.id)
  try {
    return await (deps.schemaCurrent ?? defaultSchemaCurrent)(t)
  } catch {
    return null
  } finally {
    verifying.delete(t.id)
  }
}

async function lockTimeoutMs(): Promise<number> {
  const { config } = await import('../../config.js')
  return config.MIGRATION_LOCK_TIMEOUT_MS
}

/**
 * Migrate one app's database now: core migrations (advisory lock), the default workspace row,
 * then each loaded extension's schema steps, all inside the app. Never throws: the result is the
 * app's new state. One run per app at a time (a second call joins the first).
 */
export function ensureAppSchema(
  t: TenantRecord,
  deps: AppSchemaDeps = {}
): Promise<AppSchemaStatus> {
  const running = inFlight.get(t.id)
  if (running) return running
  const p = runEnsure(t, deps).finally(() => {
    inFlight.delete(t.id)
    // A lane is free: the loop (when running) looks for the next app at once.
    nudgeAppMigrations()
  })
  inFlight.set(t.id, p)
  return p
}

async function runEnsure(t: TenantRecord, deps: AppSchemaDeps): Promise<AppSchemaStatus> {
  const conn = connFingerprint(t)
  const started: Entry = {
    state: 'running',
    version: NIVARO_VERSION,
    at: new Date(nowFn()).toISOString(),
    error: null,
    conn,
    nextTry: 0
  }
  setState(t.id, started)
  await writeStored(t.id, started)
  try {
    const timeoutMs = await lockTimeoutMs()
    const migrate = deps.migrate ?? (await import('../../db/index.js')).runMigrationsOn
    const steps = deps.schemaSteps ?? (await import('../extension-schema-steps.js')).runSchemaSteps
    const workspace = deps.workspace ?? defaultWorkspace
    await withTenant(
      t,
      async () => {
        const k = getTenantDb() as Knex
        await migrate(k, t.dbClient, { timeoutMs, safe: true })
        await workspace()
        const exts = deps.extensions ? deps.extensions() : await defaultExtensions()
        // A failed step is recorded in the app's own ledger and shown by the extension's readiness
        // (as on a self-hosted boot); it does not block the app.
        for (const extId of exts) await steps(extId, k, { timeoutMs })
        // Boot-time seeds (payload templates…) reach this app's database now (never fail it).
        await (deps.seeds ?? defaultSeeds)()
      },
      t.origin
    )
    const ok: Entry = {
      state: 'ok',
      version: NIVARO_VERSION,
      at: new Date(nowFn()).toISOString(),
      error: null,
      conn,
      nextTry: 0,
      verifyAt: nextVerifyAt(nowFn())
    }
    await writeStored(t.id, ok)
    const status = setState(t.id, ok)
    if (perAppJobs()) fireAppReady(t)
    return status
  } catch (err) {
    const at = nowFn()
    if (lockBusy(err)) {
      // Another replica is migrating this database: not a failure. Pending until it is done
      // (its stored `ok` is adopted on a later pass) or the lock is free.
      return setState(t.id, { ...PENDING, conn, nextTry: at + BUSY_RETRY_MS })
    }
    const failed: Entry = {
      state: 'failed',
      version: NIVARO_VERSION,
      at: new Date(at).toISOString(),
      error: scrubDbError(err, secretsOf(t)),
      conn,
      nextTry: at + APP_SCHEMA_RETRY_MS
    }
    // biome-ignore lint/suspicious/noConsole: an operator must see a failed app in the server log
    console.warn(`[tenancy] app ${t.id}: migrations failed — ${failed.error}`)
    // A replica that failed after another finished (`ok` stored) does not overwrite that.
    const stored = await readStored(t.id)
    if (!(stored?.state === 'ok' && stored.conn === conn)) await writeStored(t.id, failed)
    return setState(t.id, failed)
  }
}

/**
 * One look at the list: start the apps that need migrating (up to the concurrency left) and wait
 * for those started here. An app needs it when its state at this version is not `ok` for its
 * current database and its status is active, maintenance or provisioning.
 */
export function appMigrationPass(
  registry: TenantRegistry,
  deps: AppSchemaDeps & { concurrency?: number } = {}
): Promise<void> {
  return migrationPass(registry, deps, { loop: false })
}

/** The loop's pass waits at most this long for its ledger checks; one still running then (an
 *  unreachable database, held up to the pool's acquire timeout) finishes on its own and records its
 *  verdict, while the next pass may start. */
const LOOP_CHECK_WAIT_MS = 10_000

async function migrationPass(
  registry: TenantRegistry,
  deps: AppSchemaDeps & { concurrency?: number },
  mode: { loop: boolean }
): Promise<void> {
  const list = await (registry.listAll ? registry.listAll() : registry.listActive())
  const listed = new Set(list.map((t) => t.id))
  for (const id of [...states.keys()]) if (!listed.has(id) && !inFlight.has(id)) states.delete(id)
  const now = nowFn()
  const due: TenantRecord[] = []
  const toVerify: Array<{ t: TenantRecord; conn: string }> = []
  /** Stored `ok` states to adopt once the app's ledger says the database is migrated (I-3):
   *  `fresh` = no usable state here (adopt, else migrate again); `waiting` = waiting out a
   *  failure or a busy lock (adopt, else keep waiting). */
  const toAdopt: Array<{
    t: TenantRecord
    conn: string
    stored: StoredState
    kind: 'fresh' | 'waiting'
  }> = []
  for (const t of list) {
    if (!MIGRATED_STATUSES.has(t.status) || inFlight.has(t.id)) continue
    const conn = connFingerprint(t)
    const e = states.get(t.id)
    if (e && e.conn === conn) {
      if (e.state === 'ok' && e.version === NIVARO_VERSION) {
        // Every APP_SCHEMA_VERIFY_MS: is the database behind this connection still migrated? A
        // database restored from a backup or replaced by an environment refresh is not (I-3).
        if (now < (e.verifyAt ?? 0)) continue
        // Checked below, a few at a time and at most APP_SCHEMA_VERIFY_PER_PASS per pass; the
        // next check is set now, so an overlapping pass never takes the same app (review N2).
        if (toVerify.length < APP_SCHEMA_VERIFY_PER_PASS) {
          e.verifyAt = nextVerifyAt(now)
          toVerify.push({ t, conn })
        }
        continue
      }
      if (now < e.nextTry) {
        // waiting out a failure or a busy lock; another replica may have finished meanwhile
        const stored = await readStored(t.id)
        if (stored?.state === 'ok' && stored.conn === conn)
          toAdopt.push({ t, conn, stored, kind: 'waiting' })
        continue
      }
    }
    const stored = await readStored(t.id)
    if (stored?.conn === conn && stored.version === NIVARO_VERSION) {
      if (stored.state === 'ok') {
        // Adopt another replica's (or an earlier process's) run only if this database still
        // holds the newest migration; a replaced database is migrated again (I-3). Checked below
        // with the others, a few at a time.
        toAdopt.push({ t, conn, stored, kind: 'fresh' })
        continue
      }
      const at = typeof stored.at === 'string' ? Date.parse(stored.at) : Number.NaN
      if (
        stored.state === 'failed' &&
        !e &&
        Number.isFinite(at) &&
        now < at + APP_SCHEMA_RETRY_MS
      ) {
        // failed on another replica (or before a restart) less than 5 min ago
        setState(t.id, {
          state: 'failed',
          version: NIVARO_VERSION,
          at: stored.at as string,
          error: typeof stored.error === 'string' ? stored.error : null,
          conn,
          nextTry: at + APP_SCHEMA_RETRY_MS
        })
        continue
      }
    }
    due.push(t)
  }
  // The ledger checks (adoptions first, then the 5-minute checks of `ok` apps):
  // APP_SCHEMA_VERIFY_CONCURRENCY lanes, so one unreachable app database (held up to the pool's
  // acquire timeout) never holds every other app — at "getting ready" after a restart, or behind
  // its 5-minute check (final review M2).
  const checks: Array<() => Promise<void>> = [
    ...toAdopt.map(({ t, conn, stored, kind }) => async () => {
      const current = await checkCurrent(t, deps)
      if (current === undefined) return // another check is reading it: decided there
      if (current !== false) {
        // The app joins this process: its boot-time seeds first (an efp-ops release that changed
        // a template reaches every app), then it serves.
        await seedApp(t, deps)
        adopt(t, stored, conn)
        return
      }
      if (kind === 'waiting') return
      await dropOk(t.id, conn)
      due.push(t)
    }),
    ...toVerify.map(({ t, conn }) => async () => {
      const current = await checkCurrent(t, deps)
      if (current === false) {
        await dropOk(t.id, conn)
        due.push(t)
        return
      }
      // Still migrated: write the stored `ok` again so it never runs out of its TTL while the
      // app is served (Task 14 fix M3: an importer, which runs no loop, reads only that key).
      const e = states.get(t.id)
      if (current !== undefined && e?.state === 'ok' && e.conn === conn) await writeStored(t.id, e)
    })
  ]
  let next = 0
  const lane = async () => {
    while (next < checks.length) await checks[next++]()
  }
  const lanes = Promise.all(
    Array.from({ length: Math.min(APP_SCHEMA_VERIFY_CONCURRENCY, checks.length) }, lane)
  )
  if (mode.loop) {
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      lanes,
      new Promise<void>((r) => {
        timer = setTimeout(r, LOOP_CHECK_WAIT_MS)
        timer.unref?.()
      })
    ])
    if (timer) clearTimeout(timer)
  } else await lanes
  // Checked and taken with no await between, so two passes never start more than `max` together.
  const max = Math.max(1, Math.floor(deps.concurrency ?? DEFAULT_CONCURRENCY))
  const runs: Promise<AppSchemaStatus>[] = []
  for (const t of due) {
    if (inFlight.size >= max) break
    if (!inFlight.has(t.id)) runs.push(ensureAppSchema(t, deps))
  }
  // The loop does not wait for the runs: each frees its lane with a nudge (ensureAppSchema).
  if (!mode.loop) await Promise.all(runs)
}

/** The app's database is behind: forget its `ok` here and in Redis (other replicas adopt no
 *  stale `ok`; their own 5-minute check finds the same), and the app's cached module state. */
async function dropOk(tenantId: string, conn: string): Promise<void> {
  // A replaced database: nothing cached from the old one may answer the app (final review I-1).
  forgetAppState(tenantId)
  const pending: Entry = { ...PENDING, conn, nextTry: 0 }
  setState(tenantId, pending)
  await writeStored(tenantId, pending)
}

/** When an `ok` app's ledger is next checked: APP_SCHEMA_VERIFY_MS from now, minus up to
 *  APP_SCHEMA_VERIFY_JITTER_MS at random (never later than the 5 minutes). */
function nextVerifyAt(from: number): number {
  return from + APP_SCHEMA_VERIFY_MS - Math.floor(randomFn() * APP_SCHEMA_VERIFY_JITTER_MS)
}

function adopt(t: TenantRecord, stored: StoredState, conn: string): void {
  setState(t.id, {
    state: 'ok',
    version: NIVARO_VERSION,
    at: typeof stored.at === 'string' ? stored.at : null,
    error: null,
    conn,
    nextTry: 0,
    verifyAt: nextVerifyAt(nowFn())
  })
  if (perAppJobs()) fireAppReady(t)
}

/** A loop pass is deciding now; `passAgain` = one more was asked for meanwhile (final review M2:
 *  the interval started a pass every 5 s whether or not the last one had finished). */
let passRunning = false
let passAgain = false

function runLoopPass(): void {
  const l = loop
  if (!l) return
  if (passRunning) {
    passAgain = true
    return
  }
  passRunning = true
  // Outside any app: the pass reads the deployment's list and enters each app itself.
  void runWithoutTenant(() =>
    migrationPass(l.registry, l.opts, { loop: true })
      .catch(() => {})
      .finally(() => {
        passRunning = false
        if (passAgain && loop === l) {
          passAgain = false
          nudgeAppMigrations()
        }
      })
  )
}

/** Run a pass soon (a request reached an app that is not ready, a lane freed). Folded. */
/** Request nudges start a pass at most this often (a busy not-ready app is asked a lot). */
const REQUEST_NUDGE_GAP_MS = 1_000
let lastRequestNudge = Number.NEGATIVE_INFINITY

/**
 * Run a pass soon. With a tenant id (a request reached an app that is not ready): nothing while
 * that app waits out a failure or a busy lock, and at most one pass a second. Without (a lane
 * freed): within 50 ms. Folded either way.
 */
export function nudgeAppMigrations(tenantId?: string): void {
  const l = loop
  if (!l || l.kick) return
  if (tenantId !== undefined) {
    const e = states.get(tenantId)
    if (e && e.state !== 'ok' && nowFn() < e.nextTry) return
    if (Date.now() - lastRequestNudge < REQUEST_NUDGE_GAP_MS) return
    lastRequestNudge = Date.now()
  }
  l.kick = setTimeout(() => {
    l.kick = null
    runLoopPass()
  }, 50)
  l.kick.unref?.()
}

/**
 * Start migrating the deployment's apps: a pass now, then every `intervalMs` (default 5 s), and a
 * pass as soon as a lane frees. Never blocks the caller. Returns the stop function.
 */
export function startAppMigrations(registry: TenantRegistry, opts: LoopOptions = {}): () => void {
  stopLoop()
  gateOn = true
  if (opts.redis !== undefined) redisRef = opts.redis
  if (opts.now) nowFn = opts.now
  registerAppSchemasReadiness()
  const timer = setInterval(runLoopPass, Math.max(50, opts.intervalMs ?? DEFAULT_INTERVAL_MS))
  timer.unref?.()
  loop = { registry, opts, timer, kick: null }
  runLoopPass()
  return stopLoop
}

function stopLoop(): void {
  if (!loop) return
  clearInterval(loop.timer)
  if (loop.kick) clearTimeout(loop.kick)
  loop = null
}

/** Readiness `app-schemas`: inside an app, that app's own state; outside, the failed apps. */
export function judgeAppSchemas(tenantId: string | null): ReadinessResult {
  if (tenantId) {
    const s = appSchemaStatus(tenantId)
    if (s.state === 'ok') return { status: 'pass', detail: "This app's database is migrated." }
    if (s.state === 'failed')
      return {
        status: 'warn',
        detail:
          'This app\'s database could not be migrated on this deployment; it answers "not ready" until it is.',
        blockers: [s.error ?? 'The migration failed.']
      }
    return { status: 'warn', detail: "This app's database is being migrated." }
  }
  const failed = [...states.entries()].filter(([, e]) => e.state === 'failed').map(([id]) => id)
  if (failed.length)
    return {
      status: 'warn',
      detail: `Migrations failed for ${failed.length} app${failed.length === 1 ? '' : 's'}: ${failed.sort().join(', ')}. Each answers "not ready" until it is migrated; the others serve.`,
      blockers: failed.map((id) => `${id}: ${states.get(id)?.error ?? 'migration failed'}`)
    }
  return { status: 'pass', detail: 'Every app on this deployment is migrated or being migrated.' }
}

let readinessRegistered = false
function registerAppSchemasReadiness(): void {
  if (readinessRegistered) return
  readinessRegistered = true
  void import('../readiness.js')
    .then(({ registerReadinessCheck }) =>
      registerReadinessCheck({
        id: 'app-schemas',
        label: "Every app's database is migrated",
        group: 'Deploy',
        description:
          'On a Hub shared deployment: each app\'s database is migrated by this deployment when it joins or the version changes. Warns naming the apps whose migrations failed (each answers "not ready" until fixed; the others serve).',
        ttlMs: 30_000,
        run: async () => {
          if (tenantSource() !== 'hub')
            return { status: 'skip', detail: 'Not a Hub shared deployment.' }
          return judgeAppSchemas(getTenantId() ?? null)
        }
      })
    )
    .catch(() => {
      readinessRegistered = false
    })
}

/** Test seams. */
export function _configureAppMigrationsForTests(o: {
  redis?: RedisLike | null
  now?: () => number
  gate?: boolean
  random?: () => number
}): void {
  if (o.redis !== undefined) redisRef = o.redis
  if (o.now) nowFn = o.now
  if (o.random) randomFn = o.random
  if (o.gate !== undefined) gateOn = o.gate
}

export function _resetAppMigrationsForTests(): void {
  stopLoop()
  states.clear()
  inFlight.clear()
  verifying.clear()
  passRunning = false
  passAgain = false
  lastRequestNudge = Number.NEGATIVE_INFINITY
  gateOn = false
  redisRef = null
  nowFn = Date.now
  randomFn = Math.random
}
