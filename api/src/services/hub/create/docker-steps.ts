// The steps of a creation that does not go through a GitLab target (gap `create`, 0.3.215).
//
//   Docker  database → stack → deploy → name → link → admin
//           `stack`  the environment's dedicated placement on the Docker driver (stack
//                    `<app>--<env>`), its one `stack` component (so later promotions, Apply now,
//                    Restart and moves treat it as any phase-4 stack) and its stack settings:
//                    size, Redis, publish port, the plain settings and secrets the person gave,
//                    sign-in (OIDC_ISSUER / OIDC_CLIENT_ID / OIDC_REDIRECT_URI + the sealed
//                    OIDC_CLIENT_SECRET) and the extension pins; SESSION_SECRET and
//                    ENCRYPTION_KEY are generated and sealed by saveStackSettings (never twice).
//           `deploy` phase 4's agent deploy (docker/run-step.ts defaultDockerOps().deploy: the
//                    agent's health and limits read again, the spec rendered fresh, applied, swarm
//                    waited for) recorded as a promote deploy row, so the environment's history,
//                    Restart and Apply now know what the stack runs.
//           name, link and admin are the GitLab kind's own (steps.ts).
//   Shared  database → place
//           `place`  place-shared run inline under the leg's lock (shared/place.ts
//                    placeForCreation): placement, app key, list, replicas, schema, first
//                    administrator, `active`.
//
// Secrets: nothing here opens a stack secret; the sealed values go from the creation's `made`
// (sealed at the start) straight into nivaro_hub_stack_settings, and only the deploy step's
// renderer opens them, inside the call that sends the spec to the agent.
import { insertReturningId } from '../../../db/dialect/ef.js'
import { db } from '../../../db/index.js'
import { createComponent, listComponents } from '../components.js'
import { agentOrigin } from '../docker/driver-config.js'
import { type DockerStepOps, defaultDockerOps } from '../docker/run-step.js'
import { strictPinMap } from '../docker/stack-gather.js'
import {
  openSealedMap,
  readStackSettings,
  saveStackSettings,
  sealMap
} from '../docker/stack-settings.js'
import { STACK_SIZES, type StackSize } from '../docker/templates.js'
import {
  createPlacement,
  type DockerDriverRow,
  getPlacement,
  placementStackRefusal
} from '../drivers.js'
import { withoutFreshHeartbeat } from '../promote-heal.js'
import { LOCK_RENEW_MS, type PromoteLock } from '../promote-lock.js'
import type { PromotionStep } from '../promote-types.js'
import { hubImage } from '../registry.js'
import { PlaceSharedError, placeForCreation } from '../shared/place.js'
import type { SharedDeployment } from '../shared/store.js'
import { redirectUriFor, stackName } from './app-config.js'
import {
  type BaseStepContext,
  dbIdOf,
  StepFailure,
  type StepResult,
  stepAdmin,
  stepDatabase,
  stepLink,
  stepName
} from './steps.js'
import type { CreationStepKey } from './types.js'

/** Where a non-GitLab creation goes, loaded fresh by the runner for each leg. */
export type CreationDest =
  | { kind: 'docker'; driver: DockerDriverRow }
  | { kind: 'shared'; shared: SharedDeployment }

export interface DestStepContext extends BaseStepContext {
  dest: CreationDest
  /** The environment lock the leg holds (the place step runs place-shared under it). */
  envLock?: { lock: PromoteLock; token: string }
}

/** What these steps call out to; tests pass fakes. */
export interface DestStepDeps {
  docker?: DockerStepOps
  place?: typeof placeForCreation
}

const DEPLOYS = 'nivaro_hub_deploys'
const ENVS = 'nivaro_hub_environments'

const done = (note: string): StepResult => ({ status: 'done', note })

function dockerOf(ctx: DestStepContext): DockerDriverRow {
  if (ctx.dest.kind !== 'docker')
    throw new StepFailure('BAD_TARGET', 'This creation does not deploy through a Docker driver.')
  return ctx.dest.driver
}

