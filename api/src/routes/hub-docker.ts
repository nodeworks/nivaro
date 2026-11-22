import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { environmentFromRow, idParam, isAppOwner } from '../services/hub/apps.js'
import { hubDeploysKeys } from '../services/hub/deploys.js'
import {
  AgentError,
  agentHealth,
  agentLeftovers,
  agentRemove,
  agentRestart,
  agentStack,
  describeAgentError
} from '../services/hub/docker/agent-client.js'
import type {
  StackRemoveResult,
  StackRestartResult,
  StackStatus
} from '../services/hub/docker/agent-types.js'
import { lookName, markNameServing, nameRequest } from '../services/hub/docker/name-check.js'
import { prepareStackSpec } from '../services/hub/docker/run-step.js'
import { agentEnvPrefixes } from '../services/hub/docker/stack-env.js'
import { strictPinMap } from '../services/hub/docker/stack-gather.js'
import {
  deployedStack,
  dockerTargetOf,
  ownsStack,
  withEnvironmentLock
} from '../services/hub/docker/stack-guards.js'
import {
  publicStackSettings,
  readStackSettings,
  type StackSettingsRow,
  saveStackSettings,
  validateStackSettings
} from '../services/hub/docker/stack-settings.js'
import { getDriver } from '../services/hub/drivers.js'
import { PromotionError } from '../services/hub/promote-lock.js'
import { startStackApply } from '../services/hub/promote-run.js'
import type { HubEnvironmentRow } from '../services/hub/promote-types.js'
import { HUB_MASK, HubSecretError } from '../services/hub/secrets.js'
import { hubStatusKey } from '../services/hub/status.js'

/**
 * The Hub's Docker routes (phase 4), mounted under /api/hub by hub.ts:
 *
 *   GET  /drivers/:id/agent                       admin           the agent's /v1/health
 *   GET  /environments/:envId/stack               admin + owner   stack name, DNS mode, status
 *   GET  /environments/:envId/stack/settings      admin           settings, secrets as masks
 *   PUT  /environments/:envId/stack/settings      admin           save (masks keep secrets)
 *   POST /environments/:envId/stack/restart       admin + owner   { confirm: <env key> }
 *   POST /environments/:envId/stack/apply         admin + owner   { confirm: <env key> } (P4-30)
 *   POST /environments/:envId/stack/remove        admin           { confirm: <stack name>, … }
 *   POST /environments/:envId/stack/check-name    admin + owner   look at the name now
 *
 * An environment the caller may not read answers 404 (never 403); an owner on an admin-only
 * route 403; an environment not deployed through a Docker driver 409 NOT_DOCKER. Every write is
 * behind the root maintenance freeze and logged. Answers carry codes, names and field names —
 * never a secret value, a token or the agent's body text.
 */

const ENVS = 'nivaro_hub_environments'
const STACK_SETTINGS = 'nivaro_hub_stack_settings'

type Body = Record<string, unknown>

function fail(reply: FastifyReply, status: number, code: string, error: string) {
  return reply.code(status).send({ error, code })
}

const notFound = (reply: FastifyReply) => fail(reply, 404, 'NOT_FOUND', 'Not found')
const adminOnly = (reply: FastifyReply) =>
  fail(reply, 403, 'ADMIN_ONLY', 'Only a Hub administrator may do this')
const notDocker = (reply: FastifyReply) =>
  fail(reply, 409, 'NOT_DOCKER', 'This environment is not deployed through a Docker driver')

function userId(req: FastifyRequest): string {
  return String(req.user?.id ?? '')
}

function body(req: FastifyRequest): Body {
  const b = req.body
  return b && typeof b === 'object' && !Array.isArray(b) ? (b as Body) : {}
}

/**
 * The environment `envId` names when the caller may read it: admins any, anyone else only one
 * of an app they own. Undefined otherwise (the route answers 404).
 */
