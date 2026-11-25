import { insertReturningId } from '../../../db/dialect/ef.js'
import { db } from '../../../db/index.js'
import { logActivity } from '../../activity.js'
import { getApp } from '../../io-holder.js'
import { startWithChecklist } from '../changes/checklist.js'
import { recordOutsideWindow, windowWasClosed } from '../changes/emergency.js'
import { componentTargetBranch, listComponents } from '../components.js'
import { creationOpenRefusal } from '../create/store.js'
import { strictPinMap } from '../docker/stack-gather.js'
import { dockerTargetOf } from '../docker/stack-guards.js'
import {
  driverCtx,
  type GitlabDriverRow,
  getDriver,
  getPlacement,
  repositoryIdentity
} from '../drivers.js'
import { commitFile, readFile, runDeployJob } from '../gitlab-write.js'
import { moveOpenRefusal } from '../move-open.js'
import { notifyHubEvent } from '../notify-events.js'
import { flagOf, productionMap } from '../owner-access.js'
import {
  defaultBranchLock,
  defaultPromoteLock,
  holdBranches,
  LOCK_RENEW_MS,
  type PromoteLock
} from '../promote-lock.js'
import { startStackApply } from '../promote-run.js'
import { freezeRefusal } from '../releases/freeze.js'
import { getShared } from '../shared/store.js'
import { callVerify, type VerifyEnvTarget, type VerifyLinkDeps, verifyTargets } from './link.js'

/**
 * The extension version manager (Hub verification, idea 31): which extension each environment
 * runs and promoting ONE extension on its own.
 *
 * What runs: each environment's app reports the extensions it loaded over its link (id, status,
 * manifest version, build — GET …/verify/extensions, 0.3.215+); the Hub adds what it PINS there:
 *   - a Docker stack: nivaro_hub_environments.extension_pins (image@sha256:digest per id);
 *   - a GitLab deploy: the pin file `extensions/<id>.pin` beside the driver's pin file, on the
 *     environment's target branch (one line: image@sha256:digest);
 *   - a shared deployment: the deployment's extension pins (deployment-wide).
 * Both are kept in nivaro_hub_extension_sightings by the `hub-verify-extensions` tick (every 30
 * minutes) and by Refresh.
 *
 * Behind: in each app's promotion chain an environment is BEHIND for an extension when the one
 * before it runs something else (pin, else build, else version) and, when both report x.y.z
 * versions, not an older one; `missing` when the one before has it and this one does not.
 *
 * Promote one extension (admin; typed environment key): the target takes the pin of the
 * environment before it (or a given pin). Docker: the pin is written into the environment's
 * extension pins and Apply now redeploys the stack (lock, freeze, verify, history — a normal Hub
 * deploy; a refused start puts the old pins back). GitLab: the pin file is committed to the target
 * branch (one commit; GitLab refuses it if the file changed meanwhile) and that repository's CI
 * deploys it. A shared deployment's pins are deployment-wide: refused (EXTENSION_ON_SHARED).
 * Every promote is refused while a move is open (MOVE_OPEN), a GitLab one also in a freeze window
 * (FROZEN) and while the environment's promotion lock is held (LOCKED).
 */

const ENVS = 'nivaro_hub_environments'
const APPS = 'nivaro_hub_apps'
export const SIGHTINGS = 'nivaro_hub_extension_sightings'
export const EXT_PROMOTIONS = 'nivaro_hub_extension_promotions'

export const EXTENSION_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/
export const PIN_RE = /^[^@\s]+@sha256:[0-9a-f]{64}$/
const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)$/

export type PinSource = 'docker' | 'gitlab' | 'shared'

export class ExtensionError extends Error {
  code: string
  status: number
  constructor(code: string, message: string, status = 409) {
    super(message)
    this.code = code
    this.status = status
  }
}

// ─── Pure rules ────────────────────────────────────────────────────────────────

/** The GitLab pin file of an extension: `extensions/<id>.pin` in the driver pin file's folder. */
export function extensionPinPath(pinFile: string | null | undefined, id: string): string {
  const f = String(pinFile ?? '').trim()
  const cut = f.lastIndexOf('/')
  return `${cut >= 0 ? f.slice(0, cut + 1) : ''}extensions/${id}.pin`
}

/** The pin a pin file holds (its first non-empty line), or null when it is not one. */
export function pinFromFile(text: string | null): string | null {
  const line = String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l)
  return line && PIN_RE.test(line) ? line : null
}

export interface CellFacts {
  version: string | null
  build: string | null
  status: string | null
  pin: string | null
}

export type CellState = 'first' | 'same' | 'behind' | 'ahead' | 'missing' | 'unknown'

/** What identifies the extension that runs: the pin, else the build, else the version. */
export function identity(c: CellFacts | null): string | null {
  if (!c) return null
  if (c.status === 'absent') return null
  return c.pin ?? c.build ?? c.version ?? null
}