function sharedOf(ctx: DestStepContext): SharedDeployment {
  if (ctx.dest.kind !== 'shared')
    throw new StepFailure('BAD_TARGET', 'This creation is not placed on a shared deployment.')
  return ctx.dest.shared
}

const parseObj = (raw: unknown): Record<string, unknown> => {
  let v = raw
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw)
    } catch {
      return {}
    }
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

// ── stack ────────────────────────────────────────────────────────────────────

/**
 * The dedicated placement of `driver` deploying `name` that no other environment uses (one an
 * earlier try made before it could record it), if any.
 */
async function leftPlacement(driverId: number, name: string, envId: number) {
  const rows = (await db('nivaro_hub_placements')
    .where({ driver_id: driverId, kind: 'dedicated' })
    .orderBy('id')
    .select('id', 'target')) as Array<{ id: number; target: unknown }>
  for (const r of rows) {
    if (parseObj(r.target).stack !== name) continue
    const user = await db(ENVS).where({ placement_id: r.id }).whereNot({ id: envId }).first('id')
    if (!user) return Number(r.id)
  }
  return null
}

export async function stepStack(ctx: DestStepContext): Promise<StepResult> {
  const driver = dockerOf(ctx)
  const planned = ctx.made.planned
  if (!planned?.stack)
    throw new StepFailure('PLAN_MISSING', 'The creation has no planned stack settings.')
  const name = stackName(ctx.app.key, ctx.env.key)

  // The placement: the recorded one while it still deploys this stack, else a leftover, else new.
  const recorded = ctx.made.placement_id ?? ctx.env.placement_id ?? null
  const p = recorded ? await getPlacement(recorded) : null
  let placementId: number
  if (p && p.kind === 'dedicated' && p.driver_id === driver.id && p.target.stack === name)
    placementId = p.id
  else {
    const left = await leftPlacement(driver.id, name, ctx.env.id)
    if (left) placementId = left
    else {
      const refused = await placementStackRefusal(driver.id, { stack: name })
      if (refused) throw new StepFailure(refused.code, refused.message)
      placementId = (
        await createPlacement({ kind: 'dedicated', driver_id: driver.id, target: { stack: name } })
      ).id
    }
  }
  if (ctx.made.placement_id !== placementId) {
    ctx.made.placement_id = placementId
    await ctx.saveMade()
  }
  await db(ENVS)
    .where({ id: ctx.env.id })
    .update({ placement_id: placementId, updated_at: new Date() })
  ctx.env.placement_id = placementId

  // Its one stack component: what promotions, Apply now and moves deploy.
  const comps = await listComponents(placementId)
  let comp = comps.find((c) => c.kind === 'stack' && c.id != null)
  if (!comp) {
    const r = await createComponent(placementId, {
      position: 1,
      name: 'stack',
      kind: 'stack',
      driver_id: driver.id,
      source_branch: 'main',
      target_branch: null,
      before_job: null,
      deploy_job: null,
      verify_url: `${planned.base_url.replace(/\/+$/, '')}/api/version`,
      verify_field: 'version'
    })
    if (!r.ok) throw new StepFailure(r.code, r.message)
    comp = r.row
  }
  if (comp.id != null && ctx.made.component_id !== comp.id) {
    ctx.made.component_id = comp.id
    await ctx.saveMade()
  }

  // Settings. Stored first, then the request's (a retry keeps the generated keys), then sign-in.
  const s = planned.stack
  const existing = await readStackSettings(ctx.env.id)
  const map = {
    ...(existing ? openSealedMap(existing.secrets) : {}),
    ...openSealedMap(s.secrets)
  }
  if (ctx.app.oidc_secret) map.OIDC_CLIENT_SECRET = ctx.app.oidc_secret
  const settings: Record<string, string> = { ...s.settings }
  if (ctx.app.oidc.issuer) settings.OIDC_ISSUER = ctx.app.oidc.issuer
  if (ctx.app.oidc.client_id) settings.OIDC_CLIENT_ID = ctx.app.oidc.client_id
  settings.OIDC_REDIRECT_URI = redirectUriFor(planned.base_url)
  const size = (STACK_SIZES as readonly string[]).includes(s.size) ? (s.size as StackSize) : 'small'
  const saved = await saveStackSettings(
    ctx.env.id,
    {
      size,
      redis: s.redis === 'external' ? 'external' : 'bundled',
      publish_port: s.publish_port,
      settings,
      secrets: sealMap(map)
    },
    s.extension_pins
  )
  const pins = Object.keys(s.extension_pins).length
  ctx.log(
    `Stack ${name} on ${driver.name}: settings saved (size ${saved.size}, Redis ${saved.redis}${pins ? `, ${pins} extension pin${pins === 1 ? '' : 's'}` : ''})`
  )
  return done(
    `Stack ${name} on ${driver.name}: size ${saved.size}, Redis ${saved.redis}; SESSION_SECRET and ENCRYPTION_KEY sealed.`
  )
}

