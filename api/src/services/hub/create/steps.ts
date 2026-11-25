// The eight creation steps of one environment (phase 3, Task 9): database → repository →
// variables → config → deploy → name → link → admin. Each step is idempotent (a retry re-runs
// the step that failed and everything after it), records a short note and keeps what it made in
// the creation's `made` (ids and names only). A step either finishes (`done`), waits for
// something a person does (`waiting`: a DBA's database, a hand-made DNS name) or throws.
//
// Secrets: the database password, the hub token, the OIDC client secret, the generated session /
// encryption keys, the GitLab token and the app's deploy key are opened or made in memory only
// for the call that sends them, and every one of them (and its base64) is added to ctx.secrets so
// the runner scrubs any text it stores or logs. No step puts a value in a note, a log line or an
// error.
//
// The deploy repository (rulings P3-7, P3-9, P3-16): forked with the description marker
// `nivaro-hub creation <creationId>`; a project already at the path is adopted only when its id
// is the one this app recorded or its description carries the marker of one of this app's
// creations. Its CI configuration path is the Hub-owned template at the pinned ref and nobody
// may set pipeline variables by hand — set at fork and checked again (fail closed) on every leg,
// before every deploy and on every target change (syncTargetApps).
import { db } from '../../../db/index.js'
import { runInBackgroundPool } from '../../../db/pool-context.js'
import type { GitCtx } from '../../gitlab-client.js'
import { getApp } from '../../io-holder.js'
import { createComponent, listComponents, readComponent } from '../components.js'
import { connectionUrl, type HubDbEngine } from '../db/connection.js'
import {
  checkDatabase,
  getDatabase,
  type HubDatabase,
  openDatabaseConnection,
  provisionDatabase
} from '../db/databases.js'
import { generateHexSecret } from '../db/names.js'
import { createDriver, createPlacement, getDriver, getPlacement, listDrivers } from '../drivers.js'
import {
  findPipeline,
  GitlabWriteError,
  type HubJob,
  jobNamed,
  type PollOptions,
  retryJob,
  runDeployJob,
  type Sleep,
  waitJob
} from '../gitlab-write.js'
import { pinText } from '../registry.js'
import { openSecret } from '../secrets.js'
import type { readEnvironmentStatus } from '../status.js'
import {
  ciConfigPath,
  HUB_APP_SECRET_VARS,
  isCreatableKey,
  KEEP_ONCE_VARS,
  renderAppCi,
  renderAppEnv
} from './app-config.js'
import { generateDeployKey } from './deploy-key.js'
import {
  commitFiles,
  configureProject,
  currentUser,
  ensureBranch,
  finishFork,
  forkProject,
  type HubProjectSettings,
  jobLogTail,
  projectExists,
  protectBranch,
  pushDeployVariables,
  upsertVariable
} from './gitlab-provision.js'
import { hasKeyNotInstalledLine, KEY_NOT_INSTALLED } from './key-marker.js'
import type { requestFirstAdmin } from './link-client.js'
import type { checkName } from './name-check.js'
import {
  appMade,
  CREATE_LOCK_RENEW_MS,
  type CreationMade,
  type CreationRow,
  type CreationWait,
  creationsOfApp,
  hubCreateRepoLockKey,
  type KeyedLock,
  saveAppMade
} from './store.js'
import { getTargetRow, type HubTargetRow, targetCtx } from './targets.js'
import { stepTemplate } from './template-step.js'
import type { CreationStepKey } from './types.js'

// ── shapes ───────────────────────────────────────────────────────────────────

export interface StepApp {
  id: number
  key: string
  name: string
  target_id: number | null
  deploy_project: string | null
  oidc: { issuer: string; client_id: string }
  /** Sealed. */
  oidc_secret: string | null
}

export interface StepEnv {
  id: number
  app_id: number
  key: string
  position: number
  status: string
  base_url: string
  hostnames: string[]
  /** Sealed. */
  hub_token: string | null
  db_ref: string | null
  placement_id: number | null
}

/** What the steps call out to; the runner fills defaults, tests pass fakes. */
export interface StepDeps {
  repoLock: KeyedLock
  link: { requestFirstAdmin: typeof requestFirstAdmin }
  checkName: typeof checkName
  status: typeof readEnvironmentStatus
  sleep: Sleep
  now: () => number
}

/**
 * What every step of every kind gets (gap `create`): a Docker or shared creation has no GitLab
 * target, so the steps they share with the GitLab kind (database, name, link, admin) take this.
 */
export interface BaseStepContext {
  creation: CreationRow
  app: StepApp
  env: StepEnv
  /** How the environment's name is made: by hand (a ticket, the Hub waits) or automatically. */
  dnsMode: 'automatic' | 'manual'
  /** The creation's own `made`; persisted by saveMade(). */
  made: CreationMade
  saveMade(): Promise<void>
  /** Steps already finished in this creation (the config step's sha is read from there). */
  doneSha(key: CreationStepKey): string | null
  log(line: string, level?: 'info' | 'warn' | 'error'): void
  /** Every secret value opened or made in this leg: the runner scrubs stored text of them. */
  secrets: Set<string>
  /** Aborted when the leg loses its lock: every wait ends at once (ruling P3-31). */
  signal?: AbortSignal
  deps: StepDeps
}

/** A GitLab creation's steps: the target, and its token's GitLab user. */
export interface StepContext extends BaseStepContext {
  target: HubTargetRow
  /** The GitLab user id of the target's token (GET /user), read once per leg. */
  tokenUserId(): Promise<number>
}

export type StepResult =
  | { status: 'done'; note: string; sha?: string }
  | { status: 'waiting'; on: CreationWait; note: string }

