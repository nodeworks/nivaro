// The creation runner (phase 3, Task 9): turns a Create app request into an app, its owners, one
// environment per requested environment (status `provisioning`, hub_managed, sealed hub token),
// their database records and one creation row each — then walks every environment through the
// steps of steps.ts in the background.
//
// Starting: gather + plan run again INSIDE the creation-start lock (nvr:hub:create-start), so two
// creations at once never take the same key, hostname or stack name; a blocker answers 409 and
// nothing is written. Everything is written in ONE transaction.
//
// One leg = one environment's walk. It holds the environment's phase-2 promote lock (a promotion
// and a creation never run together: held → 'busy', the creation untouched), opens a job run
// (`Create <app>/<env>`), logs `<step> → done/waiting/failed` lines, checks the cancel flag
// between steps and releases the lock in `finally`. A step may wait (a DBA's database, a
// hand-made DNS name): the leg ends `waiting`; "Check now", a saved connection or the 5-minute
// cron (checkWaitingCreations) look again and start the leg once the thing is there.
//
// Retry never re-plans: it resumes the stored creation at its first unfinished step (every step
// is idempotent), so the creation's own app key, environments, stack names and database rows
// never count against it. A live leg renews its lock and the row's heartbeat_at every minute; a
// `running` row whose heartbeat is stale (> 2 min) and whose lock is gone becomes `interrupted`
// (boot, the cron, Retry, the delete gate); one with a fresh heartbeat is never taken over, even
// when Redis lost the lock (ruling P3-31). Retry resumes an interrupted one at that step.
//
// Secrets never reach a log line, a step note, an error, an activity row or readCreation: every
// stored or logged text passes the leg's scrub over every secret it opened or made.
import { randomBytes } from 'node:crypto'
import { insertReturningId } from '../../../db/dialect/ef.js'
import { db } from '../../../db/index.js'
import { runInBackgroundPool } from '../../../db/pool-context.js'
import { logActivity } from '../../activity.js'
import { getApp } from '../../io-holder.js'
import {
  type JobLogLine,
  type JobRunHandle,
  readJobLog,
  resumeJobRun,
  startJobRun
} from '../../job-runs.js'
import type { ChecklistItem } from '../db/checklist.js'
import { dbaChecklist } from '../db/checklist.js'
import { connectionUrl, scrubDbErrorFull } from '../db/connection.js'
import {
  attachDatabase,
  getDatabase,
  type HubDatabase,
  HubDbError,
  openDatabaseConnection,
  recordDatabase
} from '../db/databases.js'
import { generateHexSecret } from '../db/names.js'
import { getServerRow, type HubDbServerRow, publicServer } from '../db/servers.js'
import { getDriver, placedOnShared, SHARED_PLACEMENT_MESSAGE } from '../drivers.js'
import { defaultSleep, type Sleep } from '../gitlab-write.js'
import { hubTokenColumns } from '../link-token.js'
import { checkName as checkEnvironmentNameById } from '../name-check.js'
import { HEARTBEAT_FRESH_MS, withoutFreshHeartbeat } from '../promote-heal.js'
import {
  defaultPromoteLock,
  LOCK_RENEW_MS,
  lockHolderRefusal,
  type PromoteLock
} from '../promote-lock.js'
import { hubImage } from '../registry.js'
import { HubSecretError, openSecret, sealSecret } from '../secrets.js'
import { getShared } from '../shared/store.js'
import { readEnvironmentStatus } from '../status.js'
import { recordTemplateChoices } from '../templates/choice.js'
import { manualTicket, redirectUriFor, stackName } from './app-config.js'
import { managerLines } from './deploy-key.js'
import { namingForDocker } from './dest.js'
import {
  type CreationDest,
  type DestStepContext,
  type DestStepDeps,
  destSteps
} from './docker-steps.js'
import { type GatherCreationDeps, gatherCreationFacts } from './gather.js'
import { GITHUB_STEPS, type GithubStepContext } from './github-steps.js'
import { getGithubTarget, type HubGithubTargetRow } from './github-target.js'
import { requestFirstAdmin } from './link-client.js'
import { checkName } from './name-check.js'
import { buildCreationPlan } from './plan.js'
import { providerPartsOf } from './provider-parts.js'
import {
  awaitTargetSyncs,
  type BaseStepContext,
  checkDatabaseWait,
  checkNameWait,
  OPERATOR_NOTE,
  STEPS,
  type StepApp,
  type StepContext,
  type StepDeps,
  type StepEnv,
  StepFailure,
  type StepResult,
  syncTargetApps,
  tokenUserMemo
} from './steps.js'
import {
  appMade,
  CREATIONS,
  type CreationFlags,
  type CreationMade,
  type CreationRow,
  type CreationStatus,
  type CreationWait,
  creationKind,
  defaultCreationFlags,
  defaultKeyedLock,
  HUB_CREATE_START_LOCK_KEY,
  insertCreation,
  type KeyedLock,
  OPEN_CREATION_STATUSES,
  patchCreation,
  readCreationRow,
  saveAppMade,
  writeOwnMade
} from './store.js'
import { getTargetRow, type HubTargetRow } from './targets.js'
import {
  type CreateAppInput,
  type CreationFacts,
  type CreationPlan,
  type CreationStepState,
  creationKindOf,
  githubTargetIdOf,
  gitlabTargetIdOf,
  stepOrderFor
} from './types.js'

export { awaitTargetSyncs, syncTargetApps }

/** A refusal with its HTTP status; a 409 from the planner carries every blocker. */
export class CreationError extends Error {
  code: string
  status: number
  blockers?: CreationPlan['blockers']
  constructor(code: string, message: string, status = 400, blockers?: CreationPlan['blockers']) {
    super(message)
    this.name = 'CreationError'
    this.code = code
    this.status = status
    if (blockers) this.blockers = blockers
  }
}

export interface CreationDeps {
  lock: PromoteLock
  link?: { requestFirstAdmin: typeof requestFirstAdmin }
  checkName?: typeof checkName
  status?: typeof readEnvironmentStatus
  startJobRun?: (label: string, envId: number, userId: string | null) => Promise<JobRunHandle>
  sleep?: Sleep
  now?: () => number
  /** The planner's remote looks (tests inject them; default: Docker Hub, GitLab, the server). */
  gather?: GatherCreationDeps
  /** The app's repository lock and the creation-start lock (default: Redis, else in-process). */
  repoLock?: KeyedLock
  startLock?: KeyedLock
  flags?: CreationFlags
  /** How often a leg renews its lock and heartbeat (default LOCK_RENEW_MS; tests shorten it). */
  renewMs?: number
  /** Docker and shared creations: the agent deploy and place-shared (tests pass fakes). */
  dest?: DestStepDeps
}

export function defaultCreationDeps(): CreationDeps {
  return { lock: defaultPromoteLock() }
}

interface Resolved {
  lock: PromoteLock
  renewMs: number
  flags: CreationFlags
  startLock: KeyedLock
  startJobRun: NonNullable<CreationDeps['startJobRun']>
  gather?: GatherCreationDeps
  step: StepDeps
  dest: DestStepDeps
}

