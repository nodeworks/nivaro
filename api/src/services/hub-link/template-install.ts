import { createHash, randomBytes } from 'node:crypto'
import type { Redis } from 'ioredis'
import { db } from '../../db/index.js'
import { runInBackgroundPool } from '../../db/pool-context.js'
import { nullsOrder } from '../../db/sql-dialect.js'
import { logActivity } from '../activity.js'
import { appBox } from '../app-state.js'
import {
  isSystemCollection,
  type SanitizeReview,
  sanitizeBlueprint,
  TemplateShapeError
} from '../blueprint-sanitize.js'
import { type InstallReport, installBlueprint, unwrapBlueprint } from '../blueprints.js'
import { getApp } from '../io-holder.js'
import { hubLinkKeyTag } from './retire.js'

/**
 * Hub link (app side, Hub enhancement 24): install an App Blueprint the Nivaro Hub sends into an
 * app the Hub has just created.
 *
 *   POST /api/hub-link/template {bundle, digest, template?: {name, version}}
 *        → 202 {install_id, status: 'running'}        (started, or the same template's run joined)
 *   GET  /api/hub-link/template/:id → {install_id, status, report?, parts?, review?, code?}
 *        status running | done | partial | failed | interrupted (routes/hub-link-template.ts)
 *
 * The caller is the Hub (the HUB_TOKEN bearer), never a person. Frozen by maintenance and refused
 * once retired, like the first administrator (services/hub-link/retire.ts isHubLinkAppWrite).
 *
 * One install at a time per app, across replicas: a Redis lock `nvr:hub-template:lock:<tag>`
 * (tag = hubLinkKeyTag: a hash of this app's HUB_TOKEN) held with a 90 s lease and renewed while
 * the run lives. A second POST of the same template while one runs answers that run's id (never a
 * second run); another template answers 409 TEMPLATE_INSTALLING. A run whose process died stops
 * renewing: its status reads `interrupted` and a new POST starts again.
 *
 * The bundle is checked against its digest (400 BAD_DIGEST), cut down to what a template may carry
 * (services/blueprint-sanitize.ts: 400 BAD_SHAPE / TOO_MANY_PARTS), and installed only into a
 * fresh app, judged under the lock: every business collection registered here, and every table of
 * the template that already exists physically, must be one the template brings — and a physical
 * table without its registration only when this same template started here before (a run cut off
 * between the table and its registration). Otherwise 409 APP_NOT_EMPTY, nothing written.
 *
 * The install runs as the oldest active administrator (by created_at) with each workflow, layout
 * and queue in its own transaction (review M5): a part that fails leaves nothing half made, the
 * run ends `partial`, and a new POST installs the rest. The report the Hub sees names parts and
 * short codes only; the driver text is logged here (review L3).
 */

export const SYSTEM_PREFIXES = ['nivaro_', 'directus_'] as const
export const TEMPLATE_LOCK_LEASE_MS = 90_000
export const TEMPLATE_HEARTBEAT_MS = 30_000
/** A running state not renewed for this long reads as interrupted. */
export const TEMPLATE_STALE_MS = 120_000
const RUN_TTL_S = 7 * 24 * 3600
const SEEN_TTL_S = 30 * 24 * 3600

export type TemplateRunStatus = 'running' | 'done' | 'partial' | 'failed' | 'interrupted'

export interface TemplateRun {
  install_id: string
  digest: string
  status: TemplateRunStatus
  started_at: string
  heartbeat_at: string
  finished_at?: string
  report?: InstallReport
  parts?: { ok: number; failed: string[] }
  review?: SanitizeReview
  collections?: string[]
  code?: string
}

export type StartResult =
  | { ok: true; run: TemplateRun; joined: boolean }
  | {
      ok: false
      status: 400 | 409 | 503
      code: string
      message: string
      /** APP_NOT_EMPTY: the collections that are not the template's (names only, at most 10). */
      extra?: string[]
    }

