import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import type { User } from '../types.js'
import {
  type ActivityApproval,
  type ActivityChange,
  type ActivityEntryInput,
  type ActivityLabels,
  activityWhy,
  actorOf,
  choiceText,
  renderActivitySentence
} from './activity-sentence.js'
import { selectInChunks } from './db-batch.js'

/**
 * The read side of the readable audit trail (migration 516): the extra columns a page of
 * activity rows selects (column-probed), what each row gains (changes, actor, why, badge),
 * and the labels a reader may see (POST /api/activity/labels).
 *
 * Cost: the page's own select gains its optional columns, the API key name (join) and the
 * update delta (join on the revision's activity index) — no extra round trip. The only extra
 * read is the linked approvals, one query per page and only when the page holds a transition
 * or an approval decision.
 */

/** Optional nivaro_activity columns, newest migration last; each probed per tenant. */
const OPTIONAL = [
  'origin',
  'chain_parent',
  'auth_method',
  'api_key_id',
  'mcp_conn',
  'via_app',
  'group_key',
  'actor'
] as const

export async function optionalActivityColumns(): Promise<Set<string>> {
  const have = await Promise.all(
    OPTIONAL.map((c) => hasColumn('nivaro_activity', c).catch(() => false))
  )
  return new Set(OPTIONAL.filter((_, i) => have[i]))
}

const SECRET_FIELD = /pass(word)?|secret|token|api_?key|totp|hash|salt/i
const MAX_CHANGES = 6

/** A revision delta → at most six field changes, values short and secrets dropped. */
export function changesFromDelta(delta: unknown): ActivityChange[] | null {
  let d: unknown = delta
  if (typeof delta === 'string') {
    try {
      d = JSON.parse(delta)
    } catch {
      return null
    }
  }
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null
  const out: ActivityChange[] = []
  for (const [field, raw] of Object.entries(d as Record<string, unknown>)) {
    if (['updated_at', 'date_updated', 'user_updated', 'changed'].includes(field)) continue
    if (SECRET_FIELD.test(field)) {
      out.push({ field })
    } else if (raw == null || typeof raw !== 'object') {
      const v = typeof raw === 'string' && raw.length > 120 ? `${raw.slice(0, 117)}…` : raw
      out.push({ field, value: v ?? null })
    } else {
      out.push({ field })
    }
    if (out.length >= MAX_CHANGES) break
  }
  return out
}

type Row = Record<string, unknown> & ActivityEntryInput

/**
 * What every listed row gains: `changes` (from the update's revision delta), `actor` (stored
 * or derived), `why` (change reason / transition note / linked approval) and the agent badge.
 * Internal columns used only to derive them (delta, the badge source) are dropped.
 */
export function enrichActivityRow(
  row: Row,
  extras: { badge?: (viaApp: string | null) => string | null; approval?: ActivityApproval | null }
): Row {
  const { delta, ...rest } = row as Row & { delta?: unknown }
  const out: Row = { ...rest }
  if (rest.action === 'update' && delta != null) out.changes = changesFromDelta(delta)
  out.actor = actorOf(out)
  const why = activityWhy({ ...out, why: extras.approval ? { approval: extras.approval } : null })
  out.why = { reason: why.reason, note: why.note, approval: extras.approval ?? null }
  if (extras.badge && (out.mcp_conn || out.via_app))
    out.via_agent = extras.badge((out.via_app as string | null) ?? null)
  return out
}

const TRANSITION_ACTIONS = new Set(['transition', 'pipeline-transition'])
const MATCH_MS = 120_000

