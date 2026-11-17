import { db } from '../../db/index.js'
import { appEnvironment } from '../app-info-environment.js'
import { linkTo } from '../app-links.js'
import { hitCounts, hitKey } from '../issue-raise.js'
import type { RuleAction } from './rules.js'
import { defaultBodyTemplate, defaultTitleTemplate, renderIssueTemplate } from './templates.js'
import type { CreateIssueInput } from './types.js'

/**
 * What a Nivaro issue becomes on GitLab: the rendered title / description / labels plus the
 * hidden marker `<!-- nivaro:issue:<id> -->` a retried create searches for (no duplicates after
 * a timeout). Built once when the create is queued; the outbox stores the result so every retry
 * sends the same thing.
 */

const DAY_MS = 86_400_000
const TITLE_MAX = 255
const DETAILS_MAX = 8000

export const issueMarker = (issueId: number) => `<!-- nivaro:issue:${issueId} -->`

type Row = Record<string, unknown>

const iso = (v: unknown): string => {
  if (!v) return ''
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? '' : d.toISOString()
}

/** The admin issue page for one issue (`/issues/:id`). */
export async function nivaroIssueUrl(issueId: number): Promise<string> {
  return `${(await linkTo('issues', {}, { app: 'admin' })).replace(/\/+$/, '')}/${issueId}`
}

async function replayUrl(issue: Row): Promise<string | null> {
  if (!issue.recording_id) return null
  const base = (await linkTo('issues', {}, { app: 'admin' })).replace(/\/issues\/?$/, '')
  const t = issue.recording_offset_ms == null ? '' : `&t=${Number(issue.recording_offset_ms)}`
  return `${base}/analytics/replays?recording=${encodeURIComponent(String(issue.recording_id))}${t}`
}

/** Top routes + builds from the recent occurrence rows (the table keeps ≤ 50 per issue). */
async function occurrenceFacts(issueId: number): Promise<{
  topRoutes: Array<{ route: string; count: number }>
  builds: string[]
  route: string
  build: string
}> {
  let rows: Row[] = []
  try {
    rows = (await db('nivaro_issue_occurrences')
      .where({ issue: issueId })
      .orderBy('occurred_at', 'desc')
      .limit(200)
      .select('route', 'build')) as Row[]
  } catch {
    rows = []
  }
  const counts = new Map<string, number>()
  const builds: string[] = []
  for (const r of rows) {
    if (r.route) counts.set(String(r.route), (counts.get(String(r.route)) ?? 0) + 1)
    if (r.build && !builds.includes(String(r.build))) builds.push(String(r.build))
  }
  const topRoutes = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([route, count]) => ({ route, count }))
  return {
    topRoutes,
    builds,
    route: rows.find((r) => r.route)?.route ? String(rows.find((r) => r.route)?.route) : '',
    build: builds[0] ?? ''
  }
}

/** Earlier issue rows with the same fingerprint = times it came back after being resolved. */
async function recurrences(issue: Row): Promise<number> {
  if (!issue.fingerprint) return 0
  try {
    const r = (await db('nivaro_issues')
      .where({ fingerprint: issue.fingerprint })
      .where('id', '<', Number(issue.id))
      .count({ n: '*' })
      .first()) as { n?: number | string } | undefined
    return Number(r?.n ?? 0) || 0
  } catch {
    return 0
  }
}

export async function loadIssue(issueId: number): Promise<Row | null> {
  const row = (await db('nivaro_issues').where({ id: issueId }).first()) as Row | undefined
  return row ?? null
}

