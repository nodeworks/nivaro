import { db } from '../db/index.js'
import type { User } from '../types.js'

/**
 * "What they did this week" on the people page (#1968) — for administrators
 * and the person's manager. Built from the activity log, workflow history,
 * approval decisions, comments and import jobs, and narrowed to what the
 * VIEWER may read: a record the viewer cannot open is not counted, listed or
 * labelled (the team view's rule, services/team.ts). Comment text and field
 * values are never read; records are named by their display label only when
 * the viewer can open them.
 *
 * The optional AI lines are written from this narrowed payload alone.
 */

export interface PersonWeek {
  user: { id: string; name: string }
  since: string
  until: string
  figures: {
    created: number
    updated: number
    deleted: number
    moved: number
    completed: number
    sent_back: number
    approved: number
    rejected: number
    comments: number
    imports: number
  }
  by_collection: Array<{
    collection: string
    label: string
    created: number
    updated: number
    moved: number
    comments: number
  }>
  highlights: Array<{
    collection: string
    item_id: string
    label: string
    what: 'created' | 'completed' | 'moved' | 'sent back' | 'approved' | 'rejected'
    state: string | null
    at: string
  }>
}

type Ev = {
  collection: string
  item: string
  kind:
    | 'created'
    | 'updated'
    | 'deleted'
    | 'moved'
    | 'completed'
    | 'sent back'
    | 'approved'
    | 'rejected'
    | 'comment'
  at: Date
  state?: string | null
}

