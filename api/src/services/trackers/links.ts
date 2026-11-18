import { db } from '../../db/index.js'
import type { User } from '../../types.js'
import { selectInChunks, whereInList } from '../db-batch.js'
import { getConnection, providerFor, type TrackerConnection } from './connections.js'
import { queueExample } from './examples.js'
import { parseIssueUrl } from './gitlab.js'
import { buildIssueInput, loadIssue } from './issue-body.js'
import {
  addMember,
  addSourceMember,
  type JoinVia,
  LINKS,
  type LinkView,
  linkView,
  linkViews,
  MEMBERS,
  memberFor,
  memberForSource,
  mirrorFields,
  projectPathFrom,
  SOURCE_ISSUE,
  upsertLinkFromRemote
} from './link-store.js'
import { type CreatePayload, enqueue, kick, OUTBOX } from './outbox.js'
import type { RuleAction, TrackerRule } from './rules.js'
import { buildSourceInput } from './source-body.js'
import { sourceOn } from './source-switch.js'
import { type SourceKind, type SourceView, sourceFor } from './sources/index.js'
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

const SOURCE_WORDS: Record<SourceKind, string> = {
  issue: 'Issue-log entries',
  ticket: 'Support requests',
  record: 'Records'
}

/** A source switched off on the connection: nothing is created or linked for it. */
function assertSourceOn(conn: TrackerConnection, kind: SourceKind): void {
  if (!sourceOn(conn, kind))
    throw new LinkError(
      `${SOURCE_WORDS[kind]} are switched off for GitLab on this connection`,
      400,
      'SOURCE_OFF'
    )
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
    /** A rule-less action (a flow's gitlab.create_issue step); the rule's action wins. */
    action?: RuleAction
    via: 'manual' | 'rule'
    userId?: string
    /** Set by moveToNew: 2, 3, … — a new idempotency key and a new create marker. */
    generation?: number
  }
): Promise<{ outboxId: number }> {
  const issue = await loadIssue(issueId)
  if (!issue) throw new LinkError('Issue not found', 404, 'NOT_FOUND')
  const conn = await connectionOrThrow(opts.connection)
  assertSourceOn(conn, 'issue')
  if (await memberFor(opts.connection, issueId))
    throw new LinkError(
      'This issue already has a GitLab issue on this connection',
      409,
      'ALREADY_LINKED'
    )
  const action = opts.rule?.action ?? opts.action ?? null
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
  assertSourceOn(conn, 'issue')
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

// ── Tickets and records ───────────────────────────────────────────────────────

const sourceCreateKey = (connection: number, kind: SourceKind, id: string, generation: number) =>
  generation > 1
    ? `create:${connection}:${kind}:${id}:${generation}`
    : `create:${connection}:${kind}:${id}`

/** The links holding this source (one per connection), first link by id first. */
export async function linksForSource(kind: SourceKind, id: string): Promise<LinkView[]> {
  const rows = (await db(MEMBERS)
    .where({ source_kind: kind, source_id: String(id) })
    .select('link')) as Row[]
  const ids = [...new Set(rows.map((r) => Number(r.link)).filter(Number.isFinite))].sort(
    (a, b) => a - b
  )
  const views = await linkViews(ids)
  return ids.map((i) => views.get(i)).filter((v): v is LinkView => !!v)
}

/** Load a ticket / record for a create or a link (records read as `asUser`). */
async function viewFor(
  kind: SourceKind,
  id: string,
  asUser: User | null | undefined
): Promise<SourceView> {
  if (kind === 'record' && !asUser)
    throw new LinkError(
      'A record is read as the person who sends it to GitLab — none was given',
      400,
      'NO_READER'
    )
  const view = await sourceFor(kind).load(id, { asUser: asUser ?? null })
  if (!view)
    throw new LinkError(
      kind === 'ticket' ? 'Support request not found' : 'Record not found',
      404,
      'NOT_FOUND'
    )
  return view
}

/**
 * Queue a GitLab issue for any source. Issues go through requestCreate unchanged; tickets and
 * records are built by source-body.ts (records read as `asUser`, the creating person) and keyed
 * `create:<conn>:<kind>:<id>`.
 */
export async function requestSourceCreate(
  kind: SourceKind,
  id: string,
  opts: {
    connection: number
    project_id?: number
    overrides?: Partial<CreateIssueInput>
    rule?: TrackerRule
    action?: RuleAction
    via: 'manual' | 'rule'
    userId?: string
    asUser?: User | null
    generation?: number
  }
): Promise<{ outboxId: number }> {
  if (kind === 'issue')
    return requestCreate(Number(id), {
      connection: opts.connection,
      project_id: opts.project_id,
      overrides: opts.overrides,
      rule: opts.rule,
      action: opts.action,
      via: opts.via,
      userId: opts.userId,
      generation: opts.generation
    })
  const conn = await connectionOrThrow(opts.connection)
  assertSourceOn(conn, kind)
  const view = await viewFor(kind, id, opts.asUser)
  if (await memberForSource(conn.id, kind, view.id))
    throw new LinkError('This already has a GitLab issue on this connection', 409, 'ALREADY_LINKED')
  const action = opts.rule?.action ?? opts.action ?? null
  const projectId = opts.project_id ?? action?.project_id ?? conn.default_project_id ?? null
  if (!projectId)
    throw new LinkError(
      'Choose a GitLab project — this connection has no default project',
      400,
      'NO_PROJECT'
    )
  const generation = Math.max(1, Math.floor(Number(opts.generation) || 1))
  const input = await buildSourceInput(view, action, opts.overrides, {
    sync: conn.sync,
    generation
  })
  const payload: CreatePayload = {
    project_id: Number(projectId),
    issue: 0,
    source_kind: kind,
    source_id: view.id,
    input,
    created_via: opts.via,
    rule_id: opts.rule?.id ?? null,
    created_by: opts.userId ?? null
  }
  if (generation > 1) payload.generation = generation
  const key = sourceCreateKey(conn.id, kind, view.id, generation)
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
    connection: conn.id,
    link: null,
    source_kind: kind,
    source_id: view.id,
    op: 'create',
    payload,
    key
  })
  return { outboxId }
}