/** A step refusal with its code (the message never carries a secret). */
export class StepFailure extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'StepFailure'
    this.code = code
  }
}

const done = (note: string, sha?: string): StepResult =>
  sha ? { status: 'done', note, sha } : { status: 'done', note }

/** Remembers `value` (and its base64) as a secret of this leg; answers it. */
export function secret(ctx: BaseStepContext, value: string | null | undefined): string {
  if (!value) return ''
  ctx.secrets.add(value)
  ctx.secrets.add(Buffer.from(value).toString('base64'))
  return value
}

const b64 = (v: string) => Buffer.from(v).toString('base64')

/** Lets I/O run between polls even when `sleep` is a fake that resolves at once. */
const yieldToIo = () => new Promise<void>((resolve) => setImmediate(resolve))

// ── polling knobs ────────────────────────────────────────────────────────────

export const NAME_POLLS = 20
export const NAME_POLL_MS = 15_000
export const LINK_POLLS = 10
export const LINK_POLL_MS = 15_000
export const ADMIN_POLLS = 20
export const ADMIN_POLL_MS = 15_000
/** HUB_LINK_MISSING right after a deploy (the old app may still answer) is retried this often. */
export const ADMIN_EARLY_MISSING_POLLS = 4
export const DEPLOY_MINUTES = 60
export const REPO_LOCK_POLL_MS = 2_000
export const REPO_LOCK_TRIES = 600

/** first-admin answers that mean "not yet" (P3-4): wait and ask again. */
const ADMIN_RETRY = new Set([
  'MAINTENANCE',
  'TIMEOUT',
  'UNREACHABLE',
  'HTTP_502',
  'HTTP_503',
  'HTTP_504'
])

export function projectSettings(target: HubTargetRow): HubProjectSettings {
  return {
    ci_config_path: ciConfigPath(target.config),
    ci_pipeline_variables_minimum_override_role: 'no_one_allowed',
    restrict_user_defined_variables: true
  }
}

/**
 * The description a creation's fork carries (ruling P3-23): its id and its own unguessable nonce
 * (made at start, kept only in the creation row, never answered). A project is adopted by this
 * mark only when its description is EXACTLY one of this app's marks and the Hub's own GitLab user
 * made it; a Developer of the namespace can plant a project at the path but not the nonce.
 */
export const creationMarker = (creationId: number, nonce: string) =>
  `nivaro-hub creation ${creationId} ${nonce}`

/** A per-leg memo of the target token's GitLab user id (GET /user through the write client). */
export function tokenUserMemo(target: HubTargetRow): () => Promise<number> {
  let id: Promise<number> | null = null
  return () => {
    id ??= currentUser(targetCtx(target)).then((u) => {
      if (!Number.isInteger(u.id) || u.id <= 0)
        throw new StepFailure('GITLAB_BAD_ANSWER', 'GitLab named no user for the target token.')
      return u.id
    })
    return id
  }
}

function projectCtx(ctx: StepContext): GitCtx {
  const id = ctx.made.project_id
  if (!id)
    throw new StepFailure('PROJECT_MISSING', 'The deploy repository is not recorded yet; retry.')
  return { ...targetCtx(ctx.target, String(id)), ref: null }
}

export function dbIdOf(ctx: BaseStepContext): number | null {
  if (ctx.made.database_id) return ctx.made.database_id
  const m = /^hub-db:(\d+)$/.exec(String(ctx.env.db_ref ?? ''))
  return m ? Number(m[1]) : null
}

// ── database ─────────────────────────────────────────────────────────────────

/** The environment's database row (masked), or a failure. */
export async function databaseOf(ctx: BaseStepContext): Promise<HubDatabase> {
  const id = dbIdOf(ctx)
  if (!id) throw new StepFailure('DATABASE_MISSING', 'The environment has no database recorded.')
  const d = await getDatabase(id)
  if (!d) throw new StepFailure('DATABASE_MISSING', 'The environment’s database record is gone.')
  if (d.status === 'dropping')
    throw new StepFailure('DATABASE_DROPPING', `${d.database_name} is being dropped.`)
  return d
}

const isManual = (d: HubDatabase) => !d.created_by_hub && !d.adopted

function manualWaitNote(d: HubDatabase): string {
  if (d.last_check?.text)
    return `Waiting for ${d.database_name}: ${d.last_check.text}`.slice(0, 300)
  return `Waiting for the DBA to create ${d.database_name} and enter its connection.`
}

export async function stepDatabase(ctx: BaseStepContext): Promise<StepResult> {
  const d = await databaseOf(ctx)
  if (d.status === 'ready') return done(`${d.database_name} is ready.`)
  if (d.created_by_hub && !d.adopted) {
    const made = await provisionDatabase(d.id, (line) => ctx.log(line))
    return done(`${made.database_name} created and ready.`)
  }
  if (isManual(d)) return { status: 'waiting', on: 'database', note: manualWaitNote(d) }
  throw new StepFailure('DATABASE_NOT_READY', `${d.database_name} is ${d.status}, not ready.`)
}

/**
 * "Check now" for a database wait: a DBA connection already entered is checked again (it may be
 * empty by now); then the row decides. Never provisions.
 */
export async function checkDatabaseWait(
  ctx: BaseStepContext
): Promise<{ resolved: boolean; note: string }> {
  let d = await databaseOf(ctx)
  if (d.status !== 'ready' && isManual(d) && d.connection) {
    try {
      await checkDatabase(d.id)
    } catch {
      // the stored check says why; the row decides below
    }
    d = await databaseOf(ctx)
  }
  return d.status === 'ready'
    ? { resolved: true, note: `${d.database_name} is ready.` }
    : { resolved: false, note: manualWaitNote(d) }
}

