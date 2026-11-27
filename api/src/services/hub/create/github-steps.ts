// Task 11a (Hub providers): the steps of a creation on a GitHub target (github-target.ts):
//
//   database → providers → repository → variables → deploy → name → link → admin → template
//
//   repository  the app's repository (`github.repository`, app-level), created from the target's
//               template through the target's connection — once per app, under the app's
//               repository lock (another environment's leg waits, then finds it made).
//   variables   the environment's GitHub deployment environment (`github.environment`, named as
//               the environment key) and, in it, the five secrets the GitLab kind keeps as CI
//               variables (base64, the same names: NIVARO_DB_URL_B64, NIVARO_HUB_TOKEN_B64,
//               NIVARO_SESSION_SECRET_B64, NIVARO_ENCRYPTION_KEY_B64, NIVARO_OIDC_CLIENT_SECRET_B64)
//               and three variables: NIVARO_APP_ENV (the `.hub/app.env` text the GitLab kind
//               commits), NIVARO_VERSION and NIVARO_IMAGE_PIN (the pin file). A secret already
//               there is never replaced (a retry keeps the first session / encryption key).
//   deploy      the template's deploy workflow adopted (`github.workflow`, app-level), the
//               environment's placement (no driver) with ONE `github_actions` component on that
//               workflow (so later promotions dispatch it, promote-providers.ts), then the workflow
//               dispatched with the inputs `version` and `environment`; recorded as a promote
//               deploy row. The name step then waits for the app to answer the version.
//   name, link, admin and template are the GitLab kind's own.
//
// Every provider write is a change of the change engine carried by the creation (origin
// `creation`); the change ids are kept in `made.provider_changes` (keys `github:*`), so a retry
// picks each up where it stopped. Secret values are opened or made in memory for the call that
// plans the change only (and added to ctx.secrets: the runner scrubs every stored text of them).
import { insertReturningId } from '../../../db/dialect/ef.js'
import { db } from '../../../db/index.js'
import { createComponent, listComponents } from '../components.js'
import { connectionUrl, type HubDbEngine } from '../db/connection.js'
import { openDatabaseConnection } from '../db/databases.js'
import { generateHexSecret } from '../db/names.js'
import { createPlacement, getPlacement } from '../drivers.js'
import type { PlanRequest, PlanRequestOp } from '../providers/engine/contract.js'
import { hubActorForUser, runCarriedChange } from '../providers/hooks/carried.js'
import { type HubResourceRow, listResources } from '../providers/store.js'
import { pinText } from '../registry.js'
import { openSecret } from '../secrets.js'
import { isCreatableKey, renderAppEnv } from './app-config.js'
import type { HubGithubTargetRow } from './github-target.js'
import { stepProviders } from './provider-step.js'
import {
  type BaseStepContext,
  databaseOf,
  dbIdOf,
  StepFailure,
  type StepResult,
  secret,
  stepAdmin,
  stepDatabase,
  stepLink,
  stepName,
  withRepoLock
} from './steps.js'
import type { HubTargetConfig } from './targets.js'
import { stepTemplate } from './template-step.js'
import type { CreationStepKey } from './types.js'

export interface GithubStepContext extends BaseStepContext {
  github: HubGithubTargetRow
}

const DEPLOYS = 'nivaro_hub_deploys'
const ENVS = 'nivaro_hub_environments'
const done = (note: string): StepResult => ({ status: 'done', note })
const b64 = (v: string) => Buffer.from(v).toString('base64')

/** The live managed rows of the app (or this environment) of one type on the target's connection. */
async function rowsOf(
  ctx: GithubStepContext,
  type: string,
  envLevel: boolean
): Promise<HubResourceRow[]> {
  const rows = await listResources({
    appId: ctx.app.id,
    type,
    connectionId: ctx.github.connection_id
  })
  return rows.filter((r) => (envLevel ? r.environment_id === ctx.env.id : r.environment_id == null))
}

const nameOf = (r: HubResourceRow): unknown => r.desired?.name ?? r.observed?.fields?.name ?? r.name