async function readableEnvironment(
  req: FastifyRequest
): Promise<Record<string, unknown> | undefined> {
  const id = idParam((req.params as { envId: string }).envId)
  if (id === null) return undefined
  const row = (await db(ENVS).where({ id }).first()) as Record<string, unknown> | undefined
  if (!row) return undefined
  if (!req.isAdmin && !(await isAppOwner(Number(row.app_id), userId(req)))) return undefined
  return row
}

/** HTTP status for an agent / refusal code: the agent not answering is a bad gateway. */
function statusFor(code: string, agentStatus = 0): number {
  if (code === 'AGENT_REFUSED') return 409
  if (
    code === 'AGENT_UNREACHABLE' ||
    code === 'AGENT_REDIRECT' ||
    code === 'AGENT_INCOMPATIBLE' ||
    code === 'AGENT_ERROR' ||
    code === 'ENGINE_ERROR' ||
    agentStatus >= 500
  )
    return 502
  return 409
}

/**
 * Maps what the agent client, the spec preparation or the hub secrets throw onto an answer;
 * anything else rethrows. The text comes from describeAgentError / our own messages only.
 */
function refusal(
  reply: FastifyReply,
  err: unknown,
  ctx: { stack?: string; hostnames?: string[] } = {}
) {
  if (err instanceof AgentError) {
    const out: Record<string, unknown> = {
      error: describeAgentError(err, ctx),
      code: err.code
    }
    if (err.fields?.length) out.fields = err.fields
    return reply.code(statusFor(err.code, err.status)).send(out)
  }
  if (err instanceof PromotionError) {
    const status = err.code.startsWith('AGENT_')
      ? statusFor(err.code)
      : err.status === 404 || err.status === 503
        ? err.status
        : 409
    return fail(reply, status, err.code, err.message)
  }
  const code = (err as { code?: unknown } | null)?.code
  if (
    err instanceof HubSecretError ||
    code === 'DRIVER_MISCONFIGURED' ||
    code === 'HUB_SECRET_UNREADABLE' ||
    code === 'HUB_SECRET_NOT_SEALED' ||
    code === 'HUB_NEEDS_ENCRYPTION_KEY'
  )
    return fail(reply, 409, String(code), (err as Error).message)
  throw err
}

/** Drops the environment's cached status and deploy history (best effort, bounded). */
async function forgetEnvironment(app: FastifyInstance, envId: number) {
  const redis = (app as unknown as { redis?: { del(...k: string[]): Promise<unknown> } }).redis
  if (!redis) return
  let timer: NodeJS.Timeout | undefined
  await Promise.race([
    Promise.resolve()
      .then(() => redis.del(hubStatusKey(envId), ...hubDeploysKeys(envId)))
      .catch(() => undefined),
    new Promise((resolve) => {
      timer = setTimeout(resolve, 300)
    })
  ]).finally(() => clearTimeout(timer))
}

type RestartOutcome =
  | { kind: 'refused'; code: string; text: string }
  | { kind: 'agent'; err: AgentError; hostnames: string[] }
  | { kind: 'ok'; result: StackRestartResult }

/** Agent codes the stack GET passes on as they are; anything else reads AGENT_UNREACHABLE. */
const KNOWN_AGENT_CODES = new Set([
  'AGENT_UNREACHABLE',
  'AGENT_REFUSED',
  'AGENT_REDIRECT',
  'AGENT_INCOMPATIBLE',
  'BAD_STACK_NAME',
  'STACK_NAME_INVALID',
  'STACK_NOT_HUB',
  'STACK_OWNER_MISMATCH',
  'EXPECT_INVALID',
  'ENGINE_ERROR',
  'ENGINE_FORBIDDEN'
])

const ownerMismatch = (reply: FastifyReply, name: string) =>
  fail(
    reply,
    409,
    'STACK_OWNER_MISMATCH',
    `The swarm's stack ${name} belongs to another Hub app or environment — the Hub never touches it from here`
  )