// ── repository ───────────────────────────────────────────────────────────────

/** Runs `fn` holding the app's repository lock; another leg of the app waits its turn. */
async function withRepoLock<T>(ctx: StepContext, fn: () => Promise<T>): Promise<T> {
  const key = hubCreateRepoLockKey(ctx.app.id)
  const lock = ctx.deps.repoLock
  for (let i = 0; ; i++) {
    const token = await lock.take(key)
    if (token) {
      const timer = setInterval(() => {
        void lock.renew(key, token).catch(() => undefined)
      }, CREATE_LOCK_RENEW_MS)
      timer.unref?.()
      try {
        return await fn()
      } finally {
        clearInterval(timer)
        await lock.release(key, token)
      }
    }
    if (i === 0) ctx.log('Another environment of this app is setting up the repository: waiting')
    if (i >= REPO_LOCK_TRIES)
      throw new StepFailure(
        'REPOSITORY_BUSY',
        'Another environment of this app held the deploy repository too long; retry.'
      )
    await ctx.deps.sleep(REPO_LOCK_POLL_MS)
    await yieldToIo()
  }
}

/**
 * Fork (or adopt the app's own fork of) the template, make its CI configuration the pinned
 * template, give the app its deploy key and record the app's driver. Under the app's
 * repository lock, so two environments never fork twice.
 */
async function stepRepository(ctx: StepContext): Promise<StepResult> {
  return withRepoLock(ctx, async () => {
    const { app, target } = ctx
    const c = target.config
    const base = targetCtx(target)
    secret(ctx, base.token)
    const shared = await appMade(app.id)
    const ownNonce = ctx.creation.made.planned?.nonce
    if (!ownNonce)
      throw new StepFailure('PLAN_MISSING', 'The creation has no repository mark; start it again.')
    const marks = new Set<string>()
    for (const x of await creationsOfApp(app.id))
      if (x.made.planned?.nonce) marks.add(creationMarker(x.id, x.made.planned.nonce))
    for (const m of marks) secret(ctx, m)
    const ours = async (p: { id: number; description: string; creator_id: number | null }) => {
      if (shared.project_id !== undefined && p.id === shared.project_id) return true
      if (!marks.has(p.description.trim())) return false
      return p.creator_id !== null && p.creator_id === (await ctx.tokenUserId())
    }
    const repoPath = `${app.key}-deploy`
    const fullPath = `${c.namespace}/${repoPath}`

    let project: { id: number; path_with_namespace: string } | null = null
    let how = 'adopted'
    // 1. The project this app already recorded (by id, from an earlier fork or look).
    if (shared.project_id) {
      const p = await projectExists(base, String(shared.project_id))
      if (p) {
        if (!(await ours(p)))
          throw new StepFailure(
            'PROJECT_EXISTS',
            `GitLab project ${p.path_with_namespace || shared.project_id} is not this app’s deploy repository.`
          )
        project = p
      }
    }
    // 2. A project at the path: ours only by its id, or by our exact mark AND our token's user.
    if (!project) {
      const p = await projectExists(base, fullPath)
      if (p) {
        if (!(await ours(p)))
          throw new StepFailure(
            'PROJECT_EXISTS',
            `GitLab already has a project ${fullPath} the Hub did not make for this app.`
          )
        project = p
      }
    }
    if (project) {
      // Resumes an unfinished fork (import, fork link); a finished one answers at once.
      const settled = await finishFork({ ...base, project: String(project.id) }, project.id, {
        sleep: ctx.deps.sleep,
        now: ctx.deps.now
      })
      project = {
        id: project.id,
        path_with_namespace: settled.path_with_namespace || project.path_with_namespace
      }
    } else {
      how = 'forked'
      try {
        // The GitLab name is the path too: an app name may hold characters GitLab refuses.
        project = await forkProject(base, c.template_project, c.namespace, repoPath, repoPath, {
          description: creationMarker(ctx.creation.id, ownNonce),
          sleep: ctx.deps.sleep,
          now: ctx.deps.now
        })
      } catch (err) {
        // GitLab made the project before the fork failed: record it so a retry resumes it.
        const made = (err as { project?: { id: number; path_with_namespace: string } }).project
        if (made?.id) {
          await saveAppMade(app.id, {
            project_id: made.id,
            project_path: made.path_with_namespace || fullPath
          })
          ctx.made.project_id = made.id
          ctx.made.project_path = made.path_with_namespace || fullPath
        }
        throw err
      }
    }
    const path = project.path_with_namespace || fullPath
    await saveAppMade(app.id, { project_id: project.id, project_path: path })
    ctx.made.project_id = project.id
    ctx.made.project_path = path
    await db('nivaro_hub_apps')
      .where({ id: app.id })
      .update({ deploy_project: path, updated_at: new Date() })
    ctx.log(`Deploy repository ${path} ${how}`)

    const pctx = projectCtx(ctx)
    const cfg = await configureProject(pctx, projectSettings(target))
    ctx.log(
      cfg.changed
        ? `CI configuration set to the template at ${c.template_ref}; pipeline variables locked`
        : 'CI configuration already the template at its pinned ref'
    )

    // The app's own deploy key: made once, pushed once, never stored.
    const key = (await appMade(app.id)).deploy_key
    if (!key?.pushed) {
      const pair = generateDeployKey(`nivaro-hub-${app.key}`)
      secret(ctx, pair.privateKey)
      const record = { public_key: pair.publicKey, keyid: pair.keyid, pushed: false }
      await saveAppMade(app.id, { deploy_key: record })
      await upsertVariable(pctx, {
        key: 'DEPLOY_SSH_KEY',
        value: b64(pair.privateKey),
        scope: '*',
        masked: true,
        protected: true
      })
      await saveAppMade(app.id, { deploy_key: { ...record, pushed: true } })
      ctx.made.deploy_key = { ...record, pushed: true }
      ctx.log(`Deploy key made (${pair.keyid}): install it on the swarm manager`)
    }

    let driverId = shared.driver_id
    if (!driverId || !(await getDriver(driverId)))
      driverId = (await driverFor(c.api, path)) ?? undefined
    if (driverId) {
      await saveAppMade(app.id, { driver_id: driverId })
    } else {
      const driver = await createDriver({
        kind: 'gitlab',
        name: `${app.key} deploy repository`,
        config: {
          api: c.api,
          project: path,
          branch: 'main',
          pin_file: c.pin_file,
          deploy_job: c.deploy_job
        },
        // The driver's own copy of the target's sealed token.
        secret: target.secret
      })
      driverId = driver.id
      await saveAppMade(app.id, { driver_id: driverId })
      ctx.log(`Driver ${driver.name} recorded`)
    }
    ctx.made.driver_id = driverId
    return done(`${path} ${how}; CI configuration pinned to ${c.template_ref}.`)
  })
}

