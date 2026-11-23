import { createHash } from 'node:crypto'
import { db } from '../../../db/index.js'
import { hubPublicOrigin, hubUrlBootWarning, hubUrlCheck } from '../../deployment-mode.js'
import { environmentFromRow } from '../apps.js'
import { AgentError, agentHealth } from '../docker/agent-client.js'
import type { AgentHealth } from '../docker/agent-types.js'
import { environmentNames, hostnameRefusals, type StackEdge } from '../docker/render-spec.js'
import { type DockerDriverRow, getDriver, STACK_NAME_RE } from '../drivers.js'
import { openMoveFor } from '../move-open.js'
import { storedRuns, successfulVersions } from '../promote-gather.js'
import {
  defaultPromoteLock,
  defaultSharedLock,
  type LockHolder,
  lockHolderRefusal,
  type PromoteLock,
  type SharedLock,
  sharedLockRefusal
} from '../promote-lock.js'
import { compareVersions } from '../promote-plan.js'
import type { HubEnvironmentRow } from '../promote-types.js'
import { hubImage, imageDigest } from '../registry.js'
import { HUB_MASK, openSecret } from '../secrets.js'
import { DeploymentLinkError, deploymentClient } from './deployment-client.js'
import {
  explicitHostsFor,
  renderSharedSpec,
  SharedRenderError,
  sharedExtensionPins,
  sharedRoles,
  sharedStackSettings
} from './stack-render.js'
import { getShared, type SharedDeployment, tenantIdFor } from './store.js'
import { type SharedTenantRow, tenantsOf } from './tenants.js'

/**
 * Nivaro Hub phase 6 (Task 5): the plan of a Docker shared deployment's upgrade (or rollback).
 * Reads only: never applies anything, never writes a row, never opens a secret into an answer.
 *
 * Blockers (the plan's whole-deployment refusals): SHARED_RETIRED; MOVE_OPEN (a move into or out
 * of this deployment is running, waiting or interrupted — final review I-2); SHARED_NOT_HUB_DEPLOYED
 * (registered mode: the operator upgrades it); BAD_VERSION; BUSY (the shared lock, or any placed
 * environment's lock, is held); VERSION_UNKNOWN (no image digest in the registry for the tag);
 * NOT_DEPLOYED_BEFORE (a rollback to a version this deployment never ran); NO_DRIVER;
 * NO_STACK_NAME; AGENT_UNREACHABLE; AGENT_TOO_OLD (an agent before shared owners, < 0.2.0);
 * IMAGE_NOT_ALLOWED / EXTENSION_NOT_ALLOWED (the agent's allow-list); EXTENSION_UNPINNED;
 * PATTERN_NOT_ALLOWED / HOSTNAME_NOT_ALLOWED / TOO_MANY_HOSTNAMES / NO_ROUTE (routing);
 * PUBLISH_PORT_NOT_ALLOWED; REDIS_NOT_AVAILABLE / REDIS_URL_MISSING; HUB_URL_UNUSABLE (the
 * address the stack would get is not one a deployment in production accepts as HUB_URL).
 *
 * Per app (`apps[].blockers`, each overridable by a Hub admin at start, `<CODE>:<env_id>` in
 * `overrides`, logged): ORDER — the environment before this one in its app never ran the version
 * successfully (phase 2's rule, `successfulVersions`: any success row, a shared one included); a
 * previous environment placed on this same deployment is upgraded in the same run and never
 * counts. PREFLIGHT_FAILING (preflight R17) — the app's own preflight fails on the deployment now.
 * Neither is checked when the version does not change (a re-apply), nor for a rollback.
 * EXTENSION_MISSING (final review I-4) — the app uses an extension the deployment does not load;
 * never overridable, checked for every kind.
 *
 * Warnings: ROLES_CHANGE (Task 14: the run adds or removes services — a size change between
 * small's one `all` and the medium / large split; `roles` and `roles_from` say which);
 * ROLLBACK_SCHEMA_AHEAD (a rollback keeps the newer schema; final review M-8);
 * HUB_URL_PROBLEM (the Hub's own HUB_URL is ignored, hubUrlBootWarning), MULTI_NODE_
 * VOLUMES (the agent's swarm has several nodes and volumes are local), APPS_AFFECTED (every app
 * the run restarts). Confirm text: the deployment key. `plan_hash` covers everything the run does.
 */