/** One name check per environment per this long, for everyone (DNS + an HTTP read each). */
export const CHECK_NAME_EVERY_MS = 10_000
const checkNameSeen = new Map<number, number>()

/**
 * True when this environment's name may be checked now (and marks it checked). Redis when the
 * app has it (every process shares the window), else this process's own map. A Redis error
 * falls back to the map.
 */
async function checkNameAllowed(app: FastifyInstance, envId: number): Promise<boolean> {
  const redis = (
    app as unknown as {
      redis?: { set(k: string, v: string, ...a: Array<string | number>): Promise<unknown> }
    }
  ).redis
  if (redis) {
    try {
      const ok = await redis.set(
        `nvr:hub:check-name:${envId}`,
        '1',
        'PX',
        CHECK_NAME_EVERY_MS,
        'NX'
      )
      return ok === 'OK'
    } catch {
      /* fall through to the process map */
    }
  }
  const now = Date.now()
  for (const [id, at] of checkNameSeen)
    if (now - at >= CHECK_NAME_EVERY_MS) checkNameSeen.delete(id)
  if (checkNameSeen.has(envId)) return false
  checkNameSeen.set(envId, now)
  return true
}

/** The agent's answer names nothing removed (every list empty, or every count 0). */
function nothingRemoved(r: StackRemoveResult): boolean {
  const kinds = r?.removed ? Object.values(r.removed) : []
  return kinds.every((k) => (Array.isArray(k) ? k.length === 0 : !k))
}

type RemoveOutcome =
  | { kind: 'absent' }
  | { kind: 'not_ours' }
  | { kind: 'removed'; removed: StackRemoveResult }

/**
 * After the agent removed the stack (or found none): the environment becomes `suspended` (the
 * write is tried twice) and the remove is logged. Neither failure fails the answer — the stack is
 * gone either way; each is logged with its error code only, never a value.
 */
async function afterRemove(
  req: FastifyRequest,
  envId: number,
  comment: { stack: string; volumes: boolean; already_absent?: true }
): Promise<void> {
  // The stack is gone: nothing runs a version here any more (P4-31 — key and placement edits are
  // allowed again; restart and Apply now answer NOT_DEPLOYED).
  const suspend = () =>
    db(ENVS)
      .where({ id: envId })
      .update({ status: 'suspended', version_pin: null, updated_at: new Date() })
  try {
    await suspend()
  } catch {
    try {
      await suspend()
    } catch (err) {
      req.log.warn(
        { env: envId, code: (err as { code?: unknown } | null)?.code ?? null },
        'hub stack removed but the environment status could not be set to suspended'
      )
    }
  }
  try {
    await logActivity({
      action: 'hub-stack-remove',
      user: userId(req),
      collection: ENVS,
      item: String(envId),
      req,
      comment: JSON.stringify(comment)
    })
  } catch (err) {
    req.log.warn(
      { env: envId, code: (err as { code?: unknown } | null)?.code ?? null },
      'hub stack removed but its activity row could not be written'
    )
  }
}

const promotionRunning = (reply: FastifyReply, key: string) =>
  fail(reply, 409, 'PROMOTION_RUNNING', `a promotion of ${key} is running — wait for it to end`)

/** The stored extension pins of an environment; null when they cannot be read whole. */
function pinsOf(row: Record<string, unknown>): Record<string, string> | null {
  const raw = row.extension_pins
  if (raw == null || (typeof raw === 'string' && !raw.trim())) return {}
  return strictPinMap(raw)
}

/**
 * Names (never values) of what a settings save changed: size / redis / publish_port /
 * extension_pins, `settings.<KEY>` added, removed or changed, `secrets.<KEY>` set or cleared (a
 * masked value keeps the stored one and is not a change) and secrets the save generated.
 */