const originOf = (raw: string) => {
  try {
    return new URL(raw).origin
  } catch {
    return raw
  }
}

/** The driver already recorded for this deploy repository (same GitLab, same project), if any. */
async function driverFor(api: string, project: string): Promise<number | null> {
  const hit = (await listDrivers()).find(
    (d) =>
      d.kind === 'gitlab' &&
      d.config?.project === project &&
      originOf(String(d.config?.api ?? '')) === originOf(api)
  )
  return hit ? hit.id : null
}

/**
 * A dedicated placement of `driverId` for `branch` that no other environment uses (one this
 * environment's earlier try made before it could record it), if any.
 */
async function placementFor(
  driverId: number,
  branch: string,
  envId: number
): Promise<number | null> {
  const rows = (await db('nivaro_hub_placements')
    .where({ driver_id: driverId, kind: 'dedicated' })
    .orderBy('id')
    .select('id', 'target')) as Array<{ id: number; target: unknown }>
  for (const r of rows) {
    let t: { branch?: unknown } = {}
    try {
      t = (typeof r.target === 'string' ? JSON.parse(r.target) : r.target) ?? {}
    } catch {
      t = {}
    }
    if (t.branch !== branch) continue
    const user = (await db('nivaro_hub_environments')
      .where({ placement_id: r.id })
      .whereNot({ id: envId })
      .first('id')) as { id: number } | undefined
    if (!user) return Number(r.id)
  }
  return null
}

// ── variables ────────────────────────────────────────────────────────────────

async function stepVariables(ctx: StepContext): Promise<StepResult> {
  const pctx = projectCtx(ctx)
  secret(ctx, pctx.token)
  const results: Record<string, string> = {}
  for (const r of await pushDeployVariables(pctx, ctx.target.config)) results[r.key] = r.result

  const dbId = dbIdOf(ctx)
  if (!dbId) throw new StepFailure('DATABASE_MISSING', 'The environment has no database recorded.')
  const conn = await openDatabaseConnection(dbId)
  secret(ctx, conn.password)
  const url = secret(ctx, connectionUrl(conn))
  const hubToken = secret(ctx, openSecret(ctx.env.hub_token))
  const oidc = secret(ctx, openSecret(ctx.app.oidc_secret))
  if (!hubToken) throw new StepFailure('HUB_TOKEN_MISSING', 'The environment has no hub token.')
  if (!oidc) throw new StepFailure('OIDC_SECRET_MISSING', 'The app has no sign-in client secret.')
  // Made in memory only; a retry never replaces the first (KEEP_ONCE_VARS).
  const values: Record<string, string> = {
    NIVARO_DB_URL_B64: url,
    NIVARO_HUB_TOKEN_B64: hubToken,
    NIVARO_SESSION_SECRET_B64: secret(ctx, generateHexSecret(32)),
    NIVARO_ENCRYPTION_KEY_B64: secret(ctx, generateHexSecret(32)),
    NIVARO_OIDC_CLIENT_SECRET_B64: oidc
  }
  for (const key of HUB_APP_SECRET_VARS) {
    const value = b64(values[key])
    secret(ctx, value)
    results[key] = await upsertVariable(
      pctx,
      { key, value, scope: ctx.env.key, masked: true, protected: true },
      { keepExisting: KEEP_ONCE_VARS.includes(key) }
    )
  }
  ctx.made.variables = results
  await ctx.saveMade()
  const line = Object.entries(results)
    .map(([k, r]) => `${k} ${r}`)
    .join(', ')
  ctx.log(`CI variables: ${line}`)
  return done(`CI variables set for ${ctx.env.key} (${line}).`)
}

// ── config ───────────────────────────────────────────────────────────────────