// ── deploy ───────────────────────────────────────────────────────────────────

const codeOf = (err: unknown): string => {
  const c = (err as { code?: unknown } | null)?.code
  return typeof c === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(c) ? c : 'DEPLOY_FAILED'
}

export async function stepStackDeploy(
  ctx: DestStepContext,
  deps: DestStepDeps = {}
): Promise<StepResult> {
  const driver = dockerOf(ctx)
  const planned = ctx.made.planned
  if (!planned || !/^sha256:[0-9a-f]{64}$/.test(planned.digest))
    throw new StepFailure('IMAGE_NO_DIGEST', 'The planned image has no digest.')
  const version = ctx.creation.version
  const name = stackName(ctx.app.key, ctx.env.key)
  const row = await readStackSettings(ctx.env.id)
  if (!row) throw new StepFailure('STACK_SETTINGS_MISSING', `${ctx.env.key} has no stack settings.`)
  const env = (await db(ENVS).where({ id: ctx.env.id }).first('extension_pins')) as
    | { extension_pins: unknown }
    | undefined
  const pins =
    env?.extension_pins == null || env.extension_pins === '' ? {} : strictPinMap(env.extension_pins)
  if (!pins)
    throw new StepFailure('EXTENSION_UNPINNED', `${ctx.env.key}'s extension pins cannot be read.`)

  const base = ctx.env.base_url.replace(/\/+$/, '')
  const step: PromotionStep = {
    position: 1,
    component: 'stack',
    kind: 'stack',
    driverId: driver.id,
    driver: 'docker',
    sourceSha: null,
    targetBranch: '',
    pinText: null,
    pinFile: null,
    beforeJob: null,
    deployJob: '',
    verifyUrl: `${base}/api/version`,
    verifyField: 'version',
    want: version,
    stack: {
      name,
      image: `${hubImage()}@${planned.digest}`,
      size: row.size,
      extensions: pins,
      agentOrigin: agentOrigin(driver.config?.agent_url) ?? ''
    }
  }
  const mark = `"creation_id":${ctx.creation.id},`
  // An earlier try of this step left its row running (the leg died): it is closed now. We hold
  // the environment's lock, so no other run of it lives; a row a live runner still beats is left.
  await withoutFreshHeartbeat(
    db(DEPLOYS).where({ environment_id: ctx.env.id, status: 'running' }),
    ctx.deps.now()
  )
    .where('plan', 'like', `%${mark}%`)
    .update({
      status: 'interrupted',
      error: 'INTERRUPTED: The creation stopped during this deploy; it ran again.',
      finished_at: new Date(),
      heartbeat_at: null
    })
  const plan = (s: PromotionStep) =>
    JSON.stringify({ creation_id: ctx.creation.id, version, steps: [s] })
  const deployId = Number(
    await insertReturningId(db, DEPLOYS, {
      app_id: ctx.app.id,
      environment_id: ctx.env.id,
      kind: 'promote',
      version,
      from_version: null,
      status: 'running',
      step: `deploy ${step.component}`,
      error: null,
      plan: plan(step),
      job_run_id: ctx.creation.job_run_id,
      started_by: ctx.creation.started_by,
      started_at: new Date(),
      heartbeat_at: new Date()
    })
  )
  const beat = setInterval(() => {
    void db(DEPLOYS)
      .where({ id: deployId, status: 'running' })
      .update({ heartbeat_at: new Date() })
      .catch(() => undefined)
  }, LOCK_RENEW_MS)
  beat.unref?.()
  try {
    const ops = deps.docker ?? defaultDockerOps()
    const out = await ops.deploy(
      step,
      {
        deployId,
        envId: ctx.env.id,
        version,
        kind: 'promote',
        targetKey: ctx.env.key,
        gitCtx: () =>
          Promise.reject(new StepFailure('NO_GITLAB', 'A Docker stack reads no GitLab.'))
      },
      async (line, level) => ctx.log(line, level)
    )
    if (!out) throw new StepFailure('DEPLOY_FAILED', `${name} was not applied.`)
    const ran: PromotionStep = {
      ...step,
      deployedSha: out.specHash,
      deployedSpecHash: out.specHash,
      deployedImage: out.image,
      stack: { ...(step.stack as NonNullable<PromotionStep['stack']>), extensions: out.extensions }
    }
    await db(DEPLOYS)
      .where({ id: deployId })
      .update({
        status: 'success',
        step: null,
        plan: plan(ran),
        finished_at: new Date(),
        heartbeat_at: null
      })
    const short = out.image.replace(/@sha256:([0-9a-f]{12})[0-9a-f]+$/, '@$1')
    return done(`Stack ${name} runs nivaro ${version} (${short}).`)
  } catch (err) {
    const code = codeOf(err)
    const text = err instanceof Error ? err.message : 'The deploy stopped unexpectedly.'
    await db(DEPLOYS)
      .where({ id: deployId })
      .update({
        status: 'failed',
        error: `${code}: ${text}`.slice(0, 1000),
        finished_at: new Date(),
        heartbeat_at: null
      })
      .catch(() => undefined)
    throw err instanceof StepFailure ? err : new StepFailure(code, text)
  } finally {
    clearInterval(beat)
  }
}

