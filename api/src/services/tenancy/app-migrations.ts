import { createHmac } from 'node:crypto'
import type { ReadinessResult } from '@nivaro/extension-kit'
import type { Knex } from 'knex'
import { parseDbUrl } from '../../db/connection-url.js'
import type { runMigrationsOn } from '../../db/index.js'
import { getTenantDb, getTenantId, runWithoutTenant, withTenant } from '../../db/tenant-context.js'
import { NIVARO_VERSION } from '../../version.js'
import { hubSharedConfig, tenantSource } from '../deployment-mode.js'
import type { runSchemaSteps } from '../extension-schema-steps.js'
import { scrubDbError } from '../hub/db/connection.js'
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
}

interface LoopOptions extends AppSchemaDeps {
  concurrency?: number
  intervalMs?: number
  redis?: RedisLike | null
  now?: () => number
}

/** A failed app is tried again after this long. */
export const APP_SCHEMA_RETRY_MS = 5 * 60_000
/** Another process held the migration lock: tried again after this long. */
const BUSY_RETRY_MS = 30_000
const DEFAULT_INTERVAL_MS = 5_000
const DEFAULT_CONCURRENCY = 2
/** How long a stored state outlives its version (old versions' keys expire by themselves). */
const STORED_TTL_S = 30 * 24 * 3600
const MIGRATED_STATUSES = new Set(['active', 'maintenance', 'provisioning'])

const states = new Map<string, Entry>()
const inFlight = new Map<string, Promise<AppSchemaStatus>>()
/** On once the loop started: from then on an app without an `ok` state is not ready. */
let gateOn = false
let redisRef: RedisLike | null = null
let nowFn: () => number = Date.now
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

/** The database an app's state is about: an HMAC of client + connection (never the connection). */
function connFingerprint(t: TenantRecord): string {
  const key = hubSharedConfig()?.token ?? 'nivaro-app-schema'
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

async function defaultExtensions(): Promise<string[]> {
  const { extensionsWithSchemaSteps } = await import('../extension-schema-steps.js')
  return extensionsWithSchemaSteps()
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
    await withTenant(t, async () => {
      const k = getTenantDb() as Knex
      await migrate(k, t.dbClient, { timeoutMs, safe: true })
      await workspace()
      const exts = deps.extensions ? deps.extensions() : await defaultExtensions()
      // A failed step is recorded in the app's own ledger and shown by the extension's readiness
      // (as on a self-hosted boot); it does not block the app.
      for (const extId of exts) await steps(extId, k, { timeoutMs })
    })
    const ok: Entry = {
      state: 'ok',
      version: NIVARO_VERSION,
      at: new Date(nowFn()).toISOString(),
      error: null,
      conn,
      nextTry: 0
    }
    await writeStored(t.id, ok)
    return setState(t.id, ok)
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
export async function appMigrationPass(
  registry: TenantRegistry,
  deps: AppSchemaDeps & { concurrency?: number } = {}
): Promise<void> {
  const list = await (registry.listAll ? registry.listAll() : registry.listActive())
  const listed = new Set(list.map((t) => t.id))
  for (const id of [...states.keys()]) if (!listed.has(id) && !inFlight.has(id)) states.delete(id)
  const now = nowFn()
  const due: TenantRecord[] = []
  for (const t of list) {
    if (!MIGRATED_STATUSES.has(t.status) || inFlight.has(t.id)) continue
    const conn = connFingerprint(t)
    const e = states.get(t.id)
    if (e && e.conn === conn) {
      if (e.state === 'ok' && e.version === NIVARO_VERSION) continue
      if (now < e.nextTry) {
        // waiting out a failure or a busy lock; another replica may have finished meanwhile
        const stored = await readStored(t.id)
        if (stored?.state === 'ok' && stored.conn === conn) adopt(t.id, stored, conn)
        continue
      }
    }
    const stored = await readStored(t.id)
    if (stored?.conn === conn && stored.version === NIVARO_VERSION) {
      if (stored.state === 'ok') {
        adopt(t.id, stored, conn)
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
  // Checked and taken with no await between, so two passes never start more than `max` together.
  const max = Math.max(1, Math.floor(deps.concurrency ?? DEFAULT_CONCURRENCY))
  const runs: Promise<AppSchemaStatus>[] = []
  for (const t of due) {
    if (inFlight.size >= max) break
    if (!inFlight.has(t.id)) runs.push(ensureAppSchema(t, deps))
  }
  await Promise.all(runs)
}

function adopt(tenantId: string, stored: StoredState, conn: string): void {
  setState(tenantId, {
    state: 'ok',
    version: NIVARO_VERSION,
    at: typeof stored.at === 'string' ? stored.at : null,
    error: null,
    conn,
    nextTry: 0
  })
}

function runLoopPass(): void {
  const l = loop
  if (!l) return
  // Outside any app: the pass reads the deployment's list and enters each app itself.
  void runWithoutTenant(() => appMigrationPass(l.registry, l.opts).catch(() => {}))
}

/** Run a pass soon (a request reached an app that is not ready, a lane freed). Folded. */
export function nudgeAppMigrations(): void {
  const l = loop
  if (!l || l.kick) return
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
}): void {
  if (o.redis !== undefined) redisRef = o.redis
  if (o.now) nowFn = o.now
  if (o.gate !== undefined) gateOn = o.gate
}

export function _resetAppMigrationsForTests(): void {
  stopLoop()
  states.clear()
  inFlight.clear()
  gateOn = false
  redisRef = null
  nowFn = Date.now
}