function resolve(d: CreationDeps = defaultCreationDeps()): Resolved {
  return {
    lock: d.lock,
    renewMs: d.renewMs ?? LOCK_RENEW_MS,
    flags: d.flags ?? defaultCreationFlags(),
    startLock: d.startLock ?? defaultKeyedLock(),
    startJobRun:
      d.startJobRun ??
      ((label, envId, userId) =>
        startJobRun('deploy', `hub-create-${envId}`, { label, triggeredBy: userId })),
    gather: d.gather,
    dest: d.dest ?? {},
    step: {
      repoLock: d.repoLock ?? defaultKeyedLock(),
      link: d.link ?? { requestFirstAdmin },
      checkName: d.checkName ?? checkName,
      status: d.status ?? readEnvironmentStatus,
      sleep: d.sleep ?? defaultSleep,
      now: d.now ?? Date.now
    }
  }
}

const ENVS = 'nivaro_hub_environments'
const APPS = 'nivaro_hub_apps'
const yieldToIo = () => new Promise<void>((resolve) => setImmediate(resolve))

/** Text that may be stored or logged: every secret of the leg masked, cut to `max`. */
function scrub(text: unknown, secrets: Set<string>, max = 1000): string {
  return scrubDbErrorFull(text, [...secrets]).slice(0, max)
}

/** The database row id an environment's db_ref names (`hub-db:<id>`), or null. */
function dbIdFromRef(ref: string | null): number | null {
  const m = /^hub-db:(\d+)$/.exec(String(ref ?? ''))
  return m ? Number(m[1]) : null
}

function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'STEP_FAILED'
}

/** Phase 6 (Decision 17): a creation never runs on an environment placed on a shared deployment. */
async function refuseShared(envId: number): Promise<void> {
  if (await placedOnShared(envId))
    throw new CreationError('SHARED_PLACEMENT', SHARED_PLACEMENT_MESSAGE, 409)
}

// ── start ────────────────────────────────────────────────────────────────────

export const START_LOCK_POLL_MS = 250
export const START_LOCK_TRIES = 120

async function withStartLock<T>(r: Resolved, fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    const token = await r.startLock.take(HUB_CREATE_START_LOCK_KEY)
    if (token) {
      try {
        return await fn()
      } finally {
        await r.startLock.release(HUB_CREATE_START_LOCK_KEY, token)
      }
    }
    if (i >= START_LOCK_TRIES)
      throw new CreationError(
        'CREATION_STARTING',
        'Another app is being created right now — try again in a moment.',
        409
      )
    await r.step.sleep(START_LOCK_POLL_MS)
    await yieldToIo()
  }
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

/**
 * Plans the request again under the creation-start lock and writes the app, its owners, its
 * environments, their databases and creation rows in one transaction; then starts every leg in
 * position order in the background.
 */
export async function startCreation(
  input: CreateAppInput,
  user: { id: string },
  deps?: CreationDeps
): Promise<{ app_id: number; environments: Array<{ id: number; key: string }> }> {
  const r = resolve(deps)
  const out = await withStartLock(r, async () => {
    const facts = await gatherCreationFacts(input, r.gather)
    const plan = buildCreationPlan(input, facts)
    if (!plan.ok)
      throw new CreationError(plan.blockers[0].code, plan.blockers[0].text, 409, plan.blockers)
    try {
      const written = await writeCreation(input, plan, facts, user)
      await allowCreationConnections(written.app_id, input, facts)
      return written
    } catch (err) {
      if (err instanceof HubDbError) throw new CreationError(err.code, err.message, 409)
      if (err instanceof HubSecretError) throw new CreationError(err.code, err.message, 400)
      throw err
    }
  })
  for (const e of out.environments) launchLeg(e.id, user, r, ['queued'])
  return out
}

/**
 * Task 11a: the provider connections a Hub admin created the app with (its GitHub target's, its
 * environments' provider parts') join the app's allowed list, so its owners can later promote
 * and change those parts under the usual owner rules. Best effort: a Hub without the provider
 * tables keeps none.
 */
async function allowCreationConnections(
  appId: number,
  input: CreateAppInput,
  facts: CreationFacts
): Promise<void> {
  const ids = new Set<number>()
  if (facts.github?.target) ids.add(facts.github.target.connection_id)
  for (const e of input.environments ?? []) {
    const pp = providerPartsOf(e.providers)
    if (pp.ok) for (const p of pp.parts) ids.add(p.connection_id)
  }
  if (!ids.size) return
  try {
    const { appAllowedConnections, setAppAllowedConnections } = await import(
      '../providers/store.js'
    )
    const have = await appAllowedConnections(appId)
    await setAppAllowedConnections(appId, [...have, ...ids])
  } catch {
    /* no provider tables: nothing to allow */
  }
}