/** Linked approval decisions for a page: one query, matched by person + record + time. */
export async function approvalsForRows(rows: Row[]): Promise<Map<string, ActivityApproval>> {
  const out = new Map<string, ActivityApproval>()
  const instanceIds = new Set<number>()
  const pairs = new Map<string, { collection: string; item: string }>()
  let lo = Number.POSITIVE_INFINITY
  let hi = Number.NEGATIVE_INFINITY
  for (const r of rows) {
    const c = String(r.collection ?? '')
    const item = String(r.item ?? '')
    if (!c || !item) continue
    const isDecision = c === 'nivaro_approval_instances' && r.action === 'update'
    if (!isDecision && !TRANSITION_ACTIONS.has(String(r.action ?? ''))) continue
    if (isDecision && /^\d+$/.test(item)) instanceIds.add(Number(item))
    else if (!isDecision) pairs.set(`${c}\u0000${item}`, { collection: c, item })
    const t = r.timestamp ? new Date(r.timestamp).getTime() : Number.NaN
    if (Number.isFinite(t)) {
      lo = Math.min(lo, t)
      hi = Math.max(hi, t)
    }
  }
  if ((instanceIds.size === 0 && pairs.size === 0) || !Number.isFinite(lo)) return out
  let decisions: Array<Record<string, unknown>> = []
  try {
    // A day either side: decided_at is written as JS UTC, but older rows may hold the
    // server's local GETDATE() — the person + 2-minute match below is the real filter.
    const from = new Date(lo - 86_400_000)
    const to = new Date(hi + 86_400_000)
    const pairList = [...pairs.values()].slice(0, 200)
    decisions = (await db('nivaro_approval_decisions as d')
      .join('nivaro_approval_instances as i', 'i.id', 'd.instance')
      .leftJoin('nivaro_approval_chains as c', 'c.id', 'i.chain')
      .whereBetween('d.decided_at', [from, to])
      .where((q) => {
        if (instanceIds.size) q.orWhereIn('d.instance', [...instanceIds].slice(0, 500))
        for (const p of pairList)
          q.orWhere((w) => w.where('i.collection', p.collection).andWhere('i.item', p.item))
      })
      .select(
        'd.instance',
        'd.step_order',
        'd.user',
        'd.decision',
        'd.comment',
        'd.decided_at',
        'i.collection',
        'i.item',
        'c.name as chain_name'
      )
      .limit(1000)) as Array<Record<string, unknown>>
  } catch {
    return out
  }
  for (const r of rows) {
    const t = r.timestamp ? new Date(r.timestamp).getTime() : Number.NaN
    if (!Number.isFinite(t) || r.id == null) continue
    const c = String(r.collection ?? '')
    const item = String(r.item ?? '')
    const user = String(r.user ?? '').toUpperCase()
    const isDecision = c === 'nivaro_approval_instances'
    let best: Record<string, unknown> | null = null
    let bestGap = MATCH_MS + 1
    for (const d of decisions) {
      const same = isDecision
        ? String(d.instance) === item
        : String(d.collection) === c && String(d.item) === item
      if (!same || String(d.user ?? '').toUpperCase() !== user) continue
      const gap = Math.abs(new Date(d.decided_at as string).getTime() - t)
      if (gap < bestGap) {
        best = d
        bestGap = gap
      }
    }
    if (!best) continue
    out.set(String(r.id), {
      decision: String(best.decision ?? ''),
      comment: (best.comment as string | null) ?? null,
      chain: (best.chain_name as string | null) ?? null,
      step: best.step_order == null ? null : Number(best.step_order) + 1,
      collection: String(best.collection ?? ''),
      item: String(best.item ?? '')
    })
  }
  return out
}

// ─── Labels, read as the reader ─────────────────────────────────────────────

export const LABEL_LIMITS = { refs: 200, users: 200, fields: 200, collections: 100 }
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

export interface LabelsRequest {
  refs?: Array<{ collection?: unknown; id?: unknown }>
  users?: unknown[]
  fields?: Array<{ collection?: unknown; field?: unknown }>
  collections?: unknown[]
}

export interface LabelDeps {
  canRead(user: User, collection: string): Promise<boolean>
  /** Ids among `ids` the reader may see (User Scopes, row filters, policies). */
  visibleIds(user: User, collection: string, ids: string[]): Promise<Set<string>>
  /** `collection:id` → label for records the reader may read. */
  recordLabels(
    user: User,
    refs: Array<{ collection: string; id: string }>
  ): Promise<Record<string, string>>
  people(ids: string[]): Promise<
    Array<{
      id: string
      first_name: string | null
      last_name: string | null
      is_redacted?: unknown
    }>
  >
  collections(
    names: string[]
  ): Promise<Array<{ collection: string; display_name: string | null; singular: string | null }>>
  fields(
    collections: string[]
  ): Promise<Array<{ collection: string; field: string; label: string | null; options: unknown }>>
  links(
    collections: string[]
  ): Promise<Array<{ many_collection: string; many_field: string; one_collection: string | null }>>
}

