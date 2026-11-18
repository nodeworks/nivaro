import { db } from '../../db/index.js'
import { getConnection } from './connections.js'
import { issueVars, loadIssue, nivaroIssueUrl } from './issue-body.js'
import { safeLabels } from './labels.js'
import { LINKS } from './link-store.js'
import { enqueue, type LabelsPayload, OUTBOX } from './outbox.js'
import type { SourceView } from './sources/types.js'
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
/** The example marker of a ticket / record (`<!-- nivaro:example:ticket:55 -->`). */
export const sourceExampleMarker = (kind: 'ticket' | 'record', id: string) =>
  `<!-- nivaro:example:${kind}:${id} -->`

/** Another entry in an hourly roll-up that is not an issue-log entry. */
export interface RollupOther {
  key: string
  label: string
  url: string
}
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
export function rollupNoteBody(
  linkId: number,
  issues: Array<{ id: number; url: string }>,
  others: RollupOther[] = []
): string {
  const one = (v: unknown) => sanitizeMarkdown(String(v ?? ''), { singleLine: true })
  const n = issues.length + others.length
  const what = others.length ? 'example' : 'Nivaro issue'
  const lines = [
    `**More examples** — ${n} more ${what}${n === 1 ? '' : 's'} joined this GitLab issue within the hour`,
    ''
  ]
  for (const i of issues.slice(0, ROLLUP_LIST_MAX)) {
    const id = num(i.id)
    const url = one(i.url)
    lines.push(url ? `- [Nivaro issue ${id}](${url})` : `- Nivaro issue ${id}`)
  }
  for (const o of others.slice(0, Math.max(0, ROLLUP_LIST_MAX - issues.length))) {
    const label = one(o.label).replace(/[[\]]/g, '')
    const url = one(o.url)
    lines.push(url ? `- [${label}](${url})` : `- ${label}`)
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
async function addToRollup(
  link: Row,
  issueId: number | null,
  now: Date,
  depth = 0,
  other?: RollupOther
): Promise<void> {
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
    if (depth < 1) await addToRollup(link, issueId, sendAt, depth + 1, other)
    return
  }
  const ids = Array.isArray(prior.issues) ? (prior.issues as unknown[]).map(Number) : []
  const others: RollupOther[] = Array.isArray(prior.others)
    ? (prior.others as RollupOther[]).filter((o) => o && typeof o.key === 'string')
    : []
  if (issueId !== null) {
    if (ids.includes(issueId)) return
    ids.push(issueId)
  } else if (other) {
    if (others.some((o) => o.key === other.key)) return
    others.push(other)
  } else return
  const listed: Array<{ id: number; url: string }> = []
  for (const id of ids.slice(0, ROLLUP_LIST_MAX)) listed.push({ id, url: await nivaroIssueUrl(id) })
  for (const id of ids.slice(ROLLUP_LIST_MAX)) listed.push({ id, url: '' })
  const payload: Row = {
    project_id: Number(link.project_id),
    iid: Number(link.external_iid),
    issues: ids,
    body: rollupNoteBody(linkId, listed, others)
  }
  if (others.length) payload.others = others
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
      ...(issueId !== null
        ? { source_id: String(issueId) }
        : {
            source_kind: (other?.key.split(':')[0] ?? 'issue') as 'ticket' | 'record',
            source_id: other?.key.slice(other.key.indexOf(':') + 1) ?? ''
          }),
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

const SOURCE_DETAILS_MAX = 1500

/** The example note of a ticket / record (every value sanitised; the description fenced). */
export function sourceExampleNoteBody(view: SourceView, score?: number): string {
  const kind = view.kind === 'ticket' ? 'ticket' : 'record'
  const pct =
    typeof score === 'number' && Number.isFinite(score)
      ? ` (${Math.round(Math.min(1, Math.max(0, score)) * 100)}% similar)`
      : ''
  const title = one(view.title)
  // never `#<n>`: GitLab would link issue <n> of its own project
  const what = kind === 'ticket' ? `Nivaro support request ${num(view.id)}` : 'a Nivaro record'
  const lines = [`**Another example** — ${what}${pct}`, '']
  if (title) lines.push(`**${title}**`)
  const created = one(view.vars.created_at)
  if (created) lines.push(`Raised: ${created}`)
  const details = kind === 'ticket' ? String(view.body ?? '').slice(0, SOURCE_DETAILS_MAX) : ''
  if (details.trim()) lines.push('', fenced(sanitizeMarkdown(details)))
  lines.push('', `[Open in Nivaro](${one(view.url)})`, '', sourceExampleMarker(kind, view.id))
  return lines.join('\n')
}

/**
 * queueExample for a ticket / record: one note per source per link (key
 * `example:<link>:<kind>:<id>`), the same hourly limit and roll-up, and the on_example labels.
 */
export async function queueSourceExample(
  linkId: number,
  view: SourceView,
  score?: number,
  now = new Date()
): Promise<void> {
  if (view.kind === 'issue') return queueExample(linkId, Number(view.id), score, now)
  const link = (await db(LINKS)
    .where({ id: linkId })
    .first('id', 'connection', 'project_id', 'external_iid')) as Row | undefined
  if (!link) return
  const connection = Number(link.connection)
  const project_id = Number(link.project_id)
  const iid = Number(link.external_iid)
  const key = `example:${linkId}:${view.kind}:${view.id}`
  if (await db(OUTBOX).where({ idempotency_key: key }).first('id')) return
  if ((await examplesLastHour(linkId, now)) >= EXAMPLES_PER_HOUR) {
    await addToRollup(link, null, now, 0, {
      key: `${view.kind}:${view.id}`,
      label: view.kind === 'ticket' ? `Support request ${num(view.id)}` : view.title,
      url: view.url
    })
    return
  }
  await enqueue({
    connection,
    link: linkId,
    source_kind: view.kind,
    source_id: view.id,
    op: 'comment',
    payload: { project_id, iid, body: sourceExampleNoteBody(view, score) },
    key
  })
  const conn = await getConnection(connection)
  const add = safeLabels(conn?.sync?.labels?.on_example ?? [])
  if (!add.length) return
  const payload: LabelsPayload = { project_id, iid, add_labels: add, remove_labels: [] }
  await enqueue({
    connection,
    link: linkId,
    source_kind: view.kind,
    source_id: view.id,
    op: 'labels',
    payload,
    key: `example-labels:${linkId}:${view.kind}:${view.id}`
  })
}