/** One carried change for a step part; its id remembered under `made.provider_changes[key]`. */
async function carry(
  ctx: GithubStepContext,
  key: string,
  ops: PlanRequestOp[],
  envLevel: boolean
): Promise<number> {
  const actor = await hubActorForUser(ctx.creation.started_by)
  if (!actor)
    throw new StepFailure(
      'PROVIDER_ACTOR',
      'The person who started this creation can no longer act: retry it yourself.'
    )
  const req: PlanRequest = {
    connectionId: ctx.github.connection_id,
    scope: 'app',
    appId: ctx.app.id,
    ...(envLevel ? { environmentId: ctx.env.id } : {}),
    ops
  }
  const changes = { ...(ctx.made.provider_changes ?? {}) }
  const out = await runCarriedChange({
    req,
    actor,
    origin: { kind: 'creation', creationId: ctx.creation.id },
    changeId: changes[key] ?? null,
    onPlanned: async (id) => {
      changes[key] = id
      ctx.made.provider_changes = { ...changes }
      await ctx.saveMade()
    },
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    sleep: ctx.deps.sleep
  })
  if (out.status !== 'applied')
    throw new StepFailure(
      out.status === 'blocked' ? out.code : 'PROVIDER_CHANGE_FAILED',
      out.status === 'pending_approval'
        ? `Resource change #${out.changeId} waits for a Hub administrator's approval; retry once it is approved.`
        : `Resource change${out.changeId ? ` #${out.changeId}` : ''} did not apply: ${out.message}`
    )
  return out.changeId
}

async function repositoryRow(ctx: GithubStepContext): Promise<HubResourceRow> {
  const repo = (await rowsOf(ctx, 'github.repository', false))[0]
  if (!repo?.external_id)
    throw new StepFailure('REPOSITORY_MISSING', 'The app has no GitHub repository recorded yet.')
  return repo
}

// ── repository ───────────────────────────────────────────────────────────────

