import { db } from '../../db/index.js'
import { getConnection } from './connections.js'
import { issueVars, loadIssue } from './issue-body.js'
import { safeLabels } from './labels.js'
import { LINKS } from './link-store.js'
import { enqueue, type LabelsPayload } from './outbox.js'
import { fenced, sanitizeMarkdown } from './templates.js'

/**
 * The "another example" note posted on a GitLab issue when a NEW Nivaro issue joins its link
 * (fingerprint, group, similar or manual), plus the connection's `on_example` labels. Shared by
 * links.ts (joinLink) and similar.ts (joinAsExample).
 */

const DETAILS_MAX = 1500

export interface ExampleNoteVars {
  issue_id: number
  title: string
  route: string | null
  first_seen: string
  hits_24h: number
  people_24h: number
  details: string | null
  nivaro_url: string
  score?: number
}

/** The marker the inbound side uses to skip Nivaro's own example notes. */
export const exampleMarker = (issueId: number) => `<!-- nivaro:example:${issueId} -->`

const one = (v: unknown) => sanitizeMarkdown(String(v ?? ''), { singleLine: true })
const num = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0
}

/** Every value goes through the markdown sanitiser; details are fenced, at most 1500 chars. */
export function exampleNoteBody(vars: ExampleNoteVars): string {
  const id = num(vars.issue_id)
  const score =
    typeof vars.score === 'number' && Number.isFinite(vars.score)
      ? ` (${Math.round(Math.min(1, Math.max(0, vars.score)) * 100)}% similar)`
      : ''
  const lines = [`**Another example** — Nivaro #${id}${score}`, '']
  const title = one(vars.title)
  if (title) lines.push(`**${title}**`)
  const route = one(vars.route)
  if (route) lines.push(`Route: ${route}`)
  const first = one(vars.first_seen)
  if (first) lines.push(`First seen: ${first}`)
  lines.push(`Last 24 hours: ${num(vars.hits_24h)} hits by ${num(vars.people_24h)} people`)
  const details = String(vars.details ?? '').slice(0, DETAILS_MAX)
  if (details.trim()) lines.push('', fenced(sanitizeMarkdown(details)))
  lines.push('', `[Open in Nivaro](${one(vars.nivaro_url)})`, '', exampleMarker(id))
  return lines.join('\n')
}

type Row = Record<string, unknown>

/**
 * Queue the example note (idempotency key `example:<link>:<issue>`, so one per issue per link)
 * and, when the connection has any, the `on_example` labels.
 */
export async function queueExample(linkId: number, issueId: number, score?: number): Promise<void> {
  const link = (await db(LINKS)
    .where({ id: linkId })
    .first('id', 'connection', 'project_id', 'external_iid')) as Row | undefined
  if (!link) return
  const connection = Number(link.connection)
  const project_id = Number(link.project_id)
  const iid = Number(link.external_iid)
  const issue = await loadIssue(issueId)
  if (!issue) return
  const vars = await issueVars(issue, true)
  const body = exampleNoteBody({
    issue_id: issueId,
    title: String(vars.title ?? ''),
    route: vars.route ? String(vars.route) : null,
    first_seen: String(vars.first_seen ?? ''),
    hits_24h: Number(vars.hits_24h) || 0,
    people_24h: Number(vars.people_24h) || 0,
    details: vars.details ? String(vars.details) : null,
    nivaro_url: String(vars.nivaro_url ?? ''),
    score
  })
  await enqueue({
    connection,
    link: linkId,
    source_id: String(issueId),
    op: 'comment',
    payload: { project_id, iid, body },
    key: `example:${linkId}:${issueId}`
  })
  const conn = await getConnection(connection)
  const add = safeLabels(conn?.sync?.labels?.on_example ?? [])
  if (!add.length) return
  const payload: LabelsPayload = { project_id, iid, add_labels: add, remove_labels: [] }
  await enqueue({
    connection,
    link: linkId,
    source_id: String(issueId),
    op: 'labels',
    payload,
    key: `example-labels:${linkId}:${issueId}`
  })
}
