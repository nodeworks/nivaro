import { createHash, randomUUID } from 'node:crypto'
import { arr, asObj, mkOp, strs } from '../entra/shared.js'
import { typedName } from '../plan-words.js'
import type { HubResourceRow } from '../store.js'
import {
  type DesiredResource,
  type HealthAnswer,
  type Observed,
  type OpResult,
  type OutboundMessage,
  type PlannedOp,
  type ProviderContext,
  ProviderError
} from '../types.js'
import {
  hasControl,
  idSeg,
  issueSeg,
  jiraCall,
  keySeg,
  modeOf,
  projectAllowed,
  safe
} from './client.js'
import { assertProject, readComponent, readProject, refKey } from './resources.js'
import { RULE } from './specs.js'

/**
 * Jira issue rules: the Hub-side resource that says where Hub events become issues. Nothing
 * exists at Jira to create, so the provider id carries the settings that matter to a send:
 * `rule:<PROJECT>:<component id | 0>:<uuid>:<hash of the rest>`. A change to the project, the
 * component or the hash (issue type, labels, priorities) reads as a plan diff without any read,
 * and an update hands back the new id.
 *
 * `notify` makes one Jira issue per Hub incident or failed deploy: `dedupKey` is turned into a
 * label (`hub-<hash>`), and the issue is found again by label (JQL), not from memory, so a Hub
 * restart does not split one incident into two issues. `open` creates (or comments on the issue
 * still open), `update` comments, `resolve` comments and moves the issue along a transition that
 * lands in the "done" status category (found by category, never by name).
 */

const LABEL = 'Jira issue rule'
const ID_RE = /^rule:([A-Z][A-Z0-9_]{1,49}):(\d{1,12}|0):([0-9a-f-]{36}):([0-9a-f]{12})$/
const LABEL_RE = /^[A-Za-z0-9_.:-]{1,255}$/
const ISSUE_CACHE_MS = 60 * 60 * 1000

export interface RuleId {
  project: string
  component: string | null
  uuid: string
  hash: string
}

export function parseRuleId(externalId: string | null | undefined): RuleId | null {
  const m = ID_RE.exec(externalId ?? '')
  if (!m) return null
  return {
    project: m[1] as string,
    component: m[2] === '0' ? null : (m[2] as string),
    uuid: m[3] as string,
    hash: m[4] as string
  }
}

const text = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : ''
  return s === '' ? null : s
}

function cleanLabels(v: unknown): string[] {
  const list = [
    ...new Set(
      strs(v)
        .map((x) => x.trim())
        .filter(Boolean)
    )
  ].sort()
  if (list.some((l) => !LABEL_RE.test(l)))
    throw new ProviderError(
      'INVALID_FIELDS',
      'A label may hold letters, digits and _ . : - only (no spaces).'
    )
  return list
}

/** The settings of a rule that are not in the id's project/component, as one short hash. */
export function ruleHash(fields: Record<string, unknown>): string {
  const body = JSON.stringify([
    text(fields.issue_type) ?? 'Task',
    cleanLabels(fields.labels),
    text(fields.priority_info),
    text(fields.priority_warning),
    text(fields.priority_critical)
  ])
  return createHash('sha256').update(body).digest('hex').slice(0, 12)
}

function oneRef(v: unknown): string | null {
  const x = Array.isArray(v) ? v[0] : v
  return typeof x === 'string' && x ? x : null
}

export function ruleObserved(ctx: ProviderContext, externalId: string): Observed | null {
  const id = parseRuleId(externalId)
  if (!id || !projectAllowed(ctx.config, id.project)) return null
  return {
    type: RULE,
    externalId,
    name: null,
    fields: { project: id.project, component: id.component, rule_hash: id.hash },
    tags: {},
    version: null,
    status: 'active',
    url: null
  }
}

export const observeRuleOrNull = ruleObserved

export function planRule(desired: DesiredResource | null, observed: Observed | null): PlannedOp[] {
  if (!desired) {
    if (!observed) return []
    return [
      mkOp(
        RULE,
        null,
        'delete',
        observed.externalId,
        `Delete ${typedName(LABEL, observed.name)}: the Hub forgets it and any notify route that used it stops opening issues.`
      )
    ]
  }
  const name = typedName(LABEL, text(desired.fields.name))
  const project = oneRef(desired.refs?.project)
  if (!observed)
    return [
      mkOp(
        RULE,
        desired,
        'create',
        null,
        `Create ${name}: Hub events become ${text(desired.fields.issue_type) ?? 'Task'} issues in ${project ?? 'the project'}.`,
        {
          changes: [
            { field: 'project', to: project },
            { field: 'issue_type', to: text(desired.fields.issue_type) ?? 'Task' }
          ]
        }
      )
    ]
  const have = parseRuleId(observed.externalId)
  const component = oneRef(desired.refs?.component)
  const changes: PlannedOp['changes'] = []
  if (!have) changes.push({ field: 'rule', from: observed.externalId, to: 'rebuilt' })
  else {
    if (project && project !== have.project)
      changes.push({ field: 'project', from: have.project, to: project })
    if (desired.refs && 'component' in desired.refs && (component ?? null) !== have.component)
      changes.push({ field: 'component', from: have.component, to: component })
    if (ruleHash(desired.fields) !== have.hash)
      changes.push({
        field: 'issue_type',
        from: null,
        to: text(desired.fields.issue_type) ?? 'Task'
      })
  }
  if (!changes.length) return []
  return [mkOp(RULE, desired, 'update', observed.externalId, `Change ${name}.`, { changes })]
}