async function stepConfig(ctx: StepContext): Promise<StepResult> {
  const { app, env, target } = ctx
  const c = target.config
  const planned = ctx.made.planned
  if (!planned) throw new StepFailure('PLAN_MISSING', 'The creation has no planned settings.')
  if (!/^sha256:[0-9a-f]{64}$/.test(planned.digest))
    throw new StepFailure('IMAGE_NO_DIGEST', 'The planned image has no digest.')
  if (!isCreatableKey(env.key))
    throw new StepFailure('BAD_ENV_KEY', 'The environment key is not a creatable key.')
  const driverId = ctx.made.driver_id ?? (await appMade(app.id)).driver_id
  if (!driverId) throw new StepFailure('DRIVER_MISSING', 'The app has no driver recorded yet.')
  const d = await databaseOf(ctx)
  const pctx = projectCtx(ctx)

  // The branch is the environment key: app.env's ENV_KEY must equal it (deploy.sh refuses else).
  const branch = env.key
  // Protected before it exists: nobody can push to the name in between.
  await protectBranch(pctx, branch)
  const made = await ensureBranch(pctx, branch, 'main')
  const appEnv = renderAppEnv({
    app: { key: app.key, oidc: app.oidc },
    envKey: branch,
    hostname: planned.hostname,
    baseUrl: planned.base_url,
    hubUrl: planned.hub_url,
    engine: d.engine as HubDbEngine,
    target: c
  })
  const files = [
    { path: '.hub/app.env', content: appEnv },
    {
      path: c.pin_file,
      content: pinText(ctx.creation.version, planned.digest, planned.slim_digest)
    },
    { path: '.gitlab-ci.yml', content: renderAppCi(c) }
  ]
  const commit = await commitFiles(
    pctx,
    branch,
    files,
    // The subject is exactly `nivaro <version>`: phase-2 promotion finds a source commit by
    // that subject (sourceSubjectRe, anchored at the end). What made it goes in the body.
    `nivaro ${ctx.creation.version}\n\nhub: create ${app.key}/${env.key}`
  )
  ctx.log(
    `Branch ${branch} ${made}, protected; ${commit.changed ? `committed ${commit.sha.slice(0, 8)}` : 'settings already committed'}`
  )

  // The environment becomes an ordinary phase-2 environment: its placement + api component.
  let placementId = ctx.made.placement_id
  if (!placementId || !(await getPlacement(placementId)))
    // A crash between create and record left one behind: use it, never a second.
    placementId = (await placementFor(driverId, branch, env.id)) ?? undefined
  if (!placementId) {
    const p = await createPlacement({ kind: 'dedicated', driver_id: driverId, target: { branch } })
    placementId = p.id
  }
  if (ctx.made.placement_id !== placementId) {
    ctx.made.placement_id = placementId
    await ctx.saveMade()
  }
  await db('nivaro_hub_environments')
    .where({ id: env.id })
    .update({ placement_id: placementId, updated_at: new Date() })
  ctx.env.placement_id = placementId
  if (!ctx.made.component_id || !(await readComponent(ctx.made.component_id))) {
    const r = await createComponent(placementId, {
      position: 1,
      name: 'api',
      kind: 'api',
      driver_id: driverId,
      source_branch: planned.source_branch,
      target_branch: branch,
      before_job: null,
      deploy_job: null,
      verify_url: `${planned.base_url}/api/version`,
      verify_field: 'version'
    })
    if (r.ok) ctx.made.component_id = Number(r.row.id)
    else {
      const existing = (await listComponents(placementId)).find((x) => x.position === 1 && x.id)
      if (!existing?.id) throw new StepFailure(r.code, r.message)
      ctx.made.component_id = existing.id
    }
    await ctx.saveMade()
  }
  return done(
    `${branch}: settings and pin for ${ctx.creation.version} committed (${commit.sha.slice(0, 8)}).`,
    commit.sha
  )
}

// ── deploy ───────────────────────────────────────────────────────────────────

export { hasKeyNotInstalledLine, KEY_NOT_INSTALLED }

export const OPERATOR_NOTE =
  'Install this app’s deploy key on the swarm manager (the authorized_keys line and key.conf shown here), then press Installed.'

/** The newest deploy job of the pipeline for `sha` on `branch`, or null. */
async function deployJobOf(ctx: StepContext, pctx: GitCtx, sha: string) {
  const p = await findPipeline(pctx, ctx.env.key, sha)
  return p ? jobNamed(pctx, p.id, ctx.target.config.deploy_job) : null
}

/** Retries a finished deploy job once and waits for it; anything but success is DEPLOY_FAILED. */
async function rerunJob(
  ctx: StepContext,
  pctx: GitCtx,
  jobId: number
): Promise<{ web_url: string; id: number }> {
  const poll: PollOptions = { sleep: ctx.deps.sleep, now: ctx.deps.now, signal: ctx.signal }
  const again = await retryJob(pctx, jobId)
  ctx.log(`${ctx.target.config.deploy_job}: ran again (${again.web_url || `job ${again.id}`})`)
  const end = await waitJob(pctx, again.id, {
    ...poll,
    minutes: DEPLOY_MINUTES,
    onStatus: (st) => ctx.log(`${ctx.target.config.deploy_job}: ${st}`)
  })
  if (end.status !== 'success')
    throw new GitlabWriteError(
      'DEPLOY_FAILED',
      `${ctx.target.config.deploy_job} ${end.status} — the deploy script rolled back (${end.web_url})`,
      { step: 'deployOnce', webUrl: end.web_url || undefined }
    )
  return { id: end.id, web_url: end.web_url }
}

/**
 * Runs the deploy job for `sha` once: a job that already failed (the deploy that ran on the push
 * before the key was installed, or an earlier try) is retried once and waited for; anything else
 * goes through runDeployJob (already succeeded / running on its own / manual).
 */
