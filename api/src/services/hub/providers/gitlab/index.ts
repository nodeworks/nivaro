import {
  type ConnectionTest,
  type DesiredResource,
  type HealthAnswer,
  type ListPage,
  type Observed,
  type OpResult,
  type PlannedOp,
  type ProviderAdapter,
  type ProviderContext,
  ProviderError
} from '../types.js'
import { baseOf, glCall, idSeg, pinOf, withScrub } from './client.js'
import { planGitlab } from './plan.js'
import { GITLAB_BUNDLED } from './pricing.js'
import {
  alreadyExists,
  archiveProject,
  type Created,
  type Handler,
  handlerFor,
  pinnedGroup,
  plainsOf
} from './resources.js'
import { T, TYPES } from './specs.js'

/**
 * GitLab (`gitlab`): a full provider on GitLab REST v4. Token (a group access token is preferred,
 * a project token or a personal access token works) + base URL (gitlab.com or a self-hosted
 * https address) + the ONE top-level group this connection is pinned to: every read by id checks
 * the project / group / runner is inside it, children through their parent.
 *
 * The existing Hub GitLab code (targets, drivers, promotions) is not touched: this adapter has its
 * own client over `ctx.fetch`, so the host is the admin-set one (https only; a private address
 * only through SSRF_ALLOW_HOSTS) and the token never follows a redirect off that host.
 *
 * Once-only values (a deploy token, a runner token) leave `apply` only as `OpResult.outputs`;
 * the engine seals them. Removing a project archives it; `destroy` deletes it for good.
 */

const ok = (
  externalId: string | null,
  observed: Observed | null,
  answer?: Record<string, unknown>,
  outputs?: Record<string, string>
): OpResult => ({
  ok: true,
  externalId,
  observed,
  ...(answer ? { answer } : {}),
  ...(outputs && Object.keys(outputs).length ? { outputs } : {})
})

/** A named op acts on the resource its plan named: the ref must be the one the id lives in. */
function assertTarget(h: Handler, ext: string, desired: DesiredResource | null): void {
  const t = h.target?.(ext)
  if (!t || !desired) return
  const want = desired.refs?.[t.field]
  if (typeof want !== 'string' || want !== t.id)
    throw new ProviderError(
      'TARGET_MISMATCH',
      `This change names a different ${t.field} than the one ${ext} lives in. Nothing was changed.`
    )
}

async function removeOldBestEffort(
  ctx: ProviderContext,
  h: Handler,
  oldExt: string
): Promise<Record<string, unknown>> {
  try {
    await h.remove(ctx, oldExt)
    return {}
  } catch (err) {
    // The new value is already made: never lose it over a failed removal.
    return {
      oldLeftInPlace: oldExt,
      oldRemoval: ctx.scrub(err instanceof Error ? err.message : String(err))
    }
  }
}

async function applyOne(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  const h = handlerFor(op.type)

  if (op.kind === 'delete') {
    const ext = op.externalId
    if (!ext) throw new ProviderError('BAD_ID', 'The resource to remove is not known.')
    const before = await h.observe(ctx, ext, true)
    if (!before) return ok(ext, null, { already: 'gone' })
    if (op.action === 'archive' && op.type === T.project) {
      await archiveProject(ctx, ext)
      return ok(ext, await h.observe(ctx, ext), { archived: true })
    }
    // `destroy` is the project's permanent delete; every other delete is the plain remove.
    await h.remove(ctx, ext)
    return ok(ext, null)
  }

  if (!desired) throw new ProviderError('BAD_PLAN', 'This change needs the desired values.')

  if (op.kind === 'create') {
    // Only the Hub's own interrupted create (an external id already recorded) may continue onto
    // an existing resource; anything else found there was not made by the Hub: never take it over.
    if (!desired.externalId && h.existing) {
      const found = await h.existing(ctx, desired)
      if (found) throw alreadyExists(`${found.name ?? found.externalId} already exists`)
    }
    if (desired.externalId) {
      const resumed = await h.observe(ctx, desired.externalId, true)
      // Its once-only values were sealed by the run that made it: nothing more to hand over.
      if (resumed) return ok(resumed.externalId, resumed, { already: 'exists' })
    }
    const made = await h.create(ctx, desired)
    return ok(made.externalId, await h.observe(ctx, made.externalId), undefined, made.outputs)
  }

  const ext = op.externalId
  if (!ext) throw new ProviderError('BAD_ID', 'The resource to change is not known.')

  if (op.kind === 'replace') {
    const old = await h.observe(ctx, ext, true)
    if (!old)
      throw new ProviderError('NOT_FOUND', 'The resource no longer exists.', { status: 404 })
    h.checkReplace?.(desired)
    if (h.replaceCreateFirst) {
      const made: Created = await h.create(ctx, desired)
      const left = await removeOldBestEffort(ctx, h, ext)
      return ok(
        made.externalId,
        await h.observe(ctx, made.externalId),
        { replaced: ext, ...left },
        made.outputs
      )
    }
    if (h.existing) {
      const found = await h.existing(ctx, desired)
      if (found && found.externalId !== ext)
        throw alreadyExists(`${found.name ?? found.externalId} already exists`)
    }
    await h.remove(ctx, ext)
    const made = await h.create(ctx, desired)
    return ok(
      made.externalId,
      await h.observe(ctx, made.externalId),
      { replaced: ext },
      made.outputs
    )
  }

  // update (plain, or the named rotate)
  assertTarget(h, ext, desired)
  const have = await h.observe(ctx, ext, true)
  if (!have) throw new ProviderError('NOT_FOUND', 'The resource no longer exists.', { status: 404 })
  if (op.action === 'rotate') {
    if (!h.rotate)
      throw new ProviderError('CAPABILITY_MISSING', `${op.type} has no token to rotate.`)
    const made = await h.rotate(ctx, ext, desired, have)
    const left = made.externalId !== ext ? await removeOldBestEffort(ctx, h, ext) : {}
    return ok(
      made.externalId,
      await h.observe(ctx, made.externalId),
      { rotated: true, ...left },
      made.outputs
    )
  }
  if (op.action)
    throw new ProviderError('CAPABILITY_MISSING', `${op.type} has no ${op.action} operation.`)
  await h.update(ctx, ext, desired, have)
  return ok(ext, await h.observe(ctx, ext))
}