async function writeCreation(
  input: CreateAppInput,
  plan: CreationPlan,
  facts: CreationFacts,
  user: { id: string }
): Promise<{ app_id: number; environments: Array<{ id: number; key: string }> }> {
  // Sealed before the transaction: a missing ENCRYPTION_KEY writes nothing. A shared creation may
  // come without sign-in (the deployment's own OIDC signs its apps in).
  const signin = input.signin && typeof input.signin === 'object' ? input.signin : null
  const oidcSecret = signin ? sealSecret(String(signin.client_secret)) : null
  // Ruling X-4: sealed with its app-link lookup (link-token.ts hubTokenColumns). A shared
  // environment gets no token at creation: the placement issues its token when the app serves
  // (a token before then would also make place-shared see a link it cannot reach).
  const tokens = plan.environments.map(() =>
    creationKindOf(input) === 'shared' ? null : hubTokenColumns(generateHexSecret(32))
  )
  const now = () => new Date()
  // The digests and Hub URL the planner accepted: each creation keeps them for its retries.
  const digest = String(facts.digest)
  const slimDigest =
    typeof facts.slimDigest === 'string' && facts.slimDigest.startsWith('sha256:')
      ? facts.slimDigest
      : null
  const hubUrl = facts.hubUrl ?? ''
  const servers = facts.servers
  const kind = creationKindOf(input)
  const docker = kind === 'docker' && facts.docker?.settings.ok ? facts.docker.settings.row : null
  if (kind === 'docker' && !docker)
    throw new CreationError('BAD_TARGET', 'The Docker stack settings were not checked.', 409)
  const extensions =
    kind === 'docker'
      ? Object.keys(docker?.extension_pins ?? {}).sort()
      : kind === 'shared' && Array.isArray(input.extensions)
        ? [...new Set(input.extensions.map(String))]
        : []
  const tgt = (input.target ?? {}) as { driver_id?: unknown; shared_id?: unknown }
  return db.transaction(async (trx) => {
    const appId = Number(
      await insertReturningId(trx, APPS, {
        key: plan.app.key,
        name: plan.app.name,
        signin_mode: 'direct',
        adopted: false,
        extensions: JSON.stringify(extensions),
        created_by: user.id || null,
        target_id:
          kind === 'gitlab'
            ? gitlabTargetIdOf(input)
            : kind === 'github'
              ? githubTargetIdOf(input)
              : null,
        oidc: signin
          ? JSON.stringify({ issuer: str(signin.issuer), client_id: str(signin.client_id) })
          : null,
        oidc_secret: oidcSecret,
        created_at: now(),
        updated_at: now()
      })
    )
    const owners: string[] = []
    for (const o of input.owners) {
      const id = str(o)
      if (id && !owners.some((x) => x.toLowerCase() === id.toLowerCase())) owners.push(id)
    }
    if (owners.length)
      await trx('nivaro_hub_app_owners').insert(
        owners.map((user_id) => ({ app_id: appId, user_id, created_at: now(), updated_at: now() }))
      )

    const envs: Array<{ id: number; key: string }> = []
    for (const [i, pe] of plan.environments.entries()) {
      const envId = Number(
        await insertReturningId(trx, ENVS, {
          app_id: appId,
          key: pe.key,
          position: pe.position,
          status: 'provisioning',
          base_url: pe.base_url,
          hostnames: JSON.stringify(pe.hostname ? [pe.hostname] : []),
          ...(tokens[i] ?? {}),
          hub_managed: true,
          created_at: now(),
          updated_at: now()
        })
      )
      const spec = input.environments[i].database as Record<string, unknown>
      let databaseId: number
      if (spec.database_id !== undefined) {
        databaseId = Number(spec.database_id)
        // Judged again here, in this transaction: only a ready, unattached row (never fenced).
        await attachDatabase(databaseId, envId, trx, { expect: ['ready'] })
      } else {
        const server = servers[Number(spec.server_id)]
        const rec = await recordDatabase({
          server,
          database_name: pe.database.database_name,
          login_name: pe.database.login_name ?? '',
          by: user.id || null,
          trx
        })
        databaseId = rec.id
        await attachDatabase(databaseId, envId, trx)
      }
      const made: CreationMade = {
        database_id: databaseId,
        ...(kind === 'docker'
          ? { target: { kind: 'docker' as const, driver_id: Number(tgt.driver_id) } }
          : kind === 'github'
            ? { target: { kind: 'github' as const, target_id: githubTargetIdOf(input) } }
            : kind === 'shared'
              ? {
                  target: {
                    kind: 'shared' as const,
                    shared_id: Number(tgt.shared_id),
                    pool_max: pe.pool_max ?? 5
                  }
                }
              : {}),
        planned: {
          hub_url: hubUrl,
          digest: kind === 'shared' ? '' : digest,
          slim_digest: slimDigest,
          hostname: pe.hostname as string,
          base_url: pe.base_url as string,
          source_branch: pe.source_branch,
          nonce: randomBytes(18).toString('base64url'),
          // Task 11a: the environment's provider parts, sealed (a field may hold a secret).
          ...(() => {
            const pp = providerPartsOf(input.environments[i].providers)
            return pp.ok && pp.parts.length
              ? { providers_sealed: sealSecret(JSON.stringify(pp.parts)) }
              : {}
          })(),
          // Sealed as validated (gather.ts): the stack step stores them as they are.
          ...(docker
            ? {
                stack: {
                  size: docker.fields.size,
                  redis: docker.fields.redis,
                  publish_port: pe.stack?.publish_port ?? null,
                  settings: docker.fields.settings,
                  secrets: docker.fields.secrets,
                  extension_pins: docker.extension_pins ?? {}
                }
              }
            : {})
        }
      }
      await insertCreation(trx, {
        app_id: appId,
        environment_id: envId,
        // A shared app runs its deployment's version (a blank one on the form means that).
        version: str(input.version) || (facts.shared?.deployment?.version_pin ?? ''),
        first_admin: firstAdminOf(input),
        made,
        started_by: user.id || null
      })
      envs.push({ id: envId, key: pe.key })
    }
    await recordTemplateChoices(trx, {
      input,
      appId,
      envIds: envs.map((e) => e.id),
      by: user.id || null
    })
    return { app_id: appId, environments: envs }
  })
}

function firstAdminOf(input: CreateAppInput): CreationRow['first_admin'] {
  const fa = input.first_admin
  const out: CreationRow['first_admin'] = { email: str(fa.email) }
  if (str(fa.first_name)) out.first_name = str(fa.first_name)
  if (str(fa.last_name)) out.last_name = str(fa.last_name)
  return out
}

// ── legs ─────────────────────────────────────────────────────────────────────

interface LiveLeg {
  creationId: number
  cancel: boolean
}
/** Legs this process runs now, by environment id. */
const live = new Map<number, LiveLeg>()
/** Every leg this process started, by environment id (tests and shutdown wait on it). */
const launched = new Map<number, Promise<unknown>>()

/** Resolves when every leg this process started for the environment has ended. */
export async function awaitCreation(envId: number): Promise<void> {
  for (;;) {
    const p = launched.get(envId)
    if (!p) return
    await p
    if (launched.get(envId) === p) return
  }
}

function launchLeg(
  envId: number,
  user: { id: string } | null,
  r: Resolved,
  from: readonly CreationStatus[]
): void {
  const p = runInBackgroundPool(() => runLeg(envId, user, r, from)).catch((err) =>
    getApp()?.log?.error?.(
      { envId, err: (err as Error | null)?.name ?? 'Error' },
      'hub creation bookkeeping failed'
    )
  )
  const prev = launched.get(envId)
  const chained = prev ? Promise.all([prev, p]) : p
  launched.set(envId, chained)
  void chained.finally(() => {
    if (launched.get(envId) === chained) launched.delete(envId)
  })
}

/**
 * Walks one queued or waiting environment's creation from its first unfinished step (a failed,
 * interrupted or cancelled one is refused NOT_RESUMABLE: Retry). Answers 'busy' (nothing
 * touched) when another runner — a promotion or a creation leg — holds the environment.
 */
export async function runCreationLeg(
  envId: number,
  user: { id: string } | null,
  deps?: CreationDeps
): Promise<'done' | 'waiting' | 'failed' | 'cancelled' | 'interrupted' | 'busy'> {
  // Only a queued or waiting creation; a failed, interrupted or cancelled one goes through Retry.
  const row = await readCreationRow(envId)
  if (row && !['queued', 'waiting', 'running', 'done'].includes(row.status))
    throw new CreationError(
      'NOT_RESUMABLE',
      `The creation is ${row.status}: use Retry to start it again.`,
      409
    )
  return runLeg(envId, user, resolve(deps), ['queued', 'waiting'])
}

