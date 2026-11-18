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
import { mayCreateFrom } from '../services/trackers/create-access.js'
import {
  createRule,
  deleteRule,
  explainIssue,
  listRules,
  previewRule,
  RuleInputError,
  reorderRules,
  updateRule
} from '../services/trackers/engine.js'
import {
  FeatureLockedError,
  requireFeatureOn,
  setTrackersEnabled,
  trackersEnabled,
  trackersFeature
} from '../services/trackers/feature.js'
import {
  adminChipOf,
  BULK_MAX,
  bulkCreate,
  chipOf,
  type LinkChip,
  LinkError,
  linkForIssue,
  linkSourceExisting,
  linksForSource,
  moveToNew,
  requestSourceCreate,
  resyncLink,
  sourceTitleFor,
  unlink,
  unlinkSource
} from '../services/trackers/links.js'
import { discardOutbox, listOutbox, retryOutbox } from '../services/trackers/outbox.js'
import { validateRule } from '../services/trackers/rules.js'
import {
  findSimilar,
  findSimilarForSource,
  joinAsExample,
  joinSourceAsExample
} from '../services/trackers/similar.js'
import { sourceOn } from '../services/trackers/source-switch.js'
import {
  isSourceKind,
  normalizeSourceId,
  type SourceKind,
  sourceFor
} from '../services/trackers/sources/index.js'
import {
  defaultBodyTemplate,
  defaultTicketBodyTemplate,
  defaultTicketTitleTemplate,
  defaultTitleTemplate,
  RECORD_TEMPLATE_VARS,
  renderIssueTemplate,
  renderIssueTitle,
  TEMPLATE_VARS,
  TICKET_TEMPLATE_VARS
} from '../services/trackers/templates.js'
import { type CreateIssueInput, TrackerError } from '../services/trackers/types.js'

const SAMPLE_TEMPLATE_MAX = 20_000

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

type ReplyLike = { code: (n: number) => { send: (b: unknown) => unknown } }