// ── Health ──

const DAY = 86_400_000

function tokenHealth(ctx: ProviderContext, seen: Observed, checkedAt: string): HealthAnswer | null {
  const status = String(seen.status ?? '')
  if (status === 'expired') return { status: 'down', message: 'The token has expired.', checkedAt }
  if (status === 'revoked')
    return { status: 'down', message: 'The token has been revoked.', checkedAt }
  const at = seen.fields.expiresAt ? new Date(String(seen.fields.expiresAt)).getTime() : NaN
  if (Number.isFinite(at) && at - ctx.now().getTime() < 30 * DAY)
    return { status: 'warn', message: 'The token expires within 30 days.', checkedAt }
  return null
}

export const gitlabAdapter: ProviderAdapter = {
  bundledPrices: GITLAB_BUNDLED,
  key: 'gitlab',
  label: 'GitLab',
  connection: {
    fields: [
      {
        key: 'baseUrl',
        label: 'GitLab address',
        kind: 'string',
        required: true,
        default: 'https://gitlab.com',
        placeholder: 'https://gitlab.com',
        help: 'https only. A self-hosted address on a private network must also be listed in SSRF_ALLOW_HOSTS on this Hub.'
      },
      {
        key: 'groupPath',
        label: 'Group',
        kind: 'string',
        required: true,
        placeholder: 'acme',
        help: 'Pinned: this connection reads and changes only projects and groups inside this group (its full path).'
      },
      {
        key: 'token',
        label: 'Access token',
        kind: 'string',
        secret: true,
        required: true,
        help: 'A group access token with the api scope and the Maintainer role (a project token or a personal access token also works).'
      }
    ],
    hosts: (config) => {
      const b = baseOf(config)
      return b ? [b.host] : []
    },
    describe: (config) => {
      const b = baseOf(config)
      return `GitLab ${b?.host ?? 'unknown host'} · group ${String(config.groupPath ?? '')}`
    },
    validate(config, secrets) {
      const problems: string[] = []
      if (!baseOf(config))
        problems.push(
          'The GitLab address must be an https URL with a host name (no login, no query).'
        )
      const g = String(config.groupPath ?? '')
      if (
        !/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/.test(g) ||
        g.split('/').some((p) => p === '.' || p === '..')
      )
        problems.push('The group is its full path, such as acme or acme/platform.')
      if (secrets.token !== undefined && !secrets.token.trim())
        problems.push('The access token is empty.')
      return problems
    }
  },
  types: TYPES,

  async testConnection(ctx): Promise<ConnectionTest> {
    const needs = (has: { read: boolean; write: boolean }) =>
      TYPES.flatMap((t) => [
        { type: t.key, need: `read ${t.key}`, has: has.read },
        ...(t.capabilities.create || t.capabilities.update || t.capabilities.delete
          ? [
              {
                type: t.key,
                need: `write ${t.key} (token scope api, role Maintainer or above)`,
                has: has.write
              }
            ]
          : [])
      ])
    const fail = (message: string): ConnectionTest => {
      const permissions = needs({ read: false, write: false })
      return {
        ok: false,
        identity: null,
        permissions,
        missing: permissions.map((p) => p.need),
        message
      }
    }
    let user: any = null
    try {
      if (!baseOf(ctx.config)) return fail('The GitLab address is not a valid https URL.')
      const u = await glCall(ctx, 'GET', '/user', { allow: [403, 404] })
      user = u.status === 200 ? u.body : null
    } catch (err) {
      if (err instanceof ProviderError) return fail(ctx.scrub(err.message))
      throw err
    }
    let group: any = null
    try {
      group = await pinnedGroup(ctx)
    } catch (err) {
      if (err instanceof ProviderError) return fail(ctx.scrub(err.message))
      throw err
    }
    if (!group)
      return fail(`The token cannot see the group ${pinOf(ctx)} (check the path and the token).`)

    let scopes: Set<string> | null = null
    let expires: string | null = null
    try {
      const s = await glCall(ctx, 'GET', '/personal_access_tokens/self', { allow: [401, 403, 404] })
      if (s.status === 200 && Array.isArray(s.body?.scopes)) {
        scopes = new Set(s.body.scopes.map(String))
        expires = typeof s.body.expires_at === 'string' ? s.body.expires_at : null
      }
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err
    }
    let level: number | null = null
    if (user?.id != null) {
      try {
        const m = await glCall(
          ctx,
          'GET',
          `/groups/${idSeg(group.id, 'group id')}/members/all/${idSeg(user.id, 'user id')}`,
          { allow: [403, 404] }
        )
        if (m.status === 200 && typeof m.body?.access_level === 'number')
          level = m.body.access_level
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err
      }
    }
    const canRead = !scopes || scopes.has('api') || scopes.has('read_api')
    // Unknown scopes (the token cannot describe itself) are treated as not proven for writes.
    const canWrite = !!scopes && scopes.has('api') && (level == null || level >= 40)
    const permissions = needs({ read: canRead, write: canWrite })
    const soon =
      expires && new Date(expires).getTime() - ctx.now().getTime() < 30 * DAY
        ? `The token expires on ${expires.slice(0, 10)}.`
        : undefined
    return {
      ok: canRead,
      identity: `${user?.username ? `${String(user.username)} · ` : ''}group ${String(group.full_path ?? pinOf(ctx))}`,
      permissions,
      missing: permissions.filter((p) => !p.has).map((p) => p.need),
      ...(soon ? { message: soon } : {})
    }
  },

  observe: (ctx, type, externalId) => handlerFor(type).observe(ctx, externalId, false),

  async list(ctx, type, cursor): Promise<ListPage> {
    return handlerFor(type).list(ctx, cursor ?? null)
  },

  /** Plan time: what a create would collide with at GitLab (a path, a name, a key, a url). */
  async findExisting(ctx, type, desired) {
    if (desired.externalId) return null
    const h = handlerFor(type)
    if (!h.existing) return null
    try {
      return await h.existing(ctx, desired)
    } catch (err) {
      // A parent made in the same change has no id yet: nothing can collide yet.
      if (err instanceof ProviderError && err.code === 'INVALID_FIELDS') return null
      throw err
    }
  },

  plan(_ctx, desired, observed) {
    return planGitlab(desired, observed)
  },

  async apply(ctx, op, desired) {
    if (op.kind === 'noop') return ok(op.externalId, null)
    return applyOne(withScrub(ctx, plainsOf(desired)), op, desired)
  },

  async readOutputs(ctx, type, externalId) {
    const h = handlerFor(type)
    return h.readOutputs ? h.readOutputs(ctx, externalId) : {}
  },

  async health(ctx, type, externalId): Promise<HealthAnswer> {
    const checkedAt = ctx.now().toISOString()
    const seen = await handlerFor(type).observe(ctx, externalId, false)
    if (!seen) return { status: 'down', message: 'It is gone at GitLab.', checkedAt }
    if (type === T.project) {
      if (seen.fields.archived === true)
        return { status: 'warn', message: 'The project is archived (read-only).', checkedAt }
      if (seen.status === 'failed')
        return { status: 'down', message: 'The project import failed.', checkedAt }
      if (seen.status && seen.status !== 'active')
        return { status: 'warn', message: `The project is ${seen.status}.`, checkedAt }
    }
    if (type === T.deployToken) {
      const t = tokenHealth(ctx, seen, checkedAt)
      if (t) return t
    }
    if (type === T.webhook && seen.status) {
      const down = seen.status === 'disabled'
      return {
        status: down ? 'down' : 'warn',
        message: down
          ? 'GitLab turned the webhook off after repeated failures.'
          : 'GitLab paused the webhook after failures.',
        checkedAt
      }
    }
    if (type === T.runner) {
      if (seen.status === 'paused')
        return { status: 'warn', message: 'The runner is paused.', checkedAt }
      if (seen.status === 'offline')
        return { status: 'warn', message: 'The runner is offline.', checkedAt }
    }
    if (type === T.pipelineSchedule && seen.status === 'paused')
      return { status: 'warn', message: 'The schedule is paused.', checkedAt }
    if (type === T.environment && seen.status && seen.status !== 'available')
      return { status: 'warn', message: `The environment is ${seen.status}.`, checkedAt }
    return { status: 'ok', checkedAt }
  }
}
