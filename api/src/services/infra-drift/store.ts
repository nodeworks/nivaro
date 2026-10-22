import type { Knex } from 'knex'
import { db } from '../../db/index.js'
import {
  type DockerHost,
  dockerConfigured,
  dockerGet,
  dockerHostByName,
  dockerHosts,
  envDigestKeyId,
  sanitizeServiceSpec
} from '../docker-source.js'
import { getApp } from '../io-holder.js'
import {
  type DriftItem,
  diffStack,
  type NormalizedService,
  normalizeService,
  serviceStack
} from './normalize.js'

/**
 * #2798 stack drift — storage, the check and the alert. A baseline is stored per stack +
 * environment (the newest row is the current one; the last KEEP_BASELINES are kept for
 * history). The check reads live service specs ONLY through docker-source, diffs them and keeps
 * one finding row per drifted field: the same drift seen again keeps its row (first_seen,
 * alerted_at), a drift that went away is resolved, a new baseline resolves everything open for
 * its stack. Admins are told once per new finding, through notifyUser.
 */

export const BASELINES = 'nivaro_infra_drift_baselines'
export const FINDINGS = 'nivaro_infra_drift_findings'
const KEEP_BASELINES = 10
export const MAX_SERVICES = 200
const NAME_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/

export class DriftInputError extends Error {}

/** Server log (the app's pino logger once booted; the console in tests and scripts). */
function warn(msg: string): void {
  const log = (getApp() as { log?: { warn: (m: string) => void } } | null)?.log
  if (log) log.warn(msg)
  // biome-ignore lint/suspicious/noConsole: no app logger outside a running server
  else console.warn(msg)
}

export const cloudMode = (): boolean => !!process.env.CLOUD_META_DB_URL

export async function driftTablesReady(k: Knex = db): Promise<boolean> {
  try {
    return (await k.schema.hasTable(BASELINES)) && (await k.schema.hasTable(FINDINGS))
  } catch {
    return false
  }
}

export interface BaselineRow {
  id: number
  stack: string
  environment: string
  host: string | null
  version: string | null
  release: string | null
  source: 'posted' | 'live'
  service_count: number
  services: string
  env_key_id: string | null
  created_by: string | null
  created_at: Date | string
  last_checked_at: Date | string | null
  last_check_status: 'ok' | 'drift' | 'no-source' | 'error' | null
  last_check_message: string | null
  drift_count: number
}

export interface FindingRow {
  id: number
  baseline_id: number
  stack: string
  environment: string
  service: string
  field: string
  kind: DriftItem['kind']
  expected: string | null
  actual: string | null
  secret: boolean | number
  origin: DriftItem['origin']
  detail: string | null
  fingerprint: string
  first_seen: Date | string
  last_seen: Date | string
  resolved_at: Date | string | null
  alerted_at: Date | string | null
}

const cut = (v: unknown, n: number): string | null => {
  if (v == null || v === '') return null
  const s = String(v).trim()
  return s ? s.slice(0, n) : null
}

// ── Live source ──────────────────────────────────────────────────────────────

/**
 * Which Docker host a stack + environment is read from: the baseline's own host, else the
 * DOCKER_HOSTS entry named like the environment (any case), else the only configured host.
 */
export function resolveDriftHost(b: Pick<BaselineRow, 'host' | 'environment'>): {
  host: DockerHost | null
  why: string | null
} {
  const all = dockerHosts()
  if (all.length === 0)
    return { host: null, why: 'No live source — set DOCKER_HOSTS on this instance.' }
  if (b.host) {
    const h = dockerHostByName(b.host)
    return h
      ? { host: h, why: null }
      : { host: null, why: `No Docker host named "${b.host}" in DOCKER_HOSTS.` }
  }
  const env = b.environment.toLowerCase()
  const named = all.find((h) => h.name.toLowerCase() === env)
  if (named) return { host: named, why: null }
  if (all.length === 1) return { host: all[0], why: null }
  return {
    host: null,
    why: `No Docker host named "${b.environment}" — name one after the environment in DOCKER_HOSTS.`
  }
}