const defaultLabelDeps: LabelDeps = {
  async canRead(user, collection) {
    const { can } = await import('./permissions.js')
    return can(user, 'read', collection)
  },
  async visibleIds(user, collection, ids) {
    const { readItems } = await import('./items.js')
    const res = (await readItems(user, collection, {
      filter: { id: { _in: ids } },
      fields: ['id'],
      limit: ids.length,
      count: false
    } as Parameters<typeof readItems>[2])) as unknown as { data?: Array<{ id: unknown }> }
    return new Set((res.data ?? []).map((r) => String(r.id).toLowerCase()))
  },
  async recordLabels(user, refs) {
    const { recordLabelsAsViewer } = await import('./record-labels-as-viewer.js')
    return recordLabelsAsViewer(user, refs)
  },
  async people(ids) {
    return (await selectInChunks(ids, 500, (chunk) =>
      Promise.resolve(
        db('nivaro_users')
          .whereIn('id', chunk)
          .select('id', 'first_name', 'last_name', 'is_redacted')
      )
    )) as Array<{
      id: string
      first_name: string | null
      last_name: string | null
      is_redacted?: unknown
    }>
  },
  async collections(names) {
    if (!names.length) return []
    const singular = await hasColumn('nivaro_collections', 'singular').catch(() => false)
    return (await db('nivaro_collections')
      .whereIn('collection', names)
      .select('collection', 'display_name', ...(singular ? ['singular'] : []))) as Array<{
      collection: string
      display_name: string | null
      singular: string | null
    }>
  },
  async fields(collections) {
    if (!collections.length) return []
    return (await db('nivaro_fields')
      .whereIn('collection', collections)
      .select('collection', 'field', 'label', 'options')) as Array<{
      collection: string
      field: string
      label: string | null
      options: unknown
    }>
  },
  async links(collections) {
    if (!collections.length) return []
    return (await db('nivaro_relations')
      .whereIn('many_collection', collections)
      .whereNotNull('many_field')
      .select('many_collection', 'many_field', 'one_collection')) as Array<{
      many_collection: string
      many_field: string
      one_collection: string | null
    }>
  }
}

function choicesOf(options: unknown): Record<string, string> | null {
  let o: unknown = options
  if (typeof options === 'string') {
    try {
      o = JSON.parse(options)
    } catch {
      return null
    }
  }
  if (!o || typeof o !== 'object') return null
  const list = Array.isArray(o)
    ? o
    : ((o as { choices?: unknown; options?: unknown }).choices ??
      (o as { options?: unknown }).options)
  if (!Array.isArray(list)) return null
  const out: Record<string, string> = {}
  for (const c of list as Array<Record<string, unknown>>) {
    if (!c || c.value == null) continue
    out[String(c.value)] = choiceText(String(c.text ?? c.label ?? c.value))
  }
  return Object.keys(out).length ? out : null
}

function titleOf(field: string): string {
  return field
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
}

/**
 * Labels for an activity page, read AS `user`. A record the reader cannot see is `null`
 * ("a record you can't see") — never its label, never a hint beyond that. People: first +
 * last name only (directory columns), never a redacted account. Collection, field and
 * choice labels only for collections the reader may read. Never throws.
 */
