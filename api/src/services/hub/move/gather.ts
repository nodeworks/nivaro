import { createHash } from 'node:crypto'
import { db } from '../../../db/index.js'
import { APP_KEY_RE, keyFingerprint } from '../../app-key-fingerprint.js'
import type {
  SharedReadiness,
  SharedReadinessCode,
  SharedReadinessItem
} from '../../hub-link/shared-readiness.js'
import { environmentFromRow, readApp } from '../apps.js'
import { listComponents } from '../components.js'
import { connectionUrl } from '../db/connection.js'
import { getDatabase, openDatabaseConnection } from '../db/databases.js'
import { agentHealth as realAgentHealth } from '../docker/agent-client.js'
import type { AgentHealth } from '../docker/agent-types.js'
import { environmentNames, type StackEdge } from '../docker/render-spec.js'
import { databaseRecordId } from '../docker/stack-env.js'
import {
  openStackSecrets,
  otherEnvironmentNames,
  readStackSettings
} from '../docker/stack-settings.js'
import { templateFor } from '../docker/templates.js'
import {
  DEFAULT_POOL_MAX,
  type DockerDriverRow,
  getDriver,
  getPlacement,
  type HubPlacementRow,
  MAX_SHARED_POOL_MAX,
  STACK_NAME_RE
} from '../drivers.js'
import {
  defaultPromoteLock,
  defaultSharedLock,
  type PromoteLock,
  type SharedLock
} from '../promote-lock.js'
import { openSecret } from '../secrets.js'
import {
  type DeploymentClient,
  DeploymentLinkError,
  deploymentClient
} from '../shared/deployment-client.js'
import { sharedPoolUsed } from '../shared/place.js'
import { sharedRedisPrefix, sharedStackSettings } from '../shared/stack-render.js'
import { getShared, openAppKey, type SharedDeployment, tenantIdFor } from '../shared/store.js'
import { tenantsOf } from '../shared/tenants.js'
import { readSharedSecrets } from '../shared/upgrade-plan.js'
import {
  MoveError,
  type MoveKind,
  type MovePlanInput,
  type MoveSourceFacts,
  type MoveTarget,
  type MoveTargetFacts,
  type PlacementSide
} from './types.js'

/**
 * Nivaro Hub phase 6 (Task 15): every fact a move plan needs, read from the Hub's records and,
 * live, from both sides — the source over its hub link (a dedicated app's shared-readiness
 * report, Task 9) or its deployment link (a shared source), the target over its deployment link
 * (a shared target: version, sign-in issuer, and a check of the app's database from there) or its
 * Docker agent (a dedicated Docker target).
 *
 * The answer never holds a token, a ticket, an encryption key or a database connection: the
 * connection is opened only for the deployment's db-check call and dropped, a Redis address is
 * kept as a hash, a key as its fingerprint. Reads only; it writes nothing and takes no lock.
 *
 * A refusal before any plan can be made (no such environment, no placement, a target that is not
 * a move) throws MoveError; everything else is a fact the plan judges.
 */

const ENVS = 'nivaro_hub_environments'
const MOVES = 'nivaro_hub_moves'
const OPEN_MOVE = ['running', 'waiting', 'interrupted']
const READINESS_TIMEOUT_MS = 10_000
/** How many other apps' databases a shared target is asked about (collision check), and how many
 *  at once. */
const IDENTITY_CHECK_MAX = 25
const IDENTITY_CHECK_PARALLEL = 4
/** The whole collision pass ends after this; what it did not reach counts as unchecked. */
const IDENTITY_CHECK_BUDGET_MS = 30_000

export interface MoveGatherDeps {
  /** The deployment link client of a shared deployment. */
  client?: (shared: SharedDeployment) => Pick<DeploymentClient, 'status' | 'appStatus' | 'dbCheck'>
  /** A dedicated app's shared-readiness report over its hub link. */
  readiness?: (env: { base_url: string }, hubToken: string) => Promise<ReadinessRead>
  agentHealth?: (driver: DockerDriverRow) => Promise<AgentHealth>
  lock?: PromoteLock
  sharedLock?: SharedLock
  /**
   * A move start re-plans while it holds its own locks (holder `move`): those are then not
   * someone else's. Unset for a plan read.
   */
  ownLocks?: boolean
  /** The shared tenant list (tests make it fail). */
  tenants?: typeof tenantsOf
  /** The identity-collision pass: how many other apps, how many at once, its total budget. */
  identity?: { max?: number; parallel?: number; budgetMs?: number }
}

