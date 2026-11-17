import type { FastifyInstance } from 'fastify'
import { adminBaseUrl } from '../admin-base.js'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
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
import { TrackerError } from '../services/trackers/types.js'

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

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export async function trackerRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)
  app.addHook('preHandler', requireAdmin)

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
          .send({ error: err.message, code: 'INVALID_CONNECTION' })
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
}