export type SharedUpgradeKind = 'upgrade' | 'rollback'

export interface SharedUpgradeApp {
  env_id: number
  tenant_id: string
  app: string
  env: string
  blockers: string[]
  /** One plain sentence per blocker, same order. */
  notes: string[]
  /** The wire status the deployment is sent for it (active, maintenance, provisioning …). */
  status: string
  /** Placed here (false: a move in or out is under way). */
  placed: boolean
  base_url: string
}

export interface SharedUpgradePlan {
  shared_id: number
  kind: SharedUpgradeKind
  version: string
  from_version: string | null
  apps: SharedUpgradeApp[]
  blockers: { code: string; text: string }[]
  warnings: { code: string; text: string }[]
  plan_hash: string
  /** Type this to start (the deployment key). */
  confirm: string
  /** Per-app codes a Hub admin may override. */
  overridable: string[]
  /** <repo>@sha256:<64 hex> the run deploys; null when unknown (a blocker says why). */
  image: string | null
  stack: string | null
  /** Names routed besides the pattern. */
  hostnames: string[]
  /** The services the run deploys (sharedRoles of the deployment's size), in order (Task 14). */
  roles: Array<{ role: string; replicas: number }>
  /**
   * The roles the last successful run deployed; null when the Hub never deployed this one. A run
   * recorded before the split carries none and counts as one `all` service.
   */
  roles_from: string[] | null
  /**
   * An upgrade to a version older than the one deployed (or either version unparseable): the
   * start needs `downgrade: true` (409 DOWNGRADE_NEEDS_CONFIRM, ruling P6-29). Never a rollback.
   */
  downgrade: boolean
}

/** Per-app codes an override may clear. */
export const OVERRIDABLE_CODES = ['ORDER', 'PREFLIGHT_FAILING'] as const

/** Agents from this version accept shared owners, host_pattern and an empty hostnames list. */
export const SHARED_AGENT_MIN_VERSION = '0.2.0'

const VERSION_RE = /^\d+\.\d+\.\d+$/
const SEMVER_RE =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/

/** Semver precedence of two parsed versions (build metadata ignored); null if either is not one. */
function semverCompare(a: string, b: string): number | null {
  const pa = SEMVER_RE.exec(a)
  const pb = SEMVER_RE.exec(b)
  if (!pa || !pb) return null
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i])
    if (d !== 0) return Math.sign(d)
  }
  const ra = pa[4]?.split('.') ?? null
  const rb = pb[4]?.split('.') ?? null
  if (!ra || !rb) return ra ? -1 : rb ? 1 : 0 // a pre-release comes before its release
  for (let i = 0; i < Math.max(ra.length, rb.length); i++) {
    if (ra[i] === undefined) return -1
    if (rb[i] === undefined) return 1
    const na = /^\d+$/.test(ra[i]) ? Number(ra[i]) : null
    const nb = /^\d+$/.test(rb[i]) ? Number(rb[i]) : null
    if (na !== null && nb !== null) {
      if (na !== nb) return Math.sign(na - nb)
    } else if (na !== null) return -1
    else if (nb !== null) return 1
    else if (ra[i] !== rb[i]) return ra[i] < rb[i] ? -1 : 1
  }
  return 0
}

/**
 * True when going from `from` to `to` is a downgrade the admin must confirm (ruling P6-29): `to`
 * is older by semver precedence, or either side cannot be read as semver. Nothing deployed yet
 * (`from` null) and the same version are never one.
 */
export function isSharedDowngrade(from: string | null, to: string): boolean {
  if (from === null || from === to) return false
  const c = semverCompare(to, from)
  return c === null || c < 0
}