/** sha256 of the bundle as sent: what the Hub stored and what it says it sent. */
export function bundleDigest(bundle: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(bundle)).digest('hex')}`
}

export function isBusinessCollection(name: string): boolean {
  return !isSystemCollection(name)
}

/** Pure: the business collections that stop the install (not brought by the blueprint). */
export function foreignCollections(present: string[], brought: string[]): string[] {
  const own = new Set(brought.map((c) => c.toLowerCase()))
  return present.filter((c) => isBusinessCollection(c) && !own.has(c.toLowerCase()))
}

// ─── state: Redis (every replica), or this process when there is no Redis ────

const prefix = () => (process.env.REDIS_CHANNEL_PREFIX ?? '').trim()
export const templateLockKey = () => [prefix(), `nvr:hub-template:lock:${hubLinkKeyTag()}`].join('')
export const templateRunKey = (id: string) =>
  [prefix(), `nvr:hub-template:run:${hubLinkKeyTag()}:${id}`].join('')
export const templateSeenKey = (digest: string) =>
  [prefix(), `nvr:hub-template:seen:${hubLinkKeyTag()}:${digest}`].join('')

const local = appBox<{
  lock: { id: string; until: number } | null
  runs: Map<string, TemplateRun>
  seen: Set<string>
}>(() => ({ lock: null, runs: new Map(), seen: new Set() }))

function appRedis(): Redis | null {
  try {
    return (getApp()?.redis as Redis | undefined) ?? null
  } catch {
    return null
  }
}

const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`
const RENEW = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`

async function takeLock(id: string): Promise<string | null> {
  const redis = appRedis()
  if (redis) {
    const got = await redis.set(templateLockKey(), id, 'PX', TEMPLATE_LOCK_LEASE_MS, 'NX')
    return got === 'OK' ? null : ((await redis.get(templateLockKey())) ?? '')
  }
  const s = local.value
  if (s.lock && s.lock.until > Date.now()) return s.lock.id
  s.lock = { id, until: Date.now() + TEMPLATE_LOCK_LEASE_MS }
  return null
}

async function renewLock(id: string): Promise<void> {
  const redis = appRedis()
  if (redis) {
    await redis.eval(RENEW, 1, templateLockKey(), id, String(TEMPLATE_LOCK_LEASE_MS))
    return
  }
  const s = local.value
  if (s.lock?.id === id) s.lock.until = Date.now() + TEMPLATE_LOCK_LEASE_MS
}

async function releaseLock(id: string): Promise<void> {
  const redis = appRedis()
  if (redis) {
    await redis.eval(RELEASE, 1, templateLockKey(), id)
    return
  }
  const s = local.value
  if (s.lock?.id === id) s.lock = null
}

async function writeRun(run: TemplateRun): Promise<void> {
  const redis = appRedis()
  if (redis) {
    await redis.set(templateRunKey(run.install_id), JSON.stringify(run), 'EX', RUN_TTL_S)
    return
  }
  local.value.runs.set(run.install_id, run)
}

/** One run as stored, with a running run that stopped renewing read as interrupted. */
export async function readTemplateRun(id: string): Promise<TemplateRun | null> {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) return null
  const redis = appRedis()
  let run: TemplateRun | null = null
  if (redis) {
    const raw = await redis.get(templateRunKey(id))
    if (raw) {
      try {
        run = JSON.parse(raw) as TemplateRun
      } catch {
        run = null
      }
    }
  } else run = local.value.runs.get(id) ?? null
  if (run?.status === 'running' && Date.now() - Date.parse(run.heartbeat_at) > TEMPLATE_STALE_MS)
    return { ...run, status: 'interrupted' }
  return run
}

async function markSeen(digest: string): Promise<void> {
  const redis = appRedis()
  if (redis) await redis.set(templateSeenKey(digest), '1', 'EX', SEEN_TTL_S)
  else local.value.seen.add(digest)
}

async function wasSeen(digest: string): Promise<boolean> {
  const redis = appRedis()
  if (redis) return (await redis.get(templateSeenKey(digest))) === '1'
  return local.value.seen.has(digest)
}

// ─── the fresh-app check ─────────────────────────────────────────────────────

async function businessCollections(): Promise<string[]> {
  const rows = (await db('nivaro_collections').select('collection')) as Array<{
    collection: string
  }>
  return rows.map((r) => String(r.collection)).filter(isBusinessCollection)
}

/** The template's tables that exist physically here (registered or not). */
async function existingTables(names: string[]): Promise<Set<string>> {
  const out = new Set<string>()
  for (const n of names) if (await db.schema.hasTable(n)) out.add(n.toLowerCase())
  return out
}

/**
 * Why this app is not fresh for the template, or null. Exported for the test: registered business
 * collections outside the template, and physical tables of the template without their
 * registration (an adopted database), unless this same template started here before.
 */
export async function notFreshReason(brought: string[], digest: string): Promise<string[] | null> {
  const registered = await businessCollections()
  const foreign = foreignCollections(registered, brought)
  if (foreign.length) return foreign
  const reg = new Set(registered.map((c) => c.toLowerCase()))
  const physical = await existingTables(brought)
  const orphans = brought.filter((c) => physical.has(c.toLowerCase()) && !reg.has(c.toLowerCase()))
  if (orphans.length && !(await wasSeen(digest))) return orphans
  return null
}

/** The oldest active administrator person (the install's owner), or null. */
async function installOwner(): Promise<string | null> {
  try {
    const row = (await db('nivaro_users as u')
      .join('nivaro_roles as r', 'r.id', 'u.role')
      .where('r.admin_access', true)
      .where('u.status', 'active')
      .whereNull('u.account_kind')
      .orderByRaw(`?? asc${nullsOrder(db, 'asc')}, ?? asc`, ['u.created_at', 'u.id'])
      .first('u.id')) as { id: string } | undefined
    return row ? String(row.id) : null
  } catch {
    return null
  }
}

/** Pure: an install report the Hub may see — part names and short codes, no driver text. */
export function publicReport(report: InstallReport): InstallReport {
  return {
    ...report,
    errors: report.errors.map((e) => {
      const head = e.split(':')[0]?.trim().slice(0, 80) || 'part'
      return `${head}: INSTALL_FAILED`
    })
  }
}

// ─── start + run ─────────────────────────────────────────────────────────────

export async function startTemplateInstall(
  body: unknown,
  log: { warn: (o: object, msg: string) => void } = { warn: () => undefined }
): Promise<StartResult> {
  const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as {
    bundle?: unknown
    digest?: unknown
    template?: { name?: unknown; version?: unknown }
  }
  const raw = unwrapBlueprint(b.bundle)
  if (!raw)
    return {
      ok: false,
      status: 400,
      code: 'BAD_BUNDLE',
      message: 'The bundle is not a Nivaro blueprint or blueprint package'
    }
  const digest = bundleDigest(b.bundle)
  if (typeof b.digest !== 'string' || b.digest !== digest)
    return {
      ok: false,
      status: 400,
      code: 'BAD_DIGEST',
      message: 'The bundle does not match its digest'
    }
  let clean: ReturnType<typeof sanitizeBlueprint>
  try {
    clean = sanitizeBlueprint(raw)
  } catch (err) {
    if (err instanceof TemplateShapeError)
      return { ok: false, status: 400, code: err.code, message: err.message }
    throw err
  }
  const bp = clean.blueprint
  const brought = bp.collections.map((c) => String(c.meta.collection ?? '')).filter(Boolean)

  const id = randomBytes(12).toString('base64url')
  let holder: string | null
  try {
    holder = await takeLock(id)
  } catch {
    return {
      ok: false,
      status: 503,
      code: 'REDIS_UNAVAILABLE',
      message: 'The install lock could not be taken (Redis)'
    }
  }
  if (holder !== null) {
    const running = holder ? await readTemplateRun(holder) : null
    if (running && running.digest === digest && running.status === 'running')
      return { ok: true, run: running, joined: true }
    return {
      ok: false,
      status: 409,
      code: 'TEMPLATE_INSTALLING',
      message: 'Another template install runs here; try again when it ends'
    }
  }

  // Judged under the lock, so nothing else installs between the check and the run.
  const foreign = await notFreshReason(brought, digest).catch(async (err) => {
    await releaseLock(id).catch(() => undefined)
    throw err
  })
  if (foreign) {
    await releaseLock(id).catch(() => undefined)
    return {
      ok: false,
      status: 409,
      code: 'APP_NOT_EMPTY',
      message:
        'This app already has collections of its own; a template is installed only into a new app',
      extra: foreign.slice(0, 10)
    }
  }

  const now = new Date().toISOString()
  const run: TemplateRun = {
    install_id: id,
    digest,
    status: 'running',
    started_at: now,
    heartbeat_at: now,
    review: clean.review,
    collections: brought
  }
  try {
    await writeRun(run)
    await markSeen(digest)
  } catch {
    await releaseLock(id).catch(() => undefined)
    return {
      ok: false,
      status: 503,
      code: 'REDIS_UNAVAILABLE',
      message: 'The install could not be recorded (Redis)'
    }
  }
  const name = typeof b.template?.name === 'string' ? b.template.name.slice(0, 120) : bp.name
  const version = typeof b.template?.version === 'string' ? b.template.version.slice(0, 40) : null
  void runInBackgroundPool(() => runInstall(run, bp, { name, version }, log))
  return { ok: true, run, joined: false }
}

async function runInstall(
  run: TemplateRun,
  bp: ReturnType<typeof sanitizeBlueprint>['blueprint'],
  label: { name: string; version: string | null },
  log: { warn: (o: object, msg: string) => void }
): Promise<void> {
  const beat = setInterval(() => {
    run.heartbeat_at = new Date().toISOString()
    void renewLock(run.install_id).catch(() => undefined)
    void writeRun(run).catch(() => undefined)
  }, TEMPLATE_HEARTBEAT_MS)
  beat.unref?.()
  const failed: string[] = []
  let ok = 0
  try {
    const report = await installBlueprint(bp, await installOwner(), {
      atomic: true,
      onPart: (part, good) => {
        if (good) ok++
        else if (failed.length < 50) failed.push(part.slice(0, 120))
      }
    })
    if (report.errors.length)
      log.warn(
        { install_id: run.install_id, errors: report.errors },
        'hub link: template parts failed'
      )
    Object.assign(run, {
      status: failed.length || report.errors.length ? 'partial' : 'done',
      report: publicReport(report),
      parts: { ok, failed },
      finished_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString()
    })
    await logActivity({
      action: 'hub-template-install',
      user: null,
      collection: 'nivaro_collections',
      comment:
        `Hub template ${label.name}${label.version ? ` v${label.version}` : ''}: +${report.collections.created} collections, +${report.workflows.created} workflows, +${report.queues.created} queues${failed.length ? `, ${failed.length} parts failed` : ''}`.slice(
          0,
          400
        )
    }).catch(() => null)
  } catch (err) {
    log.warn(
      {
        install_id: run.install_id,
        err: (err as Error | null)?.message?.slice(0, 300) ?? 'failed'
      },
      'hub link: template install failed'
    )
    Object.assign(run, {
      status: 'failed',
      code: 'TEMPLATE_FAILED',
      parts: { ok, failed },
      finished_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString()
    })
  } finally {
    clearInterval(beat)
    await writeRun(run).catch(() => undefined)
    await releaseLock(run.install_id).catch(() => undefined)
  }
}

/** Tests: drop the in-process fallback state. */
export function _resetTemplateInstallForTests(): void {
  local.reset()
}