async function deployOnce(
  ctx: StepContext,
  pctx: GitCtx,
  sha: string
): Promise<{ web_url: string; id: number }> {
  const poll: PollOptions = { sleep: ctx.deps.sleep, now: ctx.deps.now, signal: ctx.signal }
  const job = await deployJobOf(ctx, pctx, sha)
  if (job && (job.status === 'failed' || job.status === 'canceled'))
    return rerunJob(ctx, pctx, job.id)
  const out = await runDeployJob(pctx, ctx.env.key, sha, {
    ...poll,
    deploy: ctx.target.config.deploy_job,
    minutes: DEPLOY_MINUTES,
    onEvent: (e) => ctx.log(e.message)
  })
  return { id: out.job.id, web_url: out.job.web_url }
}

/**
 * The deploy job that refused this app's key: `err` is a failed deploy and the newest deploy job
 * failed with the marker line in its log. Null for any other failure (a read that fails says no).
 */
async function keyRefusal(
  err: unknown,
  ctx: StepContext,
  pctx: GitCtx,
  sha: string
): Promise<HubJob | null> {
  if (!(err instanceof GitlabWriteError) || err.code !== 'DEPLOY_FAILED') return null
  try {
    const job = await deployJobOf(ctx, pctx, sha)
    if (job?.status !== 'failed') return null
    return hasKeyNotInstalledLine(await jobLogTail(pctx, job.id)) ? job : null
  } catch {
    return null
  }
}

/**
 * The job started before `at` (both readable times); unknown = no. `started_at` is GitLab's clock
 * and `at` the Hub's: a skew between them can call a job that started just before the press
 * "after" (it then waits again, as before this check) or one just after it "before" (one extra
 * run of a job that may already hold the key). Either way at most one retry per deploy step, and
 * every further run needs another Installed press.
 */
function startedBefore(job: HubJob, at: string): boolean {
  const started = Date.parse(job.started_at ?? '')
  const pressed = Date.parse(at)
  return Number.isFinite(started) && Number.isFinite(pressed) && started < pressed
}

/** Back to the operator wait: the press is spent (the manager refused the key). */
async function backToOperator(ctx: StepContext): Promise<StepResult> {
  await saveAppMade(ctx.app.id, { operator_ack: null })
  ctx.log(`${KEY_NOT_INSTALLED}: the swarm manager refused this app's deploy key`, 'warn')
  return {
    status: 'waiting',
    on: 'operator',
    note: `The swarm manager refused this app’s deploy key (not installed, or the stack is bound to another key). ${OPERATOR_NOTE}`
  }
}

/**
 * Ruling P3-22: the deploy waits for the operator (waiting_for 'operator') until someone says the
 * app's deploy key and key.conf are installed on the swarm manager (confirmOperatorInstalled).
 * Then it runs the deploy once. A deploy refused with the marker line NIVARO_HUB_KEY_NOT_INSTALLED
 * (and only that) goes back to the operator wait; any other failure fails the step. No timeout,
 * no automatic re-deploy. One exception: a refusing job that STARTED BEFORE the press (the push's
 * own deploy, still running when Installed was pressed) is run once more before waiting again.
 */
async function stepDeploy(ctx: StepContext): Promise<StepResult> {
  const sha = ctx.doneSha('config')
  if (!sha) throw new StepFailure('COMMIT_MISSING', 'The config step recorded no commit.')
  const ack = (await appMade(ctx.app.id)).operator_ack
  if (!ack) return { status: 'waiting', on: 'operator', note: OPERATOR_NOTE }
  const pctx = projectCtx(ctx)
  // Fail closed: the deploy runs only with the pinned template as the CI configuration.
  await configureProject(pctx, projectSettings(ctx.target))
  let job: { id: number; web_url: string }
  try {
    job = await deployOnce(ctx, pctx, sha)
  } catch (err) {
    const refused = await keyRefusal(err, ctx, pctx, sha)
    if (!refused) throw err
    if (!startedBefore(refused, ack.at)) return backToOperator(ctx)
    ctx.log(
      `${ctx.target.config.deploy_job}: refused for the key, but it started before Installed was pressed — running it once more`
    )
    try {
      job = await rerunJob(ctx, pctx, refused.id)
    } catch (again) {
      if (await keyRefusal(again, ctx, pctx, sha)) return backToOperator(ctx)
      throw again
    }
  }
  return done(`Deployed ${ctx.creation.version} (${job.web_url || `job ${job.id}`}).`)
}

// ── name ─────────────────────────────────────────────────────────────────────

function hostnameOf(ctx: BaseStepContext): string {
  return ctx.made.planned?.hostname ?? ctx.env.hostnames[0] ?? ''
}

async function setEnvStatus(envId: number, to: string, from: string[]): Promise<void> {
  await db('nivaro_hub_environments')
    .where({ id: envId })
    .whereIn('status', from)
    .update({ status: to, updated_at: new Date() })
}

/** One look at the environment's name: does it resolve and serve the creation's version? */
export async function checkNameWait(
  ctx: BaseStepContext
): Promise<{ resolved: boolean; note: string }> {
  const r = await ctx.deps.checkName(hostnameOf(ctx), ctx.env.base_url, ctx.creation.version)
  return { resolved: r.resolves && r.serves, note: r.text }
}

export async function stepName(ctx: BaseStepContext): Promise<StepResult> {
  if (ctx.dnsMode === 'manual') {
    const r = await checkNameWait(ctx)
    if (r.resolved) {
      await setEnvStatus(ctx.env.id, 'provisioning', ['waiting_for_name'])
      return done(r.note)
    }
    // No timeout: a hand-made name keeps the environment waiting until it works.
    await setEnvStatus(ctx.env.id, 'waiting_for_name', ['provisioning', 'waiting_for_name'])
    return { status: 'waiting', on: 'name', note: r.note }
  }
  let last = ''
  for (let i = 1; i <= NAME_POLLS; i++) {
    const r = await checkNameWait(ctx)
    if (r.resolved) return done(r.note)
    last = r.note
    if (i < NAME_POLLS) {
      await ctx.deps.sleep(NAME_POLL_MS)
      await yieldToIo()
    }
  }
  throw new StepFailure('NAME_NOT_SERVING', last || 'The name never served the new version.')
}

