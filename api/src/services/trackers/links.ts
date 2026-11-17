import { db } from '../../db/index.js'
import { selectInChunks, whereInList } from '../db-batch.js'
import { getConnection, providerFor } from './connections.js'
import { queueExample } from './examples.js'
import { parseIssueUrl } from './gitlab.js'
import { buildIssueInput, loadIssue } from './issue-body.js'
import {
  addMember,
  type JoinVia,
  LINKS,
  type LinkView,
  linkView,
  linkViews,
  MEMBERS,
  memberFor,
  mirrorFields,
  projectPathFrom,
  SOURCE_ISSUE,
  upsertLinkFromRemote
} from './link-store.js'
import { type CreatePayload, enqueue, kick, OUTBOX } from './outbox.js'
import type { TrackerRule } from './rules.js'
import type { CreateIssueInput } from './types.js'

export type { LinkView } from './link-store.js'

/** Bulk create: at most this many issues per action. */
export const BULK_MAX = 50
/** Links one connection may open per hour before the bulk screen warns. */
export const CONNECTION_CAP_PER_HOUR = 30

export class LinkError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string
  ) {
    super(message)
    this.name = 'LinkError'
  }
}

type Row = Record<string, unknown>

export async function linkForIssue(issueId: number): Promise<LinkView | null> {
  return (await linksForIssues([issueId])).get(issueId) ?? null
}

/** The link of each issue (first link by id when an issue is linked on several connections). */
export async function linksForIssues(ids: number[]): Promise<Map<number, LinkView>> {
  const out = new Map<number, LinkView>()
  const keys = [...new Set(ids.filter((n) => Number.isFinite(n)).map(String))]
  if (!keys.length) return out
  const members = await selectInChunks(
    keys,
    500,
    async (chunk) =>
      (await whereInList(db(MEMBERS), 'source_id', chunk)
        .where({ source_kind: SOURCE_ISSUE })
        .select('link', 'source_id')) as Row[]
  )
  const views = await linkViews(members.map((m) => Number(m.link)))
  for (const m of [...members].sort((a, b) => Number(a.link) - Number(b.link))) {
    const issue = Number(m.source_id)
    const view = views.get(Number(m.link))
    if (view && !out.has(issue)) out.set(issue, view)
  }
  return out
}

async function connectionOrThrow(connection: number) {
  const conn = await getConnection(connection)
  if (!conn) throw new LinkError('Connection not found', 404, 'CONNECTION_NOT_FOUND')
  return conn
}

const createKey = (connection: number, issueId: number, generation: number) =>
  generation > 1
    ? `create:${connection}:${issueId}:${generation}`
    : `create:${connection}:${issueId}`

/** Queue a GitLab issue for this Nivaro issue. The outbox sends it (at once, then retries). */
export async function requestCreate(
  issueId: number,
  opts: {
    connection: number
    project_id?: number
    overrides?: Partial<CreateIssueInput>
    rule?: TrackerRule
    via: 'manual' | 'rule'
    userId?: string
    /** Set by moveToNew: 2, 3, … — a new idempotency key and a new create marker. */
    generation?: number
  }
): Promise<{ outboxId: number }> {
  const issue = await loadIssue(issueId)
  if (!issue) throw new LinkError('Issue not found', 404, 'NOT_FOUND')
  const conn = await connectionOrThrow(opts.connection)
  if (await memberFor(opts.connection, issueId))
    throw new LinkError(
      'This issue already has a GitLab issue on this connection',
      409,
      'ALREADY_LINKED'
    )
  const action = opts.rule?.action ?? null
  const projectId = opts.project_id ?? action?.project_id ?? conn.default_project_id ?? null
  if (!projectId)
    throw new LinkError(
      'Choose a GitLab project — this connection has no default project',
      400,
      'NO_PROJECT'
    )

  const generation = Math.max(1, Math.floor(Number(opts.generation) || 1))
  const input = await buildIssueInput(issueId, action, opts.overrides, {
    sync: conn.sync,
    generation
  })
  let mapEmail: string | null = null
  if (action?.map_assignee_by_email && !input.assignee_ids?.length && issue.assigned_to) {
    const u = (await db('nivaro_users').where({ id: issue.assigned_to }).first('email')) as
      | Row
      | undefined
    if (typeof u?.email === 'string' && u.email.includes('@')) mapEmail = u.email
  }
  const payload: CreatePayload = {
    project_id: Number(projectId),
    issue: issueId,
    input,
    attach_screenshot: !!action?.attach_screenshot && !!issue.screenshot,
    map_assignee_email: mapEmail,
    assign_nivaro_to: action?.assign_nivaro_to ?? null,
    created_via: opts.via,
    rule_id: opts.rule?.id ?? null,
    created_by: opts.userId ?? null
  }
  if (generation > 1) payload.generation = generation
  const key = createKey(opts.connection, issueId, generation)

  // A create that finished (then was unlinked) or died is asked for again: reuse its row.
  const old = (await db(OUTBOX).where({ idempotency_key: key }).first('id', 'status')) as
    | Row
    | undefined
  if (old && (old.status === 'done' || old.status === 'dead')) {
    await db(OUTBOX)
      .where({ id: old.id })
      .update({
        payload: JSON.stringify(payload),
        status: 'pending',
        attempts: 0,
        next_attempt_at: new Date(),
        last_error: null,
        done_at: null,
        link: null
      })
    kick(Number(old.id))
    return { outboxId: Number(old.id) }
  }
  const outboxId = await enqueue({
    connection: opts.connection,
    link: null,
    source_id: String(issueId),
    op: 'create',
    payload,
    key
  })
  return { outboxId }
}