function semver(v: string | null): number[] | null {
  const m = SEMVER_RE.exec(String(v ?? '').trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

function cmp(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

/** Per environment in chain order: its state against the environment before it (pure). */
export function judgeChain(cells: Array<CellFacts | null>): CellState[] {
  return cells.map((c, i) => {
    if (i === 0) return identity(c) ? 'first' : 'unknown'
    const prev = cells[i - 1]
    const mine = identity(c)
    const theirs = identity(prev)
    if (!theirs) return mine ? 'first' : 'unknown'
    if (!mine) return c?.status === 'absent' || !c ? 'missing' : 'unknown'
    if (mine === theirs) return 'same'
    const a = semver(c?.version ?? null)
    const b = semver(prev?.version ?? null)
    if (a && b) {
      const d = cmp(a, b)
      if (d > 0) return 'ahead'
      if (d < 0) return 'behind'
      // Same version, another build or image: what runs differs from the one before.
      return 'behind'
    }
    return 'behind'
  })
}

// ─── Reading what runs ─────────────────────────────────────────────────────────

export interface Sighting extends CellFacts {
  environment_id: number
  extension_id: string
  enabled: boolean | null
  pin_source: PinSource | null
  seen_at: string | null
  pin_read_at: string | null
}

const iso = (v: unknown) => (v == null ? null : new Date(v as string | Date).toISOString())
const str = (v: unknown) => (v == null || v === '' ? null : String(v))

export function sightingFromRow(r: Record<string, unknown>): Sighting {
  return {
    environment_id: Number(r.environment_id),
    extension_id: String(r.extension_id),
    version: str(r.version),
    build: str(r.build),
    status: str(r.status),
    enabled: r.enabled == null ? null : r.enabled === true || r.enabled === 1 || r.enabled === '1',
    pin: str(r.pin),
    pin_source: (str(r.pin_source) as PinSource | null) ?? null,
    seen_at: iso(r.seen_at),
    pin_read_at: iso(r.pin_read_at)
  }
}

async function upsertSighting(
  envId: number,
  extId: string,
  patch: Record<string, unknown>
): Promise<void> {
  const changed = await db(SIGHTINGS)
    .where({ environment_id: envId, extension_id: extId })
    .update(patch)
  if (changed) return
  try {
    await db(SIGHTINGS).insert({ environment_id: envId, extension_id: extId, ...patch })
  } catch {
    await db(SIGHTINGS).where({ environment_id: envId, extension_id: extId }).update(patch)
  }
}

interface GitlabPinTarget {
  driver: GitlabDriverRow
  branch: string
  /** The API component's own jobs (null = the driver's deploy job, no before job). */
  before_job: string | null
  deploy_job: string | null
}

/** The GitLab driver + branch an environment's API deploys through, or null. */
export async function gitlabPinTarget(envId: number): Promise<GitlabPinTarget | null> {
  const env = (await db(ENVS).where({ id: envId }).first('placement_id')) as
    | { placement_id: number | null }
    | undefined
  if (env?.placement_id == null) return null
  const placement = await getPlacement(Number(env.placement_id))
  if (!placement || placement.kind === 'shared') return null
  for (const c of await listComponents(placement.id)) {
    if (c.kind !== 'api') continue
    const driver = await getDriver(c.driver_id)
    if (driver?.kind !== 'gitlab') continue
    const branch = componentTargetBranch(c, placement, driver.config.branch)
    if (branch)
      return { driver, branch, before_job: c.before_job ?? null, deploy_job: c.deploy_job ?? null }
  }
  return null
}

export interface ReadDeps {
  link?: VerifyLinkDeps
  readFile?: typeof readFile
  now?: () => number
}

/** What the Hub pins for each id on one environment (source + pin; pin null = none). */
export async function readPins(
  env: VerifyEnvTarget,
  ids: string[],
  deps: ReadDeps = {}
): Promise<{ source: PinSource | null; pins: Map<string, string | null> }> {
  const pins = new Map<string, string | null>()
  if (env.shared_deployment_id != null) {
    const s = await getShared(env.shared_deployment_id)
    for (const id of ids) pins.set(id, s?.extension_pins?.[id] ?? null)
    return { source: 'shared', pins }
  }
  if (await dockerTargetOf(env.id)) {
    const row = (await db(ENVS).where({ id: env.id }).first('extension_pins')) as
      | { extension_pins: unknown }
      | undefined
    const map = strictPinMap(row?.extension_pins ?? '{}') ?? {}
    for (const id of ids) pins.set(id, map[id] ?? null)
    return { source: 'docker', pins }
  }
  const gl = await gitlabPinTarget(env.id)
  if (gl) {
    const read = deps.readFile ?? readFile
    const ctx = driverCtx(gl.driver)
    for (const id of ids) {
      try {
        pins.set(
          id,
          pinFromFile(await read(ctx, extensionPinPath(gl.driver.config.pin_file, id), gl.branch))
        )
      } catch {
        // GitLab did not answer for this one: keep what was read last time.
      }
    }
    return { source: 'gitlab', pins }
  }
  return { source: null, pins }
}

/** Reads one environment's extensions and pins into the sightings. Answers the link state. */
export async function refreshEnvironment(
  env: VerifyEnvTarget,
  appExtensions: string[],
  deps: ReadDeps = {}
): Promise<string> {
  const now = new Date(deps.now ? deps.now() : Date.now())
  const res = await callVerify(env, 'extensions', undefined, deps.link)
  const reported = new Map<string, Record<string, unknown>>()
  const list = (res.body as { extensions?: unknown } | null)?.extensions
  if (res.state === 'ok' && Array.isArray(list))
    for (const x of list as Array<Record<string, unknown>>)
      if (typeof x?.id === 'string' && EXTENSION_ID_RE.test(x.id)) reported.set(x.id, x)
  const known = (
    (await db(SIGHTINGS).where({ environment_id: env.id }).select('extension_id')) as Array<{
      extension_id: string
    }>
  ).map((r) => r.extension_id)
  const ids = [...new Set([...appExtensions, ...reported.keys(), ...known])]
    .filter((id) => EXTENSION_ID_RE.test(id))
    .sort()
    .slice(0, 50)
  if (res.state === 'ok') {
    for (const id of ids) {
      const x = reported.get(id)
      await upsertSighting(
        env.id,
        id,
        x
          ? {
              version: str(x.version)?.slice(0, 64) ?? null,
              build: str(x.build)?.slice(0, 80) ?? null,
              status: (str(x.status) ?? 'loaded').slice(0, 16),
              enabled: x.enabled !== false,
              seen_at: now
            }
          : { version: null, build: null, status: 'absent', enabled: null, seen_at: now }
      )
    }
  }
  const { source, pins } = await readPins(env, ids, deps).catch(() => ({
    source: null,
    pins: new Map<string, string | null>()
  }))
  for (const [id, pin] of pins)
    await upsertSighting(env.id, id, { pin, pin_source: source, pin_read_at: now })
  return res.state
}

/** Refreshes every environment (or those of `appIds`). Answers how many could be read. */
export async function refreshSightings(
  o: { appIds?: number[] } = {},
  deps: ReadDeps = {}
): Promise<number> {
  const apps = (await db(APPS).select('id', 'extensions')) as Array<Record<string, unknown>>
  const extOf = new Map<number, string[]>()
  for (const a of apps) extOf.set(Number(a.id), stringList(a.extensions))
  const envRows = (await db(ENVS)
    .whereNot({ status: 'archived' })
    .modify((q) => {
      if (o.appIds) q.whereIn('app_id', o.appIds.length ? o.appIds : [-1])
    })
    .select('id', 'app_id')) as Array<{ id: number; app_id: number }>
  if (!envRows.length) return 0
  const targets = await verifyTargets(envRows.map((e) => Number(e.id)))
  const appOf = new Map(envRows.map((e) => [Number(e.id), Number(e.app_id)]))
  let ok = 0
  for (const t of targets) {
    const state = await refreshEnvironment(t, extOf.get(appOf.get(t.id) ?? -1) ?? [], deps).catch(
      () => 'failed'
    )
    if (state === 'ok') ok++
  }
  return ok
}

function stringList(v: unknown): string[] {
  try {
    const p = typeof v === 'string' ? JSON.parse(v) : v
    if (Array.isArray(p)) return p.filter((x): x is string => typeof x === 'string')
  } catch {
    /* comma list below */
  }
  return typeof v === 'string'
    ? v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : []
}

// ─── The matrix ────────────────────────────────────────────────────────────────

export interface MatrixEnv {
  id: number
  key: string
  position: number
  production: boolean
  on_shared: boolean
}

export interface MatrixCell extends Sighting {
  state: CellState
}

export interface AppMatrix {
  app: { id: number; key: string; name: string }
  environments: MatrixEnv[]
  extensions: Array<{ id: string; cells: Array<MatrixCell | null>; behind: number }>
}

export async function extensionMatrix(appIds: number[] | null): Promise<AppMatrix[]> {
  const aq = db(APPS).orderBy('key', 'asc').select('id', 'key', 'name', 'extensions')
  if (appIds) aq.whereIn('id', appIds.length ? appIds : [-1])
  const apps = (await aq) as Array<Record<string, unknown>>
  if (!apps.length) return []
  const envs = (await db(`${ENVS} as e`)
    .leftJoin('nivaro_hub_placements as p', 'p.id', 'e.placement_id')
    .whereIn(
      'e.app_id',
      apps.map((a) => Number(a.id))
    )
    .orderBy('e.position', 'asc')
    .orderBy('e.id', 'asc')
    .select(
      'e.id',
      'e.app_id',
      'e.key',
      'e.position',
      'e.status',
      'e.production',
      'p.kind as placement_kind'
    )) as Array<Record<string, unknown>>
  const sightings = envs.length
    ? (
        (await db(SIGHTINGS).whereIn(
          'environment_id',
          envs.map((e) => Number(e.id))
        )) as Array<Record<string, unknown>>
      ).map(sightingFromRow)
    : []
  const out: AppMatrix[] = []
  for (const a of apps) {
    const appId = Number(a.id)
    const mine = envs.filter((e) => Number(e.app_id) === appId)
    const prod = productionMap(
      mine.map((e) => ({
        id: Number(e.id),
        key: String(e.key),
        position: Number(e.position ?? 0),
        status: e.status == null ? null : String(e.status),
        production: flagOf(e.production)
      }))
    )
    const chain = mine.filter((e) => e.status !== 'archived')
    const environments: MatrixEnv[] = chain.map((e) => ({
      id: Number(e.id),
      key: String(e.key),
      position: Number(e.position ?? 0),
      production: prod.get(Number(e.id)) ?? true,
      on_shared: e.placement_kind === 'shared'
    }))
    const ids = new Set(stringList(a.extensions).filter((id) => EXTENSION_ID_RE.test(id)))
    for (const s of sightings)
      if (environments.some((e) => e.id === s.environment_id) && s.status !== 'absent')
        ids.add(s.extension_id)
    const extensions = [...ids].sort().map((id) => {
      const facts = environments.map(
        (e) => sightings.find((s) => s.environment_id === e.id && s.extension_id === id) ?? null
      )
      const states = judgeChain(facts)
      const cells = facts.map((f, i) => (f ? { ...f, state: states[i] } : null))
      return { id, cells, behind: states.filter((s) => s === 'behind' || s === 'missing').length }
    })
    out.push({
      app: { id: appId, key: String(a.key), name: String(a.name ?? a.key) },
      environments,
      extensions
    })
  }
  return out
}

// ─── Promoting one extension ───────────────────────────────────────────────────

export interface PromoteInput {
  /** Take the pin of this environment (default: the one before the target in the chain). */
  from_env_id?: number | null
  /** Or a pin given as is (image@sha256:digest). */
  pin?: string | null
  /** An administrator's emergency start outside the deploy window (outsideWindowOf). */
  outsideWindow?: { reason: string } | null
}

export interface ExtensionPlan {
  environment: { id: number; key: string; app_id: number; production: boolean }
  extension_id: string
  via: PinSource | null
  from_env: { id: number; key: string } | null
  current_pin: string | null
  to_pin: string | null
  blockers: Array<{ code: string; text: string }>
}

async function chainOf(appId: number) {
  const rows = (await db(ENVS)
    .where({ app_id: appId })
    .orderBy('position', 'asc')
    .orderBy('id', 'asc')
    .select('id', 'key', 'position', 'status', 'production')) as Array<Record<string, unknown>>
  const prod = productionMap(
    rows.map((e) => ({
      id: Number(e.id),
      key: String(e.key),
      position: Number(e.position ?? 0),
      status: e.status == null ? null : String(e.status),
      production: flagOf(e.production)
    }))
  )
  return {
    chain: rows
      .filter((r) => r.status !== 'archived')
      .map((r) => ({ id: Number(r.id), key: String(r.key) })),
    prod
  }
}

/**
 * THE change-engine gate of an extension promote beyond the plan's own blockers: freeze windows
 * and deploy windows (freezeRefusal, action `extension_promote`, judged for THIS environment so
 * production-only windows apply). `skipWindows` = an administrator's emergency start outside the
 * window (services/hub/changes/emergency.ts): freezes still refuse. Called by the plan (as a
 * blocker) and again at the start of both paths (inside the lock for GitLab). The production
 * pre-deploy checklist (checklistGate, action `extension_promote`) is claimed by
 * promoteExtension through startWithChecklist, linked as run kind `extension`.
 */
export async function extensionPromoteRefusal(
  appId: number,
  envId: number,
  o: { skipWindows?: boolean } = {}
): Promise<{ code: string; message: string; status: number } | null> {
  const frozen = await freezeRefusal({
    appIds: [appId],
    action: 'extension_promote',
    envId,
    ...(o.skipWindows ? { skipWindows: true } : {})
  })
  return frozen ? { code: frozen.code, message: frozen.message, status: frozen.status } : null
}

/**
 * The "version" an extension promote's checklist is ticked for (one checklist per extension and
 * image): `<extension id>@<first 12 hex of the digest>` — the admin Extensions panel builds the
 * same string (verify-api.ts).
 */
export function extensionChecklistVersion(extId: string, pin: string): string {
  const at = pin.indexOf('@sha256:')
  return `${extId}@${at >= 0 ? pin.slice(at + 8, at + 20) : pin.slice(0, 12)}`.slice(0, 64)
}

/** The Nivaro version the Hub last deployed to an environment (promote / rollback), or its pin. */
async function deployedVersion(envId: number): Promise<string | null> {
  const row = (await db('nivaro_hub_deploys')
    .where({ environment_id: envId, status: 'success' })
    .whereIn('kind', ['promote', 'rollback'])
    .orderBy('id', 'desc')
    .first('version')) as { version: string } | undefined
  if (row?.version) return String(row.version)
  const env = (await db(ENVS).where({ id: envId }).first('version_pin')) as
    | { version_pin: string | null }
    | undefined
  return env?.version_pin ? String(env.version_pin) : null
}

/** Whether the app declares the extension or one of its environments was seen with it (L4). */
async function knownExtension(appId: number, extId: string): Promise<boolean> {
  const app = (await db(APPS).where({ id: appId }).first('extensions')) as
    | { extensions: unknown }
    | undefined
  if (stringList(app?.extensions).includes(extId)) return true
  const seen = await db(`${SIGHTINGS} as s`)
    .join(`${ENVS} as e`, 'e.id', 's.environment_id')
    .where('e.app_id', appId)
    .where('s.extension_id', extId)
    .whereNot('s.status', 'absent')
    .first('s.id')
  return !!seen
}

/** The plan of promoting `extId` into `envId` (a read: nothing is written). */
export async function planExtensionPromote(
  envId: number,
  extId: string,
  input: PromoteInput,
  deps: ReadDeps & { lock?: PromoteLock } = {}
): Promise<ExtensionPlan> {
  if (!EXTENSION_ID_RE.test(extId))
    throw new ExtensionError('BAD_EXTENSION', 'That is not an extension id.', 400)
  const target = (await verifyTargets([envId]))[0]
  const env = (await db(ENVS).where({ id: envId }).first('id', 'key', 'app_id', 'status')) as
    | Record<string, unknown>
    | undefined
  if (!target || !env || env.status === 'archived')
    throw new ExtensionError('NOT_FOUND', 'Not found', 404)
  const appId = Number(env.app_id)
  const { chain, prod } = await chainOf(appId)
  const blockers: ExtensionPlan['blockers'] = []
  const block = (code: string, text: string) => blockers.push({ code, text })

  if (!(await knownExtension(appId, extId)))
    block(
      'UNKNOWN_EXTENSION',
      `${extId} is neither listed for this app nor seen on any of its environments.`
    )

  const { source, pins } = await readPins(target, [extId], deps)
  const current = pins.get(extId) ?? null

  let fromEnv: { id: number; key: string } | null = null
  let toPin: string | null = null
  if (input.pin != null && input.pin !== '') {
    if (typeof input.pin !== 'string' || !PIN_RE.test(input.pin.trim()))
      block('BAD_PIN', 'A pin is <repository>@sha256:<64 hex> (a tag is not enough).')
    else toPin = input.pin.trim()
  } else {
    const i = chain.findIndex((e) => e.id === envId)
    const fromId = input.from_env_id ?? (i > 0 ? chain[i - 1].id : null)
    const from = chain.find((e) => e.id === fromId) ?? null
    if (!from || from.id === envId)
      block('NO_SOURCE', 'Pick the environment to take the extension from, or give a pin.')
    else {
      fromEnv = from
      const ft = (await verifyTargets([from.id]))[0]
      const fp = ft ? ((await readPins(ft, [extId], deps)).pins.get(extId) ?? null) : null
      if (!fp) block('SOURCE_UNPINNED', `${from.key} has no pin for ${extId} the Hub can read.`)
      else toPin = fp
    }
  }

  if (source === 'shared')
    block(
      'EXTENSION_ON_SHARED',
      'This environment runs on a shared deployment: its extension pins are the deployment’s (change them with an upgrade of the deployment).'
    )
  else if (source == null)
    block(
      'NOT_PINNABLE',
      'The Hub deploys this environment through neither a Docker stack nor a GitLab driver with a pin file.'
    )
  if (toPin && current === toPin) block('ALREADY_PINNED', `${env.key} already pins this image.`)
  if (source === 'gitlab') {
    const gl = await gitlabPinTarget(envId)
    if (gl && !gl.driver.config.pin_file?.trim())
      block('NO_PIN_FILE', 'The GitLab driver has no pin file, so the Hub has no folder to pin in.')
    if (!(await deployedVersion(envId)))
      block(
        'NOT_DEPLOYED_BY_HUB',
        `The Hub has not deployed ${env.key} yet, so it cannot record the extension deploy.`
      )
  }
  const move = await moveOpenRefusal({ envIds: [envId] })
  if (move) block(move.code, move.message)
  const creating = await creationOpenRefusal(envId)
  if (creating) block(creating.code, creating.message)
  const gate = await extensionPromoteRefusal(appId, envId, {
    skipWindows: !!input.outsideWindow
  })
  if (gate) block(gate.code, gate.message)
  const held = await (deps.lock ?? defaultPromoteLock()).held(envId).catch(() => 'unknown' as const)
  if (held) block('LOCKED', `${env.key} is being deployed right now — try again when it is done.`)
  return {
    environment: {
      id: envId,
      key: String(env.key),
      app_id: appId,
      production: prod.get(envId) ?? true
    },
    extension_id: extId,
    via: source,
    from_env: fromEnv,
    current_pin: current,
    to_pin: toPin,
    blockers
  }
}

export interface PromoteDeps extends ReadDeps {
  /** The start's request (the outside-window activity row names it). */
  req?: import('fastify').FastifyRequest
  apply?: typeof startStackApply
  commit?: typeof commitFile
  deployJob?: typeof runDeployJob
  lock?: PromoteLock
  notify?: typeof notifyHubEvent
}

/**
 * Puts the pin of `extId` back to `fromPin` (null = no pin) — only while it still holds `toPin`,
 * and only if nobody changed the stored pins since they were read (compare-and-set on the text).
 */
export async function restoreDockerPin(
  envId: number,
  extId: string,
  toPin: string,
  fromPin: string | null
): Promise<boolean> {
  const row = (await db(ENVS).where({ id: envId }).first('extension_pins')) as
    | { extension_pins: unknown }
    | undefined
  const raw = row?.extension_pins == null ? null : String(row.extension_pins)
  const map = strictPinMap(raw ?? '{}')
  if (!map || map[extId] !== toPin) return false
  const next = { ...map }
  if (fromPin) next[extId] = fromPin
  else delete next[extId]
  const q = db(ENVS).where({ id: envId })
  if (raw == null) q.whereNull('extension_pins')
  else q.where('extension_pins', raw)
  return (await q.update({ extension_pins: JSON.stringify(next), updated_at: new Date() })) > 0
}

async function finishPromotion(id: number, ok: boolean, deployId: number | null, error?: string) {
  await db(EXT_PROMOTIONS)
    .where({ id })
    .whereIn('status', ['starting', 'deploying'])
    .update({
      status: ok ? 'done' : 'failed',
      ...(deployId != null ? { deploy_id: deployId } : {}),
      error: ok ? null : (error ?? 'The deploy did not finish').slice(0, 1000),
      finished_at: new Date()
    })
}

/** Promotes one extension (admin; `confirm` = the environment key). Answers the promotion row id. */
export async function promoteExtension(
  envId: number,
  extId: string,
  input: PromoteInput & { confirm?: unknown; checklist_run_id?: unknown },
  user: { id: string },
  deps: PromoteDeps = {}
): Promise<{ id: number; via: PinSource; deploy_id: number | null; commit_sha: string | null }> {
  const plan = await planExtensionPromote(envId, extId, input, deps)
  if (input.confirm !== plan.environment.key)
    throw new ExtensionError(
      'CONFIRM_REQUIRED',
      `Type the environment key (${plan.environment.key}) to promote`,
      400
    )
  if (plan.blockers.length)
    throw Object.assign(new ExtensionError(plan.blockers[0].code, plan.blockers[0].text), {
      blockers: plan.blockers
    })
  const toPin = plan.to_pin as string
  const via = plan.via as PinSource
  const appId = plan.environment.app_id
  const outsideWindow = input.outsideWindow ?? null
  // Judged before the start, without the override: was a window really closed?
  const closed = outsideWindow
    ? await windowWasClosed({ appIds: [appId], action: 'extension_promote', envId })
    : false
  let id = 0
  let out: { deploy_id: number | null; commit_sha: string | null } = {
    deploy_id: null,
    commit_sha: null
  }
  // Production: the pre-deploy checklist (action extension_promote) is claimed first, linked to
  // the promotion row, and given back when the start fails.
  await startWithChecklist(
    {
      target: { kind: 'environment', envId },
      action: 'extension_promote',
      version: extensionChecklistVersion(extId, toPin),
      runId: input.checklist_run_id
    },
    'extension',
    async () => {
      id = Number(
        await insertReturningId(db, EXT_PROMOTIONS, {
          app_id: appId,
          environment_id: envId,
          extension_id: extId,
          from_environment_id: plan.from_env?.id ?? null,
          from_pin: plan.current_pin,
          to_pin: toPin,
          via,
          status: 'starting',
          created_by: user.id,
          created_at: new Date()
        })
      )
      try {
        out =
          via === 'docker'
            ? await promoteDocker(id, envId, extId, plan, user, deps, outsideWindow)
            : await promoteGitlab(id, envId, extId, plan, user, deps, outsideWindow)
      } catch (err) {
        await finishPromotion(id, false, null, (err as Error | null)?.message ?? 'refused')
        throw err
      }
      return id
    },
    (n) => n
  )
  if (outsideWindow && closed)
    await recordOutsideWindow({
      ...(deps.req ? { req: deps.req } : {}),
      userId: user.id,
      action: 'extension_promote',
      appIds: [appId],
      where: `${plan.environment.key} (${extId})`,
      reason: outsideWindow.reason,
      collection: EXT_PROMOTIONS,
      item: String(id)
    })
  await upsertSighting(envId, extId, { pin: toPin, pin_source: via, pin_read_at: new Date() })
  await logActivity({
    action: 'hub-extension-promote',
    user: user.id,
    collection: EXT_PROMOTIONS,
    item: String(id),
    comment: `${plan.environment.key}: ${extId} → ${toPin.slice(0, 120)} (${via}${
      out.commit_sha
        ? ` commit ${out.commit_sha.slice(0, 12)}`
        : out.deploy_id
          ? ` deploy #${out.deploy_id}`
          : ''
    })`.slice(0, 1000)
  })
  return { id, via, ...out }
}

/**
 * Docker: the pin is written INSIDE the environment's promotion lock, as part of the Apply now
 * start (StartHooks.onLocked, before gather reads the pins), and put back when that start is
 * refused or its deploy does not succeed (onEnd). A promote or Apply now that holds the lock first
 * refuses ours before anything is written, so it never deploys our pin.
 */
async function promoteDocker(
  id: number,
  envId: number,
  extId: string,
  plan: ExtensionPlan,
  user: { id: string },
  deps: PromoteDeps,
  outsideWindow: { reason: string } | null = null
): Promise<{ deploy_id: number | null; commit_sha: null }> {
  const toPin = plan.to_pin as string
  let wrote = false
  const started = await (deps.apply ?? startStackApply)(envId, {
    confirm: plan.environment.key,
    user,
    ...(outsideWindow ? { outsideWindow } : {}),
    hooks: {
      onLocked: async () => {
        const row = (await db(ENVS).where({ id: envId }).first('extension_pins')) as
          | { extension_pins: unknown }
          | undefined
        const pins = strictPinMap(row?.extension_pins ?? '{}')
        if (!pins)
          throw new ExtensionError(
            'PINS_UNREADABLE',
            'The environment’s extension pins cannot be read; fix them in its Stack panel first.'
          )
        await db(ENVS)
          .where({ id: envId })
          .update({
            extension_pins: JSON.stringify({ ...pins, [extId]: toPin }),
            updated_at: new Date()
          })
        wrote = true
      },
      onEnd: async (ok, deployId) => {
        if (!ok && wrote) await restoreDockerPin(envId, extId, toPin, plan.current_pin)
        // A refused start (deployId null) is recorded by promoteExtension's own catch.
        if (deployId != null) await finishPromotion(id, ok, deployId)
      }
    }
  })
  await db(EXT_PROMOTIONS)
    .where({ id, status: 'starting' })
    .update({ status: 'deploying', deploy_id: started.deployId })
  return { deploy_id: started.deployId, commit_sha: null }
}

/**
 * GitLab: under the environment's promotion lock and its branch's lock (held for the whole run),
 * the pin file is committed, a deploy record (kind `extension`) is written, and the repository's
 * pipeline is watched the way a promotion's is (runDeployJob: the before job, then the deploy job —
 * played when manual). Success → the deploy row succeeds (a smoke run follows); failure → it fails
 * and the app's people are told, like a failed promotion. The commit stays in git either way.
 */
async function promoteGitlab(
  id: number,
  envId: number,
  extId: string,
  plan: ExtensionPlan,
  user: { id: string },
  deps: PromoteDeps,
  outsideWindow: { reason: string } | null = null
): Promise<{ deploy_id: number; commit_sha: string }> {
  const gl = await gitlabPinTarget(envId)
  if (!gl) throw new ExtensionError('NOT_PINNABLE', 'The GitLab target could not be found.')
  const version = await deployedVersion(envId)
  if (!version)
    throw new ExtensionError(
      'NOT_DEPLOYED_BY_HUB',
      'The Hub has not deployed this environment yet.'
    )
  const lock = deps.lock ?? defaultPromoteLock()
  const token = await lock.take(envId, 'promotion')
  if (!token)
    throw new ExtensionError(
      'LOCKED',
      `${plan.environment.key} is being deployed right now — try again when it is done.`
    )
  let handedOff = false
  let branches: Awaited<ReturnType<typeof holdBranches>> | null = null
  try {
    // Judged again inside the lock: a move, a creation or a freeze that began since the plan.
    const move = await moveOpenRefusal({ envIds: [envId] })
    if (move) throw new ExtensionError(move.code, move.message, move.status)
    const creating = await creationOpenRefusal(envId)
    if (creating) throw new ExtensionError(creating.code, creating.message, creating.status)
    const gate = await extensionPromoteRefusal(plan.environment.app_id, envId, {
      skipWindows: !!outsideWindow
    })
    if (gate) throw new ExtensionError(gate.code, gate.message, gate.status)
    branches = await holdBranches(
      defaultBranchLock(),
      [
        {
          identity: repositoryIdentity(gl.driver.config.api, gl.driver.config.project),
          branch: gl.branch
        }
      ],
      'promotion'
    )
    const ctx = driverCtx(gl.driver)
    const toPin = plan.to_pin as string
    const committed = await (deps.commit ?? commitFile)(
      ctx,
      gl.branch,
      extensionPinPath(gl.driver.config.pin_file, extId),
      `${toPin}\n`,
      `Pin extension ${extId} (Nivaro Hub)`
    )
    const deployId = Number(
      await insertReturningId(db, 'nivaro_hub_deploys', {
        app_id: plan.environment.app_id,
        environment_id: envId,
        kind: 'extension',
        version,
        from_version: version,
        status: 'running',
        step: `deploy ${extId}`,
        error: null,
        plan: JSON.stringify({
          steps: [],
          extension: { id: extId, from_pin: plan.current_pin, to_pin: toPin, commit: committed.sha }
        }),
        started_by: user.id,
        started_at: new Date(),
        heartbeat_at: new Date()
      })
    )
    await db(EXT_PROMOTIONS)
      .where({ id, status: 'starting' })
      .update({ status: 'deploying', deploy_id: deployId, commit_sha: committed.sha })
    handedOff = true
    const held = branches
    void watchGitlabDeploy({
      id,
      envId,
      extId,
      deployId,
      sha: committed.sha,
      gl,
      lock,
      token,
      deps
    })
      .catch((err) =>
        getApp()?.log?.error?.(
          { deployId, err: (err as Error | null)?.name ?? 'Error' },
          'hub extension deploy bookkeeping failed'
        )
      )
      .finally(async () => {
        await held?.release()
        await lock.release(envId, token)
      })
    return { deploy_id: deployId, commit_sha: committed.sha }
  } finally {
    if (!handedOff) {
      await branches?.release()
      await lock.release(envId, token)
    }
  }
}

async function watchGitlabDeploy(o: {
  id: number
  envId: number
  extId: string
  deployId: number
  sha: string
  gl: GitlabPinTarget
  lock: PromoteLock
  token: string
  deps: PromoteDeps
}): Promise<void> {
  const DEPLOYS = 'nivaro_hub_deploys'
  const renew = setInterval(() => {
    void o.lock.renew(o.envId, o.token).catch(() => undefined)
    void db(DEPLOYS)
      .where({ id: o.deployId, status: 'running' })
      .update({ heartbeat_at: new Date() })
      .catch(() => undefined)
  }, LOCK_RENEW_MS)
  renew.unref?.()
  let ok = false
  let error: string | null = null
  try {
    await (o.deps.deployJob ?? runDeployJob)(driverCtx(o.gl.driver), o.gl.branch, o.sha, {
      before: o.gl.before_job,
      deploy: o.gl.deploy_job ?? o.gl.driver.config.deploy_job,
      minutes: 60
    })
    ok = true
  } catch (err) {
    const e = err as { code?: unknown; message?: unknown } | null
    error =
      `${typeof e?.code === 'string' ? `${e.code}: ` : ''}${String(e?.message ?? 'the deploy failed')}`.slice(
        0,
        1000
      )
  } finally {
    clearInterval(renew)
  }
  await db(DEPLOYS)
    .where({ id: o.deployId, status: 'running' })
    .update({
      status: ok ? 'success' : 'failed',
      step: ok ? null : `deploy ${o.extId}`,
      error,
      finished_at: new Date()
    })
  await finishPromotion(o.id, ok, o.deployId, error ?? undefined)
  ;(o.deps.notify ?? notifyHubEvent)({
    kind: ok ? 'promote_done' : 'promote_failed',
    envId: o.envId,
    deployId: o.deployId,
    detail: `extension ${o.extId}${error ? ` — ${error}` : ''}`,
    path: '/hub/extensions'
  })
}

/**
 * The tick's fallback for runs whose process stopped (no onEnd ran): a promotion follows its
 * deploy row — done, or failed; a failed Docker one puts the old pin back (compare-and-set).
 */
export async function settleExtensionPromotions(): Promise<number> {
  const open = (await db(EXT_PROMOTIONS)
    .where({ status: 'deploying' })
    .whereNotNull('deploy_id')
    .select(
      'id',
      'deploy_id',
      'environment_id',
      'extension_id',
      'via',
      'from_pin',
      'to_pin'
    )) as Array<Record<string, unknown>>
  let n = 0
  for (const p of open) {
    const d = (await db('nivaro_hub_deploys')
      .where({ id: p.deploy_id })
      .first('status', 'error')) as { status: string; error: string | null } | undefined
    const status = d?.status
    if (status === 'running' || status === 'planned') continue
    const ok = status === 'success'
    if (!ok && p.via === 'docker')
      await restoreDockerPin(
        Number(p.environment_id),
        String(p.extension_id),
        String(p.to_pin),
        p.from_pin == null ? null : String(p.from_pin)
      )
    await finishPromotion(Number(p.id), ok, Number(p.deploy_id), d?.error ?? undefined)
    n++
  }
  return n
}

export async function listExtensionPromotions(o: { appIds?: number[]; limit?: number }) {
  const q = db(EXT_PROMOTIONS)
    .orderBy('id', 'desc')
    .limit(Math.min(o.limit ?? 50, 200))
  if (o.appIds) q.whereIn('app_id', o.appIds.length ? o.appIds : [-1])
  return ((await q) as Array<Record<string, unknown>>).map((r) => ({
    id: Number(r.id),
    app_id: Number(r.app_id),
    environment_id: Number(r.environment_id),
    extension_id: String(r.extension_id),
    from_environment_id: r.from_environment_id == null ? null : Number(r.from_environment_id),
    from_pin: str(r.from_pin),
    to_pin: String(r.to_pin),
    via: String(r.via),
    status: String(r.status),
    deploy_id: r.deploy_id == null ? null : Number(r.deploy_id),
    commit_sha: str(r.commit_sha),
    error: str(r.error),
    created_by: str(r.created_by),
    created_at: iso(r.created_at),
    finished_at: iso(r.finished_at)
  }))
}
