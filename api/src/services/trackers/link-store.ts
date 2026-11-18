import { db } from '../../db/index.js'
import { selectInChunks, whereInList } from '../db-batch.js'
import { parseIssueUrl } from './gitlab.js'
import type { RemoteIssue } from './types.js'

/**
 * Link rows (one per GitLab issue) and their members (the Nivaro issues it holds). Shared by the
 * public link API (links.ts) and the outbox sender (outbox.ts) so neither imports the other.
 */

export const LINKS = 'nivaro_tracker_links'
export const MEMBERS = 'nivaro_tracker_link_members'
export const SOURCE_ISSUE = 'issue'

/** What a link member is: an issue-log entry, a support ticket or a business record. */
export type MemberKind = 'issue' | 'ticket' | 'record'
export interface MemberRef {
  kind: MemberKind
  /** issue / ticket: the numeric id as text; record: `<collection>:<id>`. */
  id: string
}

export interface LinkView {
  id: number
  connection: number
  web_url: string
  project_path: string
  iid: number
  remote_state: string
  remote_title: string
  labels: string[]
  assignees: string[]
  milestone: string | null
  created_via: string
  sync_error: string | null
  /** Issue-log members (issue ids). */
  members: number[]
  /** Every member, issues included. */
  sources: MemberRef[]
}

export type JoinVia = 'lead' | 'fingerprint' | 'group' | 'similar' | 'manual'

type Row = Record<string, unknown>

const strList = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map(String)
  if (typeof v !== 'string' || !v) return []
  try {
    const p = JSON.parse(v)
    return Array.isArray(p) ? p.map(String) : []
  } catch {
    return []
  }
}

export function toLinkView(row: Row, members: number[], sources?: MemberRef[]): LinkView {
  return {
    id: Number(row.id),
    connection: Number(row.connection),
    web_url: String(row.web_url ?? ''),
    project_path: String(row.project_path ?? ''),
    iid: Number(row.external_iid),
    remote_state: String(row.remote_state ?? ''),
    remote_title: String(row.remote_title ?? ''),
    labels: strList(row.remote_labels),
    assignees: strList(row.remote_assignees),
    milestone: row.remote_milestone == null ? null : String(row.remote_milestone),
    created_via: String(row.created_via ?? ''),
    sync_error: row.sync_error == null ? null : String(row.sync_error),
    members,
    sources: sources ?? members.map((id) => ({ kind: 'issue' as const, id: String(id) }))
  }
}

/** The mirror columns a link keeps of its GitLab issue. */
export function mirrorFields(remote: RemoteIssue): Row {
  const updated = new Date(remote.updated_at)
  return {
    external_id: remote.id,
    web_url: String(remote.web_url ?? '').slice(0, 800),
    remote_state: remote.state,
    remote_title: String(remote.title ?? '').slice(0, 500),
    remote_labels: JSON.stringify(remote.labels ?? []),
    remote_assignees: JSON.stringify((remote.assignees ?? []).map((a) => a.username)),
    remote_milestone: remote.milestone?.title ?? null,
    remote_updated_at: Number.isNaN(updated.getTime()) ? null : updated,
    last_synced_at: new Date(),
    sync_error: null
  }
}

/** `group/project` from the issue's web URL, without the connection's own path prefix. */
export function projectPathFrom(webUrl: string, baseUrl: string): string {
  const parsed = parseIssueUrl(webUrl)
  if (!parsed) return ''
  let prefix = ''
  try {
    prefix = new URL(baseUrl).pathname.replace(/^\/+|\/+$/g, '')
  } catch {
    prefix = ''
  }
  const path = parsed.projectPath
  return prefix && path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : path
}

const idOf = (inserted: unknown[]): number => {
  const first = inserted[0]
  return Number(typeof first === 'object' && first !== null ? (first as { id: unknown }).id : first)
}

/**
 * The link row for this GitLab issue: the existing one (unique connection + project + iid),
 * refreshed from `remote`, else a new one.
 */