/** A stack's live services from one host, through docker-source (env as digests). */
export async function readLiveStack(host: DockerHost, stack: string): Promise<NormalizedService[]> {
  const raw = await dockerGet<unknown[]>(host, '/services', {
    env: 'digest',
    cacheMs: 0,
    query: { filters: { label: [`com.docker.stack.namespace=${stack}`] } }
  })
  return (Array.isArray(raw) ? raw : [])
    .filter((s) => serviceStack(s) === stack)
    .map((s) => normalizeService(s, { withPrevious: true }))
}

// ── Baselines ────────────────────────────────────────────────────────────────

export interface BaselineInput {
  stack?: unknown
  environment?: unknown
  version?: unknown
  release?: unknown
  host?: unknown
  services?: unknown
}

export interface BaselineResult {
  id: number
  stack: string
  environment: string
  source: 'posted' | 'live'
  services: number
  /** Posted services that are not in this stack's namespace (not stored). */
  ignored: string[]
  resolved_findings: number
}

/** Validates the body and returns the stack's normalized services (posted or read live). */
export async function prepareBaseline(
  input: BaselineInput,
  readLive: (host: DockerHost, stack: string) => Promise<NormalizedService[]> = readLiveStack
): Promise<{
  stack: string
  environment: string
  host: string | null
  version: string | null
  release: string | null
  source: 'posted' | 'live'
  services: NormalizedService[]
  ignored: string[]
}> {
  const stack = typeof input.stack === 'string' ? input.stack.trim() : ''
  const environment = typeof input.environment === 'string' ? input.environment.trim() : ''
  if (!NAME_SHAPE.test(stack)) throw new DriftInputError('stack must be a stack name')
  if (!NAME_SHAPE.test(environment))
    throw new DriftInputError('environment must be a name like production or staging')
  const host = input.host == null || input.host === '' ? null : String(input.host).trim()
  if (host && !/^[A-Za-z0-9_.-]{1,40}$/.test(host))
    throw new DriftInputError('host must be a DOCKER_HOSTS name')
  const version = cut(input.version, 60)
  const release = cut(input.release, 120)

  if (input.services == null) {
    const { host: h, why } = resolveDriftHost({ host, environment })
    if (!h) throw new DriftInputError(`services were not sent and ${why}`)
    const services = await readLive(h, stack)
    if (services.length === 0)
      throw new DriftInputError(`No services of stack "${stack}" are running on ${h.name}`)
    return { stack, environment, host, version, release, source: 'live', services, ignored: [] }
  }
  if (!Array.isArray(input.services)) throw new DriftInputError('services must be an array')
  if (input.services.length === 0) throw new DriftInputError('services is empty')
  if (input.services.length > MAX_SERVICES)
    throw new DriftInputError(`At most ${MAX_SERVICES} services`)
  const services: NormalizedService[] = []
  const ignored: string[] = []
  for (const raw of input.services) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new DriftInputError('each service must be a docker service inspect object')
    // The posted object goes through the same sanitizer as a live read: env becomes a digest
    // map (secret values hashed), everything else exactly what docker-source would keep.
    const clean = sanitizeServiceSpec(raw)
    const n = normalizeService(clean)
    const ns = serviceStack(clean)
    if (ns ? ns !== stack : !n.name.startsWith(`${stack}_`)) {
      ignored.push(n.name.slice(0, 200))
      continue
    }
    services.push(n)
  }
  if (services.length === 0)
    throw new DriftInputError(`None of the services belong to stack "${stack}"`)
  return { stack, environment, host, version, release, source: 'posted', services, ignored }
}