// ── link ─────────────────────────────────────────────────────────────────────

export async function stepLink(ctx: BaseStepContext): Promise<StepResult> {
  let last = ''
  for (let i = 1; i <= LINK_POLLS; i++) {
    const s = await ctx.deps.status(
      {
        id: ctx.env.id,
        key: ctx.env.key,
        base_url: ctx.env.base_url,
        hub_token: ctx.env.hub_token
      },
      { fresh: true }
    )
    if (s.state === 'ok' || s.state === 'degraded')
      return done(
        `Hub link answers${s.version ? ` (version ${s.version})` : ''}${s.state === 'degraded' ? ', with failing checks' : ''}.`
      )
    if (s.state === 'link_refused')
      throw new StepFailure(
        'LINK_REFUSED',
        `The app refused the Hub link${s.error ? ` (${s.error})` : ''}: its HUB_TOKEN is not the Hub's.`
      )
    last = s.error ?? 'unreachable'
    if (i < LINK_POLLS) {
      await ctx.deps.sleep(LINK_POLL_MS)
      await yieldToIo()
    }
  }
  throw new StepFailure('LINK_UNREACHABLE', `The app's Hub link did not answer (${last}).`)
}

// ── admin ────────────────────────────────────────────────────────────────────

export async function stepAdmin(ctx: BaseStepContext): Promise<StepResult> {
  const token = secret(ctx, openSecret(ctx.env.hub_token))
  const fa = ctx.creation.first_admin
  const person = {
    email: fa.email,
    ...(fa.first_name ? { first_name: fa.first_name } : {}),
    ...(fa.last_name ? { last_name: fa.last_name } : {})
  }
  let last = ''
  for (let i = 1; i <= ADMIN_POLLS; i++) {
    const r = await ctx.deps.link.requestFirstAdmin(ctx.env.base_url, token, person)
    if (r.result !== 'refused') {
      if (r.result === 'created') return done(`First administrator ${fa.email} created.`)
      if (r.result === 'existed') return done(`${fa.email} made the first administrator.`)
      return done('The app already has an administrator.')
    }
    const transient =
      ADMIN_RETRY.has(r.code) || (r.code === 'HUB_LINK_MISSING' && i <= ADMIN_EARLY_MISSING_POLLS)
    if (!transient)
      throw new StepFailure(r.code, `The app refused the first administrator (${r.code}).`)
    last = r.code
    if (i === 1) ctx.log(`First administrator: the app answered ${r.code}; asking again`)
    if (i < ADMIN_POLLS) {
      await ctx.deps.sleep(ADMIN_POLL_MS)
      await yieldToIo()
    }
  }
  throw new StepFailure(last, `The app did not take the first administrator (${last}).`)
}

/** The GitLab kind's steps (STEP_ORDER); Docker and shared ones are docker-steps.ts's. */
export const STEPS: Record<
  Exclude<CreationStepKey, 'stack' | 'place'>,
  (ctx: StepContext) => Promise<StepResult>
> = {
  database: stepDatabase,
  repository: stepRepository,
  variables: stepVariables,
  config: stepConfig,
  deploy: stepDeploy,
  name: stepName,
  link: stepLink,
  admin: stepAdmin,
  template: stepTemplate
}

// ── target changes ───────────────────────────────────────────────────────────

/** One app's sync after a target change; `pending` = still running in the background. */
export interface TargetSyncResult {
  app_id: number
  ok: boolean
  code?: string
  pending?: true
  /** The target's token was rotated and this app's driver copy now holds the new one. */
  driver_token?: 'updated'
}

/**
 * A rotated target token reaches the driver the creation made for an app (ruling P3-32): its
 * copy is replaced only while it still holds the target's PREVIOUS token (a driver an admin gave
 * another token is left alone). Answers whether it was replaced. Never throws.
 */
async function followRotatedToken(
  driverId: number | undefined,
  previous: string,
  next: string | null
): Promise<boolean> {
  if (!driverId || !next) return false
  try {
    const driver = await getDriver(driverId)
    if (!driver?.secret || openSecret(driver.secret) !== openSecret(previous)) return false
    const n = await db('nivaro_hub_drivers')
      .where({ id: driverId, secret: driver.secret })
      .update({ secret: next, updated_at: new Date() })
    return Number(n) > 0
  } catch {
    return false
  }
}

export const TARGET_SYNC_CONCURRENCY = 3
export const TARGET_SYNC_BUDGET_MS = 20_000

/** Target syncs still running after their request answered (tests and shutdown wait on them). */
const syncsInFlight = new Set<Promise<unknown>>()

/** Waits for every background target sync, at most `maxMs` (a closing process never hangs). */
export async function awaitTargetSyncs(maxMs = Number.POSITIVE_INFINITY): Promise<void> {
  const all = (async () => {
    while (syncsInFlight.size) await Promise.allSettled([...syncsInFlight])
  })()
  if (!Number.isFinite(maxMs)) return all
  let timer: NodeJS.Timeout | undefined
  await Promise.race([
    all,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, maxMs)
      timer.unref?.()
    })
  ])
  clearTimeout(timer)
}

async function syncAppProject(target: HubTargetRow, project: string): Promise<void> {
  const pctx = { ...targetCtx(target, project), ref: null }
  await configureProject(pctx, projectSettings(target))
  await pushDeployVariables(pctx, target.config)
}