async function loadContext(row: CreationRow): Promise<{
  app: StepApp
  env: StepEnv
  /** A GitLab creation's target (null for Docker and shared ones). */
  target: HubTargetRow | null
  /** A Docker or shared creation's driver or deployment (null for GitLab ones). */
  dest: CreationDest | null
  /** Task 11a: a GitHub creation's target. */
  github: HubGithubTargetRow | null
  dnsMode: 'automatic' | 'manual'
}> {
  const a = (await db(APPS).where({ id: row.app_id }).first()) as
    | Record<string, unknown>
    | undefined
  const e = (await db(ENVS).where({ id: row.environment_id }).first()) as
    | Record<string, unknown>
    | undefined
  if (!a || !e) throw new StepFailure('NOT_FOUND', 'The app or environment is gone.')
  const oidc = (() => {
    try {
      const v = typeof a.oidc === 'string' ? JSON.parse(a.oidc) : a.oidc
      return { issuer: String(v?.issuer ?? ''), client_id: String(v?.client_id ?? '') }
    } catch {
      return { issuer: '', client_id: '' }
    }
  })()
  const hostnames = (() => {
    try {
      const v = typeof e.hostnames === 'string' ? JSON.parse(e.hostnames) : e.hostnames
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  })()
  const t = row.made.target
  let target: HubTargetRow | null = null
  let dest: CreationDest | null = null
  let github: HubGithubTargetRow | null = null
  let dnsMode: 'automatic' | 'manual' = 'automatic'
  if (t?.kind === 'docker') {
    const driver = await getDriver(t.driver_id)
    if (driver?.kind !== 'docker')
      throw new StepFailure('BAD_TARGET', 'The creation’s Docker driver is gone.')
    dest = { kind: 'docker', driver }
    dnsMode = driver.config.dns_mode === 'manual' ? 'manual' : 'automatic'
  } else if (t?.kind === 'shared') {
    const shared = await getShared(t.shared_id)
    if (!shared) throw new StepFailure('BAD_TARGET', 'The creation’s shared deployment is gone.')
    dest = { kind: 'shared', shared }
  } else if (t?.kind === 'github') {
    // Task 11a: a GitHub target (github-steps.ts).
    github = await getGithubTarget(t.target_id)
    if (!github) throw new StepFailure('BAD_TARGET', 'The creation’s GitHub target is gone.')
    dnsMode = github.config.dns_mode === 'manual' ? 'manual' : 'automatic'
  } else {
    target = a.target_id == null ? null : await getTargetRow(Number(a.target_id))
    if (!target) throw new StepFailure('BAD_TARGET', 'The app’s target is gone.')
    dnsMode = target.config.dns_mode === 'manual' ? 'manual' : 'automatic'
  }
  return {
    app: {
      id: Number(a.id),
      key: String(a.key),
      name: String(a.name),
      target_id: Number(a.target_id),
      deploy_project: (a.deploy_project as string | null) ?? null,
      oidc,
      oidc_secret: (a.oidc_secret as string | null) ?? null
    },
    env: {
      id: Number(e.id),
      app_id: Number(e.app_id),
      key: String(e.key),
      position: Number(e.position ?? 0),
      status: String(e.status),
      base_url: String(e.base_url),
      hostnames,
      hub_token: (e.hub_token as string | null) ?? null,
      db_ref: (e.db_ref as string | null) ?? null,
      placement_id: e.placement_id == null ? null : Number(e.placement_id)
    },
    target,
    dest,
    github,
    dnsMode
  }
}

async function runLeg(
  envId: number,
  user: { id: string } | null,
  r: Resolved,
  from: readonly CreationStatus[]
): Promise<'done' | 'waiting' | 'failed' | 'cancelled' | 'interrupted' | 'busy'> {
  const first = await readCreationRow(envId)
  if (!first) throw new CreationError('NOT_FOUND', 'No creation for this environment.', 404)
  if (first.status === 'done') return 'done'
  // A shared creation places the environment on its deployment itself (its place step).
  if (creationKind(first.made) !== 'shared') await refuseShared(envId)
  const token = await r.lock.take(envId, 'creation')
  if (!token) return 'busy'
  const entry: LiveLeg = { creationId: first.id, cancel: false }
  live.set(envId, entry)
  // A lost lock aborts the step's waits (a deploy wait, a name / link / admin poll) at once.
  const ac = new AbortController()
  let lockLost = false
  let claimed = 0
  /** This leg is alive: written with every lock renewal, whether or not the lock held (P3-31). */
  const heartbeat = () =>
    claimed
      ? db(CREATIONS)
          .where({ id: first.id, status: 'running' })
          .update({ heartbeat_at: new Date() })
          .catch(() => undefined)
      : Promise.resolve()
  const renew = setInterval(() => {
    void r.lock
      .renew(envId, token)
      .then((held) => {
        if (!held) {
          lockLost = true
          ac.abort()
        }
      })
      .catch(() => undefined)
    void heartbeat()
  }, r.renewMs)
  renew.unref?.()
  try {
    // We hold the environment, but a row still `running` here may belong to a leg that lost its
    // lock and runs on (a Redis restart): only one whose heartbeat is stale is taken over.
    claimed = await claimLeg(first.id, from)
    if (!claimed) return 'busy'
    await r.flags.clearCancel(first.id)
    return await walk(envId, first.id, user, r, entry, () => lockLost, ac.signal, token)
  } finally {
    clearInterval(renew)
    live.delete(envId)
    // This leg no longer vouches for the row (whatever it ended in): one left `running` is
    // stale at once. Still under our lock, so no other leg can have claimed it meanwhile.
    if (claimed)
      await db(CREATIONS)
        .where({ id: first.id })
        .update({ heartbeat_at: null })
        .catch(() => undefined)
    await r.lock.release(envId, token)
  }
}

/**
 * Moves the creation to `running` for this leg: from one of `from`, or from a `running` row no
 * leg vouches for (no heartbeat, or one older than HEARTBEAT_FRESH_MS). Answers the rows changed.
 */
async function claimLeg(id: number, from: readonly CreationStatus[]): Promise<number> {
  const now = Date.now()
  const q = db(CREATIONS)
    .where({ id })
    .where((w) =>
      w
        .whereIn('status', from as CreationStatus[])
        .orWhere((x) => withoutFreshHeartbeat(x.where({ status: 'running' }), now))
    )
  return Number(
    await q.update({
      status: 'running',
      waiting_for: null,
      error: null,
      finished_at: null,
      heartbeat_at: new Date(now),
      updated_at: new Date(now)
    })
  )
}

/** A `running` creation row a live leg still vouches for (heartbeat within HEARTBEAT_FRESH_MS). */
export function creationHeartbeatFresh(row: CreationRow, now = Date.now()): boolean {
  if (row.status !== 'running' || !row.heartbeat_at) return false
  const at = Date.parse(row.heartbeat_at)
  return Number.isFinite(at) && at >= now - HEARTBEAT_FRESH_MS
}

/** A step's sleep that ends at once and throws when the leg's lock is lost (P3-31). */
function guardedSleep(sleep: Sleep, signal: AbortSignal): Sleep {
  const stop = () => new StepFailure('INTERRUPTED', 'The environment lock was lost.')
  return async (ms) => {
    if (signal.aborted) throw stop()
    await sleep(ms, signal)
    if (signal.aborted) throw stop()
  }
}

async function walk(
  envId: number,
  creationId: number,
  user: { id: string } | null,
  r: Resolved,
  entry: LiveLeg,
  lockLost: () => boolean,
  signal: AbortSignal,
  lockToken: string
): Promise<'done' | 'waiting' | 'failed' | 'cancelled' | 'interrupted'> {
  const secrets = new Set<string>()
  let row = (await readCreationRow(envId)) as CreationRow
  let run: JobRunHandle | null = null
  const log = (line: string, level: 'info' | 'warn' | 'error' = 'info') =>
    run?.log(scrub(line, secrets, 480), level)
  const steps: CreationStepState[] = row.steps.map((s) => ({ ...s }))
  const persist = (patch: Parameters<typeof patchCreation>[1] = {}) =>
    patchCreation(creationId, { steps, ...patch }, ['running'])

  let current: CreationStepState | null = null
  try {
    const { app, env, target, dest, github, dnsMode } = await loadContext(row)
    // Every secret this leg could print, known before any step runs (a retry that resumes
    // mid-leg opens no variable step, yet its deploy lines may echo one).
    const remember = (plain: string | null | undefined) => {
      if (!plain) return
      secrets.add(plain)
      secrets.add(Buffer.from(plain).toString('base64'))
    }
    const own = target?.secret ?? (dest?.kind === 'docker' ? dest.driver.secret : null)
    for (const sealed of [own, env.hub_token, app.oidc_secret]) {
      try {
        remember(openSecret(sealed))
      } catch {
        // unreadable: the step that needs it fails with its own code
      }
    }
    // The database's password and URL, once it is ready (a waiting or failed one has none yet:
    // the variables step registers them when it opens them).
    const dbId = row.made.database_id ?? dbIdFromRef(env.db_ref)
    if (dbId) {
      try {
        const conn = await openDatabaseConnection(dbId)
        remember(conn.password)
        remember(connectionUrl(conn))
      } catch {
        // not ready or unreadable: nothing to print yet
      }
    }
    run = await r.startJobRun(`Create ${app.key}/${env.key}`, envId, user?.id || null)
    if (run.id != null) await patchCreation(creationId, { job_run_id: run.id }, ['running'])
    const base: BaseStepContext = {
      creation: row,
      app,
      env,
      dnsMode,
      made: { ...row.made },
      async saveMade() {
        // Own keys only; the app-level ones are saveAppMade's (the row's copy comes back).
        ctx.made = await writeOwnMade(creationId, ctx.made)
      },
      doneSha: (key) => steps.find((s) => s.key === key && s.status === 'done')?.sha ?? null,
      log,
      secrets,
      signal,
      deps: { ...r.step, sleep: guardedSleep(r.step.sleep, signal) }
    }
    // A GitLab creation walks steps.ts STEPS with its target; Docker and shared ones docker-steps.
    const ctx: BaseStepContext = github
      ? ({ ...base, github } as GithubStepContext)
      : target
        ? ({ ...base, target, tokenUserId: tokenUserMemo(target) } as StepContext)
        : ({
            ...base,
            dest: dest as CreationDest,
            envLock: { lock: r.lock, token: lockToken },
            cancelRequested: async () => entry.cancel || (await r.flags.cancelRequested(creationId))
          } as DestStepContext)
    const table = github
      ? (GITHUB_STEPS as Record<string, (c: BaseStepContext) => Promise<StepResult>>)
      : target
        ? (STEPS as Record<string, (c: BaseStepContext) => Promise<StepResult>>)
        : (destSteps(r.dest) as Record<string, (c: BaseStepContext) => Promise<StepResult>>)

    for (const key of stepOrderFor(creationKind(row.made))) {
      const state = steps.find((s) => s.key === key) as CreationStepState
      if (state.status === 'done') continue
      if (lockLost()) {
        await finish('interrupted', 'INTERRUPTED: The environment lock was lost; retry.')
        log('the creation lock was lost — stopped', 'error')
        await run.fail(new Error(`Create ${app.key}/${env.key}: stopped (lock lost)`))
        return 'interrupted'
      }
      if (entry.cancel || (await r.flags.cancelRequested(creationId))) {
        await finish('cancelled', null)
        log(`cancelled before ${key}`, 'warn')
        await run.complete(`Create ${app.key}/${env.key}: cancelled before ${key}`)
        return 'cancelled'
      }
      current = state
      Object.assign(state, { status: 'running', at: new Date().toISOString(), note: null })
      await persist({ step: key })
      const runStep = table[key]
      if (!runStep) throw new StepFailure('STEP_FAILED', `No ${key} step for this creation.`)
      const result = await runStep(ctx)
      // This leg's own keys; the app-level ones come back as the rows hold them.
      ctx.made = await writeOwnMade(creationId, ctx.made)
      if (result.status === 'waiting') {
        Object.assign(state, {
          status: 'waiting',
          at: new Date().toISOString(),
          note: scrub(result.note, secrets, 300)
        })
        await persist({ status: 'waiting', waiting_for: result.on })
        log(`${key} → waiting: ${result.note}`)
        await run.complete(`Create ${app.key}/${env.key}: waiting for the ${result.on}`)
        return 'waiting'
      }
      Object.assign(state, {
        status: 'done',
        at: new Date().toISOString(),
        note: scrub(result.note, secrets, 300),
        ...(result.sha ? { sha: result.sha } : {})
      })
      await persist()
      log(`${key} → done: ${result.note}`)
      current = null
    }

    // Only the run that really closed the row moves the environment on.
    if (!(await finish('done', null))) {
      log('the creation was changed elsewhere while it finished — left as it is', 'warn')
      await run.complete(`Create ${app.key}/${env.key}: finished elsewhere`)
      return 'interrupted'
    }
    await db(ENVS)
      .where({ id: envId })
      .whereIn('status', ['provisioning', 'waiting_for_name'])
      .update({ status: 'active', updated_at: new Date() })
    await logActivity({
      action: 'hub-create-done',
      user: user?.id || row.started_by,
      collection: ENVS,
      item: String(envId),
      comment: `Created ${app.key}/${env.key} (${row.version})`
    })
    await run.complete(`Create ${app.key}/${env.key}: done`)
    return 'done'
  } catch (err) {
    if (signal.aborted) {
      // The lock was lost mid-step: stop at once, the step left as interrupted (Retry resumes).
      const note = 'The environment lock was lost during this step; retry.'
      if (current) Object.assign(current, { status: 'failed', at: new Date().toISOString(), note })
      await finish('interrupted', `INTERRUPTED: ${note}`).catch(() => undefined)
      log(`${current?.key ?? 'start'} → stopped: the creation lock was lost`, 'error')
      await run?.fail(new Error(`${current?.key ?? 'start'}: stopped (lock lost)`))
      return 'interrupted'
    }
    const code = errorCode(err)
    if (code === 'CANCELLED') {
      // Review M1: a Docker deploy stopped by a cancel before its apply. The step did nothing.
      if (current) Object.assign(current, { status: 'pending', at: null, note: null })
      await finish('cancelled', null).catch(() => undefined)
      log(`cancelled during ${current?.key ?? 'start'} (nothing was applied)`, 'warn')
      await run?.complete(`Create: cancelled during ${current?.key ?? 'start'}`)
      return 'cancelled'
    }
    const text = scrub(err instanceof Error ? err.message : err, secrets, 900)
    if (current)
      Object.assign(current, {
        status: 'failed',
        at: new Date().toISOString(),
        note: scrub(`${code}: ${text}`, secrets, 300)
      })
    await finish('failed', `${code}: ${text}`).catch(() => undefined)
    log(`${current?.key ?? 'start'} → failed: ${code}: ${text}`, 'error')
    await run?.fail(new Error(scrub(`${current?.key ?? 'start'} failed: ${code}`, secrets)))
    return 'failed'
  }

  async function finish(status: CreationStatus, error: string | null): Promise<number> {
    const terminal = status !== 'running' && status !== 'waiting' && status !== 'queued'
    const n = await patchCreation(
      creationId,
      {
        steps,
        status,
        waiting_for: null,
        error: error ? scrub(error, secrets) : null,
        ...(terminal ? { finished_at: new Date() } : {})
      },
      ['running']
    )
    row = (await readCreationRow(envId)) ?? row
    return n
  }
}

// ── resume, cancel, recover ──────────────────────────────────────────────────

/** The waiting step's note when what it waited for is there but another run holds the env. */
export const QUEUED_NOTE = 'queued: another run holds this environment'

/**
 * retry: a failed, interrupted or cancelled creation → its leg starts again at the first
 * unfinished step (never re-planned). check: a waiting creation → the waited thing is looked at
 * now (the DBA's connection checked again / the name checked); still missing → stays waiting with
 * the reason as the step note; there → the leg starts (and re-checks it first).
 */
export async function resumeCreation(
  envId: number,
  user: { id: string },
  why: 'retry' | 'check',
  deps?: CreationDeps
): Promise<{ status: string }> {
  const r = resolve(deps)
  let row = await readCreationRow(envId)
  if (!row) throw new CreationError('NOT_FOUND', 'No creation for this environment.', 404)
  if (creationKind(row.made) !== 'shared') await refuseShared(envId)
  if (row.status === 'running' && !live.has(envId) && (await r.lock.held(envId)) === false) {
    await interrupt(row, 'The runner stopped during this step')
    row = (await readCreationRow(envId)) as CreationRow
  }
  if (why === 'retry') {
    if (!['failed', 'interrupted', 'cancelled'].includes(row.status))
      throw new CreationError(
        'NOT_RESUMABLE',
        `The creation is ${row.status}: only a failed, interrupted or cancelled one is retried.`,
        409
      )
    if ((await r.lock.held(envId)) === true)
      throw new CreationError(
        'ENVIRONMENT_BUSY',
        'A promotion or a creation step holds this environment right now — try again shortly.',
        409
      )
    launchLeg(envId, user, r, ['failed', 'interrupted', 'cancelled'])
    return { status: 'running' }
  }
  if (row.status !== 'waiting')
    throw new CreationError(
      'NOT_RESUMABLE',
      `The creation is ${row.status}: only a waiting one is checked.`,
      409
    )
  const look = await lookAtWait(row, r)
  // Resolved, but a promotion (or another leg) holds the environment: the leg would only answer
  // busy. Stay waiting; the next look starts it once the lock is free.
  const held = look.resolved && (await r.lock.held(envId)) === true
  if (!look.resolved || held) {
    const note = held ? QUEUED_NOTE : look.note
    const steps = row.steps.map((s) =>
      s.status === 'waiting' ? { ...s, at: new Date().toISOString(), note } : s
    )
    await patchCreation(row.id, { steps }, ['waiting'])
    return { status: 'waiting' }
  }
  launchLeg(envId, user, r, ['waiting'])
  return { status: 'running' }
}

/** The waited thing, looked at once. Never throws: a failed look stays waiting with its reason. */
async function lookAtWait(
  row: CreationRow,
  r: Resolved
): Promise<{ resolved: boolean; note: string }> {
  const secrets = new Set<string>()
  if (row.waiting_for === 'operator') {
    // Only the operator's "Installed" moves it on (no automatic re-deploy). A press this leg has
    // not acted on yet (its environment was busy when Installed started it) is acted on now; a
    // deploy refused for the key clears the press, so this never re-deploys by itself.
    try {
      if ((await appMade(row.app_id)).operator_ack)
        return { resolved: true, note: 'The deploy key is installed; deploying.' }
    } catch {
      // unreadable: keep waiting
    }
    const waiting = row.steps.find((x) => x.status === 'waiting')
    return { resolved: false, note: waiting?.note ?? OPERATOR_NOTE }
  }
  try {
    const { app, env, dnsMode } = await loadContext(row)
    const ctx: BaseStepContext = {
      creation: row,
      app,
      env,
      dnsMode,
      made: { ...row.made },
      saveMade: async () => undefined,
      doneSha: () => null,
      log: () => undefined,
      secrets,
      deps: r.step
    }
    const look =
      row.waiting_for === 'name' ? await checkNameWait(ctx) : await checkDatabaseWait(ctx)
    return { resolved: look.resolved, note: scrub(look.note, secrets, 300) }
  } catch (err) {
    return {
      resolved: false,
      note: scrub(`The check failed (${errorCode(err)}).`, secrets, 300)
    }
  }
}

/**
 * The operator's "Installed" (ruling P3-22): the app's deploy key and key.conf are on the swarm
 * manager. Recorded for the app (one key per app), then every environment of the app waiting for
 * the operator runs its deploy once. Refused NOT_WAITING_FOR_OPERATOR unless this environment's
 * creation waits for the operator.
 */
export async function confirmOperatorInstalled(
  envId: number,
  user: { id: string },
  deps?: CreationDeps
): Promise<{ status: 'running'; environments: number[] }> {
  const r = resolve(deps)
  const row = await readCreationRow(envId)
  if (!row) throw new CreationError('NOT_FOUND', 'No creation for this environment.', 404)
  if (row.status !== 'waiting' || row.waiting_for !== 'operator')
    throw new CreationError(
      'NOT_WAITING_FOR_OPERATOR',
      'This creation is not waiting for the deploy key to be installed.',
      409
    )
  await saveAppMade(row.app_id, {
    operator_ack: { at: new Date().toISOString(), by: user.id || null }
  })
  const waiting = (await db(CREATIONS)
    .where({ app_id: row.app_id, status: 'waiting', waiting_for: 'operator' })
    .orderBy('id')
    .select('environment_id')) as Array<{ environment_id: number }>
  const envs = waiting.map((w) => Number(w.environment_id))
  for (const id of envs) launchLeg(id, user, r, ['waiting'])
  return { status: 'running', environments: envs }
}

/** Asks a running creation to stop at its next step boundary; a waiting or queued one stops now. */
export async function cancelCreation(
  envId: number,
  user: { id: string },
  deps: Pick<CreationDeps, 'flags'> = {}
): Promise<{ ok: true } | { ok: false; code: 'NOT_FOUND' | 'NOT_RUNNING' }> {
  const flags = deps.flags ?? defaultCreationFlags()
  const row = await readCreationRow(envId)
  if (!row) return { ok: false, code: 'NOT_FOUND' }
  if (row.status === 'waiting' || row.status === 'queued') {
    const n = await patchCreation(
      row.id,
      { status: 'cancelled', waiting_for: null, finished_at: new Date() },
      [row.status]
    )
    if (n) {
      await db(ENVS)
        .where({ id: envId, status: 'waiting_for_name' })
        .update({ status: 'provisioning', updated_at: new Date() })
      return { ok: true }
    }
    return cancelCreation(envId, user, deps)
  }
  if (row.status !== 'running') return { ok: false, code: 'NOT_RUNNING' }
  await flags.requestCancel(row.id)
  const here = live.get(envId)
  if (here) here.cancel = true
  return { ok: true }
}

/**
 * Marks a `running` row interrupted — only while no leg vouches for it: no heartbeat, or one
 * older than HEARTBEAT_FRESH_MS ("now" from the app's clock, bound). A live leg whose lock was
 * lost keeps its heartbeat fresh and is never interrupted here (ruling P3-31).
 */
async function interrupt(row: CreationRow, note: string, now = Date.now()): Promise<boolean> {
  const steps = row.steps.map((s) =>
    s.status === 'running'
      ? { ...s, status: 'failed' as const, at: new Date(now).toISOString(), note }
      : s
  )
  const n = await withoutFreshHeartbeat(
    db(CREATIONS).where({ id: row.id, status: 'running' }),
    now
  ).update({
    status: 'interrupted',
    steps: JSON.stringify(steps),
    error: `INTERRUPTED: ${note}${row.step ? ` (${row.step})` : ''}`,
    finished_at: new Date(now),
    heartbeat_at: null,
    updated_at: new Date(now)
  })
  if (Number(n) === 0) return false
  // Its job run would otherwise stay `running` in the Jobs tray: the restart sweep skips runs
  // whose process is still in the instance roster (a quick restart after a kill), P3-34.
  if (row.job_run_id != null) await closeJobRun(row.job_run_id, row.environment_id, note)
  return true
}

/** Fails a healed creation's job run (only while it still runs). Never throws. */
async function closeJobRun(jobRunId: number, envId: number, note: string): Promise<void> {
  try {
    const started = (await db('nivaro_job_runs')
      .where({ id: jobRunId })
      .first('started_at')
      .catch(() => undefined)) as { started_at?: Date | string | null } | undefined
    const at = started?.started_at == null ? null : new Date(started.started_at)
    await resumeJobRun(jobRunId, 'deploy', `hub-create-${envId}`, {
      guardRunning: true,
      startedAt: at && Number.isFinite(at.getTime()) ? at : null
    }).fail(new Error(`Creation interrupted: ${note}`))
  } catch {
    // bookkeeping never breaks healing
  }
}

/**
 * A `running` creation no leg vouches for becomes `interrupted`; its step is marked failed and
 * Retry resumes there. A row a leg in this process runs, or whose heartbeat is fresh (a live leg
 * on any process renews it every minute), is never touched (interrupt is heartbeat-gated).
 *
 * Every cron tick (`hub-creation-waits`) also leaves alone a row whose environment lock is held
 * or unreadable. At boot (`ignoreLock`) the lock is not asked (decision 14, ruling P3-33): a
 * killed process's lock outlives it for up to 5 minutes, but its heartbeat stops, and only the
 * heartbeat says whether a leg is alive.
 */
export async function recoverInterruptedCreations(
  deps: Pick<CreationDeps, 'lock'> = { lock: defaultPromoteLock() },
  opts: { ignoreLock?: boolean } = {}
): Promise<number> {
  const rows = (await db(CREATIONS)
    .where({ status: 'running' })
    .select('environment_id')) as Array<{
    environment_id: number
  }>
  let n = 0
  for (const x of rows) {
    const envId = Number(x.environment_id)
    if (live.has(envId)) continue
    if (!opts.ignoreLock && (await deps.lock.held(envId)) !== false) continue
    const row = await readCreationRow(envId)
    if (row?.status === 'running' && (await interrupt(row, 'The Hub restarted during this step')))
      n++
  }
  return n
}

/** When boot recovery runs again: once a heartbeat fresh at boot has had time to go stale. */
export const BOOT_RECOVERY_AGAIN_MS = HEARTBEAT_FRESH_MS + 30_000

/**
 * Boot: recovery now (lock not asked), and once more BOOT_RECOVERY_AGAIN_MS later — a process
 * killed just before this boot may still have a fresh heartbeat now. Answers a cancel for the
 * second pass (the routes call it on close). `later` is for tests.
 */
export function recoverCreationsAtBoot(
  deps: Pick<CreationDeps, 'lock'> = { lock: defaultPromoteLock() },
  o: {
    later?: (fn: () => void, ms: number) => () => void
    onError?: (err: unknown) => void
  } = {}
): () => void {
  const run = () =>
    recoverInterruptedCreations(deps, { ignoreLock: true }).catch((err) => o.onError?.(err))
  void run()
  const later =
    o.later ??
    ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms)
      t.unref?.()
      return () => clearTimeout(t)
    })
  return later(() => void run(), BOOT_RECOVERY_AGAIN_MS)
}