export type ReadinessRead = { ok: true; report: SharedReadiness } | { ok: false; code: string }

// ── input ──────────────────────────────────────────────────────────────────────────────────

function positiveInt(v: unknown): number | null {
  const n = typeof v === 'string' && /^\d{1,10}$/.test(v) ? Number(v) : v
  return typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= 2147483647 ? n : null
}

/** The `to` of a plan or start request, checked; every problem a 400. */
export function checkMoveTarget(raw: unknown): MoveTarget {
  const b = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<
    string,
    unknown
  >
  if (b.kind === 'shared') {
    const id = positiveInt(b.shared_id)
    if (id === null)
      throw new MoveError('BAD_TARGET', 'to.shared_id must name a shared deployment.')
    if (b.pool_max === undefined || b.pool_max === null) return { kind: 'shared', shared_id: id }
    const n = b.pool_max
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_SHARED_POOL_MAX)
      throw new MoveError(
        'BAD_POOL',
        `to.pool_max must be a whole number of connections from 1 to ${MAX_SHARED_POOL_MAX}.`
      )
    return { kind: 'shared', shared_id: id, pool_max: n }
  }
  if (b.kind === 'dedicated') {
    const id = positiveInt(b.placement_id)
    if (id === null)
      throw new MoveError('BAD_TARGET', 'to.placement_id must name a dedicated placement.')
    return { kind: 'dedicated', placement_id: id }
  }
  throw new MoveError('BAD_TARGET', 'to.kind is shared or dedicated.')
}

// ── small helpers ──────────────────────────────────────────────────────────────────────────

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 32)

function codeOf(err: unknown, fallback: string): string {
  if (err instanceof DeploymentLinkError) return err.code
  const c = (err as { code?: unknown } | null)?.code
  return typeof c === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(c) ? c : fallback
}

/** A Redis db + channel prefix as a hash (never the address or its password). */
export function redisIdentity(url: string | null | undefined, prefix: string | null | undefined) {
  if (!url) return null
  try {
    const u = new URL(url)
    const db = u.pathname.replace(/^\//, '') || '0'
    const port = u.port || (u.protocol === 'rediss:' ? '6380' : '6379')
    return sha(`redis|${u.hostname.toLowerCase()}|${port}|${db}|${prefix ?? ''}`)
  } catch {
    return null
  }
}

/**
 * A shared deployment's Redis as a hash. bundled = its own (never shared). external = its
 * REDIS_URL from the deployment's sealed secrets (Task 5: one sealed JSON of plain values,
 * readSharedSecrets) with the channel prefix every shared stack runs with (sharedRedisPrefix).
 * null = the Hub cannot see it: registered, or no REDIS_URL it can open (REDIS_UNVERIFIED).
 */
async function sharedRedis(s: SharedDeployment): Promise<string | null> {
  if (s.mode !== 'docker') return null
  if (sharedStackSettings(s).redis !== 'external') return sha(`bundled|shared|${s.id}`)
  const url = (await readSharedSecrets(s.id)).REDIS_URL
  return redisIdentity(url, sharedRedisPrefix(s.key))
}

/** STORAGE_PROVIDER of a Hub-deployed shared stack: the renderer sets none, so env storage is
 *  local. null for a registered deployment (run outside the Hub: STORAGE_UNVERIFIED). */
function sharedStorage(s: SharedDeployment): string | null {
  return s.mode === 'docker' ? 'local' : null
}

/** The environment's Docker stack settings: Redis as a hash, STORAGE_PROVIDER, key fingerprint.
 *  A read that fails is a GATHER_FAILED part, never "no settings". */
async function stackFacts(
  ctx: Ctx,
  driverId: number,
  stack: string
): Promise<{ redis: string | null; storage: string | null; keyFp: string | null }> {
  let row: Awaited<ReturnType<typeof readStackSettings>>
  try {
    row = await readStackSettings(ctx.envId)
  } catch {
    ctx.failed.push("this environment's Docker stack settings")
    return { redis: null, storage: null, keyFp: null }
  }
  if (!row) return { redis: null, storage: null, keyFp: null }
  let secrets: Record<string, string> = {}
  try {
    secrets = openStackSecrets(row)
  } catch {
    ctx.failed.push("this environment's Docker stack secrets")
    return { redis: null, storage: null, keyFp: null }
  }
  const redis =
    row.redis === 'bundled'
      ? sha(`bundled|docker|${driverId}|${stack}`)
      : redisIdentity(
          row.settings.REDIS_URL ?? secrets.REDIS_URL,
          row.settings.REDIS_CHANNEL_PREFIX ?? null
        )
  const key = secrets.ENCRYPTION_KEY
  return {
    redis,
    storage: row.settings.STORAGE_PROVIDER?.trim() || 'local',
    keyFp: key && APP_KEY_RE.test(key) ? keyFingerprint(key.toLowerCase()) : null
  }
}

/** Swarm nodes when local volumes sit on more than one node (P4-33), else null. */
function multiNode(h: AgentHealth | null): number | null {
  const nodes = h?.swarm?.nodes
  return typeof nodes === 'number' && nodes > 1 && (h?.volume_driver ?? 'local') === 'local'
    ? nodes
    : null
}

async function inParallel<T, R>(
  items: T[],
  n: number,
  fn: (x: T, i: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker))
  return out
}