/** Stores a baseline (newest wins), resolves the stack's open findings, prunes old baselines. */
export async function recordBaseline(
  input: BaselineInput,
  userId: string | null,
  opts: {
    knex?: Knex
    readLive?: (host: DockerHost, stack: string) => Promise<NormalizedService[]>
  } = {}
): Promise<BaselineResult> {
  const k = opts.knex ?? db
  const p = await prepareBaseline(input, opts.readLive)
  // Stored without the previous-spec fields (a live read carries them; the baseline does not).
  const services = p.services.map(({ previous: _p, ...s }) => s)
  const now = new Date()
  const inserted = await k(BASELINES).insert(
    {
      stack: p.stack,
      environment: p.environment,
      host: p.host,
      version: p.version,
      release: p.release,
      source: p.source,
      service_count: services.length,
      services: JSON.stringify(services),
      env_key_id: envDigestKeyId(),
      created_by: userId,
      created_at: now,
      drift_count: 0
    },
    ['id']
  )
  const first = (Array.isArray(inserted) ? inserted[0] : inserted) as unknown
  const id = Number(typeof first === 'object' && first ? (first as { id: number }).id : first)
  const resolved = await k(FINDINGS)
    .where({ stack: p.stack, environment: p.environment })
    .whereNull('resolved_at')
    .update({ resolved_at: now })
  // Keep the newest KEEP_BASELINES per stack + environment.
  const old = (await k(BASELINES)
    .where({ stack: p.stack, environment: p.environment })
    .orderBy('id', 'desc')
    .offset(KEEP_BASELINES)
    .select('id')) as Array<{ id: number }>
  if (old.length)
    await k(BASELINES)
      .whereIn(
        'id',
        old.map((r) => r.id)
      )
      .delete()
  return {
    id,
    stack: p.stack,
    environment: p.environment,
    source: p.source,
    services: services.length,
    ignored: p.ignored,
    resolved_findings: Number(resolved) || 0
  }
}

/** The current (newest) baseline of every stack + environment. */
export async function currentBaselines(k: Knex = db): Promise<BaselineRow[]> {
  const ids = k(BASELINES).max('id as id').groupBy('stack', 'environment')
  return (await k(BASELINES)
    .whereIn('id', ids)
    .orderBy([
      { column: 'environment', order: 'asc' },
      { column: 'stack', order: 'asc' }
    ])
    .select('*')) as BaselineRow[]
}

export function baselineServices(b: Pick<BaselineRow, 'services'>): NormalizedService[] {
  try {
    const v = JSON.parse(b.services)
    return Array.isArray(v) ? (v as NormalizedService[]) : []
  } catch {
    return []
  }
}

// ── Check ────────────────────────────────────────────────────────────────────

export interface CheckOutcome {
  baseline_id: number
  stack: string
  environment: string
  /** busy = another check of this stack held the lock; nothing was recorded. */
  status: 'ok' | 'drift' | 'no-source' | 'error' | 'busy'
  message: string | null
  drift: number
  /** Findings nobody has been told about: new this check, or open and never alerted. */
  new_findings: FindingRow[]
}

/** SQL Server 2601/2627, Postgres 23505, MySQL 1062: a unique index refused the row. */
export function isDuplicateKey(err: unknown): boolean {
  const e = err as { number?: number; code?: string | number; errno?: number }
  return (
    e?.number === 2601 ||
    e?.number === 2627 ||
    e?.code === '23505' ||
    e?.errno === 1062 ||
    e?.code === 'ER_DUP_ENTRY'
  )
}

/**
 * Writes a check's items as findings: keeps matching rows, opens new ones, resolves the rest.
 * Returns the rows still to tell admins about (new ones + open ones never alerted).
 */