/** Checks the project, issue type and component exist (and belong together), then names the id. */
async function checked(
  ctx: ProviderContext,
  desired: DesiredResource
): Promise<Omit<RuleId, 'uuid'>> {
  const project = refKey(desired)
  assertProject(ctx, project)
  const type = text(desired.fields.issue_type) ?? 'Task'
  const r = await jiraCall(ctx, 'GET', `/project/${keySeg(project)}`, { allow: [404] })
  if (r.status === 404 || !r.body)
    throw new ProviderError('NOT_FOUND', `Project ${project} is gone at Jira.`, { status: 404 })
  const types = arr(r.body.issueTypes).map((t) => String(t.name ?? '').toLowerCase())
  if (types.length && !types.includes(type.toLowerCase()))
    throw new ProviderError('INVALID_FIELDS', `Project ${project} has no issue type named ${type}.`)
  const compRaw = oneRef(desired.refs?.component)
  let component: string | null = null
  if (compRaw) {
    component = idSeg(compRaw, 'component id')
    const c = await readComponent(ctx, component)
    if (!c || String(c.fields.project) !== project)
      throw new ProviderError('INVALID_FIELDS', `That component is not in project ${project}.`)
  }
  return { project, component, hash: ruleHash(desired.fields) }
}

const ok = (externalId: string, observed: Observed | null): OpResult => ({
  ok: true,
  externalId,
  observed,
  answer: { status: 200 }
})

export async function createRule(
  ctx: ProviderContext,
  desired: DesiredResource
): Promise<OpResult> {
  const c = await checked(ctx, desired)
  const uuid = parseRuleId(desired.externalId)?.uuid ?? randomUUID()
  const id = `rule:${c.project}:${c.component ?? '0'}:${uuid}:${c.hash}`
  return ok(id, ruleObserved(ctx, id))
}

export async function updateRule(
  ctx: ProviderContext,
  externalId: string,
  desired: DesiredResource
): Promise<OpResult> {
  const have = parseRuleId(externalId)
  if (!have) throw new ProviderError('BAD_ID', 'That is not a Jira issue rule id.')
  const c = await checked(ctx, desired)
  const id = `rule:${c.project}:${c.component ?? '0'}:${have.uuid}:${c.hash}`
  return ok(id, ruleObserved(ctx, id))
}

export function deleteRule(externalId: string | null): OpResult {
  return { ok: true, externalId, observed: null, answer: { status: 204 } }
}

export async function ruleHealth(ctx: ProviderContext, externalId: string): Promise<HealthAnswer> {
  const checkedAt = ctx.now().toISOString()
  const id = parseRuleId(externalId)
  if (!id) return { status: 'down', message: 'This rule’s id is not valid.', checkedAt }
  const p = await readProject(ctx, id.project)
  if (!p)
    return { status: 'down', message: `Project ${id.project} is gone or not allowed.`, checkedAt }
  return { status: 'ok', checkedAt }
}

// ── Sending ──

/** Plain text inside a Jira wiki-markup field: a {noformat} block cannot be broken out of. */
function plainBlock(s: string): string {
  return `{noformat}\n${s.replace(/\{noformat[^}]*\}/gi, '').slice(0, 20000)}\n{noformat}`
}

function bodyText(msg: OutboundMessage, link: string | null, lead?: string): string {
  const parts = [lead, msg.body ? plainBlock(msg.body) : null, `Severity: ${msg.severity}`]
  if (link) parts.push(`Open in the Hub: ${link}`)
  return parts.filter(Boolean).join('\n\n')
}

const httpsLink = (l?: string): string | null =>
  l && /^https:\/\/[^\s]+$/i.test(l) && !hasControl(l) ? l : null

const clean = (s: string) => s.replace(/\s+/g, ' ').trim()

function dedupLabel(resource: HubResourceRow, dedupKey: string): string {
  return `hub-${createHash('sha256').update(`${resource.id}|${dedupKey}`).digest('hex').slice(0, 16)}`
}

async function findOpen(
  ctx: ProviderContext,
  resource: HubResourceRow,
  project: string,
  label: string
): Promise<string | null> {
  const cacheKey = `issue:${resource.id}:${label}`
  const cached = ctx.tokens.get(cacheKey)
  if (cached) {
    const r = await jiraCall(ctx, 'GET', `/issue/${issueSeg(cached)}`, {
      query: { fields: 'status,labels,project' },
      allow: [404]
    })
    const done = asObj(asObj(asObj(r.body?.fields).status).statusCategory).key === 'done'
    const labels = strs(asObj(r.body?.fields).labels)
    if (r.status !== 404 && !done && labels.includes(label)) return cached
    ctx.tokens.delete(cacheKey)
  }
  const jql = `project = "${keySeg(project)}" AND labels = "${label}" AND statusCategory != Done ORDER BY created DESC`
  const path = modeOf(ctx.config) === 'datacenter_pat' ? '/search' : '/search/jql'
  const r = await jiraCall(ctx, 'GET', path, { query: { jql, fields: 'status', maxResults: 1 } })
  const key = arr(r.body?.issues)[0]?.key
  if (typeof key !== 'string') return null
  const issue = issueSeg(key)
  ctx.tokens.set(cacheKey, issue, new Date(ctx.now().getTime() + ISSUE_CACHE_MS))
  return issue
}

