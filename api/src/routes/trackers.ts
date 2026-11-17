import type { FastifyInstance } from 'fastify'
import { adminBaseUrl } from '../admin-base.js'
import { db } from '../db/index.js'
import { authenticate, requireAdmin, requireAuth } from '../middleware/authenticate.js'
import {
  ConnectionInputError,
  getConnection,
  listConnections,
  markBroken,
  markOk,
  providerFor,
  rotateWebhookSecret,
  saveConnection
} from '../services/trackers/connections.js'
import {
  FeatureLockedError,
  requireFeatureOn,
  setTrackersEnabled,
  trackersEnabled,
  trackersFeature
} from '../services/trackers/feature.js'
import {
  BULK_MAX,
  bulkCreate,
  LinkError,
  linkExisting,
  requestCreate,
  resyncLink,
  unlink
} from '../services/trackers/links.js'
import { discardOutbox, listOutbox, retryOutbox } from '../services/trackers/outbox.js'
import { type CreateIssueInput, TrackerError } from '../services/trackers/types.js'

const webhookUrl = (id: number) => `${adminBaseUrl() ?? ''}/api/tracker-hooks/gitlab/${id}`

function hintFor(err: unknown, host: string): string {
  if (err instanceof TrackerError) {
    if (err.kind === 'auth')
      return 'GitLab refused the token. It needs the api scope and Reporter (or higher) access to the project.'
    if (err.kind === 'not_found') return "Project not found or the token can't see it."
    if (/private\/(loopback|reserved)/.test(err.message))
      return 'This GitLab is on a private address. Add its host to SSRF_ALLOW_HOSTS on the API and restart.'
    if (err.kind === 'network') return `Nivaro could not reach ${host}.`
  }
  return 'GitLab did not answer as expected.'
}

/** Only the CreateIssueInput keys an admin may override, with the right types. */
function cleanOverrides(raw: unknown): Partial<CreateIssueInput> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const o = raw as Record<string, unknown>
  const out: Partial<CreateIssueInput> = {}
  if (typeof o.title === 'string' && o.title.trim()) out.title = o.title.trim()
  if (typeof o.description === 'string') out.description = o.description
  if (Array.isArray(o.labels)) out.labels = o.labels.filter((l) => typeof l === 'string')
  if (Array.isArray(o.assignee_ids))
    out.assignee_ids = o.assignee_ids.filter((n): n is number => Number.isInteger(n))
  if (Number.isInteger(o.milestone_id)) out.milestone_id = o.milestone_id as number
  if (typeof o.due_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.due_date))
    out.due_date = o.due_date
  if (Number.isInteger(o.weight)) out.weight = o.weight as number
  if (typeof o.confidential === 'boolean') out.confidential = o.confidential
  if (o.issue_type === 'issue' || o.issue_type === 'incident') out.issue_type = o.issue_type
  return Object.keys(out).length ? out : undefined
}

const posInt = (v: unknown): number | undefined => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : undefined
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** Sign-in only: lets any screen hide GitLab bits when the feature is off. */
export async function trackerFeaturePublicRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)
  app.addHook('preHandler', requireAuth)
  app.get('/feature/public', async () => ({ data: { enabled: await trackersEnabled() } }))
}