export async function recordFindings(
  b: Pick<BaselineRow, 'id' | 'stack' | 'environment'>,
  items: DriftItem[],
  k: Knex = db,
  now = new Date()
): Promise<FindingRow[]> {
  const open = (await k(FINDINGS)
    .where({ stack: b.stack, environment: b.environment })
    .whereNull('resolved_at')
    .select('*')) as FindingRow[]
  const openByFp = new Map(open.map((f) => [f.fingerprint, f]))
  const seen = new Set<number>()
  const fresh: DriftItem[] = []
  // Open rows nobody has been told about yet (an earlier alert reached no one) go out again.
  const untold: FindingRow[] = []
  for (const it of items) {
    const hit = openByFp.get(it.fingerprint)
    if (hit && hit.baseline_id === b.id) {
      seen.add(hit.id)
      if (!hit.alerted_at) untold.push(hit)
    } else fresh.push(it)
  }
  const stale = open.filter((f) => !seen.has(f.id)).map((f) => f.id)
  for (let i = 0; i < stale.length; i += 500)
    await k(FINDINGS)
      .whereIn('id', stale.slice(i, i + 500))
      .update({ resolved_at: now })
  const keep = [...seen]
  for (let i = 0; i < keep.length; i += 500)
    await k(FINDINGS)
      .whereIn('id', keep.slice(i, i + 500))
      .update({ last_seen: now })
  const created: FindingRow[] = []
  for (const it of fresh) {
    const row = {
      baseline_id: b.id,
      stack: b.stack,
      environment: b.environment,
      service: it.service.slice(0, 200),
      field: it.field.slice(0, 300),
      kind: it.kind,
      expected: it.expected?.slice(0, 2000) ?? null,
      actual: it.actual?.slice(0, 2000) ?? null,
      secret: it.secret,
      origin: it.origin,
      detail: it.detail?.slice(0, 500) ?? null,
      fingerprint: it.fingerprint,
      first_seen: now,
      last_seen: now
    }
    let ins: unknown
    try {
      ins = await k(FINDINGS).insert(row, ['id'])
    } catch (err) {
      // The open-row unique index (baseline_id, fingerprint WHERE resolved_at IS NULL): another
      // check recorded this drift first — it is that check's to alert, not ours.
      if (isDuplicateKey(err)) continue
      throw err
    }
    const first = (Array.isArray(ins) ? ins[0] : ins) as unknown
    const id = Number(typeof first === 'object' && first ? (first as { id: number }).id : first)
    created.push({ ...row, id, resolved_at: null, alerted_at: null } as FindingRow)
  }
  return [...created, ...untold]
}

/** Checks one baseline against the live stack and records the outcome. */
export async function checkBaseline(
  b: BaselineRow,
  opts: {
    knex?: Knex
    readLive?: (host: DockerHost, stack: string) => Promise<NormalizedService[]>
    now?: Date
  } = {}
): Promise<CheckOutcome> {
  const k = opts.knex ?? db
  const now = opts.now ?? new Date()
  const base = { baseline_id: b.id, stack: b.stack, environment: b.environment }
  const finish = async (o: Omit<CheckOutcome, keyof typeof base>): Promise<CheckOutcome> => {
    await k(BASELINES)
      .where({ id: b.id })
      .update({
        last_checked_at: now,
        last_check_status: o.status,
        last_check_message: o.message?.slice(0, 500) ?? null,
        ...(o.status === 'ok' || o.status === 'drift' ? { drift_count: o.drift } : {})
      })
    return { ...base, ...o }
  }
  const { host, why } = resolveDriftHost(b)
  // Not "no drift": without a live source nothing was compared, and the status says so.
  if (!host) return finish({ status: 'no-source', message: why, drift: 0, new_findings: [] })
  let live: NormalizedService[]
  try {
    live = await (opts.readLive ?? readLiveStack)(host, b.stack)
  } catch (err) {
    return finish({
      status: 'error',
      message: String((err as Error)?.message ?? err),
      drift: 0,
      new_findings: []
    })
  }
  let keyId: string
  try {
    keyId = envDigestKeyId()
  } catch (err) {
    return finish({
      status: 'error',
      message: String((err as Error)?.message ?? err),
      drift: 0,
      new_findings: []
    })
  }
  const secretsComparable = !b.env_key_id || b.env_key_id === keyId
  const items = diffStack(baselineServices(b), live, { secretsComparable })
  const created = await recordFindings(b, items, k, now)
  const note = secretsComparable
    ? null
    : 'Secret env values were not compared: the hash key changed since the baseline (SESSION_SECRET rotated) — take a new baseline.'
  return finish({
    status: items.length ? 'drift' : 'ok',
    message: note ?? (items.length ? null : `Live specs on ${host.name} match the baseline.`),
    drift: items.length,
    new_findings: created
  })
}