/**
 * An app's deploy_project, used only when it passes the adoption rule (ruling P3-23): its
 * description is EXACTLY one of the app's creation marks AND the target token's own GitLab user
 * made it (a recorded project id never reaches here). Answers its numeric id, or null: no
 * project there, no creation row left to hold a mark, or not ours.
 */
async function ownedFallback(
  target: HubTargetRow,
  path: string,
  rows: Awaited<ReturnType<typeof creationsOfApp>>,
  tokenUser: () => Promise<number>
): Promise<string | null> {
  const marks = new Set<string>()
  for (const r of rows)
    if (r.made.planned?.nonce) marks.add(creationMarker(r.id, r.made.planned.nonce))
  if (!marks.size) return null
  const p = await projectExists(targetCtx(target), path)
  if (!p || !marks.has(p.description.trim())) return null
  if (p.creator_id === null || p.creator_id !== (await tokenUser())) return null
  return String(p.id)
}

/**
 * After a target changes (settings, template_ref moved): every app created on it gets the
 * target's CI configuration path and project variables again, checked back (fail closed per
 * app). Call it after every target update (routes, Task 10). The project is the one the app's
 * creation rows recorded, else the app's own deploy_project — only when it passes the adoption
 * rule (ownedFallback; otherwise that app is `PROJECT_NOT_OURS`).
 *
 * Answers per app (an app with no project is left out); one app's failure — a read or a GitLab
 * call — is that app's `{ok: false, code}`, never a throw. At most TARGET_SYNC_CONCURRENCY apps at
 * once, on the background pool; whatever is not done after TARGET_SYNC_BUDGET_MS is answered
 * `pending` and finishes in the background (fire and forget; failures logged by name only).
 * Only the target and app-list reads may throw (the caller says so; nothing was changed).
 */
export async function syncTargetApps(
  targetId: number,
  opts: {
    concurrency?: number
    budgetMs?: number
    syncApp?: (target: HubTargetRow, project: string) => Promise<void>
    /**
     * The target's sealed token before this update, when the update changed it: each app's
     * driver copy that still holds it gets the new one.
     */
    previousSecret?: string | null
  } = {}
): Promise<TargetSyncResult[]> {
  const target = await getTargetRow(targetId)
  if (!target) return []
  const apps = (await db('nivaro_hub_apps')
    .where({ target_id: targetId })
    .orderBy('id')
    .select('id', 'deploy_project')) as Array<{ id: number; deploy_project: string | null }>
  const sync = opts.syncApp ?? syncAppProject
  const results = new Map<number, TargetSyncResult>()
  const skipped = new Set<number>()

  const tokenUser = tokenUserMemo(target)
  const one = async (a: { id: number; deploy_project: string | null }) => {
    const appId = Number(a.id)
    let made: CreationMade
    let rows: Awaited<ReturnType<typeof creationsOfApp>>
    try {
      made = await appMade(appId)
      rows = await creationsOfApp(appId)
    } catch {
      results.set(appId, { app_id: appId, ok: false, code: 'READ_FAILED' })
      return
    }
    const rotated = opts.previousSecret
      ? await followRotatedToken(made.driver_id, opts.previousSecret, target.secret)
      : false
    const mark = rotated ? { driver_token: 'updated' as const } : {}
    const fallback = made.project_id == null ? a.deploy_project?.trim() || null : null
    if (made.project_id == null && !fallback) {
      skipped.add(appId)
      return
    }
    try {
      let project: string
      if (made.project_id != null) project = String(made.project_id)
      else {
        // The app's own deploy_project (no recorded project id): judged like adoption (P3-23)
        // before anything is configured or pushed there.
        const owned = await ownedFallback(target, fallback as string, rows, tokenUser)
        if (!owned) {
          results.set(appId, { app_id: appId, ok: false, code: 'PROJECT_NOT_OURS' })
          return
        }
        project = owned
      }
      await sync(target, project)
      results.set(appId, { app_id: appId, ok: true, ...mark })
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code
      results.set(appId, {
        app_id: appId,
        ok: false,
        code: typeof code === 'string' && code ? code : 'FAILED',
        ...mark
      })
    }
  }

  const width = Math.max(1, Math.min(opts.concurrency ?? TARGET_SYNC_CONCURRENCY, apps.length))
  let next = 0
  const work: Promise<unknown> = runInBackgroundPool(() =>
    Promise.all(
      Array.from({ length: width }, async () => {
        while (next < apps.length) await one(apps[next++])
      })
    )
  )
  let timer: NodeJS.Timeout | undefined
  const finished = await Promise.race([
    work.then(
      () => true,
      () => true
    ),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), opts.budgetMs ?? TARGET_SYNC_BUDGET_MS)
    })
  ])
  clearTimeout(timer)
  if (!finished) {
    const tail = work
      .then(() => {
        const failed = [...results.values()].filter((r) => !r.ok).map((r) => r.app_id)
        if (failed.length)
          getApp()?.log?.warn?.({ targetId, failed }, 'hub target sync: some apps failed')
      })
      .catch((err) =>
        getApp()?.log?.error?.(
          { targetId, err: (err as Error | null)?.name ?? 'Error' },
          'hub target sync failed'
        )
      )
      .finally(() => syncsInFlight.delete(tail))
    syncsInFlight.add(tail)
  }
  return apps
    .map((a) => Number(a.id))
    .filter((id) => !skipped.has(id))
    .map(
      (id) => results.get(id) ?? { app_id: id, ok: false, code: 'PENDING', pending: true as const }
    )
}