/**
 * Heal on read (ruling P3-33, phase-2 P25's pattern): a `running` creation whose heartbeat is
 * stale and that no leg here runs becomes `interrupted` when it is read, so a Hub with
 * CRON_TICKS=off still shows it and offers Retry. Never throws; a fresh heartbeat is never healed.
 */
export async function healStaleCreation(envId: number): Promise<void> {
  try {
    if (live.has(envId)) return
    const row = await readCreationRow(envId)
    if (row?.status === 'running') await interrupt(row, 'The runner stopped during this step')
  } catch {
    // a read never fails for this
  }
}

/**
 * The 5-minute cron (hub-creation-waits): heals stale running rows, looks at every waiting
 * creation one at a time (a resolved one starts its leg), and checks the name of every
 * environment waiting for a name that no creation walks (phase 3 owns that check). Answers how
 * many moved on. Never throws.
 */
export async function checkWaitingCreations(deps?: CreationDeps): Promise<number> {
  const r = deps ?? defaultCreationDeps()
  let moved = 0
  try {
    await recoverInterruptedCreations({ lock: r.lock })
  } catch {
    // the next tick tries again
  }
  const open = (await db(CREATIONS)
    .whereIn('status', ['waiting', 'queued'])
    .orderBy('id')
    .select('environment_id', 'status')) as Array<{ environment_id: number; status: string }>
  const resolved = resolve(r)
  for (const w of open) {
    const envId = Number(w.environment_id)
    try {
      if (w.status === 'queued') {
        // A leg that found its environment busy at the start (a promotion held it): start it.
        if (live.has(envId) || (await r.lock.held(envId)) !== false) continue
        launchLeg(envId, null, resolved, ['queued'])
        moved++
        continue
      }
      const out = await resumeCreation(envId, { id: '' }, 'check', r)
      if (out.status === 'running') moved++
    } catch {
      // one environment's trouble never stops the others
    }
  }
  const named = (await db(ENVS)
    .where({ status: 'waiting_for_name' })
    .whereNotExists(
      db(CREATIONS)
        .whereRaw('?? = ??', [`${CREATIONS}.environment_id`, `${ENVS}.id`])
        .whereIn('status', OPEN_CREATION_STATUSES as CreationStatus[])
        .select('id')
    )
    .select('id')) as Array<{ id: number }>
  for (const e of named) {
    try {
      if ((await checkEnvironmentNameById(Number(e.id))) === 'ok') moved++
    } catch {
      // next tick
    }
  }
  return moved
}