const SYSTEM = /^(nivaro|directus)_/i
const nameOf = (u: Record<string, unknown>) =>
  `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || String(u.email ?? u.id)

async function eventsOf(userId: string, since: Date, until: Date): Promise<Ev[]> {
  const [acts, moves, decisions, comments] = await Promise.all([
    db('nivaro_activity')
      .where('user', userId)
      .where('timestamp', '>=', since)
      .where('timestamp', '<', until)
      .whereIn('action', ['create', 'update', 'delete'])
      .whereNotNull('item')
      .orderBy('timestamp', 'desc')
      .limit(5000)
      .select('action', 'collection', 'item', 'timestamp')
      .catch(() => []) as Promise<Array<Record<string, unknown>>>,
    db('nivaro_workflow_history as h')
      .join('nivaro_workflow_instances as i', 'i.id', 'h.instance')
      .join('nivaro_workflow_states as st', 'st.id', 'h.to_state')
      .leftJoin('nivaro_workflow_states as sf', 'sf.id', 'h.from_state')
      .where('h.user', userId)
      .where('h.timestamp', '>=', since)
      .where('h.timestamp', '<', until)
      .whereNotNull('h.from_state')
      .orderBy('h.timestamp', 'desc')
      .limit(2000)
      .select(
        'i.collection',
        'i.item',
        'h.timestamp',
        'st.label as to_label',
        'st.key as to_key',
        'st.is_terminal',
        'st.sort as to_sort',
        'sf.sort as from_sort'
      )
      .catch(() => []) as Promise<Array<Record<string, unknown>>>,
    db('nivaro_approval_decisions as d')
      .join('nivaro_approval_instances as i', 'i.id', 'd.instance')
      .where('d.user', userId)
      .where('d.decided_at', '>=', since)
      .where('d.decided_at', '<', until)
      .limit(1000)
      .select('i.collection', 'i.item', 'd.decision', 'd.decided_at')
      .catch(() => []) as Promise<Array<Record<string, unknown>>>,
    db('nivaro_comments')
      .where('user', userId)
      .whereNull('deleted_at')
      .where('created_at', '>=', since)
      .where('created_at', '<', until)
      .limit(2000)
      .select('collection', 'item', 'created_at')
      .catch(() => []) as Promise<Array<Record<string, unknown>>>
  ])
  const out: Ev[] = []
  for (const a of acts) {
    const kind = a.action === 'create' ? 'created' : a.action === 'delete' ? 'deleted' : 'updated'
    out.push({
      collection: String(a.collection),
      item: String(a.item),
      kind,
      at: new Date(a.timestamp as Date)
    })
  }
  for (const m of moves) {
    const done = Number(m.is_terminal) === 1 || m.is_terminal === true
    const back = m.from_sort != null && m.to_sort != null && Number(m.from_sort) > Number(m.to_sort)
    out.push({
      collection: String(m.collection),
      item: String(m.item),
      kind: done && m.to_key !== 'canceled' ? 'completed' : back ? 'sent back' : 'moved',
      at: new Date(m.timestamp as Date),
      state: (m.to_label as string | null) ?? (m.to_key as string | null) ?? null
    })
  }
  for (const d of decisions) {
    const dec = String(d.decision ?? '').toLowerCase()
    if (!dec.startsWith('approv') && !dec.startsWith('reject')) continue
    out.push({
      collection: String(d.collection),
      item: String(d.item),
      kind: dec.startsWith('approv') ? 'approved' : 'rejected',
      at: new Date(d.decided_at as Date)
    })
  }
  for (const c of comments)
    out.push({
      collection: String(c.collection),
      item: String(c.item),
      kind: 'comment',
      at: new Date(c.created_at as Date)
    })
  return out.filter((e) => e.collection && !SYSTEM.test(e.collection) && e.item)
}

/**
 * Pure: events already narrowed to readable records → the summary payload
 * (labels from `labels`, keyed `collection:id`). Exported for tests.
 */
export function shapeWeek(
  events: Ev[],
  labels: Record<string, string>,
  collectionLabels: Record<string, string>,
  imports: number
): Pick<PersonWeek, 'figures' | 'by_collection' | 'highlights'> {
  const distinct = (kind: Ev['kind']) =>
    new Set(events.filter((e) => e.kind === kind).map((e) => `${e.collection}:${e.item}`)).size
  const count = (kind: Ev['kind']) => events.filter((e) => e.kind === kind).length
  const figures = {
    created: distinct('created'),
    updated: distinct('updated'),
    deleted: distinct('deleted'),
    moved: count('moved') + count('completed') + count('sent back'),
    completed: count('completed'),
    sent_back: count('sent back'),
    approved: count('approved'),
    rejected: count('rejected'),
    comments: count('comment'),
    imports
  }
  const cols = new Map<string, PersonWeek['by_collection'][number]>()
  const seen = new Map<string, Set<string>>()
  for (const e of events) {
    let c = cols.get(e.collection)
    if (!c) {
      c = {
        collection: e.collection,
        label: collectionLabels[e.collection] ?? e.collection,
        created: 0,
        updated: 0,
        moved: 0,
        comments: 0
      }
      cols.set(e.collection, c)
    }
    const k = `${e.kind}:${e.item}`
    const s = seen.get(e.collection) ?? new Set<string>()
    seen.set(e.collection, s)
    if (e.kind === 'created' && !s.has(k)) c.created++
    else if (e.kind === 'updated' && !s.has(k)) c.updated++
    else if (e.kind === 'moved' || e.kind === 'completed' || e.kind === 'sent back') c.moved++
    else if (e.kind === 'comment') c.comments++
    s.add(k)
  }
  const rank: Record<string, number> = {
    completed: 0,
    approved: 1,
    rejected: 1,
    'sent back': 2,
    created: 3,
    moved: 4
  }
  const picked = new Set<string>()
  const highlights: PersonWeek['highlights'] = []
  for (const e of [...events]
    .filter((x) => x.kind in rank)
    .sort((a, b) => rank[a.kind] - rank[b.kind] || b.at.getTime() - a.at.getTime())) {
    const key = `${e.collection}:${e.item}`
    if (picked.has(key)) continue
    picked.add(key)
    highlights.push({
      collection: e.collection,
      item_id: e.item,
      label: labels[key] ?? `#${e.item}`,
      what: e.kind as PersonWeek['highlights'][number]['what'],
      state: e.state ?? null,
      at: e.at.toISOString()
    })
    if (highlights.length >= 10) break
  }
  return {
    figures,
    by_collection: [...cols.values()]
      .sort(
        (a, b) =>
          b.created +
          b.updated +
          b.moved +
          b.comments -
          (a.created + a.updated + a.moved + a.comments)
      )
      .slice(0, 8),
    highlights
  }
}