/** The documented template variables (templates.ts TEMPLATE_VARS) for one issue. */
export async function issueVars(
  issue: Row,
  includeDetails: boolean
): Promise<Record<string, unknown>> {
  const id = Number(issue.id)
  const occ = await occurrenceFacts(id)
  let day = { hits: 0, people: 0 }
  try {
    day = await hitCounts(
      hitKey({ id, fingerprint: (issue.fingerprint as string | null) ?? null }),
      new Date(Date.now() - DAY_MS)
    )
  } catch {
    // counters are best-effort
  }
  const details = includeDetails && issue.details ? String(issue.details).slice(0, DETAILS_MAX) : ''
  return {
    title: String(issue.title ?? ''),
    severity: String(issue.severity ?? ''),
    status: String(issue.status ?? ''),
    source: String(issue.source ?? ''),
    details,
    route: occ.route,
    collection: issue.collection == null ? '' : String(issue.collection),
    item: issue.item == null ? '' : String(issue.item),
    environment: appEnvironment(),
    build: occ.build,
    first_seen: iso(issue.created_at),
    last_seen: iso(issue.last_seen_at ?? issue.updated_at ?? issue.created_at),
    total_hits: Number(issue.occurrence_count ?? 1) || 1,
    hits_24h: day.hits,
    people_24h: day.people,
    recurrences: await recurrences(issue),
    top_routes: occ.topRoutes,
    builds: occ.builds,
    nivaro_url: await nivaroIssueUrl(id),
    group_size: 1,
    issue_id: id
  }
}

const utcDate = (d: Date) => d.toISOString().slice(0, 10)

/**
 * The final CreateIssueInput for one issue. `action` null = a manual create: default templates,
 * no labels (the caller picks the connection's default project). `overrides` win over the rule.
 */
export async function buildIssueInput(
  issueId: number,
  action: RuleAction | null,
  overrides?: Partial<CreateIssueInput>
): Promise<CreateIssueInput> {
  const issue = await loadIssue(issueId)
  if (!issue) throw new Error(`Issue ${issueId} not found`)
  const vars = await issueVars(issue, action ? action.include_details !== false : true)

  const title = (
    await renderIssueTemplate(action?.title_template || defaultTitleTemplate(), vars)
  ).trim()
  let body = await renderIssueTemplate(action?.body_template || defaultBodyTemplate(), vars)
  if (action?.attach_replay_link) {
    const replay = await replayUrl(issue)
    if (replay) body += `\n\n[Watch the replay](${replay})`
  }

  const labels: string[] = []
  for (const l of action?.labels ?? []) {
    const v = (await renderIssueTemplate(l, vars)).trim()
    if (v && !labels.includes(v)) labels.push(v)
  }

  const input: CreateIssueInput = {
    title: title || String(issue.title ?? `Nivaro issue ${issueId}`),
    description: body,
    labels
  }
  if (action) {
    if (action.assignee_ids.length) input.assignee_ids = [...action.assignee_ids]
    if (action.milestone_id !== undefined) input.milestone_id = action.milestone_id
    if (action.due_in_days !== undefined)
      input.due_date = utcDate(new Date(Date.now() + action.due_in_days * DAY_MS))
    if (action.weight !== undefined) input.weight = action.weight
    if (action.confidential) input.confidential = true
    input.issue_type = action.issue_type
  }
  if (overrides) {
    for (const [k, v] of Object.entries(overrides)) {
      if (v !== undefined) (input as unknown as Record<string, unknown>)[k] = v
    }
  }
  input.title = input.title.slice(0, TITLE_MAX)

  // The Nivaro link and the marker always ride last, whatever the template or override said.
  const url = String(vars.nivaro_url)
  let description = input.description ?? ''
  if (!description.includes(url)) description += `\n\n[Open in Nivaro](${url})`
  input.description = `${description}\n\n${issueMarker(issueId)}`
  return input
}

/** Put text into a description just above the marker block. */
export function insertBeforeMarker(description: string, text: string): string {
  const at = description.lastIndexOf('<!-- nivaro:issue:')
  if (at === -1) return `${description}\n\n${text}`
  return `${description.slice(0, at).replace(/\s+$/, '')}\n\n${text}\n\n${description.slice(at)}`
}

/** `data:<mime>;base64,<data>` → bytes, or null when it is not one. */
export function decodeDataUri(uri: unknown): { mime: string; data: Buffer; name: string } | null {
  if (typeof uri !== 'string') return null
  const m = /^data:([\w.+-]+\/[\w.+-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(uri.trim())
  if (!m) return null
  const data = Buffer.from(m[2].replace(/\s+/g, ''), 'base64')
  if (!data.length) return null
  const ext = (m[1].split('/')[1] ?? 'bin').replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '')
  return { mime: m[1], data, name: `screenshot.${ext || 'bin'}` }
}