function linkFailureReply(reply: ReplyLike, err: unknown) {
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

/**
 * The source a links body names: `{source_kind, source_id}` (issue | ticket | record, a record as
 * `<collection>:<id>`), or the issue-log form `{issue}`. Null when neither is valid.
 */
export function sourceOfBody(b: Record<string, unknown>): { kind: SourceKind; id: string } | null {
  if (b.source_kind !== undefined || b.source_id !== undefined) {
    if (!isSourceKind(b.source_kind)) return null
    const id = normalizeSourceId(b.source_kind, b.source_id)
    return id ? { kind: b.source_kind, id } : null
  }
  const issue = posInt(b.issue)
  return issue ? { kind: 'issue', id: String(issue) } : null
}

/**
 * Sign-in only: create / link a GitLab issue from a source. Admins for any source; others for
 * support tickets and records under the connection's create_roles (mayCreateFrom). Everything
 * else about GitLab sync stays in the admin plugin.
 */
export async function trackerSourceRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)
  app.addHook('preHandler', requireAuth)
  app.addHook('preHandler', requireFeatureOn)

  app.post('/links', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>
    const source = sourceOfBody(b)
    const connection = posInt(b.connection)
    if (!source || !connection)
      return reply.code(400).send({
        error: 'a source (issue, or source_kind + source_id) and connection are required',
        code: 'INVALID_BODY'
      })
    const may = await mayCreateFrom(req, source.kind, source.id, connection)
    if (!may.ok) return reply.code(may.status).send({ error: may.error, code: may.code })
    // A non-admin (create_roles) creates only in the connection's default project, with a title,
    // a description and extra labels — never assignees, milestone, confidentiality, weight, due
    // date, type or another project.
    const admin = !!req.isAdmin
    const overrides = admin ? cleanOverrides(b.overrides) : personOverrides(b.overrides)
    try {
      const { outboxId } = await requestSourceCreate(source.kind, source.id, {
        connection,
        project_id: admin ? posInt(b.project_id) : undefined,
        overrides,
        via: 'manual',
        userId: req.user?.id,
        asUser: req.user ?? null
      })
      return reply.code(202).send({ data: { outbox_id: outboxId } })
    } catch (err) {
      return linkFailureReply(reply, err)
    }
  })

  app.post('/links/existing', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>
    const source = sourceOfBody(b)
    const connection = posInt(b.connection)
    if (!source || !connection || !req.user)
      return reply.code(400).send({
        error: 'a source (issue, or source_kind + source_id) and connection are required',
        code: 'INVALID_BODY'
      })
    const may = await mayCreateFrom(req, source.kind, source.id, connection)
    if (!may.ok) return reply.code(may.status).send({ error: may.error, code: may.code })
    try {
      const admin = !!req.isAdmin
      const view = await linkSourceExisting(
        source.kind,
        source.id,
        connection,
        typeof b.url === 'string' ? b.url : '',
        req.user,
        { restricted: !admin }
      )
      // a non-admin gets the chip only (no labels, people or the link's other members) and
      // never GitLab's title: the title of what they linked, as they read it
      if (admin) return { data: view }
      return { data: chipOf(view, await sourceTitleFor(source.kind, source.id, req.user)) }
    } catch (err) {
      return linkFailureReply(reply, err)
    }
  })

  // The GitLab chip(s) of a ticket / record / issue: only for someone who can read it, only on
  // ACTIVE connections that sync that kind (a paused one syncs nothing), and only iid, link,
  // state and title.
  app.get('/links/for', async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, unknown>
    const source = sourceOfBody({ source_kind: q.source_kind, source_id: q.source_id })
    if (!source || !req.user)
      return reply
        .code(400)
        .send({ error: 'source_kind and source_id are required', code: 'INVALID_QUERY' })
    if (!(await sourceFor(source.kind).canRead(req.user, source.id, !!req.isAdmin)))
      return reply.code(404).send({ error: 'Not found', code: 'NOT_FOUND' })
    // A non-admin's chip never carries GitLab's title (chipOf): it carries the title of the source
    // they asked about, as they read it (a server issue's route only).
    const title = req.isAdmin ? null : await sourceTitleFor(source.kind, source.id, req.user)
    const out: Array<LinkChip & { connection?: number }> = []
    for (const view of await linksForSource(source.kind, source.id)) {
      const conn = await getConnection(view.connection)
      if (!conn?.is_active || !sourceOn(conn, source.kind)) continue
      if (req.isAdmin) out.push({ ...adminChipOf(view), connection: view.connection })
      else out.push(chipOf(view, title))
    }
    return { data: out }
  })

  // Connections this person may create / link on for a kind of source: admins every active
  // connection that syncs it; others those whose create_roles hold their role (tickets and
  // records only).
  app.get('/creatable', async (req, reply) => {
    const kind = (req.query as { source_kind?: unknown } | undefined)?.source_kind
    if (!isSourceKind(kind))
      return reply.code(400).send({ error: 'source_kind is required', code: 'INVALID_QUERY' })
    const role = String(req.user?.role ?? '').toLowerCase()
    const out: Array<{ id: number; name: string; default_project_path: string | null }> = []
    for (const conn of await listConnections()) {
      if (!conn.is_active || !sourceOn(conn, kind)) continue
      if (!req.isAdmin) {
        if (kind === 'issue' || !role) continue
        if (!(conn.sync.create_roles ?? []).some((r) => String(r).toLowerCase() === role)) continue
      }
      out.push({ id: conn.id, name: conn.name, default_project_path: conn.default_project_path })
    }
    return { data: out }
  })
}