export async function trackerRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)
  app.addHook('preHandler', requireAdmin)
  app.addHook('preHandler', requireFeatureOn)

  app.get('/feature', async () => ({ data: await trackersFeature() }))

  app.put('/feature', async (req, reply) => {
    const enabled = (req.body as { enabled?: unknown } | null)?.enabled
    if (typeof enabled !== 'boolean')
      return reply.code(400).send({ error: 'enabled must be true or false', code: 'INVALID_BODY' })
    try {
      return { data: await setTrackersEnabled(enabled, req.user?.id ?? '') }
    } catch (err) {
      if (err instanceof FeatureLockedError)
        return reply.code(409).send({ error: err.message, code: err.code })
      throw err
    }
  })

  const idOf = (req: { params: unknown }) => Number((req.params as { id: string }).id)

  app.get('/', async () => ({ data: await listConnections() }))

  app.post('/', async (req, reply) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>
      const view = await saveConnection(
        { ...(body as object), id: undefined } as never,
        req.user?.id ?? ''
      )
      const secret = await rotateWebhookSecret(view.id)
      return reply
        .code(201)
        .send({ data: { ...view, webhook_secret: secret, webhook_url: webhookUrl(view.id) } })
    } catch (err) {
      if (err instanceof ConnectionInputError)
        return reply.code(400).send({ error: err.message, code: 'INVALID_CONNECTION' })
      throw err
    }
  })

  app.patch('/:id', async (req, reply) => {
    const id = idOf(req)
    try {
      const body = (req.body ?? {}) as Record<string, unknown>
      const view = await saveConnection({ ...(body as object), id } as never, req.user?.id ?? '')
      return { data: view }
    } catch (err) {
      if (err instanceof ConnectionInputError)
        return reply
          .code(err.message === 'Connection not found' ? 404 : 400)
          .send({ error: err.message, code: err.code })
      throw err
    }
  })

  app.delete('/:id', async (req, reply) => {
    const id = idOf(req)
    const link = await db('nivaro_tracker_links').where({ connection: id }).first('id')
    const rule = await db('nivaro_tracker_rules')
      .where({ connection: id, enabled: true })
      .first('id')
    if (link || rule)
      return reply.code(409).send({
        error: 'This connection still has linked issues or enabled rules',
        code: 'TRACKER_IN_USE'
      })
    await db('nivaro_tracker_connections').where({ id }).delete()
    return reply.code(204).send()
  })

  app.post('/:id/test', async (req, reply) => {
    const id = idOf(req)
    const conn = await getConnection(id)
    if (!conn) return reply.code(404).send({ error: 'Connection not found' })
    try {
      const provider = await providerFor(id)
      const user = await provider.whoami()
      let project: { id: number; path_with_namespace: string } | null = null
      let access_level: number | null = null
      const ref = conn.default_project_id ?? conn.default_project_path
      if (ref != null) {
        const p = await provider.project(ref)
        project = { id: p.id, path_with_namespace: p.path_with_namespace }
        access_level = p.access_level
      }
      await markOk(id)
      return {
        ok: true,
        user,
        project,
        access_level,
        webhook: { last_seen_at: conn.last_webhook_at }
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Request failed'
      await markBroken(id, error).catch(() => {})
      return { ok: false, error, hint: hintFor(err, hostOf(conn.base_url)) }
    }
  })

  app.post('/:id/rotate-secret', async (req, reply) => {
    const id = idOf(req)
    if (!(await getConnection(id))) return reply.code(404).send({ error: 'Connection not found' })
    const secret = await rotateWebhookSecret(id)
    return { secret, webhook_url: webhookUrl(id) }
  })

  const upstream = async (
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
    fn: () => Promise<unknown>
  ) => {
    try {
      return { data: await fn() }
    } catch (err) {
      if (err instanceof TrackerError)
        return reply.code(502).send({ error: err.message, code: 'TRACKER_ERROR', kind: err.kind })
      throw err
    }
  }

  app.get('/:id/projects', async (req, reply) => {
    const id = idOf(req)
    const { search } = req.query as { search?: string }
    return upstream(reply, async () => (await providerFor(id)).searchProjects(search ?? ''))
  })

  app.get('/:id/users', async (req, reply) => {
    const id = idOf(req)
    const { search, project } = req.query as { search?: string; project?: string }
    const projectId = Number(project)
    if (!Number.isFinite(projectId))
      return reply.code(400).send({ error: 'project is required', code: 'INVALID_QUERY' })
    return upstream(reply, async () => (await providerFor(id)).searchUsers(search ?? '', projectId))
  })

  app.get('/:id/health', async (req, reply) => {
    const id = idOf(req)
    const conn = await getConnection(id)
    if (!conn) return reply.code(404).send({ error: 'Connection not found' })
    const rows = (await db('nivaro_tracker_outbox')
      .where({ connection: id })
      .whereIn('status', ['pending', 'dead'])
      .groupBy('status')
      .select('status')
      .count({ n: '*' })) as Array<{ status: string; n: number | string }>
    const count = (s: string) => Number(rows.find((r) => r.status === s)?.n ?? 0)
    return {
      data: {
        outbox: { pending: count('pending'), dead: count('dead') },
        last_webhook_at: conn.last_webhook_at,
        last_reconcile_at: conn.last_reconcile_at,
        status: conn.status
      }
    }
  })

  // ── Links + outbox ──────────────────────────────────────────────────────────
  type Reply = { code: (n: number) => { send: (b: unknown) => unknown } }
  const linkFailure = (reply: Reply, err: unknown) => {
    if (err instanceof LinkError)
      return reply.code(err.status).send({ error: err.message, code: err.code })
    if (err instanceof TrackerError) {
      if (err.kind === 'not_found')
        return reply
          .code(404)
          .send({ error: 'GitLab issue not found, or the token cannot see it', code: 'NOT_FOUND' })
      return reply.code(502).send({ error: err.message, code: 'TRACKER_ERROR', kind: err.kind })
    }
    throw err
  }

  app.post('/links', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>
    const issue = posInt(b.issue)
    const connection = posInt(b.connection)
    if (!issue || !connection)
      return reply
        .code(400)
        .send({ error: 'issue and connection are required', code: 'INVALID_BODY' })
    try {
      const { outboxId } = await requestCreate(issue, {
        connection,
        project_id: posInt(b.project_id),
        overrides: cleanOverrides(b.overrides),
        via: 'manual',
        userId: req.user?.id
      })
      return reply.code(202).send({ data: { outbox_id: outboxId } })
    } catch (err) {
      return linkFailure(reply, err)
    }
  })

  app.post('/links/existing', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>
    const issue = posInt(b.issue)
    const connection = posInt(b.connection)
    if (!issue || !connection)
      return reply
        .code(400)
        .send({ error: 'issue and connection are required', code: 'INVALID_BODY' })
    try {
      const view = await linkExisting(
        issue,
        connection,
        typeof b.url === 'string' ? b.url : '',
        req.user?.id ?? ''
      )
      return { data: view }
    } catch (err) {
      return linkFailure(reply, err)
    }
  })

  app.post('/links/bulk', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>
    const connection = posInt(b.connection)
    if (!connection || !Array.isArray(b.issues))
      return reply
        .code(400)
        .send({ error: 'issues and connection are required', code: 'INVALID_BODY' })
    if (b.issues.length > BULK_MAX)
      return reply
        .code(400)
        .send({ error: `At most ${BULK_MAX} issues can be sent at once`, code: 'TOO_MANY' })
    try {
      const data = await bulkCreate(b.issues as number[], {
        connection,
        project_id: posInt(b.project_id),
        userId: req.user?.id,
        dry_run: b.dry_run === true
      })
      return { data }
    } catch (err) {
      return linkFailure(reply, err)
    }
  })

  app.delete('/links/issue/:issueId', async (req, reply) => {
    const issue = posInt((req.params as { issueId: string }).issueId)
    if (!issue) return reply.code(400).send({ error: 'Bad issue id', code: 'INVALID_PARAMS' })
    await unlink(issue)
    return reply.code(204).send()
  })

  app.post('/links/:id/resync', async (req, reply) => {
    const id = posInt((req.params as { id: string }).id)
    if (!id) return reply.code(400).send({ error: 'Bad link id', code: 'INVALID_PARAMS' })
    try {
      return { data: await resyncLink(id) }
    } catch (err) {
      return linkFailure(reply, err)
    }
  })

  app.get('/outbox', async (req) => {
    const { status, connection } = req.query as { status?: string; connection?: string }
    const s = ['pending', 'sending', 'done', 'dead'].includes(String(status)) ? status : undefined
    return { data: await listOutbox({ status: s, connection: posInt(connection) }) }
  })

  app.post('/outbox/:id/retry', async (req, reply) => {
    const id = posInt((req.params as { id: string }).id)
    if (!id) return reply.code(400).send({ error: 'Bad id', code: 'INVALID_PARAMS' })
    const r = await retryOutbox(id)
    if (r === 'missing') return reply.code(404).send({ error: 'Not found', code: 'NOT_FOUND' })
    if (r === 'busy')
      return reply.code(409).send({ error: 'This change is not waiting', code: 'NOT_RETRYABLE' })
    return { ok: true }
  })

  app.post('/outbox/:id/discard', async (req, reply) => {
    const id = posInt((req.params as { id: string }).id)
    if (!id) return reply.code(400).send({ error: 'Bad id', code: 'INVALID_PARAMS' })
    const r = await discardOutbox(id)
    if (r === 'missing') return reply.code(404).send({ error: 'Not found', code: 'NOT_FOUND' })
    if (r === 'busy')
      return reply.code(409).send({ error: 'This change is being sent right now', code: 'SENDING' })
    return reply.code(204).send()
  })
}