const PIN_RE = /^[^@\s]+@sha256:[0-9a-f]{64}$/
const SHARED_DEPLOYS = 'nivaro_hub_shared_deploys'
const SHARED = 'nivaro_hub_shared_deployments'
const ENVS = 'nivaro_hub_environments'
/** Preflight reads at once (one per app). */
const PREFLIGHT_CONCURRENCY = 4
const DRY = `sha256:${'0'.repeat(64)}`

export interface SharedPlanDeps {
  agentHealth(driver: DockerDriverRow): Promise<AgentHealth>
  imageDigest(image: string, tag: string): Promise<string | 'present' | null>
  client(shared: SharedDeployment): Pick<ReturnType<typeof deploymentClient>, 'appStatus'>
  sharedLock: SharedLock
  envLock: PromoteLock
  /** The address the stack gets as HUB_URL (deployment-mode.ts hubPublicOrigin). */
  hubPublicUrl(): string | null
  /** hubUrlBootWarning(): the Hub's own HUB_URL is ignored. */
  hubUrlWarning(): string | null
}

export function defaultSharedPlanDeps(over: Partial<SharedPlanDeps> = {}): SharedPlanDeps {
  return {
    agentHealth: (d) => agentHealth(d),
    imageDigest,
    client: (s) => deploymentClient(s),
    sharedLock: defaultSharedLock(),
    envLock: defaultPromoteLock(),
    hubPublicUrl: () => hubPublicOrigin(),
    hubUrlWarning: () => hubUrlBootWarning(),
    ...over
  }
}

/** A refusal before a plan can be made (no such deployment). */
export class SharedUpgradeError extends Error {
  code: string
  statusCode: number
  plan?: SharedUpgradePlan
  constructor(code: string, message: string, statusCode = 409, plan?: SharedUpgradePlan) {
    super(message)
    this.name = 'SharedUpgradeError'
    this.code = code
    this.statusCode = statusCode
    if (plan) this.plan = plan
  }
}

// ── the deployment's own secrets (SESSION_SECRET, ENCRYPTION_KEY, REDIS_URL) ──────────────────

/** The opened `secrets` JSON of a deployment; {} when none or unreadable. Never answered. */
export async function readSharedSecrets(sharedId: number): Promise<Record<string, string>> {
  const row = await db(SHARED).where({ id: sharedId }).first('secrets')
  return openSharedSecrets((row?.secrets as string | null | undefined) ?? null)
}

/** One sealed `secrets` value opened; {} when none or unreadable. Never answered. */
export function openSharedSecrets(sealed: string | null): Record<string, string> {
  if (!sealed) return {}
  try {
    const v = JSON.parse(openSecret(sealed) ?? '{}') as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    const out: Record<string, string> = {}
    for (const [k, x] of Object.entries(v)) if (typeof x === 'string') out[k] = x
    return out
  } catch {
    return {}
  }
}

// ── what the run deploys ──────────────────────────────────────────────────────────────────────

export interface SharedFacts {
  shared: SharedDeployment
  driver: DockerDriverRow | null
  health: AgentHealth | null
  edge: StackEdge
  image: string | null
  extensions: Record<string, string>
  hostnames: string[]
  rows: SharedTenantRow[]
}

export interface GatheredPlan {
  plan: SharedUpgradePlan
  facts: SharedFacts
}

function hashOf(v: unknown): string {
  return createHash('sha256').update(JSON.stringify(v)).digest('hex')
}

/** The newest successful run of `version` on this deployment and what it deployed. */
async function recordedRun(
  sharedId: number,
  version: string
): Promise<{ image: string | null; extensions: Record<string, string> | null } | null> {
  const rows = (await db(SHARED_DEPLOYS)
    .where({ shared_deployment_id: sharedId, version, status: 'success' })
    .orderBy('id', 'desc')
    .limit(20)
    .select('plan')) as Array<{ plan: string | null }>
  if (!rows.length) return null
  for (const r of rows) {
    try {
      const p = JSON.parse(String(r.plan ?? '')) as { image?: unknown; extensions?: unknown }
      const image = typeof p.image === 'string' && PIN_RE.test(p.image) ? p.image : null
      if (!image) continue
      const ext =
        p.extensions && typeof p.extensions === 'object' && !Array.isArray(p.extensions)
          ? (p.extensions as Record<string, string>)
          : null
      return { image, extensions: ext }
    } catch {
      /* an unreadable plan proves nothing */
    }
  }
  return { image: null, extensions: null }
}