// ── deletes (routes, Task 10) ────────────────────────────────────────────────

/**
 * Runs `fn` (an app or environment delete) holding every listed environment's lock, so no leg or
 * promotion starts meanwhile. Refused 409 CREATION_RUNNING while a leg runs or holds one of them.
 * Delete the creation rows inside `fn` with deleteCreationRows.
 */
export async function withEnvironmentsQuiet<T>(
  envIds: number[],
  fn: () => Promise<T>,
  deps: Pick<CreationDeps, 'lock'> = { lock: defaultPromoteLock() }
): Promise<T> {
  const held: Array<{ envId: number; token: string }> = []
  try {
    for (const envId of envIds) {
      const token = await deps.lock.take(envId, 'delete')
      if (!token) {
        // A dead leg's lock lives on for up to 5 minutes: its row still heals now (stale
        // heartbeat), and the delete is asked again once the lock is gone.
        await healStaleCreation(envId)
        // X-6b: name the real holder (a creation leg, a promotion or a stack action).
        const r = lockHolderRefusal((await deps.lock.holder?.(envId)) ?? null, {
          code: 'CREATION_RUNNING',
          message:
            'A creation step or a promotion is running on this environment — wait for it or cancel it.'
        })
        throw new CreationError(r.code, r.message, 409)
      }
      held.push({ envId, token })
    }
    // We hold every lock: a `running` row here belongs to a runner that died — unless its leg
    // lost the lock and still runs (fresh heartbeat): then refused, the row left alone.
    for (const envId of envIds) {
      const busy = () =>
        new CreationError(
          'CREATION_RUNNING',
          'A creation step is running on this environment — wait for it or cancel it.',
          409
        )
      if (live.has(envId)) throw busy()
      const row = await readCreationRow(envId)
      if (row?.status !== 'running') continue
      if (await interrupt(row, 'The runner stopped during this step')) continue
      if ((await readCreationRow(envId))?.status === 'running') throw busy()
    }
    return await fn()
  } finally {
    for (const h of held) await deps.lock.release(h.envId, h.token)
  }
}