/** Link an issue that already exists on GitLab (pasted URL). */
export async function linkExisting(
  issueId: number,
  connection: number,
  url: string,
  userId: string
): Promise<LinkView> {
  const parsed = typeof url === 'string' ? parseIssueUrl(url.trim()) : null
  if (!parsed)
    throw new LinkError(
      'Paste the link of a GitLab issue (…/-/issues/<number>)',
      400,
      'BAD_ISSUE_URL'
    )
  const issue = await loadIssue(issueId)
  if (!issue) throw new LinkError('Issue not found', 404, 'NOT_FOUND')
  const conn = await connectionOrThrow(connection)
  let sameHost = false
  try {
    sameHost = new URL(url.trim()).host.toLowerCase() === new URL(conn.base_url).host.toLowerCase()
  } catch {
    sameHost = false
  }
  if (!sameHost)
    throw new LinkError(
      `That issue is not on this connection's GitLab (${conn.base_url})`,
      400,
      'BAD_ISSUE_URL'
    )
  if (await memberFor(connection, issueId))
    throw new LinkError(
      'This issue already has a GitLab issue on this connection',
      409,
      'ALREADY_LINKED'
    )

  const projectPath = projectPathFrom(url.trim(), conn.base_url)
  const provider = await providerFor(connection)
  const project = await provider.project(projectPath)
  const remote = await provider.getIssue(project.id, parsed.iid)
  const existing = (await db(LINKS)
    .where({ connection, project_id: remote.project_id, external_iid: remote.iid })
    .first('id')) as Row | undefined
  if (existing) {
    await db(LINKS).where({ id: existing.id }).update(mirrorFields(remote))
    await joinLink(Number(existing.id), issueId, 'manual')
    const view = await linkView(Number(existing.id))
    if (!view) throw new LinkError('Link not found', 404, 'NOT_FOUND')
    return view
  }
  const linkId = await upsertLinkFromRemote(connection, remote, {
    project_path: project.path_with_namespace || projectPath,
    created_via: 'linked',
    fingerprint: (issue.fingerprint as string | null) ?? null,
    created_by: userId || null
  })
  const added = await addMember(linkId, connection, issueId, 'lead')
  if (added === 'conflict')
    throw new LinkError(
      'This issue already has a GitLab issue on this connection',
      409,
      'ALREADY_LINKED'
    )
  const view = await linkView(linkId)
  if (!view) throw new LinkError('Link not found', 404, 'NOT_FOUND')
  return view
}

/** Add an issue to an existing link (recurrence, grouped variant or a manual link). */
export async function joinLink(
  linkId: number,
  issueId: number,
  via: 'fingerprint' | 'group' | 'manual'
): Promise<void> {
  const link = (await db(LINKS).where({ id: linkId }).first('id', 'connection')) as Row | undefined
  if (!link) throw new LinkError('Link not found', 404, 'NOT_FOUND')
  const res = await addMember(linkId, Number(link.connection), issueId, via as JoinVia)
  if (res === 'conflict')
    throw new LinkError(
      'This issue already has a GitLab issue on this connection',
      409,
      'ALREADY_LINKED'
    )
  // A new member is a new example: one note (+ on_example labels). A repeat adds nothing.
  if (res === 'added') await queueExample(linkId, issueId)
}

/**
 * Remove an issue from its link(s) — on one connection, or on all when none is named. A link left
 * with no members is removed too, along with changes still queued for it; a create still queued
 * for this issue (on that connection) is dropped.
 */
export async function unlink(issueId: number, connection?: number): Promise<void> {
  const scope: Row = { source_kind: SOURCE_ISSUE, source_id: String(issueId) }
  if (connection !== undefined) scope.connection = connection
  const members = (await db(MEMBERS).where(scope).select('id', 'link')) as Row[]
  for (const m of members) await db(MEMBERS).where({ id: m.id }).delete()
  for (const linkId of [...new Set(members.map((m) => Number(m.link)))]) {
    const left = await db(MEMBERS).where({ link: linkId }).first('id')
    if (left) continue
    await db(OUTBOX).where({ link: linkId, status: 'pending' }).delete()
    await db(LINKS).where({ id: linkId }).delete()
  }
  const queued: Row = { op: 'create', source_kind: SOURCE_ISSUE, source_id: String(issueId) }
  if (connection !== undefined) queued.connection = connection
  await db(OUTBOX).where(queued).where({ status: 'pending' }).delete()
}