export async function activityLabelsFor(
  user: User,
  body: LabelsRequest,
  opts: { isAdmin?: boolean } = {},
  deps: LabelDeps = defaultLabelDeps
): Promise<ActivityLabels> {
  const admin = opts.isAdmin === true
  const refs = (Array.isArray(body.refs) ? body.refs : [])
    .map((r) => ({ collection: String(r?.collection ?? ''), id: String(r?.id ?? '').trim() }))
    .filter((r) => IDENT.test(r.collection) && r.id && r.id.length <= 100)
    .slice(0, LABEL_LIMITS.refs)
  const userIds = new Set(
    (Array.isArray(body.users) ? body.users : [])
      .map((u) => String(u ?? '').trim())
      .filter((u) => /^[0-9a-f-]{36}$/i.test(u))
      .slice(0, LABEL_LIMITS.users)
  )
  const fieldAsks = (Array.isArray(body.fields) ? body.fields : [])
    .map((f) => ({ collection: String(f?.collection ?? ''), field: String(f?.field ?? '') }))
    .filter((f) => IDENT.test(f.collection) && IDENT.test(f.field))
    .slice(0, LABEL_LIMITS.fields)
  const collNames = new Set(
    [
      ...(Array.isArray(body.collections) ? body.collections : []).map((c) => String(c ?? '')),
      ...refs.map((r) => r.collection),
      ...fieldAsks.map((f) => f.collection)
    ].filter((c) => IDENT.test(c))
  )
  const names = [...collNames].slice(0, LABEL_LIMITS.collections)

  // Which collections the reader may read at all — everything below hangs off it.
  const readable = new Set<string>()
  await Promise.all(
    names.map(async (c) => {
      if (c === 'nivaro_users') return
      if (admin || (await deps.canRead(user, c).catch(() => false))) readable.add(c)
    })
  )

  const labels: Required<
    Pick<ActivityLabels, 'users' | 'records' | 'collections' | 'fields' | 'choices' | 'links'>
  > = {
    users: {},
    records: {},
    collections: {},
    fields: {},
    choices: {},
    links: {}
  }

  // Records: visible ids per collection (read as the reader), then their labels.
  const byCollection = new Map<string, string[]>()
  for (const r of refs) {
    if (r.collection === 'nivaro_users') {
      userIds.add(r.id)
      continue
    }
    const list = byCollection.get(r.collection) ?? []
    list.push(r.id)
    byCollection.set(r.collection, list)
  }
  const visible: Array<{ collection: string; id: string }> = []
  await Promise.all(
    [...byCollection].map(async ([collection, ids]) => {
      const seen = readable.has(collection)
        ? await deps.visibleIds(user, collection, ids).catch(() => new Set<string>())
        : new Set<string>()
      for (const id of ids) {
        if (seen.has(id.toLowerCase())) visible.push({ collection, id })
        // Gone (deleted) for an administrator, who could read any row: the id is no secret.
        else labels.records[`${collection}:${id}`] = admin && readable.has(collection) ? id : null
      }
    })
  )
  const found = visible.length
    ? await deps.recordLabels(user, visible).catch(() => ({}) as Record<string, string>)
    : {}

  const [people, colls, fieldRows, linkRows] = await Promise.all([
    userIds.size ? deps.people([...userIds]).catch(() => []) : Promise.resolve([]),
    deps.collections(names).catch(() => []),
    deps.fields([...readable]).catch(() => []),
    deps.links([...readable]).catch(() => [])
  ])
  const collTitle = new Map<string, string>()
  for (const c of colls) {
    if (c.collection !== 'nivaro_users' && !readable.has(c.collection)) continue
    const display = String(c.display_name ?? '').trim()
    const singular = String(c.singular ?? '').trim()
    if (display || singular)
      labels.collections[c.collection] = { singular: singular || null, plural: display || null }
    collTitle.set(c.collection, display || titleOf(c.collection))
  }
  for (const v of visible) {
    const key = `${v.collection}:${v.id}`
    const label = String((found as Record<string, string>)[key] ?? '').trim()
    // recordLabelsAsViewer's last resort is the collection's own name — the id reads better.
    labels.records[key] = !label || label === collTitle.get(v.collection) ? v.id : label
  }
  for (const p of people) {
    if (p.is_redacted === true || p.is_redacted === 1) continue
    const name = [p.first_name, p.last_name].filter(Boolean).join(' ').trim()
    if (name) labels.users[String(p.id).toUpperCase()] = name
  }
  // A person named as the record ("changed the role of Pat"): the same directory name.
  for (const r of refs) {
    if (r.collection !== 'nivaro_users') continue
    const name = labels.users[r.id.toUpperCase()]
    if (name) labels.records[`nivaro_users:${r.id}`] = name
  }
  const asked = new Set(fieldAsks.map((f) => `${f.collection}.${f.field}`))
  for (const f of fieldRows) {
    const key = `${f.collection}.${f.field}`
    if (!asked.has(key)) continue
    labels.fields[key] = String(f.label ?? '').trim() || titleOf(f.field)
    const choices = choicesOf(f.options)
    if (choices) labels.choices[key] = choices
  }
  // Asked-for fields without a config row still get a readable label.
  for (const f of fieldAsks)
    if (readable.has(f.collection) && !labels.fields[`${f.collection}.${f.field}`])
      labels.fields[`${f.collection}.${f.field}`] = titleOf(f.field)
  for (const l of linkRows) {
    const key = `${l.many_collection}.${l.many_field}`
    if (asked.has(key)) labels.links[key] = String(l.one_collection ?? '') || 'record'
  }
  return labels
}

/**
 * Sentences for activity rows as `user` reads them — the email digest's entry point (one
 * labels read for the whole batch, every record judged as the recipient).
 */
export async function activitySentencesFor(
  user: User,
  rows: ActivityEntryInput[],
  opts: { timeZone?: string | null } = {}
): Promise<string[]> {
  const { activityLabelRefs } = await import('./activity-sentence.js')
  const { isAdminRole } = await import('./permissions.js')
  const isAdmin = await isAdminRole(user).catch(() => false)
  const labels = await activityLabelsFor(user, activityLabelRefs(rows), { isAdmin })
  return rows.map((r) => renderActivitySentence(r, { ...labels, timeZone: opts.timeZone ?? null }))
}