// ── the hub-link report of a dedicated source ──────────────────────────────────────────────

const READINESS_CODES: Record<SharedReadinessCode, true> = {
  STAGED_IMPORTS: true,
  ROW_SCHEDULES: true,
  ISSUE_TRACKERS: true,
  EXEC_SCRIPT_FLOWS: true,
  SQLITE: true,
  ENV_OBJECT_STORAGE: true,
  DIRECTORY_SYNC: true,
  PHONE_PUSH: true,
  TEAMS_BOT: true,
  MAIL_RETRY: true,
  HUDDLE_TURN: true,
  ENV_SMTP: true,
  SESSION_REPLAYS: true,
  HELP_VIDEO_RENDERS: true
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)
const shortStr = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : null)

/**
 * The report checked for shape; null when it is not one. A code this Hub does not know at level
 * `blocker` makes the whole report unreadable: an app newer than the Hub may report something a
 * shared deployment would lose, and the Hub must not read that as nothing (fails closed). An
 * unknown warning is dropped.
 */
export function parseReadiness(raw: unknown): SharedReadiness | null {
  if (!isObj(raw) || !Array.isArray(raw.codes) || raw.codes.length > 50) return null
  const codes: SharedReadinessItem[] = []
  for (const c of raw.codes) {
    if (!isObj(c) || typeof c.code !== 'string') return null
    if (c.level !== 'blocker' && c.level !== 'warning') return null
    if (!Object.hasOwn(READINESS_CODES, c.code)) {
      if (c.level === 'blocker') return null
      continue
    }
    const detail = typeof c.detail === 'string' ? c.detail.slice(0, 300) : ''
    codes.push({ code: c.code as SharedReadinessCode, level: c.level, detail })
  }
  const fp = raw.key_fp
  if (fp !== null && (typeof fp !== 'string' || !/^[0-9a-f]{32}$/.test(fp))) return null
  let oidc: SharedReadiness['oidc'] = null
  if (raw.oidc !== null && raw.oidc !== undefined) {
    if (!isObj(raw.oidc)) return null
    const host = shortStr(raw.oidc.issuer_host, 253)
    const rawTenant = raw.oidc.tenant
    const absent = rawTenant === null || rawTenant === undefined
    const tenant = absent ? null : shortStr(rawTenant, 128)
    // A tenant that is there but malformed rejects the report (never "no tenant", M-7).
    if (!host || (!absent && tenant === null)) return null
    oidc = { issuer_host: host, tenant }
  }
  const identity = raw.db_identity === null ? null : shortStr(raw.db_identity, 600)
  if (identity === undefined || (raw.db_identity !== null && identity === null)) return null
  const busy = isObj(raw.busy) ? raw.busy : null
  const files = isObj(raw.files) ? raw.files : null
  const version = shortStr(raw.version, 64)
  if (!busy || !files || !version) return null
  const b = { imports: num(busy.imports), exports: num(busy.exports), renders: num(busy.renders) }
  const f = { count: num(files.count), bytes: num(files.bytes), local: num(files.local) }
  if (Object.values(b).includes(null) || Object.values(f).includes(null)) return null
  const extensions: Record<string, string> = {}
  if (raw.extensions !== undefined && raw.extensions !== null) {
    if (!isObj(raw.extensions)) return null
    for (const [id, v] of Object.entries(raw.extensions)) {
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id) || typeof v !== 'string' || v.length > 64)
        return null
      extensions[id] = v
    }
  }
  return {
    codes,
    key_fp: fp as string | null,
    oidc,
    signin_hub: raw.signin_hub === true,
    db_identity: identity,
    busy: b as SharedReadiness['busy'],
    files: f as SharedReadiness['files'],
    version,
    extensions
  }
}

function plainHttpHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  return (
    ['localhost', '127.0.0.1', '[::1]'].includes(h) ||
    h.endsWith('.localhost') ||
    h.endsWith('.test')
  )
}

/** The report is a few KB; anything past this is not one (M-8). */
const READINESS_MAX_BYTES = 256 * 1024

/** Reads at most `max` bytes of a body; null when it is bigger (the rest is cancelled). */
async function readCapped(res: Response, max: number): Promise<string | null> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(
        () => reject(Object.assign(new Error('deadline'), { name: 'AbortError' })),
        ms
      )
    })
  ]).finally(() => clearTimeout(timer))
}

/**
 * GET {base_url}/api/hub-link/shared-readiness with the environment's hub token. The bearer goes
 * only in the header, never follows a redirect, and goes over plain http only to this machine or
 * a .test / .localhost name (the phase-3 link-client rule). Never throws.
 */
export async function readSharedReadiness(
  env: { base_url: string },
  hubToken: string,
  timeoutMs = READINESS_TIMEOUT_MS
): Promise<ReadinessRead> {
  let base: string
  try {
    const u = new URL(String(env.base_url ?? '').trim())
    if (u.protocol !== 'https:' && u.protocol !== 'http:')
      return { ok: false, code: 'BAD_BASE_URL' }
    if (u.username || u.password) return { ok: false, code: 'BAD_BASE_URL' }
    if (u.protocol === 'http:' && !plainHttpHost(u.hostname))
      return { ok: false, code: 'BAD_BASE_URL' }
    base = u.origin
  } catch {
    return { ok: false, code: 'BAD_BASE_URL' }
  }
  const ctl = new AbortController()
  let status: number
  let text: string | null
  try {
    const run = async () => {
      const res = await fetch(`${base}/api/hub-link/shared-readiness`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${hubToken}` },
        redirect: 'error',
        signal: ctl.signal
      })
      return { status: res.status, text: res.ok ? await readCapped(res, READINESS_MAX_BYTES) : '' }
    }
    ;({ status, text } = await within(run(), timeoutMs))
  } catch (err) {
    const cause = (err as { cause?: { message?: unknown } } | null)?.cause
    if (/redirect/i.test(String(cause?.message ?? '')))
      return { ok: false, code: 'HUB_LINK_REDIRECT' }
    const name = (err as { name?: unknown } | null)?.name
    return {
      ok: false,
      code: name === 'AbortError' || name === 'TimeoutError' ? 'TIMEOUT' : 'UNREACHABLE'
    }
  } finally {
    ctl.abort()
  }
  if (status === 401 || status === 403 || status === 429)
    return { ok: false, code: 'HUB_LINK_REFUSED' }
  if (status === 404) return { ok: false, code: 'HUB_LINK_MISSING' }
  if (status < 200 || status >= 300) return { ok: false, code: `HTTP_${status}` }
  if (text === null) return { ok: false, code: 'TOO_LARGE' }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return { ok: false, code: 'BAD_ANSWER' }
  }
  const report = parseReadiness(body)
  return report ? { ok: true, report } : { ok: false, code: 'BAD_ANSWER' }
}

// ── the sides ──────────────────────────────────────────────────────────────────────────────

interface Ctx {
  envId: number
  deps: MoveGatherDeps
  health: Map<number, Promise<{ h: AgentHealth | null; code: string | null }>>
  problems: string[]
  /** Parts of the gather that could not be read (GATHER_FAILED): never read as "nothing". */
  failed: string[]
}

/** The agent's health of a Docker driver, read once per gather. */
function healthOf(ctx: Ctx, driver: DockerDriverRow) {
  let p = ctx.health.get(driver.id)
  if (!p) {
    const read = ctx.deps.agentHealth ?? ((d: DockerDriverRow) => realAgentHealth(d))
    p = read(driver).then(
      (h) => ({ h, code: null }),
      (err) => ({ h: null, code: codeOf(err, 'AGENT_UNREACHABLE') })
    )
    ctx.health.set(driver.id, p)
  }
  return p
}

/** The settings a side may carry into the plan input: the stack shape only. Anything else an
 *  operator put there (an address with a password, say) stays out. */
const SAFE_SHARED_SETTINGS = ['size', 'redis', 'publish_port'] as const

async function sharedSide(ctx: Ctx, shared: SharedDeployment): Promise<PlacementSide> {
  let edge: StackEdge | null = null
  if (shared.mode === 'docker' && shared.driver_id != null) {
    const driver = await getDriver(shared.driver_id)
    if (driver?.kind === 'docker') edge = (await healthOf(ctx, driver)).h?.edge ?? null
  }
  const settings: Record<string, unknown> = {}
  for (const k of SAFE_SHARED_SETTINGS)
    if (shared.settings[k] !== undefined) settings[k] = shared.settings[k]
  return { kind: 'shared', shared: { ...shared, settings }, edge }
}

async function dedicatedSide(
  ctx: Ctx,
  placement: HubPlacementRow,
  role: 'source' | 'target'
): Promise<PlacementSide> {
  const driver = placement.driver_id == null ? null : await getDriver(placement.driver_id)
  const who = role === 'source' ? 'The current placement' : 'The target placement'
  if (driver?.kind === 'docker') {
    const name = placement.kind === 'dedicated' ? placement.target.stack : undefined
    const stack = typeof name === 'string' && STACK_NAME_RE.test(name) ? name : ''
    if (!stack) ctx.problems.push(`${who} names no usable Docker stack (target.stack).`)
    const { h } = await healthOf(ctx, driver)
    return {
      kind: 'docker',
      placement,
      driverId: driver.id,
      stack,
      edge: h?.edge ?? null
    }
  }
  if (!driver) ctx.problems.push(`${who} has no driver any more.`)
  const components = await listComponents(placement.id).catch(() => [])
  return { kind: 'gitlab', placement, components }
}

function kindOf(from: PlacementSide, to: MoveTarget): MoveKind {
  if (from.kind === 'shared') return to.kind === 'shared' ? 'between_shared' : 'to_dedicated'
  if (to.kind === 'shared') return 'to_shared'
  throw new MoveError(
    'NOT_A_MOVE',
    'A move goes onto or off a shared deployment. Between two dedicated placements, change the placement and promote instead.'
  )
}

// ── source facts ───────────────────────────────────────────────────────────────────────────

const NO_SOURCE: MoveSourceFacts = {
  reachable: false,
  error: null,
  version: null,
  key_fp: null,
  oidc: null,
  signin_hub: false,
  db_identity: null,
  files: null,
  extensions: {},
  readiness: [],
  storage_provider: null,
  redis: null
}

async function dedicatedSourceFacts(
  ctx: Ctx,
  env: { base_url: string },
  sealedToken: string | null,
  side: PlacementSide
): Promise<MoveSourceFacts> {
  const redisAndStorage =
    side.kind === 'docker' && side.stack
      ? await stackFacts(ctx, side.driverId, side.stack)
      : { redis: null, storage: null }
  const base: MoveSourceFacts = {
    ...NO_SOURCE,
    redis: redisAndStorage.redis,
    // The readiness report names env-driven object storage itself (ENV_OBJECT_STORAGE).
    storage_provider: null
  }
  if (!sealedToken) return { ...base, error: 'NO_HUB_TOKEN' }
  let token: string | null
  try {
    token = openSecret(sealedToken)
  } catch {
    token = null
  }
  if (!token) return { ...base, error: 'HUB_SECRET_UNREADABLE' }
  const read = await (ctx.deps.readiness ?? readSharedReadiness)(env, token)
  if (!read.ok) return { ...base, error: read.code }
  const r = read.report
  return {
    ...base,
    reachable: true,
    version: r.version,
    key_fp: r.key_fp,
    oidc: r.oidc,
    signin_hub: r.signin_hub,
    db_identity: r.db_identity,
    files: r.files,
    extensions: r.extensions,
    readiness: r.codes,
    // The app's own report says whether env-driven object storage is in use (ENV_OBJECT_STORAGE).
    storage_provider: r.codes.some((c) => c.code === 'ENV_OBJECT_STORAGE') ? 'object' : 'local'
  }
}

type DbWire = { client: string; connection: string }

/** The record's connection in the deployment link's db-check shape; null when it cannot be
 *  opened. Lives only in the caller's call. */
async function dbWire(recordId: number | null): Promise<DbWire | null> {
  if (recordId == null) return null
  try {
    const c = await openDatabaseConnection(recordId)
    return { client: c.engine, connection: connectionUrl(c) }
  } catch {
    return null
  }
}

async function sharedSourceFacts(
  ctx: Ctx,
  shared: SharedDeployment,
  tenantId: string,
  recordId: number | null,
  appExtensions: string[]
): Promise<MoveSourceFacts> {
  const client = (ctx.deps.client ?? ((s) => deploymentClient(s)))(shared)
  const out: MoveSourceFacts = {
    ...NO_SOURCE,
    storage_provider: sharedStorage(shared),
    redis: await sharedRedis(shared),
    // The app runs the deployment's pins of the extensions it uses.
    extensions: Object.fromEntries(
      appExtensions
        .filter((x) => typeof shared.extension_pins[x] === 'string')
        .map((x) => [x, shared.extension_pins[x]])
    )
  }
  try {
    const st = await client.appStatus(tenantId)
    Object.assign(out, {
      reachable: true,
      version: st.version,
      key_fp: st.key_fp,
      files: st.files
    })
  } catch (err) {
    return { ...out, error: codeOf(err, 'LINK_UNREACHABLE') }
  }
  try {
    out.oidc = (await client.status()).oidc
  } catch {
    out.oidc = null
  }
  const wire = await dbWire(recordId)
  if (wire) {
    try {
      out.db_identity = (await client.dbCheck(wire)).db_identity
    } catch {
      out.db_identity = null
    }
  }
  return out
}

// ── target facts ───────────────────────────────────────────────────────────────────────────

const NO_TARGET: MoveTargetFacts = {
  reachable: true,
  error: null,
  version: null,
  oidc: null,
  extensions: [],
  extension_pins: {},
  db: null,
  identity_shared_with: [],
  pool: null,
  siblings: [],
  storage_provider: null,
  redis: null,
  multi_node: null,
  stack_key_fp: null,
  in_use_by: null,
  identity_unchecked: 0
}

async function sharedTargetFacts(
  ctx: Ctx,
  shared: SharedDeployment,
  app: { id: number },
  recordId: number | null,
  poolAsked: number
): Promise<MoveTargetFacts> {
  const client = (ctx.deps.client ?? ((s) => deploymentClient(s)))(shared)
  const out: MoveTargetFacts = {
    ...NO_TARGET,
    version: shared.version_pin,
    extensions: [...shared.extensions],
    extension_pins: { ...shared.extension_pins },
    storage_provider: sharedStorage(shared),
    redis: await sharedRedis(shared),
    pool: {
      used: await sharedPoolUsed(shared.id, ctx.envId),
      budget: shared.pool_budget,
      asked: poolAsked
    }
  }
  if (shared.mode === 'docker' && shared.driver_id != null) {
    const driver = await getDriver(shared.driver_id)
    if (driver?.kind === 'docker') out.multi_node = multiNode((await healthOf(ctx, driver)).h)
  }

  let rows: Awaited<ReturnType<typeof tenantsOf>> = []
  try {
    rows = await (ctx.deps.tenants ?? tenantsOf)(shared)
  } catch {
    ctx.failed.push(`the list of apps on ${shared.key}`)
  }
  const others = rows.filter((r) => r.env.id !== ctx.envId)
  out.siblings = others.filter((r) => r.app.id === app.id).map((r) => r.env.key)

  try {
    const st = await client.status()
    out.version = st.version
    out.oidc = st.oidc
  } catch (err) {
    return { ...out, reachable: false, error: codeOf(err, 'LINK_UNREACHABLE') }
  }

  if (recordId == null) return out
  const wire = await dbWire(recordId)
  if (!wire) {
    // The record exists but the Hub cannot open its connection: never read as a pass (R2).
    out.db = { reachable: false, identity: null, error: 'CONNECTION_UNREADABLE' }
    return out
  }
  try {
    const answer = await client.dbCheck(wire)
    out.db = {
      reachable: answer.reachable,
      identity: answer.db_identity,
      error: answer.reachable ? null : 'DB_UNREACHABLE'
    }
  } catch (err) {
    const code = codeOf(err, 'LINK_UNREACHABLE')
    if (code === 'BAD_DB_CLIENT' || code === 'BAD_DB_CONNECTION' || code === 'APP_UNREACHABLE')
      out.db = { reachable: false, identity: null, error: code }
    else return { ...out, reachable: false, error: code }
  }

  // T9 carry: two different databases can report one identity from the target (containers on
  // different hosts that look alike). Ask about the other apps' databases there; a match means
  // "same database" cannot be proven for this one.
  const mine = out.db?.identity
  if (out.db?.reachable && mine) {
    const refs = new Map(
      others.length
        ? (
            (await db(ENVS)
              .whereIn(
                'id',
                others.map((r) => r.env.id)
              )
              .select('id', 'db_ref')) as Array<{ id: number; db_ref: string | null }>
          ).map((r) => [Number(r.id), databaseRecordId(r.db_ref)])
        : []
    )
    const lim = ctx.deps.identity ?? {}
    const candidates = others.filter((r) => {
      const id = refs.get(r.env.id)
      return id != null && id !== recordId
    })
    const asks = candidates.slice(0, lim.max ?? IDENTITY_CHECK_MAX)
    /** Per ask: a match label, 'no' (compared, differs), or undefined (not compared). */
    const results: Array<string | 'no' | undefined> = asks.map(() => undefined)
    let stopped = false
    const pass = inParallel(asks, lim.parallel ?? IDENTITY_CHECK_PARALLEL, async (r, i) => {
      if (stopped) return
      const w = await dbWire(refs.get(r.env.id) ?? null)
      if (!w || stopped) return
      try {
        const a = await client.dbCheck(w)
        if (stopped) return
        if (a.reachable && a.db_identity)
          results[i] = a.db_identity === mine ? `${r.app.key}/${r.env.key}` : 'no'
      } catch {
        // not compared
      }
    })
    let timer: NodeJS.Timeout | undefined
    await Promise.race([
      pass,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, lim.budgetMs ?? IDENTITY_CHECK_BUDGET_MS)
      })
    ]).finally(() => {
      stopped = true
      clearTimeout(timer)
    })
    pass.catch(() => undefined)
    const same = results.filter((x): x is string => x !== undefined && x !== 'no')
    out.identity_unchecked = candidates.length - results.filter((x) => x !== undefined).length
    out.identity_shared_with = same
  }
  return out
}

async function dedicatedTargetFacts(
  ctx: Ctx,
  side: PlacementSide,
  placementId: number
): Promise<MoveTargetFacts> {
  const out: MoveTargetFacts = { ...NO_TARGET }
  const user = (await db(`${ENVS} as e`)
    .join('nivaro_hub_apps as a', 'a.id', 'e.app_id')
    .where('e.placement_id', placementId)
    .whereNot('e.id', ctx.envId)
    .first('a.key as app', 'e.key as env')) as { app: string; env: string } | undefined
  if (user) out.in_use_by = `${user.app}/${user.env}`
  if (side.kind !== 'docker') return out
  const driver = await getDriver(side.driverId)
  const { h, code } =
    driver?.kind === 'docker' ? await healthOf(ctx, driver) : { h: null, code: 'NO_DRIVER' }
  if (!h) return { ...out, reachable: false, error: code ?? 'AGENT_UNREACHABLE' }
  out.multi_node = multiNode(h)
  if (side.stack) {
    const f = await stackFacts(ctx, side.driverId, side.stack)
    out.redis = f.redis
    out.storage_provider = f.storage
    out.stack_key_fp = f.keyFp
  }
  return out
}

// ── locks ──────────────────────────────────────────────────────────────────────────────────

async function lockFacts(ctx: Ctx, sides: SharedDeployment[]): Promise<MovePlanInput['locks']> {
  const lock = ctx.deps.lock ?? defaultPromoteLock()
  const shared = ctx.deps.sharedLock ?? defaultSharedLock()
  const ignore = (h: string | null) => (ctx.deps.ownLocks && h === 'move' ? null : h)
  let env: string | null = null
  // A lock that cannot be read is 'unreadable' (BUSY), never free (M-1).
  try {
    env = ignore((await lock.holder?.(ctx.envId)) ?? null)
    if (env === null && !ctx.deps.ownLocks) {
      const held = await lock.held(ctx.envId)
      if (held === true) env = 'held'
      else if (held === 'unknown') env = 'unreadable'
    }
  } catch {
    env = 'unreadable'
  }
  const open = await db(MOVES)
    .where({ environment_id: ctx.envId })
    .whereIn('status', OPEN_MOVE)
    .first('id')
  const seen = new Set<number>()
  const out: MovePlanInput['locks']['shared'] = []
  for (const s of sides) {
    if (seen.has(s.id)) continue
    seen.add(s.id)
    let holder: string | null = null
    try {
      holder = ignore(await shared.holder(s.id))
    } catch {
      holder = 'unreadable'
    }
    out.push({ id: s.id, key: s.key, holder, upgrading: s.status === 'upgrading' })
  }
  return { env, open_move: !!open && !ctx.deps.ownLocks, shared: out }
}

// ── the gather ─────────────────────────────────────────────────────────────────────────────

export async function gatherMovePlanInput(
  envId: number,
  to: MoveTarget,
  deps: MoveGatherDeps = {}
): Promise<MovePlanInput> {
  const target = checkMoveTarget(to)
  const row = (await db(ENVS).where({ id: envId }).first()) as Record<string, unknown> | undefined
  if (!row) throw new MoveError('NOT_FOUND', 'No such environment.', 404)
  const env = environmentFromRow(row)
  const app = await readApp(env.app_id)
  if (!app) throw new MoveError('NOT_FOUND', 'No such app.', 404)
  if (env.placement_id == null)
    throw new MoveError(
      'NO_PLACEMENT',
      'This environment has no placement yet: place it on a shared deployment instead of moving it.',
      409
    )
  const current = await getPlacement(env.placement_id)
  if (!current)
    throw new MoveError('NO_PLACEMENT', "This environment's placement no longer exists.", 409)

  const ctx: Ctx = { envId, deps, health: new Map(), problems: [], failed: [] }

  // The sides.
  let from: PlacementSide
  /** The shared deployments as stored (full settings: Redis and storage are judged on them). */
  let fromShared: SharedDeployment | null = null
  let toShared: SharedDeployment | null = null
  if (current.kind === 'shared') {
    const s = await getShared(current.shared_deployment_id)
    if (!s)
      throw new MoveError(
        'NOT_FOUND',
        'The shared deployment this environment runs on no longer exists.',
        409
      )
    fromShared = s
    from = await sharedSide(ctx, s)
  } else from = await dedicatedSide(ctx, current, 'source')

  let toSide: PlacementSide
  if (target.kind === 'shared') {
    const s = await getShared(target.shared_id)
    if (!s) throw new MoveError('NOT_FOUND', 'No such shared deployment.', 404)
    toShared = s
    toSide = await sharedSide(ctx, s)
  } else {
    const p = await getPlacement(target.placement_id)
    if (!p) throw new MoveError('NOT_FOUND', 'No such placement.', 404)
    if (p.kind === 'shared')
      throw new MoveError(
        'BAD_TARGET',
        'That placement is on a shared deployment: name the shared deployment (to.kind shared) instead.'
      )
    toSide = await dedicatedSide(ctx, p, 'target')
  }
  const kind = kindOf(from, target)

  // The Hub's own records.
  const recordId = databaseRecordId(row.db_ref)
  const record = recordId == null ? null : await getDatabase(recordId).catch(() => null)
  const names = environmentNames(env)
  const others = await otherEnvironmentNames(envId)
  let appKey: string | null = null
  try {
    appKey = await openAppKey(envId)
  } catch {
    appKey = null
  }
  const tenantId = tenantIdFor(app, env)
  const poolAsked =
    target.kind === 'shared' ? (target.pool_max ?? DEFAULT_POOL_MAX) : DEFAULT_POOL_MAX

  /** Only a ready record is checked from a side (one not ready is NO_DATABASE_RECORD). */
  const readyRecord = record?.status === 'ready' ? record.id : null

  // Live: both sides at once.
  const [source, targetFacts] = await Promise.all([
    fromShared
      ? sharedSourceFacts(ctx, fromShared, tenantId, readyRecord, app.extensions)
      : dedicatedSourceFacts(ctx, env, (row.hub_token as string | null) ?? null, from),
    toSide.kind !== 'shared'
      ? dedicatedTargetFacts(ctx, toSide, toSide.placement.id)
      : sharedTargetFacts(ctx, toShared ?? toSide.shared, app, readyRecord, poolAsked)
  ])

  // A Docker target is deployed at the source's version: it needs a stack template for it.
  const version = source.version ?? env.version_pin
  if (toSide.kind === 'docker' && version) {
    try {
      templateFor(version)
    } catch {
      ctx.problems.push(`Docker stacks have no template for Nivaro ${version}.`)
    }
  }

  const sharedSides = [from, toSide]
    .filter((s): s is Extract<PlacementSide, { kind: 'shared' }> => s.kind === 'shared')
    .map((s) => s.shared)

  return {
    kind,
    app: {
      id: app.id,
      key: app.key,
      signin_mode: app.signin_mode,
      extensions: [...app.extensions]
    },
    env: { id: env.id, key: env.key, hub_linked: !!row.hub_token, version_pin: env.version_pin },
    from,
    to: toSide,
    target,
    names,
    names_taken: names.filter((n) => others.has(n)),
    database: record ? { id: record.id, ready: record.status === 'ready' } : null,
    app_key: { known: !!appKey, fp: appKey ? keyFingerprint(appKey) : null },
    locks: await lockFacts(ctx, sharedSides),
    source,
    target_facts: targetFacts,
    driver_problem: ctx.problems.length ? ctx.problems.join(' ') : null,
    gather_failed: [...ctx.failed]
  }
}