export interface RunOptions {
  knex?: Knex
  readLive?: (host: DockerHost, stack: string) => Promise<NormalizedService[]>
  /** Only this stack / environment. */
  stack?: string
  environment?: string
  /** Tell admins about new findings (default true); `alert` replaces notifyUser in proofs. */
  alert?: AlertDeps
  notify?: boolean
}

// One check per stack + environment at a time, across replicas: the nightly cron and Check now
// (or two replicas' Check now) would otherwise both record and both alert the same drift. A
// Redis SET NX lease (like the SQL checks run lock) plus a process-local guard; Redis down =
// the local guard and the open-row unique index still keep rows single.
const LOCK_TTL_S = 10 * 60
const localLocks = new Set<string>()
const lockKey = (stack: string, environment: string) =>
  `${process.env.REDIS_CHANNEL_PREFIX ?? ''}nvr:infra-drift:lock:${stack}:${environment}`

type LockRedis = {
  set: (...a: unknown[]) => Promise<unknown>
  eval: (...a: unknown[]) => Promise<unknown>
}

async function lockRedis(): Promise<LockRedis | null> {
  try {
    const { getApp } = await import('../io-holder.js')
    return (getApp()?.redis as LockRedis | undefined) ?? null
  } catch {
    return null
  }
}

/** Runs `fn` holding the stack's lock; null when another check holds it. */
export async function withStackLock<T>(
  stack: string,
  environment: string,
  fn: () => Promise<T>,
  redisArg?: LockRedis | null
): Promise<T | null> {
  const key = lockKey(stack, environment)
  if (localLocks.has(key)) return null
  localLocks.add(key)
  const redis = redisArg === undefined ? await lockRedis() : redisArg
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`
  let held = false
  try {
    if (redis) {
      const ok = await redis.set(key, token, 'EX', LOCK_TTL_S, 'NX').catch((err) => {
        warn(`[infra-drift] lock ${key}: Redis unavailable, local guard only (${err})`)
        return 'OK'
      })
      if (ok !== 'OK') return null
      held = true
    }
    return await fn()
  } finally {
    localLocks.delete(key)
    // Release only our own lease (a lease that expired and was taken by another check stays).
    if (redis && held)
      await redis
        .eval(
          "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
          1,
          key,
          token
        )
        .catch(() => undefined)
  }
}

/** Checks every current baseline (or the named one); returns each outcome. */
export async function runDriftCheck(
  opts: RunOptions & { redis?: LockRedis | null } = {}
): Promise<CheckOutcome[]> {
  const k = opts.knex ?? db
  if (!(await driftTablesReady(k))) return []
  const rows = (await currentBaselines(k)).filter(
    (b) =>
      (!opts.stack || b.stack === opts.stack) &&
      (!opts.environment || b.environment === opts.environment)
  )
  const out: CheckOutcome[] = []
  for (const b of rows) {
    // Check AND alert inside the lock, so a second check never sees rows the first has not
    // stamped yet.
    const o = await withStackLock(
      b.stack,
      b.environment,
      async () => {
        const r = await checkBaseline(b, opts)
        if (opts.notify !== false)
          await alertNewDrift([r], k, opts.alert).catch((err) => {
            warn(
              `[infra-drift] ${b.stack}:${b.environment}: alert failed — left unstamped for the next check (${(err as Error)?.message ?? err})`
            )
          })
        return r
      },
      opts.redis
    )
    out.push(
      o ?? {
        baseline_id: b.id,
        stack: b.stack,
        environment: b.environment,
        status: 'busy',
        message: 'Another check of this stack is running.',
        drift: b.drift_count,
        new_findings: []
      }
    )
  }
  return out
}

// ── Alert ────────────────────────────────────────────────────────────────────

/** One line per finding for the alert text (values never included, secret or not). */
export function findingLine(f: Pick<FindingRow, 'service' | 'field' | 'kind' | 'origin'>): string {
  const what = f.field
  const verb =
    f.kind === 'missing'
      ? 'is missing'
      : f.kind === 'extra'
        ? 'is running but not in the baseline'
        : f.kind === 'added'
          ? `${what} was added`
          : f.kind === 'removed'
            ? `${what} was removed`
            : `${what} changed`
  const how =
    f.origin === 'hand-run'
      ? ' (docker service update)'
      : f.origin === 'recreated'
        ? ' (recreated)'
        : ''
  return `${f.service}: ${verb}${how}`
}

export interface AlertNote {
  subject: string
  message: string
  url: string
}

export interface AlertDeps {
  /** Replaces notifyUser (tests and the rolled-back DB proof). */
  notify?: (userId: string, note: AlertNote) => Promise<{ dropped: boolean }>
}

/** The alert for one stack's new findings (field names only, never values). */
export function alertNote(
  o: Pick<CheckOutcome, 'stack' | 'environment' | 'new_findings'>
): AlertNote {
  const n = o.new_findings.length
  const services = new Set(o.new_findings.map((f) => f.service)).size
  const subject = `Stack drift: ${o.stack} on ${o.environment} — ${n} change${n === 1 ? '' : 's'} in ${services} service${services === 1 ? '' : 's'}`
  const lines = o.new_findings.slice(0, 6).map(findingLine)
  if (n > lines.length) lines.push(`…and ${n - lines.length} more`)
  return {
    subject: subject.slice(0, 255),
    message:
      `Live service specs no longer match what the last deploy left. ${lines.join('; ')}.`.slice(
        0,
        500
      ),
    url: `/environments?drift=${encodeURIComponent(`${o.stack}:${o.environment}`)}`
  }
}

/** Every active administrator (people, not machine identities), in id order, read in pages. */
export async function activeAdminIds(k: Knex = db, pageSize = 500): Promise<string[]> {
  const out: string[] = []
  for (let offset = 0; ; offset += pageSize) {
    let page: Array<{ id: string }>
    try {
      page = (await k('nivaro_users as u')
        .join('nivaro_roles as r', 'r.id', 'u.role')
        .where('r.admin_access', true)
        .where('u.status', 'active')
        .whereNull('u.account_kind')
        .orderBy('u.id', 'asc')
        .offset(offset)
        .limit(pageSize)
        .select('u.id')) as Array<{ id: string }>
    } catch (err) {
      // Logged, then thrown: the caller leaves the findings unstamped so the next check retries.
      warn(`[infra-drift] reading administrators failed: ${(err as Error)?.message ?? err}`)
      throw err
    }
    out.push(...page.map((r) => String(r.id)))
    if (page.length < pageSize) return out
  }
}

/** Admins are told once per new finding; the row's alerted_at is the memory. */
export async function alertNewDrift(
  outcomes: CheckOutcome[],
  k: Knex = db,
  deps: AlertDeps = {}
): Promise<number> {
  const withNew = outcomes.filter((o) => o.new_findings.length > 0)
  if (withNew.length === 0) return 0
  let notify = deps.notify
  if (!notify) {
    const { getApp } = await import('../io-holder.js')
    const app = getApp()
    if (!app) return 0
    const { notifyUser } = await import('../notification-channels.js')
    notify = async (userId, note) => {
      const r = await notifyUser(app, userId, {
        subject: note.subject,
        message: note.message,
        category: 'system',
        target: { kind: 'external', url: note.url, action: 'review' },
        source: { kind: 'infra_drift', label: 'Stack drift' },
        why: 'You are an administrator; a hand-run change to a running service is undone (or kept) by the next deploy without anyone deciding.'
      })
      return { dropped: !!r?.decision?.dropped }
    }
  }
  const admins = await activeAdminIds(k)
  if (admins.length === 0) return 0
  const { noteAlertFired } = await import('../alert-fired.js')
  let told = 0
  for (const o of withNew) {
    const note = alertNote(o)
    noteAlertFired({
      source: 'infra_drift',
      key: `${o.stack}:${o.environment}`,
      label: note.subject
    })
    let delivered = 0
    for (const id of admins) {
      try {
        if (!(await notify(id, note)).dropped) delivered++
      } catch (err) {
        // The rest still deserve a try.
        warn(`[infra-drift] notifying ${id} failed: ${(err as Error)?.message ?? err}`)
      }
    }
    // Nobody heard it (dropped or failed): left unstamped, so the next check retries.
    if (delivered === 0) continue
    told += delivered
    const ids = o.new_findings.map((f) => f.id)
    for (let i = 0; i < ids.length; i += 500)
      await k(FINDINGS)
        .whereIn('id', ids.slice(i, i + 500))
        .update({ alerted_at: new Date() })
  }
  return told
}

// ── Status (what the pages read) ─────────────────────────────────────────────

export interface DriftFindingView {
  id: number
  service: string
  field: string
  kind: DriftItem['kind']
  /** Secret values are never sent: "set" / null only. */
  expected: string | null
  actual: string | null
  secret: boolean
  origin: DriftItem['origin']
  detail: string | null
  first_seen: string
  last_seen: string
  alerted: boolean
}

export interface DriftStackView {
  baseline_id: number
  stack: string
  environment: string
  host: string | null
  /** The Docker host a check reads, or why there is none. */
  live_host: string | null
  live_note: string | null
  baseline: {
    version: string | null
    release: string | null
    source: 'posted' | 'live'
    services: number
    at: string
  }
  last_check: {
    at: string | null
    status: BaselineRow['last_check_status']
    message: string | null
  }
  drift: number
  findings: DriftFindingView[]
}

export interface DriftStatus {
  available: boolean
  cloud: boolean
  docker_configured: boolean
  /** Words for the page when there is no live source (never "no drift"). */
  source_note: string | null
  stacks: DriftStackView[]
}

const isoOf = (v: Date | string | null | undefined): string | null =>
  v == null ? null : new Date(v).toISOString()

export function findingView(f: FindingRow): DriftFindingView {
  const secret = !!f.secret
  return {
    id: f.id,
    service: f.service,
    field: f.field,
    kind: f.kind,
    expected: secret ? (f.kind === 'added' ? null : 'set') : f.expected,
    actual: secret ? (f.kind === 'removed' ? null : 'set') : f.actual,
    secret,
    origin: f.origin,
    detail: f.detail,
    first_seen: isoOf(f.first_seen) ?? '',
    last_seen: isoOf(f.last_seen) ?? '',
    alerted: !!f.alerted_at
  }
}

export async function driftStatus(k: Knex = db): Promise<DriftStatus> {
  const configured = dockerConfigured()
  const source_note = cloudMode()
    ? 'Not available in cloud mode.'
    : configured
      ? null
      : 'No live source — set DOCKER_HOSTS on this instance. Baselines are still stored; nothing is compared until a Docker host is connected.'
  if (!(await driftTablesReady(k)))
    return {
      available: false,
      cloud: cloudMode(),
      docker_configured: configured,
      source_note,
      stacks: []
    }
  const rows = await currentBaselines(k)
  const open = rows.length
    ? ((await k(FINDINGS)
        .whereNull('resolved_at')
        .whereIn(
          'baseline_id',
          rows.map((r) => r.id)
        )
        .orderBy([
          { column: 'service', order: 'asc' },
          { column: 'field', order: 'asc' }
        ])
        .select('*')) as FindingRow[])
    : []
  const stacks = rows.map((b): DriftStackView => {
    const { host, why } = resolveDriftHost(b)
    const findings = open.filter((f) => f.baseline_id === b.id).map(findingView)
    return {
      baseline_id: b.id,
      stack: b.stack,
      environment: b.environment,
      host: b.host,
      live_host: host?.name ?? null,
      live_note: why,
      baseline: {
        version: b.version,
        release: b.release,
        source: b.source,
        services: b.service_count,
        at: isoOf(b.created_at) ?? ''
      },
      last_check: {
        at: isoOf(b.last_checked_at),
        status: b.last_check_status,
        message: b.last_check_message
      },
      drift: findings.length,
      findings
    }
  })
  return { available: true, cloud: cloudMode(), docker_configured: configured, source_note, stacks }
}
