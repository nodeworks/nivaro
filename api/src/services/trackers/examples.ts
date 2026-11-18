import { db } from '../../db/index.js'
import { getConnection } from './connections.js'
import { issueVars, loadIssue, nivaroIssueUrl } from './issue-body.js'
import { safeLabels } from './labels.js'
import { LINKS } from './link-store.js'
import { enqueue, type LabelsPayload, OUTBOX } from './outbox.js'
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
/** The last line of an example roll-up note (inbound.ts isOwnNote skips it). */
export const rollupMarker = (linkId: number) => `<!-- nivaro:rollup:${Math.floor(linkId)} -->`

/** Example notes one link gets per rolling hour; the rest go into one roll-up note per hour. */
export const EXAMPLES_PER_HOUR = 5
/** Issues a roll-up note lists by name; the rest are counted. */
export const ROLLUP_LIST_MAX = 50
const HOUR_MS = 3_600_000

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
  // never `#<n>`: GitLab would link issue <n> of its own project
  const lines = [`**Another example** — Nivaro issue ${id}${score}`, '']
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

/** The roll-up note: the extra Nivaro issues as plain links (no `#<n>`), the roll-up marker last. */
export function rollupNoteBody(linkId: number, issues: Array<{ id: number; url: string }>): string {
  const one = (v: unknown) => sanitizeMarkdown(String(v ?? ''), { singleLine: true })
  const n = issues.length
  const lines = [
    `**More examples** — ${n} more Nivaro issue${n === 1 ? '' : 's'} joined this GitLab issue within the hour`,
    ''
  ]
  for (const i of issues.slice(0, ROLLUP_LIST_MAX)) {
    const id = num(i.id)
    const url = one(i.url)
    lines.push(url ? `- [Nivaro issue ${id}](${url})` : `- Nivaro issue ${id}`)
  }
  if (n > ROLLUP_LIST_MAX) lines.push(`- +${n - ROLLUP_LIST_MAX} more`)
  lines.push('', rollupMarker(linkId))
  return lines.join('\n')
}

const hourKey = (d: Date) => d.toISOString().slice(0, 13)

/** Example notes queued for this link within the last hour. */
async function examplesLastHour(linkId: number, now: Date): Promise<number> {
  const r = (await db(OUTBOX)
    .where({ link: linkId, op: 'comment' })
    .where('idempotency_key', 'like', `example:${linkId}:%`)
    .where('created_at', '>=', new Date(now.getTime() - HOUR_MS))
    .count({ n: '*' })
    .first()) as { n?: number | string } | undefined
  return Number(r?.n ?? 0) || 0
}

/**
 * Past the hourly limit: add the issue to this hour's roll-up note for the link. The roll-up row
 * waits until the end of the hour (so it collects the whole storm) and is rewritten while still
 * pending; once sent, a later join this hour is only counted in the next hour's roll-up.
 */
async function addToRollup(link: Row, issueId: number, now: Date, depth = 0): Promise<void> {
  const linkId = Number(link.id)
  const hour = hourKey(now)
  const key = `example-rollup:${linkId}:${hour}`
  const sendAt = new Date(Date.parse(`${hour}:00:00.000Z`) + HOUR_MS)
  const existing = (await db(OUTBOX)
    .where({ idempotency_key: key })
    .first('id', 'status', 'payload')) as Row | undefined
  const prior = existing ? parsePayload(existing.payload) : {}
  if (existing && existing.status !== 'pending') {
    // already sent (or being sent): this issue rides the next hour's roll-up
    if (depth < 1) await addToRollup(link, issueId, sendAt, depth + 1)
    return
  }
  const ids = Array.isArray(prior.issues) ? (prior.issues as unknown[]).map(Number) : []
  if (ids.includes(issueId)) return
  ids.push(issueId)
  const listed: Array<{ id: number; url: string }> = []
  for (const id of ids.slice(0, ROLLUP_LIST_MAX)) listed.push({ id, url: await nivaroIssueUrl(id) })
  for (const id of ids.slice(ROLLUP_LIST_MAX)) listed.push({ id, url: '' })
  const payload = {
    project_id: Number(link.project_id),
    iid: Number(link.external_iid),
    issues: ids,
    body: rollupNoteBody(linkId, listed)
  }
  if (existing) {
    await db(OUTBOX)
      .where({ id: existing.id, status: 'pending' })
      .update({ payload: JSON.stringify(payload) })
    return
  }
  // due at the end of its hour from the insert on: never claimed (or sent) early
  await enqueue(
    {
      connection: Number(link.connection),
      link: linkId,
      source_id: String(issueId),
      op: 'comment',
      payload,
      key
    },
    { notBefore: sendAt }
  )
}

function parsePayload(v: unknown): Row {
  if (v && typeof v === 'object') return v as Row
  if (typeof v !== 'string' || !v) return {}
  try {
    const p = JSON.parse(v)
    return p && typeof p === 'object' ? (p as Row) : {}
  } catch {
    return {}
  }
}

/**
 * Queue the example note (idempotency key `example:<link>:<issue>`, so one per issue per link)
 * and, when the connection has any, the `on_example` labels. A link gets at most 5 example notes
 * per rolling hour (joins are not capped, a storm would flood the GitLab issue): past that the
 * issue goes into one roll-up note per link per hour, and no labels are queued (the earlier
 * examples added them).
 */
export async function queueExample(
  linkId: number,
  issueId: number,
  score?: number,
  now = new Date()
): Promise<void> {
  const link = (await db(LINKS)
    .where({ id: linkId })
    .first('id', 'connection', 'project_id', 'external_iid')) as Row | undefined
  if (!link) return
  const connection = Number(link.connection)
  const project_id = Number(link.project_id)
  const iid = Number(link.external_iid)
  const issue = await loadIssue(issueId)
  if (!issue) return
  const already = await db(OUTBOX)
    .where({ idempotency_key: `example:${linkId}:${issueId}` })
    .first('id')
  if (already) return
  if ((await examplesLastHour(linkId, now)) >= EXAMPLES_PER_HOUR) {
    await addToRollup(link, issueId, now)
    return
  }
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