/**
 * The roles the newest successful run of this deployment deployed (its stored plan's `roles`);
 * ['all'] for a run recorded before the split (Task 14), null when none succeeded. Observed runs
 * (a registered deployment's version) deploy nothing and never count.
 */
async function deployedRoles(sharedId: number): Promise<string[] | null> {
  const row = (await db(SHARED_DEPLOYS)
    .where({ shared_deployment_id: sharedId, status: 'success' })
    .whereNot({ kind: 'observed' })
    .orderBy('id', 'desc')
    .first('plan')) as { plan: string | null } | undefined
  if (!row) return null
  try {
    const stored = JSON.parse(String(row.plan ?? '')) as { plan?: { roles?: unknown } }
    const roles = stored?.plan?.roles
    if (Array.isArray(roles)) {
      const names = roles
        .map((r) => (r && typeof r === 'object' ? (r as { role?: unknown }).role : null))
        .filter((r): r is string => typeof r === 'string')
      if (names.length) return names
    }
  } catch {
    /* an unreadable plan: a run before the split */
  }
  return ['all']
}

/** Runs `fn` over `items`, at most `n` at once, in order of the answers. */
async function mapLimited<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i])
      }
    })
  )
  return out
}

/** ORDER: the environment before this one in its app never ran `version` successfully. */
async function orderProblem(
  row: SharedTenantRow,
  version: string,
  placedHere: Set<number>
): Promise<string | null> {
  const siblings = (await db(ENVS)
    .where({ app_id: row.app.id })
    .orderBy('position', 'asc')
    .orderBy('id', 'asc')) as Record<string, unknown>[]
  const at = siblings.findIndex((r) => Number(r.id) === row.env.id)
  if (at <= 0) return null
  const prev = environmentFromRow(siblings[at - 1]) as HubEnvironmentRow
  // Upgraded in this same run: nothing to wait for.
  if (placedHere.has(prev.id)) return null
  if (successfulVersions(await storedRuns(prev.id)).includes(version)) return null
  return `${prev.key} never ran ${version} successfully — upgrade it first, or override`
}

const agentTooOld = (v: unknown) =>
  typeof v !== 'string' ||
  !/^\d+\.\d+\.\d+/.test(v) ||
  compareVersions(v.replace(/[^\d.].*$/, ''), SHARED_AGENT_MIN_VERSION) < 0