/** Deletes the creation rows of these environments (inside the delete's transaction). */
export async function deleteCreationRows(k: typeof db, envIds: number[]): Promise<number> {
  if (!envIds.length) return 0
  return Number(await k(CREATIONS).whereIn('environment_id', envIds).del())
}

// ── read ─────────────────────────────────────────────────────────────────────

export interface CreationView {
  id: number
  app_id: number
  app_key: string
  /** Where the app goes (gap `create`): its kind and the target's, driver's or deployment's name. */
  target: { kind: 'gitlab' | 'docker' | 'shared' | 'github'; name: string | null }
  environment_id: number
  env_key: string
  status: CreationStatus
  step: string | null
  waiting_for: CreationWait | null
  /** When the operator last said the app's deploy key is installed (null: not yet, or refused since). */
  operator_installed_at: string | null
  steps: CreationStepState[]
  error: string | null
  version: string
  first_admin: CreationRow['first_admin']
  job_run_id: number | null
  started_by: string | null
  created_at: string | null
  updated_at: string | null
  finished_at: string | null
  hostname: string | null
  base_url: string | null
  redirect_uri: string | null
  /** Ids and names only: project, driver, placement, component, database, variable outcomes. */
  made: Omit<CreationMade, 'planned'>
  log: JobLogLine[]
  /** The DBA checklist while a requested database is not ready. */
  checklist: ChecklistItem[] | null
  /** The DNS / certificate ticket on a target that makes names by hand. */
  ticket: string | null
  /**
   * The environment's database, masked, with its server's TLS (never the server's login): an
   * owner's connection always uses the server's TLS (ruling P3-24), so the form shows it read-only.
   */
  database: (HubDatabase & { server_tls: CreationServerTls | null }) | null
  /** What the operator installs on the swarm manager for this app (template README). */
  deploy_key: {
    keyid: string
    public_key: string
    authorized_keys: string
    key_conf: string
    key_conf_path: string
  } | null
}