/**
 * "Move to a new GitLab issue": take the issue off its link on this connection and open a NEW
 * GitLab issue for it (same project as before). The create is generation n (n = earlier create
 * rows for this issue + 1, at least 2): its own idempotency key `create:<conn>:<issue>:<n>` and
 * its own marker, so the marker search never finds the GitLab issue it was moved away from.
 */
export async function moveToNew(
  issueId: number,
  connection: number,
  userId: string
): Promise<{ outboxId: number; generation: number }> {
  const issue = await loadIssue(issueId)
  if (!issue) throw new LinkError('Issue not found', 404, 'NOT_FOUND')
  await connectionOrThrow(connection)
  const member = await memberFor(connection, issueId)
  let projectId: number | undefined
  if (member) {
    const l = (await db(LINKS).where({ id: member.link }).first('project_id')) as Row | undefined
    if (l?.project_id != null) projectId = Number(l.project_id)
  }
  await unlink(issueId, connection)
  const prior = (await db(OUTBOX)
    .where({
      connection,
      op: 'create',
      source_kind: SOURCE_ISSUE,
      source_id: String(issueId)
    })
    .count({ n: '*' })
    .first()) as { n?: number | string } | undefined
  let generation = Math.max(2, (Number(prior?.n ?? 0) || 0) + 1)
  // A discarded row lowers the count: never reuse a key that is still there.
  while (
    await db(OUTBOX)
      .where({ idempotency_key: createKey(connection, issueId, generation) })
      .first('id')
  )
    generation++
  const { outboxId } = await requestCreate(issueId, {
    connection,
    project_id: projectId,
    via: 'manual',
    userId,
    generation
  })
  return { outboxId, generation }
}

/** Re-read the GitLab issue and refresh the mirror. GitLab errors are kept on the link. */
export async function resyncLink(linkId: number): Promise<LinkView> {
  const link = (await db(LINKS).where({ id: linkId }).first()) as Row | undefined
  if (!link) throw new LinkError('Link not found', 404, 'NOT_FOUND')
  try {
    const provider = await providerFor(Number(link.connection))
    const remote = await provider.getIssue(Number(link.project_id), Number(link.external_iid))
    await db(LINKS).where({ id: linkId }).update(mirrorFields(remote))
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 1000)
    await db(LINKS).where({ id: linkId }).update({ sync_error: msg })
    throw err
  }
  const view = await linkView(linkId)
  if (!view) throw new LinkError('Link not found', 404, 'NOT_FOUND')
  return view
}

export interface BulkResult {
  issue: number
  ok: boolean
  outbox_id?: number
  error?: string
  code?: string
}

/**
 * Create GitLab issues for up to 50 Nivaro issues. Manual creates are never capped; the answer
 * says whether this batch passes the connection's hourly cap (links opened in the last hour +
 * this batch > 30). `dry_run` answers only that.
 */
export async function bulkCreate(
  issues: number[],
  opts: { connection: number; project_id?: number; userId?: string; dry_run?: boolean }
): Promise<{ would_pass_cap: boolean; results: BulkResult[] }> {
  const list = [...new Set((Array.isArray(issues) ? issues : []).map(Number))].filter(
    (n) => Number.isInteger(n) && n > 0
  )
  if (list.length > BULK_MAX)
    throw new LinkError(`At most ${BULK_MAX} issues can be sent at once`, 400, 'TOO_MANY')
  if (!list.length) throw new LinkError('Choose at least one issue', 400, 'NO_ISSUES')
  await connectionOrThrow(opts.connection)
  const since = new Date(Date.now() - 3_600_000)
  const recent = (await db(LINKS)
    .where({ connection: opts.connection })
    .where('created_at', '>=', since)
    .count({ n: '*' })
    .first()) as { n?: number | string } | undefined
  const would_pass_cap = (Number(recent?.n ?? 0) || 0) + list.length > CONNECTION_CAP_PER_HOUR
  if (opts.dry_run) return { would_pass_cap, results: [] }

  const results: BulkResult[] = []
  for (const issue of list) {
    try {
      const { outboxId } = await requestCreate(issue, {
        connection: opts.connection,
        project_id: opts.project_id,
        via: 'manual',
        userId: opts.userId
      })
      results.push({ issue, ok: true, outbox_id: outboxId })
    } catch (err) {
      results.push({
        issue,
        ok: false,
        error: err instanceof Error ? err.message : 'Could not queue it',
        code: err instanceof LinkError ? err.code : 'FAILED'
      })
    }
  }
  return { would_pass_cap, results }
}