export async function buildPersonWeek(
  viewer: User,
  userId: string,
  days = 7,
  now = new Date()
): Promise<PersonWeek | null> {
  const person = (await db('nivaro_users')
    .where('id', userId)
    .first('id', 'first_name', 'last_name', 'email')
    .catch(() => undefined)) as Record<string, unknown> | undefined
  if (!person) return null
  const until = now
  const since = new Date(now.getTime() - days * 86_400_000)
  const all = await eventsOf(String(person.id), since, until)

  // Only what the viewer may open — role, row filter and user scopes.
  const byCollection = new Map<string, Set<string>>()
  for (const e of all) {
    const s = byCollection.get(e.collection) ?? new Set<string>()
    s.add(e.item)
    byCollection.set(e.collection, s)
  }
  const { readableRecords } = await import('./team.js')
  // A deleted record cannot be checked any more: it counts only when the
  // viewer can read its collection.
  const readable = await readableRecords(viewer, byCollection)
  const { can } = await import('./permissions.js')
  const colReadable = new Map<string, boolean>()
  for (const c of byCollection.keys())
    colReadable.set(c, await can(viewer, 'read', c).catch(() => false))
  const events = all.filter((e) =>
    e.kind === 'deleted' ? colReadable.get(e.collection) : readable.has(`${e.collection}:${e.item}`)
  )

  const imports = (await db('nivaro_import_jobs')
    .where('created_by', person.id as string)
    .where('created_at', '>=', since)
    .select('collection')
    .catch(() => [])) as Array<{ collection: string }>
  let importCount = 0
  for (const i of imports) {
    if (
      colReadable.get(i.collection) ??
      (await can(viewer, 'read', i.collection).catch(() => false))
    )
      importCount++
  }

  // Labels come from the display template; only where the viewer may read
  // every field of the collection — otherwise the record shows as #id.
  const { getAllowedFields } = await import('./permissions.js')
  const fullRead = new Map<string, boolean>()
  for (const c of new Set(events.map((e) => e.collection)))
    fullRead.set(c, (await getAllowedFields(viewer, 'read', c).catch(() => [])) === null)
  const labelIds = new Map<string, Set<string>>()
  for (const e of events) {
    if (e.kind === 'deleted' || e.kind === 'updated' || e.kind === 'comment') continue
    if (!fullRead.get(e.collection)) continue
    const s = labelIds.get(e.collection) ?? new Set<string>()
    s.add(e.item)
    labelIds.set(e.collection, s)
  }
  const { getLabels } = await import('./queues.js')
  const labels = labelIds.size ? await getLabels(labelIds).catch(() => ({})) : {}
  const cols = (await db('nivaro_collections')
    .whereIn('collection', [...new Set(events.map((e) => e.collection))])
    .select('collection', 'display_name')
    .catch(() => [])) as Array<{ collection: string; display_name: string | null }>
  const collectionLabels = Object.fromEntries(
    cols.map((c) => [c.collection, c.display_name || c.collection])
  )
  return {
    user: { id: String(person.id), name: nameOf(person) },
    since: since.toISOString(),
    until: until.toISOString(),
    ...shapeWeek(events, labels, collectionLabels, importCount)
  }
}

/** A few plain lines from the narrowed payload — nothing else reaches the model. */
export async function summarizePersonWeek(week: PersonWeek): Promise<string | null> {
  const { getAiClient, getAiModelSettings } = await import('./ai-client.js')
  const client = await getAiClient()
  if (!client) return null
  const { summarizeModel } = await getAiModelSettings()
  const payload = { ...week, user: { name: 'this person' } }
  const message = await client.messages.create({
    model: summarizeModel,
    max_tokens: 300,
    system:
      'From the JSON provided and nothing else, write 2-4 short plain-text lines (start each with "- ") on what this person did in the period: records created and moved (name records by their label), approvals, comments, imports, and where most of their work went. No headers, no judgement of performance, no invented facts.',
    messages: [{ role: 'user', content: JSON.stringify(payload).slice(0, 12_000) }]
  })
  const text = message.content[0]?.type === 'text' ? message.content[0].text.trim() : ''
  return text || null
}