function changedNames(
  before: StackSettingsRow | null,
  after: StackSettingsRow,
  sent: Body,
  pinsBefore: Record<string, string> | null,
  pinsAfter: Record<string, string> | undefined
): string[] {
  const out: string[] = []
  for (const k of ['size', 'redis', 'publish_port'] as const)
    if ((before?.[k] ?? null) !== after[k] && (before || sent[k] !== undefined)) out.push(k)
  const a = before?.settings ?? {}
  const b = after.settings
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)]))
    if (a[k] !== b[k]) out.push(`settings.${k}`)
  const secretsBefore = new Set(Object.keys(publicStackSettings(before)?.secrets ?? {}))
  const secretsAfter = new Set(Object.keys(publicStackSettings(after)?.secrets ?? {}))
  const touched = new Set<string>()
  const sentSecrets = sent.secrets
  if (sentSecrets && typeof sentSecrets === 'object' && !Array.isArray(sentSecrets))
    for (const [k, v] of Object.entries(sentSecrets as Body))
      if (v !== HUB_MASK && (secretsBefore.has(k) || secretsAfter.has(k))) touched.add(k)
  for (const k of secretsAfter) if (!secretsBefore.has(k)) touched.add(k)
  for (const k of secretsBefore) if (!secretsAfter.has(k)) touched.add(k)
  for (const k of [...touched].sort()) out.push(`secrets.${k}`)
  if (pinsAfter !== undefined && JSON.stringify(pinsBefore) !== JSON.stringify(pinsAfter))
    out.push('extension_pins')
  return out
}

function settingsAnswer(envId: number, row: StackSettingsRow | null, env: Record<string, unknown>) {
  const pub = publicStackSettings(row) ?? {
    environment_id: envId,
    size: 'small',
    redis: 'bundled',
    publish_port: null,
    settings: {},
    secrets: {}
  }
  const pins = pinsOf(env)
  return {
    ...pub,
    saved: row !== null,
    extension_pins: pins,
    ...(pins === null ? { extension_pins_error: 'UNREADABLE' } : {})
  }
}