export async function stepGithubRepository(ctx: GithubStepContext): Promise<StepResult> {
  return withRepoLock(ctx, async () => {
    const have = (await rowsOf(ctx, 'github.repository', false))[0]
    if (have) return done(`Repository ${have.external_id ?? have.name ?? `#${have.id}`} is there.`)
    const c = ctx.github.config
    await carry(
      ctx,
      'github:repository',
      [
        {
          action: 'create',
          type: 'github.repository',
          fields: {
            name: ctx.app.key,
            template: c.template,
            visibility: c.visibility,
            description: `Nivaro app ${ctx.app.key} (made by the Nivaro Hub)`,
            default_branch: c.source_branch
          }
        }
      ],
      false
    )
    const made = await repositoryRow(ctx)
    ctx.log(`GitHub repository ${made.external_id} created from ${c.template}`)
    return done(`Repository ${made.external_id} created from ${c.template}.`)
  })
}

// ── variables ────────────────────────────────────────────────────────────────

export async function stepGithubVariables(ctx: GithubStepContext): Promise<StepResult> {
  const repo = await repositoryRow(ctx)
  const env = ctx.env.key
  if (!isCreatableKey(env))
    throw new StepFailure('BAD_ENV_KEY', 'The environment key is not a creatable key.')
  const planned = ctx.made.planned
  if (!planned) throw new StepFailure('PLAN_MISSING', 'The creation has no planned settings.')

  // The deployment environment first: its secrets and variables live in it.
  if (!(await rowsOf(ctx, 'github.environment', true)).some((r) => nameOf(r) === env))
    await carry(
      ctx,
      'github:environment',
      [
        {
          action: 'create',
          type: 'github.environment',
          fields: { repository: { resourceId: repo.id }, name: env }
        }
      ],
      true
    )

  const dbId = dbIdOf(ctx)
  if (!dbId) throw new StepFailure('DATABASE_MISSING', 'The environment has no database recorded.')
  const haveSecrets = new Set(
    (await rowsOf(ctx, 'github.actions_secret', true)).map((r) => String(nameOf(r)))
  )
  const haveVars = new Set(
    (await rowsOf(ctx, 'github.actions_variable', true)).map((r) => String(nameOf(r)))
  )
  const ops: PlanRequestOp[] = []
  const secretOp = (name: string, make: () => string) => {
    if (haveSecrets.has(name)) return
    const value = secret(ctx, b64(secret(ctx, make())))
    ops.push({
      action: 'create',
      type: 'github.actions_secret',
      fields: { repository: { resourceId: repo.id }, environment: env, name, value }
    })
  }
  const conn = await openDatabaseConnection(dbId)
  secret(ctx, conn.password)
  const hubToken = openSecret(ctx.env.hub_token)
  const oidc = openSecret(ctx.app.oidc_secret)
  if (!hubToken) throw new StepFailure('HUB_TOKEN_MISSING', 'The environment has no hub token.')
  if (!oidc) throw new StepFailure('OIDC_SECRET_MISSING', 'The app has no sign-in client secret.')
  secretOp('NIVARO_DB_URL_B64', () => connectionUrl(conn))
  secretOp('NIVARO_HUB_TOKEN_B64', () => hubToken)
  secretOp('NIVARO_SESSION_SECRET_B64', () => generateHexSecret(32))
  secretOp('NIVARO_ENCRYPTION_KEY_B64', () => generateHexSecret(32))
  secretOp('NIVARO_OIDC_CLIENT_SECRET_B64', () => oidc)

  const d = await databaseOf(ctx)
  const appEnv = renderAppEnv({
    app: { key: ctx.app.key, oidc: ctx.app.oidc },
    envKey: env,
    hostname: planned.hostname,
    baseUrl: planned.base_url,
    hubUrl: planned.hub_url,
    engine: d.engine as HubDbEngine,
    // The naming fields are the GitHub target's; the stack's network and Traefik are the
    // template workflow's own (the defaults the GitLab kind uses).
    target: {
      ...ctx.github.config,
      proxy_network: 'proxy',
      traefik_version: 3
    } as unknown as HubTargetConfig
  })
  const variables: Record<string, string> = {
    NIVARO_APP_ENV: appEnv,
    NIVARO_VERSION: ctx.creation.version,
    NIVARO_IMAGE_PIN: pinText(ctx.creation.version, planned.digest, planned.slim_digest)
  }
  for (const [name, value] of Object.entries(variables))
    if (!haveVars.has(name))
      ops.push({
        action: 'create',
        type: 'github.actions_variable',
        fields: { repository: { resourceId: repo.id }, environment: env, name, value }
      })
  if (!ops.length) return done(`${env}: GitHub secrets and variables are there.`)
  const id = await carry(ctx, 'github:variables', ops, true)
  return done(`${env}: ${ops.length} GitHub secret(s) and variable(s) set (change #${id}).`)
}

// ── deploy ───────────────────────────────────────────────────────────────────

async function workflowRow(ctx: GithubStepContext, repo: HubResourceRow): Promise<HubResourceRow> {
  const file = ctx.github.config.deploy_workflow
  const ext = `${repo.external_id}#${file}`
  const find = async () =>
    (await rowsOf(ctx, 'github.workflow', false)).find((r) => r.external_id === ext)
  const have = await find()
  if (have) return have
  // A repository made from a template shows its workflows a moment later: a few tries.
  let last = ''
  for (let i = 0; i < 6; i++) {
    try {
      await carry(
        ctx,
        'github:workflow',
        [{ action: 'adopt', type: 'github.workflow', externalId: ext }],
        false
      )
      const got = await find()
      if (got) return got
    } catch (e) {
      if (!(e instanceof StepFailure) || e.code !== 'NOT_FOUND') throw e
      last = e.message
      // A refused plan is not remembered: the next try plans afresh.
      const changes = { ...(ctx.made.provider_changes ?? {}) }
      delete changes['github:workflow']
      ctx.made.provider_changes = changes
      await ctx.saveMade()
    }
    await ctx.deps.sleep(10_000)
  }
  throw new StepFailure(
    'WORKFLOW_MISSING',
    `The repository has no workflow ${file} yet${last ? ` (${last})` : ''}: check the template, then retry.`
  )
}

export async function stepGithubDeploy(ctx: GithubStepContext): Promise<StepResult> {
  const repo = await repositoryRow(ctx)
  const planned = ctx.made.planned
  if (!planned) throw new StepFailure('PLAN_MISSING', 'The creation has no planned settings.')
  const wf = await workflowRow(ctx, repo)
  const branch = ctx.github.config.source_branch || 'main'

  // The environment becomes an ordinary promotable one: a placement with no driver and one
  // github_actions component on the deploy workflow (promote-providers.ts).
  let placementId = ctx.made.placement_id
  if (!placementId || !(await getPlacement(placementId))) {
    // No driver (0): the placement's one component deploys through its workflow resource.
    const p = await createPlacement({ kind: 'dedicated', driver_id: 0, target: { branch } })
    placementId = Number(p.id)
    ctx.made.placement_id = placementId
    await ctx.saveMade()
  }
  await db(ENVS)
    .where({ id: ctx.env.id })
    .update({ placement_id: placementId, updated_at: new Date() })
  ctx.env.placement_id = placementId
  if (!ctx.made.component_id) {
    const existing = (await listComponents(placementId)).find((c) => c.kind === 'github_actions')
    if (existing?.id) ctx.made.component_id = existing.id
    else {
      const r = await createComponent(placementId, {
        position: 1,
        name: 'api',
        kind: 'github_actions',
        driver_id: 0,
        source_branch: branch,
        target_branch: null,
        before_job: null,
        deploy_job: null,
        verify_url: `${planned.base_url}/api/version`,
        verify_field: 'version',
        resource_id: wf.id
      })
      if (!r.ok) throw new StepFailure(r.code, r.message)
      ctx.made.component_id = Number(r.row.id)
    }
    await ctx.saveMade()
  }

  const version = ctx.creation.version
  const changeId = await carry(
    ctx,
    'github:deploy',
    [
      {
        action: 'update',
        resourceId: wf.id,
        fields: {
          ref: branch,
          inputs: JSON.stringify({ version, environment: ctx.env.key }),
          dispatch: true
        }
      }
    ],
    false
  )
  // Recorded like a promotion's deploy, so the environment's history and rollback know it.
  const step = {
    position: 1,
    component: 'api',
    kind: 'github_actions',
    driverId: 0,
    driver: 'provider',
    sourceSha: null,
    targetBranch: branch,
    pinText: null,
    pinFile: null,
    beforeJob: null,
    deployJob: '',
    verifyUrl: `${planned.base_url}/api/version`,
    verifyField: 'version',
    want: version,
    provider: {
      kind: 'github_actions',
      connectionId: ctx.github.connection_id,
      resourceId: wf.id,
      ref: branch,
      refLabel: `branch ${branch}`
    },
    deployedSha: branch,
    deployedPipelineId: null,
    deployedChangeId: changeId
  }
  const mark = `"creation_id":${ctx.creation.id},`
  const already = await db(DEPLOYS)
    .where({ environment_id: ctx.env.id, kind: 'promote', version })
    .where('plan', 'like', `%${mark}%`)
    .first('id')
  if (!already)
    await insertReturningId(db, DEPLOYS, {
      app_id: ctx.app.id,
      environment_id: ctx.env.id,
      kind: 'promote',
      version,
      from_version: null,
      status: 'success',
      step: 'deploy api',
      error: null,
      plan: JSON.stringify({ creation_id: ctx.creation.id, version, steps: [step] }),
      job_run_id: ctx.creation.job_run_id,
      started_by: ctx.creation.started_by,
      started_at: new Date(),
      finished_at: new Date()
    })
  ctx.log(
    `GitHub Actions ${ctx.github.config.deploy_workflow} dispatched on ${branch} (change #${changeId})`
  )
  return done(
    `${ctx.github.config.deploy_workflow} dispatched on ${branch} for ${version}; the name step waits for the app to answer it.`
  )
}

/** The GitHub kind's steps, in GITHUB_STEP_ORDER. */
export const GITHUB_STEPS: Partial<
  Record<CreationStepKey, (ctx: GithubStepContext) => Promise<StepResult>>
> = {
  database: stepDatabase,
  providers: (ctx) =>
    stepProviders(ctx, {
      dns_mode: ctx.github.config.dns_mode,
      dns_zone_resource_id: ctx.github.config.dns_zone_resource_id,
      wildcard_domain: ctx.github.config.wildcard_domain,
      edge: ctx.github.config.edge_address
    }),
  repository: stepGithubRepository,
  variables: stepGithubVariables,
  deploy: stepGithubDeploy,
  name: stepName,
  link: stepLink,
  admin: stepAdmin,
  template: stepTemplate
}