/** The TLS settings of a database's server, as an owner may see them (no host login). */
export interface CreationServerTls {
  ssl_mode: HubDbServerRow['ssl_mode']
  trust_server_cert: boolean
}

export async function readCreation(envId: number): Promise<CreationView | null> {
  await healStaleCreation(envId)
  const row = await readCreationRow(envId)
  if (!row) return null
  const app = (await db(APPS).where({ id: row.app_id }).first('id', 'key', 'target_id')) as
    | { id: number; key: string; target_id: number | null }
    | undefined
  const env = (await db(ENVS).where({ id: envId }).first('key', 'base_url', 'hostnames')) as
    | { key: string; base_url: string; hostnames: string | null }
    | undefined
  const kind = creationKind(row.made)
  const target =
    kind === 'gitlab' && app?.target_id != null ? await getTargetRow(Number(app.target_id)) : null
  const t = row.made.target
  const driver = t?.kind === 'docker' ? await getDriver(t.driver_id) : null
  const dockerDriver = driver?.kind === 'docker' ? driver : null
  const sharedDep = t?.kind === 'shared' ? await getShared(t.shared_id) : null
  const shared = app ? await appMade(Number(app.id)) : {}
  const made: Omit<CreationMade, 'planned'> = { ...row.made, ...shared }
  delete (made as CreationMade).planned
  const hostname = row.made.planned?.hostname ?? null
  const baseUrl = env?.base_url ?? row.made.planned?.base_url ?? null

  const dbId = row.made.database_id
  const found = dbId ? await getDatabase(dbId) : null
  const server = found?.server_id != null ? await getServerRow(found.server_id) : null
  const database: CreationView['database'] = found
    ? {
        ...found,
        server_tls: server
          ? { ssl_mode: server.ssl_mode, trust_server_cert: server.trust_server_cert }
          : null
      }
    : null
  let checklist: ChecklistItem[] | null = null
  if (
    database &&
    server &&
    !database.created_by_hub &&
    !database.adopted &&
    database.status !== 'ready' &&
    database.login_name
  )
    checklist = dbaChecklist(publicServer(server), database.database_name, database.login_name)
  let ticket: string | null = null
  const naming =
    target?.config ?? (dockerDriver ? namingForDocker(dockerDriver.config, hostname) : null)
  if (naming?.dns_mode === 'manual' && hostname) {
    try {
      ticket = manualTicket(naming, hostname)
    } catch {
      ticket = null
    }
  }
  let deployKey: CreationView['deploy_key'] = null
  if (shared.deploy_key?.pushed && app && target) {
    const siblings = (await db(ENVS)
      .where({ app_id: app.id })
      .orderBy('position')
      .select('key', 'hostnames')) as Array<{ key: string; hostnames: string | null }>
    const hosts: string[] = []
    const stacks: string[] = []
    for (const s of siblings) {
      try {
        stacks.push(stackName(app.key, s.key))
      } catch {
        // not a creatable key: no stack for it
      }
      try {
        const list = JSON.parse(String(s.hostnames ?? '[]'))
        if (Array.isArray(list)) for (const h of list) if (typeof h === 'string') hosts.push(h)
      } catch {
        // no names
      }
    }
    try {
      deployKey = {
        keyid: shared.deploy_key.keyid,
        public_key: shared.deploy_key.public_key,
        ...managerLines({
          appKey: app.key,
          publicKey: shared.deploy_key.public_key,
          keyid: shared.deploy_key.keyid,
          stacks,
          hosts,
          network: target.config.proxy_network,
          image: hubImage()
        })
      }
    } catch {
      deployKey = null
    }
  }
  let log: JobLogLine[] = []
  if (row.job_run_id != null) {
    try {
      log = await readJobLog(row.job_run_id)
    } catch {
      log = []
    }
  }
  return {
    id: row.id,
    app_id: row.app_id,
    app_key: app?.key ?? '',
    target: {
      kind,
      name:
        target?.name ??
        dockerDriver?.name ??
        sharedDep?.name ??
        (t?.kind === 'github' ? ((await getGithubTarget(t.target_id))?.name ?? null) : null)
    },
    environment_id: row.environment_id,
    env_key: env?.key ?? '',
    status: row.status,
    step: row.step,
    waiting_for: row.waiting_for,
    operator_installed_at: shared.operator_ack?.at ?? null,
    steps: row.steps,
    error: row.error,
    version: row.version,
    first_admin: row.first_admin,
    job_run_id: row.job_run_id,
    started_by: row.started_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    finished_at: row.finished_at,
    hostname,
    base_url: baseUrl,
    redirect_uri: baseUrl ? redirectUriFor(baseUrl) : null,
    made,
    log,
    checklist,
    ticket,
    database,
    deploy_key: deployKey
  }
}