export async function upsertLinkFromRemote(
  connection: number,
  remote: RemoteIssue,
  info: {
    project_path: string
    created_via: 'manual' | 'rule' | 'linked'
    rule_id?: number | null
    fingerprint?: string | null
    created_by?: string | null
  }
): Promise<number> {
  const key = { connection, project_id: remote.project_id, external_iid: remote.iid }
  const find = async () => (await db(LINKS).where(key).first('id')) as Row | undefined
  const existing = await find()
  if (existing) {
    await db(LINKS).where({ id: existing.id }).update(mirrorFields(remote))
    return Number(existing.id)
  }
  const row: Row = {
    ...key,
    project_path: info.project_path.slice(0, 300),
    ...mirrorFields(remote),
    fingerprint: info.fingerprint ? String(info.fingerprint).slice(0, 64) : null,
    created_via: info.created_via,
    rule_id: info.rule_id ?? null,
    created_by: info.created_by ?? null,
    created_at: new Date()
  }
  try {
    return idOf((await db(LINKS).insert(row).returning('id')) as unknown[])
  } catch (err) {
    // another writer linked the same GitLab issue first: use theirs
    const raced = await find()
    if (raced) return Number(raced.id)
    throw err
  }
}

/** The member row holding this issue on this connection, if any. */
export async function memberFor(connection: number, issueId: number): Promise<Row | undefined> {
  return memberForSource(connection, SOURCE_ISSUE, String(issueId))
}

/** The member row holding this source (issue, ticket or record) on this connection, if any. */
export async function memberForSource(
  connection: number,
  kind: MemberKind,
  sourceId: string
): Promise<Row | undefined> {
  return (await db(MEMBERS)
    .where({ connection, source_kind: kind, source_id: String(sourceId) })
    .first()) as Row | undefined
}

/**
 * Add an issue to a link. Already on this link = no-op. Already on another link of the same
 * connection = 'conflict' (an issue maps to one GitLab issue per connection).
 */
export async function addMember(
  linkId: number,
  connection: number,
  issueId: number,
  via: JoinVia,
  score?: number | null
): Promise<'added' | 'present' | 'conflict'> {
  return addSourceMember(linkId, connection, SOURCE_ISSUE, String(issueId), via, score)
}

/** A similarity 0..1 worth storing, else null. */
export function memberScore(score: unknown): number | null {
  return typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 1
    ? score
    : null
}

/**
 * addMember for any source kind (one GitLab issue per source per connection). `score` is the
 * similarity it joined at (a look-alike join); it is stored only when it is a real 0..1 number.
 */
export async function addSourceMember(
  linkId: number,
  connection: number,
  kind: MemberKind,
  sourceId: string,
  via: JoinVia,
  score?: number | null
): Promise<'added' | 'present' | 'conflict'> {
  const existing = await memberForSource(connection, kind, sourceId)
  if (existing) return Number(existing.link) === linkId ? 'present' : 'conflict'
  try {
    await db(MEMBERS).insert({
      link: linkId,
      connection,
      source_kind: kind,
      source_id: String(sourceId).slice(0, 100),
      joined_via: via,
      joined_at: new Date(),
      ...(memberScore(score) != null ? { score: memberScore(score) } : {})
    })
    return 'added'
  } catch (err) {
    const raced = await memberForSource(connection, kind, sourceId)
    if (raced) return Number(raced.link) === linkId ? 'present' : 'conflict'
    throw err
  }
}

/** Views for these link ids, members included. */
export async function linkViews(linkIds: number[]): Promise<Map<number, LinkView>> {
  const out = new Map<number, LinkView>()
  const unique = [...new Set(linkIds.filter((n) => Number.isFinite(n)))]
  if (!unique.length) return out
  const rows = await selectInChunks(
    unique,
    500,
    async (chunk) => (await whereInList(db(LINKS), 'id', chunk)) as Row[]
  )
  const members = await selectInChunks(
    unique,
    500,
    async (chunk) =>
      (await whereInList(db(MEMBERS), 'link', chunk).select(
        'link',
        'source_kind',
        'source_id'
      )) as Row[]
  )
  const byLink = new Map<number, number[]>()
  const refsByLink = new Map<number, MemberRef[]>()
  for (const m of members) {
    const link = Number(m.link)
    const kind = String(m.source_kind ?? SOURCE_ISSUE) as MemberKind
    const refs = refsByLink.get(link) ?? []
    refs.push({ kind, id: String(m.source_id) })
    refsByLink.set(link, refs)
    if (kind !== SOURCE_ISSUE) continue
    const list = byLink.get(link) ?? []
    const n = Number(m.source_id)
    if (Number.isFinite(n)) list.push(n)
    byLink.set(link, list)
  }
  for (const r of rows)
    out.set(
      Number(r.id),
      toLinkView(r, byLink.get(Number(r.id)) ?? [], refsByLink.get(Number(r.id)) ?? [])
    )
  return out
}

export async function linkView(linkId: number): Promise<LinkView | null> {
  return (await linkViews([linkId])).get(linkId) ?? null
}