async function comment(ctx: ProviderContext, issue: string, body: string): Promise<void> {
  await jiraCall(ctx, 'POST', `/issue/${issueSeg(issue)}/comment`, { body: { body } })
}

async function transitionToDone(ctx: ProviderContext, issue: string): Promise<boolean> {
  const r = await jiraCall(ctx, 'GET', `/issue/${issueSeg(issue)}/transitions`)
  const hit = arr(r.body?.transitions).find((t) => asObj(asObj(t.to).statusCategory).key === 'done')
  const id = hit ? String(hit.id ?? '') : ''
  if (!/^\d{1,9}$/.test(id)) return false
  await jiraCall(ctx, 'POST', `/issue/${issueSeg(issue)}/transitions`, {
    body: { transition: { id } }
  })
  return true
}

function appLabel(resource: HubResourceRow): string | null {
  const raw = resource.tags?.['nivaro-hub:app']
  const s = typeof raw === 'string' ? raw.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 60) : ''
  return s ? `app:${s}` : null
}

async function createIssue(
  ctx: ProviderContext,
  resource: HubResourceRow,
  id: RuleId,
  msg: OutboundMessage,
  label: string | null
): Promise<string> {
  const f = resource.desired ?? {}
  const labels = [
    ...new Set(
      ['nivaro-hub', appLabel(resource), label, ...cleanLabels(f.labels)].filter(
        (x): x is string => !!x
      )
    )
  ]
  const priority = text(f[`priority_${msg.severity}`])
  const r = await jiraCall(ctx, 'POST', '/issue', {
    body: {
      fields: {
        project: { key: keySeg(id.project) },
        summary: clean(msg.title).slice(0, 250) || 'Nivaro Hub event',
        description: bodyText(msg, httpsLink(msg.link)),
        issuetype: { name: text(f.issue_type) ?? 'Task' },
        labels,
        ...(id.component ? { components: [{ id: idSeg(id.component, 'component id') }] } : {}),
        ...(priority ? { priority: { name: priority } } : {})
      }
    }
  })
  return issueSeg(r.body?.key)
}

async function sendIssue(
  ctx: ProviderContext,
  resource: HubResourceRow,
  msg: OutboundMessage
): Promise<OpResult> {
  const id = parseRuleId(resource.external_id)
  if (!id || !resource.desired)
    throw new ProviderError('NOT_CONFIGURED', 'This Jira rule has no settings to send with.')
  assertProject(ctx, id.project)
  const action = msg.action ?? 'open'
  const label = msg.dedupKey ? dedupLabel(resource, msg.dedupKey) : null
  const link = httpsLink(msg.link)
  const existing = label ? await findOpen(ctx, resource, id.project, label) : null
  const done = (
    issue: string | null,
    what: string,
    extra: Record<string, unknown> = {}
  ): OpResult => ({
    ok: true,
    externalId: resource.external_id,
    observed: null,
    answer: { issue, action: what, ...extra }
  })
  if (action === 'resolve') {
    if (!existing) return done(null, 'skipped', { reason: 'no open issue' })
    await comment(ctx, existing, bodyText(msg, link, `Resolved: ${clean(msg.title)}`))
    const moved = await transitionToDone(ctx, existing)
    if (moved && label) ctx.tokens.delete(`issue:${resource.id}:${label}`)
    return done(existing, 'resolved', { transitioned: moved })
  }
  if (existing) {
    await comment(
      ctx,
      existing,
      bodyText(
        msg,
        link,
        action === 'open' ? `Raised again: ${clean(msg.title)}` : clean(msg.title)
      )
    )
    return done(existing, 'commented')
  }
  const issue = await createIssue(ctx, resource, id, msg, label)
  if (label)
    ctx.tokens.set(
      `issue:${resource.id}:${label}`,
      issue,
      new Date(ctx.now().getTime() + ISSUE_CACHE_MS)
    )
  return done(issue, 'created')
}

export async function notifyRule(
  ctx: ProviderContext,
  resource: HubResourceRow,
  msg: OutboundMessage
): Promise<OpResult> {
  try {
    return await sendIssue(ctx, resource, msg)
  } catch (err) {
    if (err instanceof ProviderError)
      return {
        ok: false,
        externalId: resource.external_id,
        observed: null,
        error: {
          code: err.code,
          message: safe(ctx, err.message),
          retryable: err.retryable,
          ...(err.status !== undefined ? { status: err.status } : {})
        }
      }
    throw err
  }
}