export function hubDockerRoutes(app: FastifyInstance) {
  app.get('/drivers/:id/agent', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    const driver = id === null ? null : await getDriver(id)
    if (!driver) return notFound(reply)
    if (driver.kind !== 'docker')
      return fail(reply, 409, 'NOT_DOCKER', 'This driver is not a Docker driver')
    try {
      return { data: await agentHealth(driver) }
    } catch (err) {
      return refusal(reply, err)
    }
  })

  app.get('/environments/:envId/stack', { preHandler: requireAuth }, async (req, reply) => {
    const row = await readableEnvironment(req)
    if (!row) return notFound(reply)
    const envId = Number(row.id)
    const target = await dockerTargetOf(envId)
    if (!target) return notDocker(reply)
    const config = target.driver.config
    const env = environmentFromRow(row)
    let status: StackStatus | null = null
    let agent = 'ok'
    let localVolumesOnNodes: number | null = null
    /** P4-25: no service runs, but parts of this stack remain (what Remove stack clears). */
    let leftovers: {
      services: number
      secrets: number
      networks: number
      volumes: number
      extensions: boolean
    } | null = null
    if (!target.stackName) agent = 'NO_STACK_NAME'
    else {
      const deployed = await deployedStack(envId, target.stackName)
      try {
        const read = await agentStack(
          target.driver,
          target.stackName,
          deployed.state === 'ok' ? (deployed.specHash ?? undefined) : undefined
        )
        // Ruling P4-21: a stack labelled for another app or environment is not shown here.
        if (read && !ownsStack(read, target)) agent = 'STACK_OWNER_MISMATCH'
        else status = read
        if (read === null) {
          const left = await agentLeftovers(target.driver, target.stackName, {
            app: target.appKey,
            environment: target.envKey
          }).catch(() => null)
          const n = (xs: unknown) => (Array.isArray(xs) ? xs.length : 0)
          if (
            left &&
            (left.extensions === true ||
              n(left.services) + n(left.secrets) + n(left.networks) + n(left.volumes) > 0)
          )
            leftovers = {
              services: n(left.services),
              secrets: n(left.secrets),
              networks: n(left.networks),
              volumes: n(left.volumes),
              extensions: left.extensions === true
            }
        }
        // P4-33: local volumes on a swarm of several nodes split the stack's data.
        if (status) {
          const h = await agentHealth(target.driver).catch(() => null)
          const nodes = h?.swarm?.nodes
          if (typeof nodes === 'number' && nodes > 1 && (h?.volume_driver ?? 'local') === 'local')
            localVolumesOnNodes = nodes
        }
      } catch (err) {
        const code = err instanceof AgentError ? err.code : null
        agent = code && KNOWN_AGENT_CODES.has(code) ? code : 'AGENT_UNREACHABLE'
      }
    }
    return {
      data: {
        stack_name: target.stackName,
        dns_mode: config.dns_mode,
        name_request: config.dns_mode === 'manual' ? nameRequest(env, config) : null,
        status,
        agent,
        local_volumes_on_nodes: localVolumesOnNodes,
        leftovers
      }
    }
  })

  app.get(
    '/environments/:envId/stack/settings',
    { preHandler: requireAuth },
    async (req, reply) => {
      const row = await readableEnvironment(req)
      if (!row) return notFound(reply)
      if (!req.isAdmin) return adminOnly(reply)
      const envId = Number(row.id)
      if (!(await dockerTargetOf(envId))) return notDocker(reply)
      return { data: settingsAnswer(envId, await readStackSettings(envId), row) }
    }
  )

  app.put(
    '/environments/:envId/stack/settings',
    { preHandler: requireAuth },
    async (req, reply) => {
      const row = await readableEnvironment(req)
      if (!row) return notFound(reply)
      if (!req.isAdmin) return adminOnly(reply)
      const envId = Number(row.id)
      const target = await dockerTargetOf(envId)
      if (!target) return notDocker(reply)
      const sent = body(req)
      const existing = await readStackSettings(envId)
      const env = environmentFromRow(row) as HubEnvironmentRow
      try {
        const v = await validateStackSettings(sent, existing, {
          driver: target.driver.config,
          env,
          // Ruling P4-23: keys outside the known list need the agent's HUB_AGENT_ENV_PREFIXES;
          // health unknown = none (fail closed).
          envPrefixes: async () => {
            try {
              return agentEnvPrefixes(await agentHealth(target.driver))
            } catch {
              return null
            }
          }
        })
        if (!v.ok) {
          return reply
            .code(400)
            .send(
              v.field
                ? { error: v.message, code: v.code, field: v.field }
                : { error: v.message, code: v.code }
            )
        }
        const pinsBefore = pinsOf(row)
        const saved = await saveStackSettings(envId, v.row.fields, v.row.extension_pins)
        const fresh = (await db(ENVS).where({ id: envId }).first()) as Record<string, unknown>
        await logActivity({
          action: 'update',
          user: userId(req),
          collection: STACK_SETTINGS,
          item: String(envId),
          req,
          changed_fields: changedNames(existing, saved, sent, pinsBefore, v.row.extension_pins)
        })
        await forgetEnvironment(app, envId)
        return { data: settingsAnswer(envId, saved, fresh ?? row) }
      } catch (err) {
        if (err instanceof HubSecretError) return fail(reply, 400, err.code, err.message)
        throw err
      }
    }
  )

  app.post(
    '/environments/:envId/stack/restart',
    { preHandler: requireAuth },
    async (req, reply) => {
      const row = await readableEnvironment(req)
      if (!row) return notFound(reply)
      const envId = Number(row.id)
      const target = await dockerTargetOf(envId)
      if (!target) return notDocker(reply)
      const key = String(row.key)
      if (body(req).confirm !== key)
        return fail(reply, 400, 'CONFIRM_REQUIRED', `Type the environment key (${key}) to restart`)
      const name = target.stackName
      if (!name) return fail(reply, 409, 'NO_STACK_NAME', 'The placement names no swarm stack')
      try {
        const done = await withEnvironmentLock(envId, async (): Promise<RestartOutcome> => {
          // Ruling P4-16: never rebuilt from an inspect — the spec the stack runs, rendered fresh
          // from what the Hub recorded: version_pin, and the image + extension pins the same
          // converged deploy step recorded.
          const fresh = (await db(ENVS).where({ id: envId }).first()) as Record<string, unknown>
          const version = fresh?.version_pin == null ? null : String(fresh.version_pin)
          const deployed = await deployedStack(envId, name)
          if (!version || deployed.state === 'none')
            return {
              kind: 'refused',
              code: 'NOT_DEPLOYED',
              text: `${key} has no deployed stack to restart — deploy it first`
            }
          if (deployed.state === 'unreadable' || deployed.version !== version)
            return {
              kind: 'refused',
              code: 'STACK_STATE_UNKNOWN',
              text: `The Hub cannot tell which spec ${name} runs — deploy it instead of restarting`
            }
          const prepared = await prepareStackSpec(envId, {
            name,
            driverId: target.driver.id,
            version,
            image: deployed.image,
            // The pins that same deploy step installed, never the environment's current ones.
            extensions: deployed.extensions
          })
          try {
            return { kind: 'ok', result: await agentRestart(prepared.driver, name, prepared.spec) }
          } catch (err) {
            if (!(err instanceof AgentError)) throw err
            // The names the Hub sent let a HOSTNAME_TAKEN refusal say which one is taken.
            return { kind: 'agent', err, hostnames: [...prepared.spec.hostnames] }
          }
        })
        if (!done.held) return promotionRunning(reply, key)
        const v = done.value
        if (v.kind === 'refused') return fail(reply, 409, v.code, v.text)
        if (v.kind === 'agent')
          return refusal(reply, v.err, { stack: name, hostnames: v.hostnames })
        await logActivity({
          action: 'hub-stack-restart',
          user: userId(req),
          collection: ENVS,
          item: String(envId),
          req,
          comment: JSON.stringify({ stack: name })
        })
        await forgetEnvironment(app, envId)
        const services = Array.isArray(v.result?.services)
          ? v.result.services.filter((s): s is string => typeof s === 'string')
          : []
        return reply.code(202).send({ data: { services } })
      } catch (err) {
        return refusal(reply, err, { stack: name })
      }
    }
  )

  // Apply now (P4-30): the running version again with the recorded image and the saved settings
  // and extension pins — a stack update through the agent, run and recorded like a promotion.
  app.post('/environments/:envId/stack/apply', { preHandler: requireAuth }, async (req, reply) => {
    const row = await readableEnvironment(req)
    if (!row) return notFound(reply)
    const envId = Number(row.id)
    const target = await dockerTargetOf(envId)
    if (!target) return notDocker(reply)
    const key = String(row.key)
    if (body(req).confirm !== key)
      return fail(reply, 400, 'CONFIRM_REQUIRED', `Type the environment key (${key}) to apply`)
    try {
      const started = await startStackApply(envId, {
        confirm: body(req).confirm,
        user: { id: userId(req) }
      })
      await logActivity({
        action: 'hub-stack-apply',
        user: userId(req),
        collection: 'nivaro_hub_deploys',
        item: String(started.deployId),
        req
      })
      await forgetEnvironment(app, envId)
      return reply
        .code(202)
        .send({ data: { deploy_id: started.deployId, job_run_id: started.jobRunId } })
    } catch (err) {
      if (err instanceof PromotionError && err.blockers?.length)
        return reply
          .code(err.status === 404 ? 404 : 409)
          .send({ error: err.message, code: err.code, blockers: err.blockers })
      return refusal(reply, err, { stack: target.stackName ?? undefined })
    }
  })

  app.post('/environments/:envId/stack/remove', { preHandler: requireAuth }, async (req, reply) => {
    const row = await readableEnvironment(req)
    if (!row) return notFound(reply)
    if (!req.isAdmin) return adminOnly(reply)
    const envId = Number(row.id)
    const target = await dockerTargetOf(envId)
    if (!target) return notDocker(reply)
    const name = target.stackName
    if (!name) return fail(reply, 409, 'NO_STACK_NAME', 'The placement names no swarm stack')
    const b = body(req)
    if (b.confirm !== name)
      return fail(reply, 400, 'CONFIRM_REQUIRED', `Type the stack name (${name}) to remove it`)
    const removeVolumes = b.remove_volumes === true
    if (removeVolumes && b.confirm_volumes !== `delete ${name} data`)
      return fail(
        reply,
        400,
        'CONFIRM_REQUIRED',
        `Type "delete ${name} data" to remove the stack's volumes too`
      )
    try {
      // Its own hold on the environment's promotion lock: no promotion starts while the
      // stack is being taken down, and none is running when it starts.
      const done = await withEnvironmentLock(envId, async (): Promise<RemoveOutcome> => {
        // Ruling P4-21: the placement's name is a claim — the agent's labels must name this
        // app and environment before anything is removed.
        // A status 404 only means no service is left: secrets, the network, volumes or the
        // extensions folder may remain, so the remove still goes to the agent, which checks the
        // owner of every object itself.
        const status = await agentStack(target.driver, name)
        if (status && !ownsStack(status, target)) return { kind: 'not_ours' }
        try {
          const removed = await agentRemove(target.driver, name, {
            removeVolumes,
            owner: { app: target.appKey, environment: target.envKey }
          })
          return nothingRemoved(removed) ? { kind: 'absent' } : { kind: 'removed', removed }
        } catch (err) {
          if (err instanceof AgentError && err.code === 'STACK_NOT_FOUND') return { kind: 'absent' }
          throw err
        }
      })
      if (!done.held) return promotionRunning(reply, String(row.key))
      const v = done.value
      if (v.kind === 'not_ours') return ownerMismatch(reply, name)
      // From here the stack is gone: a failed follow-up write never turns that into an error.
      await afterRemove(req, envId, {
        stack: name,
        volumes: removeVolumes,
        ...(v.kind === 'absent' ? { already_absent: true } : {})
      })
      await forgetEnvironment(app, envId)
      return {
        data: v.kind === 'absent' ? { removed: false, already_absent: true } : v.removed
      }
    } catch (err) {
      return refusal(reply, err, { stack: name })
    }
  })

  app.post(
    '/environments/:envId/stack/check-name',
    { preHandler: requireAuth },
    async (req, reply) => {
      const row = await readableEnvironment(req)
      if (!row) return notFound(reply)
      const envId = Number(row.id)
      if (!(await dockerTargetOf(envId))) return notDocker(reply)
      // Owners only while the environment waits for its name; admins any time.
      if (!req.isAdmin && row.status !== 'waiting_for_name')
        return fail(
          reply,
          409,
          'NOT_WAITING_FOR_NAME',
          'This environment is not waiting for its name — there is nothing to check'
        )
      if (!(await checkNameAllowed(app, envId)))
        return fail(
          reply,
          429,
          'TOO_SOON',
          `The name was checked less than ${CHECK_NAME_EVERY_MS / 1000} s ago — try again shortly`
        )
      const version = row.version_pin == null ? null : String(row.version_pin)
      // merge: use phase 3 name-check — checkName(envId) replaces the look + flip below.
      const state = await lookName({ base_url: String(row.base_url) }, version)
      const flipped = state === 'serving' ? Number(await markNameServing(envId)) > 0 : false
      if (flipped) {
        await logActivity({
          action: 'hub-name-ready',
          user: userId(req),
          collection: ENVS,
          item: String(envId),
          req
        })
        await forgetEnvironment(app, envId)
      }
      const now = (await db(ENVS).where({ id: envId }).first('status')) as
        | { status: string }
        | undefined
      return { data: { state, status: now?.status ?? String(row.status) } }
    }
  )
}