// ── place ────────────────────────────────────────────────────────────────────

export async function stepPlace(
  ctx: DestStepContext,
  deps: DestStepDeps = {}
): Promise<StepResult> {
  const shared = sharedOf(ctx)
  const t = ctx.made.target
  if (t?.kind !== 'shared')
    throw new StepFailure('PLAN_MISSING', 'The creation does not name its shared deployment.')
  if (!ctx.envLock)
    throw new StepFailure('INTERRUPTED', 'The creation does not hold the environment lock.')
  const databaseId = dbIdOf(ctx)
  if (!databaseId)
    throw new StepFailure('DATABASE_MISSING', 'The environment has no database recorded.')
  let out: { already: boolean }
  try {
    out = await (deps.place ?? placeForCreation)(
      ctx.env.id,
      {
        shared_id: t.shared_id,
        database_id: databaseId,
        pool_max: t.pool_max,
        first_admin: ctx.creation.first_admin
      },
      ctx.creation.started_by,
      { lock: ctx.envLock.lock, token: ctx.envLock.token, log: (l, lv) => ctx.log(l, lv) }
    )
  } catch (err) {
    if (err instanceof PlaceSharedError) throw new StepFailure(err.code, err.message)
    throw err
  }
  return done(
    out.already
      ? `Already placed on ${shared.key}; the app serves.`
      : `Placed on ${shared.key}: first administrator ${ctx.creation.first_admin.email} set; the app serves.`
  )
}

// ── the step tables ──────────────────────────────────────────────────────────

/** The Docker and shared kinds' steps (DOCKER_STEP_ORDER, SHARED_STEP_ORDER). */
export function destSteps(
  deps: DestStepDeps = {}
): Partial<Record<CreationStepKey, (ctx: DestStepContext) => Promise<StepResult>>> {
  return {
    database: stepDatabase,
    stack: stepStack,
    deploy: (ctx) => stepStackDeploy(ctx, deps),
    name: stepName,
    link: stepLink,
    admin: stepAdmin,
    place: (ctx) => stepPlace(ctx, deps)
  }
}
