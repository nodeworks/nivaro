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
// never count against it. On boot a `running` row whose environment lock is gone becomes
// `interrupted`; Retry resumes it at that step.
//
// Secrets never reach a log line, a step note, an error, an activity row or readCreation: every
// stored or logged text passes the leg's scrub over every secret it opened or made.
import { randomBytes } from 'node:crypto'
import { insertReturningId } from '../../../db/dialect/ef.js'
import { db } from '../../../db/index.js'
import { runInBackgroundPool } from '../../../db/pool-context.js'
import { logActivity } from '../../activity.js'
import { getApp } from '../../io-holder.js'
import { type JobLogLine, type JobRunHandle, readJobLog, startJobRun } from '../../job-runs.js'
import type { ChecklistItem } from '../db/checklist.js'
import { dbaChecklist } from '../db/checklist.js'
import { scrubDbErrorFull } from '../db/connection.js'
import {
  attachDatabase,
  getDatabase,
  type HubDatabase,
  HubDbError,
  recordDatabase
} from '../db/databases.js'
import { generateHexSecret } from '../db/names.js'
import { getServerRow, publicServer } from '../db/servers.js'
import { defaultSleep, type Sleep } from '../gitlab-write.js'
import { checkName as checkEnvironmentNameById } from '../name-check.js'
import { defaultPromoteLock, LOCK_RENEW_MS, type PromoteLock } from '../promote-lock.js'
import { hubImage } from '../registry.js'
import { HubSecretError, sealSecret } from '../secrets.js'
import { readEnvironmentStatus } from '../status.js'
import { manualTicket, redirectUriFor, stackName } from './app-config.js'
import { managerLines } from './deploy-key.js'
import { type GatherCreationDeps, gatherCreationFacts } from './gather.js'
import { requestFirstAdmin } from './link-client.js'
import { checkName } from './name-check.js'
import { buildCreationPlan } from './plan.js'
import {
  checkDatabaseWait,
  checkNameWait,
  STEPS,
  type StepApp,
  type StepContext,
  type StepDeps,
  type StepEnv,
  StepFailure,
  syncTargetApps,
  tokenUserMemo
} from './steps.js'
import {
  APP_MADE_KEYS,
  appMade,
  CREATIONS,
  type CreationFlags,
  type CreationMade,
  type CreationRow,
  type CreationStatus,
  defaultCreationFlags,
  defaultKeyedLock,
  HUB_CREATE_START_LOCK_KEY,
  insertCreation,
  type KeyedLock,
  OPEN_CREATION_STATUSES,
  patchCreation,
  readCreationRow
} from './store.js'
import { getTargetRow, type HubTargetRow } from './targets.js'
import type { CreateAppInput, CreationFacts, CreationPlan, CreationStepState } from './types.js'
import { STEP_ORDER } from './types.js'

export { syncTargetApps }

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
}

export function defaultCreationDeps(): CreationDeps {
  return { lock: defaultPromoteLock() }
}

interface Resolved {
  lock: PromoteLock
  flags: CreationFlags
  startLock: KeyedLock
  startJobRun: NonNullable<CreationDeps['startJobRun']>
  gather?: GatherCreationDeps
  step: StepDeps
}

function resolve(d: CreationDeps = defaultCreationDeps()): Resolved {
  return {
    lock: d.lock,
    flags: d.flags ?? defaultCreationFlags(),
    startLock: d.startLock ?? defaultKeyedLock(),
    startJobRun:
      d.startJobRun ??
      ((label, envId, userId) =>
        startJobRun('deploy', `hub-create-${envId}`, { label, triggeredBy: userId })),
    gather: d.gather,
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

/** `own` with the app-level keys (APP_MADE_KEYS) taken from the shared copy when it has them. */
function withShared(own: CreationMade, shared: CreationMade): CreationMade {
  const out: CreationMade = { ...own }
  for (const key of APP_MADE_KEYS)
    if (shared[key] !== undefined) (out as Record<string, unknown>)[key] = shared[key]
  return out
}

function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'STEP_FAILED'
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
      return await writeCreation(input, plan, facts, user)
    } catch (err) {
      if (err instanceof HubDbError) throw new CreationError(err.code, err.message, 409)
      if (err instanceof HubSecretError) throw new CreationError(err.code, err.message, 400)
      throw err
    }
  })
  for (const e of out.environments) launchLeg(e.id, user, r, ['queued'])
  return out
}