/** Add a ticket / record to an existing link; a new member gets one example note. */
export async function joinSourceLink(
  linkId: number,
  view: SourceView,
  via: 'similar' | 'manual',
  score?: number
): Promise<void> {
  const link = (await db(LINKS).where({ id: linkId }).first('id', 'connection')) as Row | undefined
  if (!link) throw new LinkError('Link not found', 404, 'NOT_FOUND')
  const res = await addSourceMember(linkId, Number(link.connection), view.kind, view.id, via)
  if (res === 'conflict')
    throw new LinkError('This already has a GitLab issue on this connection', 409, 'ALREADY_LINKED')
  if (res === 'added') {
    const { queueSourceExample } = await import('./examples.js')
    await queueSourceExample(linkId, view, score)
  }
}

/** Link a GitLab issue that already exists (pasted URL) to any source. */
export async function linkSourceExisting(
  kind: SourceKind,
  id: string,
  connection: number,
  url: string,
  user: User
): Promise<LinkView> {
  if (kind === 'issue') return linkExisting(Number(id), connection, url, user.id)
  const parsed = typeof url === 'string' ? parseIssueUrl(url.trim()) : null
  if (!parsed)
    throw new LinkError(
      'Paste the link of a GitLab issue (…/-/issues/<number>)',
      400,
      'BAD_ISSUE_URL'
    )
  const conn = await connectionOrThrow(connection)
  assertSourceOn(conn, kind)
  const view = await viewFor(kind, id, user)
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
  if (await memberForSource(connection, kind, view.id))
    throw new LinkError('This already has a GitLab issue on this connection', 409, 'ALREADY_LINKED')
  const projectPath = projectPathFrom(url.trim(), conn.base_url)
  const provider = await providerFor(connection)
  const project = await provider.project(projectPath)
  const remote = await provider.getIssue(project.id, parsed.iid)
  const existing = (await db(LINKS)
    .where({ connection, project_id: remote.project_id, external_iid: remote.iid })
    .first('id')) as Row | undefined
  let linkId: number
  if (existing) {
    linkId = Number(existing.id)
    await db(LINKS).where({ id: linkId }).update(mirrorFields(remote))
    await joinSourceLink(linkId, view, 'manual')
  } else {
    linkId = await upsertLinkFromRemote(connection, remote, {
      project_path: project.path_with_namespace || projectPath,
      created_via: 'linked',
      fingerprint: null,
      created_by: user.id || null
    })
    const added = await addSourceMember(linkId, connection, kind, view.id, 'lead')
    if (added === 'conflict')
      throw new LinkError(
        'This already has a GitLab issue on this connection',
        409,
        'ALREADY_LINKED'
      )
  }
  const out = await linkView(linkId)
  if (!out) throw new LinkError('Link not found', 404, 'NOT_FOUND')
  return out
}

/** unlink for any source (a link left with no members goes too). */
export async function unlinkSource(
  kind: SourceKind,
  id: string,
  connection?: number
): Promise<void> {
  if (kind === 'issue') return unlink(Number(id), connection)
  const scope: Row = { source_kind: kind, source_id: String(id) }
  if (connection !== undefined) scope.connection = connection
  const members = (await db(MEMBERS).where(scope).select('id', 'link')) as Row[]
  for (const m of members) await db(MEMBERS).where({ id: m.id }).delete()
  for (const linkId of [...new Set(members.map((m) => Number(m.link)))]) {
    const left = await db(MEMBERS).where({ link: linkId }).first('id')
    if (left) continue
    await db(OUTBOX).where({ link: linkId, status: 'pending' }).delete()
    await db(LINKS).where({ id: linkId }).delete()
  }
  const queued: Row = { op: 'create', source_kind: kind, source_id: String(id) }
  if (connection !== undefined) queued.connection = connection
  await db(OUTBOX).where(queued).where({ status: 'pending' }).delete()
}
