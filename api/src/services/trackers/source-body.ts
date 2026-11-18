import type { SyncOptions } from './connections.js'
import { mergeLabels, safeLabels } from './labels.js'
import type { RuleAction } from './rules.js'
import type { SourceView } from './sources/types.js'
import {
  defaultRecordBodyTemplate,
  defaultRecordTitleTemplate,
  defaultTicketBodyTemplate,
  defaultTicketTitleTemplate,
  renderIssueTemplate,
  renderIssueTitle,
  sanitizeMarkdown
} from './templates.js'
import type { CreateIssueInput } from './types.js'

/**
 * What a support ticket or a record becomes on GitLab (issue-log entries keep issue-body.ts):
 * the rendered title / description / labels, the Nivaro link, and the hidden create marker a
 * retried create searches for. The view's variables are already read as the creating person
 * (records) and markdown-safe.
 */

const TITLE_MAX = 255
const DAY_MS = 86_400_000

/** `<!-- nivaro:ticket:55 -->` / `<!-- nivaro:record:workflows:9001 -->` (generation 2+ suffixed). */
export const sourceMarker = (kind: 'ticket' | 'record', id: string, generation = 1) =>
  generation > 1
    ? `<!-- nivaro:${kind}:${id}:${Math.floor(generation)} -->`
    : `<!-- nivaro:${kind}:${id} -->`

const own = (rec: Record<string, string | undefined> | undefined, key: string) =>
  rec && Object.hasOwn(rec, key) ? rec[key] : undefined

/** A ticket status as a lane key: cancelled rides the done lane. */
export const ticketLane = (status: string | null | undefined): string =>
  status === 'cancelled' ? 'done' : String(status ?? '')

/** The mapped ticket priority + lane labels (either may be missing). */
export function ticketMappedLabels(
  ticket: { priority: string | null; status: string | null },
  s: Partial<Pick<SyncOptions, 'ticket_priority_map' | 'ticket_lane_map'>> | undefined
): string[] {
  const p = own(
    s?.ticket_priority_map as Record<string, string | undefined>,
    String(ticket.priority ?? '')
  )
  const l = own(s?.ticket_lane_map as Record<string, string | undefined>, ticketLane(ticket.status))
  return mergeLabels([p ?? '', l ?? ''])
}

const utcDate = (d: Date) => d.toISOString().slice(0, 10)

export async function buildSourceInput(
  view: SourceView,
  action: RuleAction | null,
  overrides?: Partial<CreateIssueInput>,
  opts: {
    sync?: Partial<Pick<SyncOptions, 'labels' | 'ticket_priority_map' | 'ticket_lane_map'>> | null
    generation?: number
  } = {}
): Promise<CreateIssueInput> {
  if (view.kind !== 'ticket' && view.kind !== 'record')
    throw new Error('buildSourceInput is for tickets and records')
  const vars = view.vars
  const ticket = view.kind === 'ticket'
  const titleTpl =
    action?.title_template || (ticket ? defaultTicketTitleTemplate() : defaultRecordTitleTemplate())
  const bodyTpl =
    action?.body_template || (ticket ? defaultTicketBodyTemplate() : defaultRecordBodyTemplate())
  const title = (await renderIssueTitle(titleTpl, vars)).trim()
  const body = await renderIssueTemplate(bodyTpl, vars)

  const ruleLabels: string[] = []
  for (const l of action?.labels ?? []) ruleLabels.push(await renderIssueTitle(l, vars))

  const fallback = ticket ? `Nivaro support request ${view.id}` : `Nivaro record ${view.id}`
  const input: CreateIssueInput = {
    title: title || sanitizeMarkdown(view.title, { singleLine: true }) || fallback,
    description: body
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
      if (k === 'labels') continue
      if (v !== undefined) (input as unknown as Record<string, unknown>)[k] = v
    }
  }
  const manualLabels = Array.isArray(overrides?.labels)
    ? overrides.labels.filter((l): l is string => typeof l === 'string')
    : []
  input.title = sanitizeMarkdown(String(input.title ?? ''), { singleLine: true }).slice(
    0,
    TITLE_MAX
  )
  if (!input.title) input.title = fallback
  // Overrides may be typed by a non-admin here (create_roles): sanitise the description too.
  input.description = sanitizeMarkdown(String(input.description ?? ''))
  input.labels = safeLabels(
    mergeLabels(
      opts.sync?.labels?.always,
      ticket ? ticketMappedLabels(view, opts.sync ?? undefined) : [],
      ruleLabels,
      manualLabels
    )
  )
  const url = String(view.url ?? '')
  let description = input.description
  if (url && !description.includes(url)) description += `\n\n[Open in Nivaro](${url})`
  input.description = `${description}\n\n${sourceMarker(view.kind, view.id, opts.generation)}`
  return input
}