async function writeCreation(
  input: CreateAppInput,
  plan: CreationPlan,
  facts: CreationFacts,
  user: { id: string }
): Promise<{ app_id: number; environments: Array<{ id: number; key: string }> }> {
  // Sealed before the transaction: a missing ENCRYPTION_KEY writes nothing.
  const oidcSecret = sealSecret(String(input.signin.client_secret))
  const tokens = plan.environments.map(() => sealSecret(generateHexSecret(32)))
  const now = () => new Date()
  // The digests and Hub URL the planner accepted: each creation keeps them for its retries.
  const digest = String(facts.digest)
  const slimDigest =
    typeof facts.slimDigest === 'string' && facts.slimDigest.startsWith('sha256:')
      ? facts.slimDigest
      : null
  const hubUrl = String(facts.hubUrl)
  const servers = facts.servers
  return db.transaction(async (trx) => {
    const appId = Number(
      await insertReturningId(trx, APPS, {
        key: plan.app.key,
        name: plan.app.name,
        signin_mode: 'direct',
        adopted: false,
        extensions: '[]',
        created_by: user.id || null,
        target_id: Number(input.target_id),
        oidc: JSON.stringify({
          issuer: str(input.signin.issuer),
          client_id: str(input.signin.client_id)
        }),
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
          hub_token: tokens[i],
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
        planned: {
          hub_url: hubUrl,
          digest,
          slim_digest: slimDigest,
          hostname: pe.hostname as string,
          base_url: pe.base_url as string,
          source_branch: pe.source_branch,
          nonce: randomBytes(18).toString('base64url')
        }
      }
      await insertCreation(trx, {
        app_id: appId,
        environment_id: envId,
        version: str(input.version),
        first_admin: firstAdminOf(input),
        made,
        started_by: user.id || null
      })
      envs.push({ id: envId, key: pe.key })
    }
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

const RESUMABLE: readonly CreationStatus[] = [
  'queued',
  'waiting',
  'failed',
  'interrupted',
  'cancelled'
]

/**
 * Walks one environment's creation from its first unfinished step. Answers 'busy' (nothing
 * touched) when another runner — a promotion or a creation leg — holds the environment.
 */
export function runCreationLeg(
  envId: number,
  user: { id: string } | null,
  deps?: CreationDeps
): Promise<'done' | 'waiting' | 'failed' | 'cancelled' | 'busy'> {
  return runLeg(envId, user, resolve(deps), RESUMABLE)
}

async function loadContext(
  row: CreationRow
): Promise<{ app: StepApp; env: StepEnv; target: HubTargetRow }> {
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
  const target = a.target_id == null ? null : await getTargetRow(Number(a.target_id))
  if (!target) throw new StepFailure('BAD_TARGET', 'The app’s target is gone.')
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
    target
  }
}

async function runLeg(
  envId: number,
  user: { id: string } | null,
  r: Resolved,
  from: readonly CreationStatus[]
): Promise<'done' | 'waiting' | 'failed' | 'cancelled' | 'busy'> {
  const first = await readCreationRow(envId)
  if (!first) throw new CreationError('NOT_FOUND', 'No creation for this environment.', 404)
  if (first.status === 'done') return 'done'
  const token = await r.lock.take(envId)
  if (!token) return 'busy'
  const entry: LiveLeg = { creationId: first.id, cancel: false }
  live.set(envId, entry)
  let lockLost = false
  const renew = setInterval(() => {
    void r.lock
      .renew(envId, token)
      .then((held) => {
        if (!held) lockLost = true
      })
      .catch(() => undefined)
  }, LOCK_RENEW_MS)
  renew.unref?.()
  try {
    // We hold the environment: a row still `running` here belongs to a runner that died.
    const claimed = await patchCreation(
      first.id,
      { status: 'running', waiting_for: null, error: null, finished_at: null },
      [...from, 'running']
    )
    if (!claimed) return 'busy'
    await r.flags.clearCancel(first.id)
    return await walk(envId, first.id, user, r, entry, () => lockLost)
  } finally {
    clearInterval(renew)
    live.delete(envId)
    await r.lock.release(envId, token)
  }
}

async function walk(
  envId: number,
  creationId: number,
  user: { id: string } | null,
  r: Resolved,
  entry: LiveLeg,
  lockLost: () => boolean
): Promise<'done' | 'waiting' | 'failed' | 'cancelled'> {
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
    const { app, env, target } = await loadContext(row)
    run = await r.startJobRun(`Create ${app.key}/${env.key}`, envId, user?.id || null)
    if (run.id != null) await patchCreation(creationId, { job_run_id: run.id }, ['running'])
    const ctx: StepContext = {
      creation: row,
      app,
      env,
      target,
      made: { ...row.made },
      async saveMade() {
        // App-level keys are written to every row by saveAppMade only: the shared copy wins.
        ctx.made = withShared(ctx.made, await appMade(app.id))
        await patchCreation(creationId, { made: ctx.made })
      },
      doneSha: (key) => steps.find((s) => s.key === key && s.status === 'done')?.sha ?? null,
      log,
      secrets,
      tokenUserId: tokenUserMemo(target),
      deps: r.step
    }

    for (const key of STEP_ORDER) {
      const state = steps.find((s) => s.key === key) as CreationStepState
      if (state.status === 'done') continue
      if (lockLost()) {
        await finish('interrupted', 'The environment lock was lost; retry.')
        log('the creation lock was lost — stopped', 'error')
        await run.fail(new Error(`Create ${app.key}/${env.key}: stopped (lock lost)`))
        return 'failed'
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
      const result = await STEPS[key](ctx)
      // Keep the shared made (another leg may have written app-level keys) with this leg's own.
      ctx.made = withShared(ctx.made, await appMade(app.id))
      if (result.status === 'waiting') {
        Object.assign(state, {
          status: 'waiting',
          at: new Date().toISOString(),
          note: scrub(result.note, secrets, 300)
        })
        await persist({ status: 'waiting', waiting_for: result.on, made: ctx.made })
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
      await persist({ made: ctx.made })
      log(`${key} → done: ${result.note}`)
      current = null
    }

    await db(ENVS)
      .where({ id: envId })
      .whereIn('status', ['provisioning', 'waiting_for_name'])
      .update({ status: 'active', updated_at: new Date() })
    await finish('done', null)
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
    const code = errorCode(err)
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

  async function finish(status: CreationStatus, error: string | null): Promise<void> {
    const terminal = status === 'done' || status === 'failed' || status === 'cancelled'
    await patchCreation(
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
  }
}

// ── resume, cancel, recover ──────────────────────────────────────────────────

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
  if (!look.resolved) {
    const steps = row.steps.map((s) =>
      s.status === 'waiting' ? { ...s, at: new Date().toISOString(), note: look.note } : s
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
  try {
    const { app, env, target } = await loadContext(row)
    const ctx: StepContext = {
      creation: row,
      app,
      env,
      target,
      made: { ...row.made },
      saveMade: async () => undefined,
      doneSha: () => null,
      log: () => undefined,
      secrets,
      tokenUserId: tokenUserMemo(target),
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

async function interrupt(row: CreationRow, note: string): Promise<boolean> {
  const steps = row.steps.map((s) =>
    s.status === 'running'
      ? { ...s, status: 'failed' as const, at: new Date().toISOString(), note }
      : s
  )
  const n = await patchCreation(
    row.id,
    {
      status: 'interrupted',
      steps,
      error: `INTERRUPTED: ${note}${row.step ? ` (${row.step})` : ''}`,
      finished_at: new Date()
    },
    ['running']
  )
  return n > 0
}

/**
 * Hub boot (and every cron tick): a `running` creation whose environment lock is gone (its
 * process died) becomes `interrupted`; its step is marked failed and Retry resumes there. A held
 * or unreadable lock means a runner may be alive somewhere: left alone (a crashed holder's lock
 * expires within 5 minutes and the next tick heals the row).
 */
export async function recoverInterruptedCreations(
  deps: Pick<CreationDeps, 'lock'> = { lock: defaultPromoteLock() }
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
    if ((await deps.lock.held(envId)) !== false) continue
    const row = await readCreationRow(envId)
    if (row?.status === 'running' && (await interrupt(row, 'The Hub restarted during this step')))
      n++
  }
  return n
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
      const token = await deps.lock.take(envId)
      if (!token)
        throw new CreationError(
          'CREATION_RUNNING',
          'A creation step or a promotion is running on this environment — wait for it or cancel it.',
          409
        )
      held.push({ envId, token })
    }
    if (envIds.length) {
      const running = await db(CREATIONS)
        .whereIn('environment_id', envIds)
        .whereIn('status', ['running', 'queued'])
        .first('id')
      if (running)
        throw new CreationError(
          'CREATION_RUNNING',
          'A creation is running on this environment — wait for it or cancel it.',
          409
        )
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
  environment_id: number
  env_key: string
  status: CreationStatus
  step: string | null
  waiting_for: 'database' | 'name' | null
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
  /** The environment's database, masked. */
  database: HubDatabase | null
  /** What the operator installs on the swarm manager for this app (template README). */
  deploy_key: {
    keyid: string
    public_key: string
    authorized_keys: string
    key_conf: string
    key_conf_path: string
  } | null
}

export async function readCreation(envId: number): Promise<CreationView | null> {
  const row = await readCreationRow(envId)
  if (!row) return null
  const app = (await db(APPS).where({ id: row.app_id }).first('id', 'key', 'target_id')) as
    | { id: number; key: string; target_id: number | null }
    | undefined
  const env = (await db(ENVS).where({ id: envId }).first('key', 'base_url', 'hostnames')) as
    | { key: string; base_url: string; hostnames: string | null }
    | undefined
  const target = app?.target_id != null ? await getTargetRow(Number(app.target_id)) : null
  const shared = app ? await appMade(Number(app.id)) : {}
  const made: Omit<CreationMade, 'planned'> = { ...row.made, ...shared }
  delete (made as CreationMade).planned
  const hostname = row.made.planned?.hostname ?? null
  const baseUrl = env?.base_url ?? row.made.planned?.base_url ?? null

  const dbId = row.made.database_id
  const database = dbId ? await getDatabase(dbId) : null
  let checklist: ChecklistItem[] | null = null
  if (
    database &&
    !database.created_by_hub &&
    !database.adopted &&
    database.status !== 'ready' &&
    database.server_id != null
  ) {
    const server = await getServerRow(database.server_id)
    if (server && database.login_name)
      checklist = dbaChecklist(publicServer(server), database.database_name, database.login_name)
  }
  let ticket: string | null = null
  if (target?.config?.dns_mode === 'manual' && hostname) {
    try {
      ticket = manualTicket(target.config, hostname)
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
    environment_id: row.environment_id,
    env_key: env?.key ?? '',
    status: row.status,
    step: row.step,
    waiting_for: row.waiting_for,
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