/** Only a title, a description and extra labels — what a create_roles member may set. */
function personOverrides(raw: unknown): Partial<CreateIssueInput> | undefined {
  const all = cleanOverrides(raw)
  if (!all) return undefined
  const out: Partial<CreateIssueInput> = {}
  if (all.title !== undefined) out.title = all.title
  if (all.description !== undefined) out.description = all.description
  if (all.labels !== undefined) out.labels = all.labels
  return Object.keys(out).length ? out : undefined
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

  // Every connection with the address GitLab's webhook must call (the admin host, never a guess
  // from the browser).
  app.get('/', async () => ({
    data: (await listConnections()).map((c) => ({ ...c, webhook_url: webhookUrl(c.id) }))
  }))

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

  app.get('/:id/labels', async (req, reply) => {
    const id = idOf(req)
    const conn = await getConnection(id)
    if (!conn) return reply.code(404).send({ error: 'Connection not found' })
    const { project } = req.query as { project?: string }
    const projectId = posInt(project) ?? conn.default_project_id ?? undefined
    if (!projectId)
      return reply.code(400).send({ error: 'project is required', code: 'INVALID_QUERY' })
    return upstream(reply, async () => (await providerFor(id)).listLabels(projectId))
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
      return linkFailureReply(reply, err)
    }
  })

  // Before a manual create: GitLab issues that look like this one ("Add as example" instead).
  app.post('/links/similar', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>
    const source = sourceOfBody(b)
    const connection = posInt(b.connection)
    if (!source || !connection)
      return reply
        .code(400)
        .send({ error: 'issue and connection are required', code: 'INVALID_BODY' })
    const conn = await getConnection(connection)
    if (!conn)
      return reply.code(404).send({ error: 'Connection not found', code: 'CONNECTION_NOT_FOUND' })
    if (!sourceOn(conn, source.kind))
      return reply.code(400).send({
        error: 'This kind of item is switched off for GitLab on this connection',
        code: 'SOURCE_OFF'
      })
    const projectId = posInt(b.project_id) ?? conn.default_project_id ?? 0
    if (source.kind === 'issue')
      return { data: await findSimilar(Number(source.id), connection, projectId) }
    const view = await sourceFor(source.kind).load(source.id, { asUser: req.user ?? null })
    if (!view) return reply.code(404).send({ error: 'Not found', code: 'NOT_FOUND' })
    return { data: await findSimilarForSource(view, connection, projectId) }
  })

  // Add the issue as an example on an existing link or on a GitLab issue (project + iid).
  app.post('/links/join', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>
    const source = sourceOfBody(b)
    const connection = posInt(b.connection)
    if (!source || !connection)
      return reply
        .code(400)
        .send({ error: 'issue and connection are required', code: 'INVALID_BODY' })
    const link = posInt(b.link)
    let target: { link_id: number } | { project_id: number; iid: number }
    if (link) target = { link_id: link }
    else {
      const iid = posInt(b.iid)
      const projectId =
        posInt(b.project_id) ?? (await getConnection(connection))?.default_project_id ?? undefined
      if (!iid || !projectId)
        return reply.code(400).send({
          error: 'Name a link, or a GitLab project and issue number',
          code: 'INVALID_BODY'
        })
      target = { project_id: projectId, iid }
    }
    // A score from the similar list shows on the example note ("91% similar").
    const score = typeof b.score === 'number' && b.score >= 0 && b.score <= 1 ? b.score : undefined
    try {
      const via = score === undefined ? 'manual' : 'similar'
      let linkId: number
      if (source.kind === 'issue')
        linkId = await joinAsExample(Number(source.id), connection, target, via, score)
      else {
        const view = await sourceFor(source.kind).load(source.id, { asUser: req.user ?? null })
        if (!view) return reply.code(404).send({ error: 'Not found', code: 'NOT_FOUND' })
        linkId = await joinSourceAsExample(view, connection, target, via, score)
      }
      return { data: { link_id: linkId } }
    } catch (err) {
      return linkFailureReply(reply, err)
    }
  })

  // Unlink + open a NEW GitLab issue (never the one it is moved away from).
  app.post('/links/move-to-new', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>
    const issue = posInt(b.issue)
    if (!issue) return reply.code(400).send({ error: 'issue is required', code: 'INVALID_BODY' })
    const connection = posInt(b.connection) ?? (await linkForIssue(issue))?.connection
    if (!connection)
      return reply
        .code(400)
        .send({ error: 'This issue has no GitLab issue to move from', code: 'NOT_LINKED' })
    try {
      const data = await moveToNew(issue, connection, req.user?.id ?? '')
      return reply
        .code(202)
        .send({ data: { outbox_id: data.outboxId, generation: data.generation } })
    } catch (err) {
      return linkFailureReply(reply, err)
    }
  })

  app.delete('/links/issue/:issueId', async (req, reply) => {
    const issue = posInt((req.params as { issueId: string }).issueId)
    if (!issue) return reply.code(400).send({ error: 'Bad issue id', code: 'INVALID_PARAMS' })
    await unlink(issue)
    return reply.code(204).send()
  })

  // The GitLab issues a support ticket or a record is linked to (one per connection).
  app.get('/links/source/:kind/:id', async (req, reply) => {
    const p = req.params as { kind: string; id: string }
    const id = isSourceKind(p.kind) ? normalizeSourceId(p.kind, p.id) : null
    if (!isSourceKind(p.kind) || !id)
      return reply.code(400).send({ error: 'Bad source', code: 'INVALID_PARAMS' })
    return { data: await linksForSource(p.kind, id) }
  })

  // Unlink a support ticket or a record (`/links/source/record/workflows:9001`).
  app.delete('/links/source/:kind/:id', async (req, reply) => {
    const p = req.params as { kind: string; id: string }
    const id = isSourceKind(p.kind) ? normalizeSourceId(p.kind, p.id) : null
    if (!isSourceKind(p.kind) || !id)
      return reply.code(400).send({ error: 'Bad source', code: 'INVALID_PARAMS' })
    await unlinkSource(p.kind, id)
    return reply.code(204).send()
  })

  app.post('/links/:id/resync', async (req, reply) => {
    const id = posInt((req.params as { id: string }).id)
    if (!id) return reply.code(400).send({ error: 'Bad link id', code: 'INVALID_PARAMS' })
    try {
      return { data: await resyncLink(id) }
    } catch (err) {
      return linkFailureReply(reply, err)
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
  // ── Rules ───────────────────────────────────────────────────────────────────
  const ruleFailure = (reply: Reply, err: unknown) => {
    if (err instanceof RuleInputError)
      return reply
        .code(err.status)
        .send({ error: err.message, code: err.code, ...(err.errors ? { errors: err.errors } : {}) })
    throw err
  }

  app.get('/rules', async () => ({ data: await listRules() }))

  app.post('/rules', async (req, reply) => {
    try {
      return reply.code(201).send({ data: await createRule(req.body, req.user?.id ?? null) })
    } catch (err) {
      return ruleFailure(reply, err)
    }
  })

  app.patch('/rules/:id', async (req, reply) => {
    const id = posInt((req.params as { id: string }).id)
    if (!id) return reply.code(400).send({ error: 'Bad rule id', code: 'INVALID_PARAMS' })
    try {
      return { data: await updateRule(id, req.body, req.user?.id ?? null) }
    } catch (err) {
      return ruleFailure(reply, err)
    }
  })

  app.delete('/rules/:id', async (req, reply) => {
    const id = posInt((req.params as { id: string }).id)
    if (!id) return reply.code(400).send({ error: 'Bad rule id', code: 'INVALID_PARAMS' })
    if (!(await deleteRule(id)))
      return reply.code(404).send({ error: 'Rule not found', code: 'NOT_FOUND' })
    return reply.code(204).send()
  })

  app.post('/rules/reorder', async (req, reply) => {
    const ids = (req.body as { ids?: unknown } | null)?.ids
    if (
      !Array.isArray(ids) ||
      ids.length > 1000 ||
      !ids.every((n) => Number.isInteger(n) && (n as number) > 0) ||
      new Set(ids).size !== ids.length
    )
      return reply
        .code(400)
        .send({ error: 'ids must be a list of distinct rule ids', code: 'INVALID_BODY' })
    await reorderRules(ids as number[], req.user?.id ?? null)
    return { data: await listRules() }
  })

  // Read-only: what a draft rule would have opened in the last 7 or 30 days.
  app.post('/rules/preview', async (req, reply) => {
    const b = (req.body ?? {}) as { rule?: unknown; days?: unknown }
    const days = b.days === undefined || b.days === null ? 7 : b.days
    if (days !== 7 && days !== 30)
      return reply.code(400).send({ error: 'days must be 7 or 30', code: 'INVALID_BODY' })
    const res = validateRule(b.rule)
    if (!res.ok)
      return reply
        .code(400)
        .send({ error: 'The rule is not valid', code: 'INVALID_RULE', errors: res.errors })
    return { data: await previewRule(res.rule, days) }
  })

  app.get('/rules/explain', async (req, reply) => {
    const issue = posInt((req.query as { issue?: string }).issue)
    if (!issue) return reply.code(400).send({ error: 'issue is required', code: 'INVALID_QUERY' })
    if (!(await db('nivaro_issues').where({ id: issue }).first('id')))
      return reply.code(404).send({ error: 'Issue not found', code: 'NOT_FOUND' })
    return { data: await explainIssue(issue) }
  })

  // Read-only: a rule's title / body / label templates rendered for one recent issue or support
  // ticket, exactly as a create would render them (empty template = the kind's default).
  app.post('/rules/sample', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>
    const kind: 'issue' | 'ticket' = b.applies_to === 'ticket' ? 'ticket' : 'issue'
    const id = normalizeSourceId(kind, b.source_id)
    if (!id) return reply.code(400).send({ error: 'source_id is required', code: 'INVALID_BODY' })
    const text = (v: unknown) => (typeof v === 'string' ? v.slice(0, SAMPLE_TEMPLATE_MAX) : '')
    const titleTpl =
      text(b.title_template).trim() ||
      (kind === 'ticket' ? defaultTicketTitleTemplate() : defaultTitleTemplate())
    const bodyTpl =
      text(b.body_template).trim() ||
      (kind === 'ticket' ? defaultTicketBodyTemplate() : defaultBodyTemplate())
    const labelTpls = Array.isArray(b.labels)
      ? b.labels
          .filter((l): l is string => typeof l === 'string')
          .slice(0, 50)
          .map((l) => l.slice(0, 255))
      : []
    const view = await sourceFor(kind).load(id, {
      asUser: req.user ?? null,
      includeDetails: b.include_details !== false
    })
    if (!view) return reply.code(404).send({ error: 'Not found', code: 'NOT_FOUND' })
    try {
      const labels: string[] = []
      for (const l of labelTpls) {
        const out = (await renderIssueTitle(l, view.vars)).trim()
        if (out) labels.push(out)
      }
      return {
        data: {
          title: (await renderIssueTitle(titleTpl, view.vars)).trim(),
          body: await renderIssueTemplate(bodyTpl, view.vars),
          labels
        }
      }
    } catch (err) {
      return reply.code(400).send({
        error: err instanceof Error ? err.message : 'The template could not be rendered',
        code: 'TEMPLATE_ERROR'
      })
    }
  })

  // ?kind=ticket | record: the variables a support-request / record template gets.
  app.get('/rules/template-vars', async (req) => {
    const kind = (req.query as { kind?: string } | undefined)?.kind
    if (kind === 'ticket') return { data: TICKET_TEMPLATE_VARS }
    if (kind === 'record') return { data: RECORD_TEMPLATE_VARS }
    return { data: TEMPLATE_VARS }
  })
}