export async function gatherSharedUpgrade(
  sharedId: number,
  version: string,
  kind: SharedUpgradeKind = 'upgrade',
  over: Partial<SharedPlanDeps> = {}
): Promise<GatheredPlan> {
  const deps = defaultSharedPlanDeps(over)
  const shared = await getShared(sharedId)
  if (!shared) throw new SharedUpgradeError('NOT_FOUND', 'No such shared deployment.', 404)
  const blockers: { code: string; text: string }[] = []
  const warnings: { code: string; text: string }[] = []
  const block = (code: string, text: string) => {
    if (!blockers.some((b) => b.code === code && b.text === text)) blockers.push({ code, text })
  }
  const versionOk = VERSION_RE.test(version)
  const sameVersion = versionOk && version === shared.version_pin

  if (shared.status === 'retired')
    block('SHARED_RETIRED', 'This shared deployment is retired; it is never deployed again.')
  if (shared.mode !== 'docker')
    block(
      'SHARED_NOT_HUB_DEPLOYED',
      'This shared deployment is registered: whoever runs it upgrades it (the Hub records the version it sees).'
    )
  if (!versionOk) block('BAD_VERSION', 'The version is x.y.z (a Nivaro release).')

  // Who is listed: every environment the deployment serves (placed, or a move under way).
  const rows = await tenantsOf(shared)
  const placedHere = new Set(rows.filter((r) => r.placedHere).map((r) => r.env.id))

  // BUSY: the deployment's own lock, or any listed environment's lock.
  // A holder that cannot be read is never free (T15 round 2): blocker LOCK_UNAVAILABLE.
  const unreadable = 'The Hub cannot reach Redis to tell who holds'
  try {
    const holder = await deps.sharedLock.holder(shared.id)
    if (holder) block('BUSY', sharedLockRefusal(holder).message)
  } catch {
    block('LOCK_UNAVAILABLE', `${unreadable} this shared deployment's lock — try again shortly.`)
  }
  for (const r of rows) {
    const held = await deps.envLock.held(r.env.id)
    if (held === false) continue
    let h: LockHolder | null = null
    try {
      h = (await deps.envLock.holder?.(r.env.id)) ?? null
    } catch {
      block(
        'LOCK_UNAVAILABLE',
        `${unreadable} the lock of ${r.app.key}/${r.env.key} — try again shortly.`
      )
      continue
    }
    block(
      'BUSY',
      `${r.app.key}/${r.env.key}: ${
        lockHolderRefusal(h, {
          code: 'ENVIRONMENT_BUSY',
          message:
            held === 'unknown'
              ? 'the Hub cannot tell whether another action holds this environment'
              : 'another action holds this environment'
        }).message
      }`
    )
  }

  // Final review I-2 (P6-37): an open move into or out of this deployment — an interrupted one
  // holds no lock — would be migrated, re-routed and verified behind its back. Resume it or roll
  // it back first.
  const move = await openMoveFor({ sharedId: shared.id })
  if (move)
    block(
      'MOVE_OPEN',
      `The move of ${move.label} (move ${move.id}) into or out of this deployment is ${move.status === 'interrupted' ? 'interrupted' : 'under way'}: resume it or roll it back first.`
    )

  // The image and extension pins the run deploys.
  let image: string | null = null
  let extensions: Record<string, string> = {}
  const pins = sharedExtensionPins(shared.extensions, shared.extension_pins)
  if (versionOk && kind === 'rollback') {
    const rec = await recordedRun(shared.id, version)
    if (!rec)
      block(
        'NOT_DEPLOYED_BEFORE',
        `This shared deployment never ran ${version} successfully — nothing to roll back to.`
      )
    else {
      image = rec.image
      if (rec.extensions) {
        const kept = sharedExtensionPins(shared.extensions, rec.extensions)
        extensions = kept.pins
        if (kept.missing.length)
          block(
            'EXTENSION_UNPINNED',
            `The ${version} run installed no pin for extension ${kept.missing.join(', ')}, which the deployment now loads.`
          )
      } else {
        extensions = pins.pins
        if (pins.missing.length)
          block(
            'EXTENSION_UNPINNED',
            `No image pin for extension ${pins.missing.join(', ')}: set extension_pins on the shared deployment (<repo>@sha256:<64 hex>).`
          )
      }
    }
  } else {
    extensions = pins.pins
    if (pins.missing.length)
      block(
        'EXTENSION_UNPINNED',
        `No image pin for extension ${pins.missing.join(', ')}: set extension_pins on the shared deployment (<repo>@sha256:<64 hex>).`
      )
  }
  if (versionOk && !image && shared.mode === 'docker' && shared.status !== 'retired') {
    const repo = hubImage()
    const digest = await deps.imageDigest(repo, version).catch(() => null)
    if (digest && digest !== 'present' && /^sha256:[0-9a-f]{64}$/.test(digest))
      image = `${repo}@${digest}`
    else
      block(
        'VERSION_UNKNOWN',
        digest === 'present'
          ? `${repo}:${version} is published without a digest the Hub can pin.`
          : `${repo}:${version} is not in the registry.`
      )
  }

  // The driver and its agent.
  let driver: DockerDriverRow | null = null
  let health: AgentHealth | null = null
  if (shared.mode === 'docker') {
    const d = await getDriver(shared.driver_id)
    if (d?.kind === 'docker') driver = d
    else block('NO_DRIVER', 'The shared deployment names no Docker driver.')
    if (!shared.stack || !STACK_NAME_RE.test(shared.stack))
      block('NO_STACK_NAME', 'The shared deployment names no swarm stack — set its stack name.')
    if (driver) {
      try {
        health = await deps.agentHealth(driver)
      } catch (err) {
        block(
          'AGENT_UNREACHABLE',
          err instanceof AgentError && err.code === 'AGENT_INCOMPATIBLE'
            ? 'The Hub agent speaks another agent API than this Hub.'
            : err instanceof AgentError && err.code === 'AGENT_REFUSED'
              ? "The Hub agent refused the Hub — check the driver's agent token."
              : 'The Hub agent does not answer.'
        )
      }
    }
  }
  const edge: StackEdge = health?.edge === 'publish' ? 'publish' : 'traefik'
  const settings = sharedStackSettings(shared)

  const names: string[] = []
  for (const r of rows) names.push(...environmentNames(r.env))
  const hostnames = edge === 'traefik' ? explicitHostsFor(names, shared.host_pattern) : []

  if (health) {
    if (agentTooOld(health.agent_version))
      block(
        'AGENT_TOO_OLD',
        `The Hub agent is ${String(health.agent_version).slice(0, 32)}; shared deployments need ${SHARED_AGENT_MIN_VERSION} or later.`
      )
    const images = Array.isArray(health.images) ? health.images : []
    const repoOf = (pin: string) => pin.slice(0, pin.indexOf('@'))
    if (image && !images.includes(repoOf(image)))
      block('IMAGE_NOT_ALLOWED', `The Hub agent does not allow the image ${repoOf(image)}.`)
    const disallowed = Object.entries(extensions)
      .filter(([, pin]) => !images.includes(repoOf(pin)))
      .map(([id]) => id)
    if (disallowed.length)
      block(
        'EXTENSION_NOT_ALLOWED',
        `The Hub agent does not allow the image of extension ${disallowed.join(', ')}.`
      )
    // Final review M-7: the pattern router is v3 HostRegexp — a v2 agent refuses it at apply.
    if (edge === 'traefik' && shared.host_pattern && health.traefik_version === 2)
      block(
        'PATTERN_NOT_ALLOWED',
        `The Hub agent sets labels for Traefik v2, which cannot route the host pattern ${shared.host_pattern}: set HUB_AGENT_TRAEFIK_VERSION=3 on the agent (Traefik v3), or remove the pattern and route explicit names.`
      )
    if (edge === 'traefik' && shared.host_pattern) {
      const base = shared.host_pattern.slice(2)
      const suffixes = Array.isArray(health.host_suffixes) ? health.host_suffixes : []
      const ok = suffixes.some((s) => {
        const suf = (s.startsWith('.') ? s : `.${s}`).toLowerCase()
        return base === suf.slice(1) || (base.length > suf.length && base.endsWith(suf))
      })
      if (!ok)
        block(
          'PATTERN_NOT_ALLOWED',
          `${shared.host_pattern} is outside the agent's allowed domains (${suffixes.join(', ')}).`
        )
    }
    if (driver && edge === 'traefik')
      for (const p of hostnameRefusals(hostnames, driver.config, {
        hostSuffixes: health.host_suffixes,
        edge
      }))
        block(
          p.code === 'TOO_MANY_HOSTNAMES' ? 'TOO_MANY_HOSTNAMES' : 'HOSTNAME_NOT_ALLOWED',
          p.message
        )
    if (edge === 'publish') {
      const range = Array.isArray(health.publish_ports) ? health.publish_ports : null
      const port = settings.publish_port
      if (!range || port == null || port < range[0] || port > range[1])
        block(
          'PUBLISH_PORT_NOT_ALLOWED',
          range
            ? `The agent publishes stacks on ${range[0]}–${range[1]}: set publish_port inside it.`
            : 'The agent publishes stacks on a port but has no publish port range set.'
        )
    }
    if (settings.redis === 'bundled' && health.redis_bundled === false)
      block(
        'REDIS_NOT_AVAILABLE',
        'The stack asks for bundled Redis but the agent has no Redis image configured.'
      )
    const nodes = health.swarm?.nodes
    if (typeof nodes === 'number' && nodes > 1 && (health.volume_driver ?? 'local') === 'local')
      warnings.push({
        code: 'MULTI_NODE_VOLUMES',
        text: `The swarm has ${nodes} nodes and local volumes: uploads and bundled Redis stay on the node a task first ran on. Use a shared volume driver, or pin the stack to one node.`
      })
  }

  // The deployment's own secrets: only whether REDIS_URL is there (never its value).
  if (settings.redis === 'external' && !(await readSharedSecrets(shared.id)).REDIS_URL)
    block(
      'REDIS_URL_MISSING',
      'The shared deployment uses external Redis but has no REDIS_URL secret.'
    )

  const hubUrl = deps.hubPublicUrl()
  if (
    shared.mode === 'docker' &&
    (!hubUrl || !hubUrlCheck({ HUB_URL: hubUrl, NODE_ENV: 'production' }).origin)
  )
    block(
      'HUB_URL_UNUSABLE',
      `The stack would get HUB_URL=${hubUrl ?? '(none)'}, which a shared deployment refuses (it needs the Hub's https origin). Set HUB_URL on the Hub.`
    )
  const hubWarn = deps.hubUrlWarning()
  if (hubWarn) warnings.push({ code: 'HUB_URL_PROBLEM', text: hubWarn })

  // A dry render over masked values: routing and settings make a spec the agent takes.
  if (shared.mode === 'docker' && hubUrl) {
    try {
      renderSharedSpec({
        shared,
        driver: driver?.config ?? {
          agent_url: '',
          dns_mode: 'manual',
          wildcard_domain: null,
          edge_target: null
        },
        edge,
        secrets: {
          SESSION_SECRET: HUB_MASK,
          ENCRYPTION_KEY: HUB_MASK,
          ...(settings.redis === 'external' ? { REDIS_URL: HUB_MASK } : {})
        },
        token: HUB_MASK,
        version,
        image: image ?? `${hubImage()}@${DRY}`,
        extensions,
        hubPublicUrl: hubUrl,
        explicitHosts: hostnames
      })
    } catch (err) {
      if (!(err instanceof SharedRenderError)) throw err
      // Named above with their own codes.
      if (!['EXTENSION_UNPINNED', 'REDIS_URL_MISSING', 'HUB_URL_UNUSABLE'].includes(err.code))
        block(
          err.code === 'PUBLISH_PORT_REQUIRED' ? 'PUBLISH_PORT_NOT_ALLOWED' : err.code,
          err.message
        )
    }
  }

  // Per app.
  const client = deps.client(shared)
  const apps: SharedUpgradeApp[] = await mapLimited(rows, PREFLIGHT_CONCURRENCY, async (r) => {
    const tenant = tenantIdFor(r.app, r.env)
    const codes: string[] = []
    const notes: string[] = []
    // Final review I-4: the run renders the deployment's extension list; an app that uses one
    // not on it would restart without its hooks and routes. Never overridable; checked on a
    // re-apply and a rollback too.
    const missing = r.app.extensions.filter((x) => !shared.extensions.includes(x))
    if (missing.length) {
      codes.push('EXTENSION_MISSING')
      notes.push(
        `it uses ${missing.slice(0, 10).join(', ')}, which the deployment does not load — add it to the deployment's extensions`
      )
    }
    if (versionOk && !sameVersion && kind === 'upgrade' && r.placedHere) {
      const order = await orderProblem(r, version, placedHere)
      if (order) {
        codes.push('ORDER')
        notes.push(order)
      }
    }
    // A rollback is the way out of a broken version: the current preflight never blocks it.
    if (
      versionOk &&
      !sameVersion &&
      kind === 'upgrade' &&
      r.placedHere &&
      shared.mode === 'docker'
    ) {
      try {
        const st = await client.appStatus(tenant)
        const failing = Array.isArray(st.preflight?.failing) ? st.preflight.failing : []
        if (failing.length || st.preflight?.status === 'fail') {
          codes.push('PREFLIGHT_FAILING')
          notes.push(
            `its preflight fails on the deployment now${failing.length ? ` (${failing.slice(0, 5).join(', ')})` : ''}`
          )
        }
      } catch (err) {
        // Not a blocker: a deployment not running yet has no preflight to read.
        if (!(err instanceof DeploymentLinkError)) throw err
      }
    }
    return {
      env_id: r.env.id,
      tenant_id: tenant,
      app: r.app.key,
      env: r.env.key,
      blockers: codes,
      notes,
      status: r.wireStatus,
      placed: r.placedHere,
      base_url: r.env.base_url
    }
  })

  if (apps.length)
    warnings.push({
      code: 'APPS_AFFECTED',
      text: `This restarts every app on the deployment (${apps.length}): ${apps
        .slice(0, 20)
        .map((a) => `${a.app}/${a.env}`)
        .join(', ')}${apps.length > 20 ? ', …' : ''}.`
    })

  const from_version = shared.version_pin
  // A rollback goes back on purpose (to the recorded previous build); only an upgrade asks.
  const downgrade = kind === 'upgrade' && isSharedDowngrade(from_version, version)
  if (downgrade)
    warnings.push({
      code: 'DOWNGRADE',
      text: `${version} is not newer than the ${from_version} this deployment runs. Every app on it goes back to ${version}; an older version may not read data a newer one wrote. Confirm the downgrade to start.`
    })
  // Final review M-8: a rollback restores the build, not the schema — said as DOWNGRADE says it.
  if (kind === 'rollback' && from_version && from_version !== version)
    warnings.push({
      code: 'ROLLBACK_SCHEMA_AHEAD',
      text: `Apps that ${from_version} already migrated keep its newer database schema under ${version}; an older version may not read data a newer one wrote.`
    })
  // Task 14: the services the run deploys, and what changes against the last run that applied.
  const roles = sharedRoles(settings.size).map((r) => ({ role: r.role, replicas: r.replicas }))
  const roles_from = shared.mode === 'docker' ? await deployedRoles(shared.id) : null
  if (roles_from) {
    const to = roles.map((r) => r.role)
    const added = to.filter((r) => !roles_from.includes(r))
    const removed = roles_from.filter((r) => !to.includes(r))
    if (added.length || removed.length)
      warnings.push({
        code: 'ROLES_CHANGE',
        text: `The stack's services change (size ${settings.size}): ${[
          added.length ? `adds ${added.join(', ')}` : '',
          removed.length ? `removes ${removed.join(', ')}` : ''
        ]
          .filter(Boolean)
          .join('; ')}. The agent creates the new services before it removes the old ones.`
      })
  }
  const stack = shared.stack && STACK_NAME_RE.test(shared.stack) ? shared.stack : null
  const plan_hash = hashOf({
    shared: shared.id,
    kind,
    version,
    from_version,
    image,
    extensions,
    stack,
    driver: shared.driver_id,
    edge,
    pattern: shared.host_pattern,
    hostnames,
    settings,
    roles,
    roles_from,
    allow: [...shared.extensions].sort(),
    apps: apps.map((a) => [a.env_id, a.tenant_id, a.blockers, a.status, a.placed]),
    blockers: blockers.map((b) => b.code)
  })
  const plan: SharedUpgradePlan = {
    shared_id: shared.id,
    kind,
    version,
    from_version,
    apps,
    blockers,
    warnings,
    plan_hash,
    confirm: shared.key,
    overridable: [...OVERRIDABLE_CODES],
    image,
    stack,
    hostnames,
    roles,
    roles_from,
    downgrade
  }
  return { plan, facts: { shared, driver, health, edge, image, extensions, hostnames, rows } }
}

export async function planSharedUpgrade(
  sharedId: number,
  version: string,
  kind: SharedUpgradeKind = 'upgrade',
  deps: Partial<SharedPlanDeps> = {}
): Promise<SharedUpgradePlan> {
  return (await gatherSharedUpgrade(sharedId, version, kind, deps)).plan
}
