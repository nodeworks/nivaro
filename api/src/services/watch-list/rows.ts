import { db } from '../../db/index.js'
import type { User } from '../../types.js'
import { whereInList } from '../db-batch.js'
import { type ChangeEvent, type ChangeIndicator, changeIndicator, stepTiming } from './change.js'
import { stepMedians } from './step-medians.js'
import { pinKey, seenAt, type WatchListPrefs, type WatchPin } from './store.js'

/**
 * The watch list's rows, read AS THE VIEWER (rt5 #1). Per collection, everything is batched:
 * one items read (role policy, row filters, User Scopes, field list — a pin they can no longer
 * read comes back `available: false` with nothing else about it), one instance read, the
 * owner + SLA batches the record header uses, and one newest-row read each for edits, moves
 * and comments. No per-record round trips; ≤ 50 pins.
 *
 * Summary mode (dock minimized or closed) answers only WHICH pins changed since seen — the
 * visibility check and the three newest-row reads, nothing else.
 */

export interface WatchFigure {
  field: string
  label: string
  value: number
  money: boolean
}

export interface WatchRow {
  key: string
  collection: string
  collection_label: string
  id: string
  pinned_at: string
  available: boolean
  title: string | null
  state: { key: string; label: string; color: string | null } | null
  owners: Array<{ id: string; name: string; inactive?: 'suspended' | 'former' }>
  figures: WatchFigure[]
  sla: {
    status: 'ok' | 'warning' | 'breached' | null
    warning_at: string | null
    due_at: string | null
  } | null
  timing: { in_step_s: number; usual_s: number | null; ratio: number | null } | null
  change: ChangeIndicator | null
  updated_at: string | null
}

const SKIP_DELTA = new Set([
  'id',
  'date_updated',
  'date_created',
  'user_updated',
  'user_created',
  'updated_at',
  'created_at',
  'sort'
])

const iso = (v: unknown): string | null => {
  if (v == null || v === '') return null
  const t = new Date(v as string).getTime()
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

const titleWords = (f: string) =>
  f
    .replace(/_/g, ' ')
    .trim()
    .replace(/^\w/, (c) => c.toUpperCase())

function deltaKeys(delta: unknown): string[] {
  let o: unknown = delta
  if (typeof delta === 'string') {
    try {
      o = JSON.parse(delta)
    } catch {
      return []
    }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return []
  return Object.keys(o as Record<string, unknown>).filter((k) => !SKIP_DELTA.has(k))
}

/** Which fields the viewer may read on a collection: null = all. */
async function readableFields(
  user: User,
  isAdmin: boolean,
  collection: string
): Promise<Set<string> | null> {
  if (isAdmin) return null
  const { getAllowedFields } = await import('../permissions.js')
  const list = await getAllowedFields(user, 'read', collection).catch(() => [] as string[])
  if (list == null || list.includes('*')) return null
  return new Set(list)
}

const mayRead = (allowed: Set<string> | null, field: string) => !allowed || allowed.has(field)

interface Newest {
  edits: Map<string, ChangeEvent>
  moves: Map<string, ChangeEvent>
  comments: Map<string, ChangeEvent>
  actors: Set<string>
}

/** The newest edit / move / comment per record, cut to what the viewer may know. */
async function newestEvents(
  collection: string,
  ids: string[],
  instances: Map<string, { id: string; template: string | null }>,
  allowed: Set<string> | null,
  fieldLabels: Map<string, string>,
  stateLabels: Map<string, string>,
  quiet: Set<string> = new Set()
): Promise<Newest> {
  const out: Newest = {
    edits: new Map(),
    moves: new Map(),
    comments: new Map(),
    actors: new Set()
  }
  if (ids.length === 0) return out
  const rn = (part: string, order: string[]) =>
    db.raw(
      `ROW_NUMBER() OVER (PARTITION BY ?? ORDER BY ${order.map(() => '?? DESC').join(', ')}) AS rn`,
      [part, ...order]
    )
  const instIds = [...instances.values()].map((i) => i.id)
  const instItem = new Map([...instances.entries()].map(([item, i]) => [i.id.toLowerCase(), item]))

  const [acts, moves, comments] = await Promise.all([
    (async () => {
      const inner = db('nivaro_activity as a')
        .where('a.collection', collection)
        .whereIn('a.action', ['create', 'update'])
      whereInList(inner, 'a.item', ids)
      inner.select(
        'a.id',
        'a.item',
        'a.action',
        'a.user',
        'a.timestamp',
        rn('a.item', ['a.timestamp', 'a.id'])
      )
      return (await db
        .from(inner.as('x'))
        .where('rn', 1)
        .select('id', 'item', 'action', 'user', 'timestamp')
        .catch(() => [])) as Array<{
        id: number
        item: string
        action: string
        user: string | null
        timestamp: Date
      }>
    })(),
    (async () => {
      if (instIds.length === 0) return []
      const inner = db('nivaro_workflow_history as h')
      whereInList(inner, 'h.instance', instIds)
      inner.select(
        'h.instance',
        'h.to_state',
        'h.user',
        'h.timestamp',
        rn('h.instance', ['h.timestamp', 'h.id'])
      )
      return (await db
        .from(inner.as('x'))
        .where('rn', 1)
        .select('instance', 'to_state', 'user', 'timestamp')
        .catch(() => [])) as Array<{
        instance: string
        to_state: string | null
        user: string | null
        timestamp: Date
      }>
    })(),
    (async () => {
      const inner = db('nivaro_comments as c')
        .where('c.collection', collection)
        .whereNull('c.deleted_at')
      whereInList(inner, 'c.item', ids)
      inner.select('c.item', 'c.user', 'c.created_at', 'c.field', rn('c.item', ['c.created_at']))
      // A field comment on a field the viewer may not read is not theirs to know about
      // (#3232) — read a few newest per record so a hidden one never masks a readable one.
      return (await db
        .from(inner.as('x'))
        .where('rn', '<=', 5)
        .orderBy('created_at', 'desc')
        .select('item', 'user', 'created_at', 'field')
        .catch(() => [])) as Array<{
        item: string
        user: string | null
        created_at: Date
        field: string | null
      }>
    })()
  ])

  // Which fields an edit touched: its revision's delta, cut to the viewer's field list.
  const updateIds = acts.filter((a) => a.action === 'update').map((a) => a.id)
  const deltas = new Map<number, string[]>()
  if (updateIds.length > 0) {
    const revs = (await db('nivaro_revisions')
      .whereIn('activity', updateIds)
      .select('activity', 'delta')
      .catch(() => [])) as Array<{ activity: number; delta: unknown }>
    for (const r of revs) deltas.set(Number(r.activity), deltaKeys(r.delta))
  }
  for (const a of acts) {
    const item = String(a.item)
    if (a.action === 'create') {
      out.edits.set(item, { kind: 'created', at: iso(a.timestamp) ?? '', by: a.user ?? null })
    } else {
      const keys = deltas.get(Number(a.id))
      // Bookkeeping columns (date / user updated, hidden fields) are not a change to name.
      const visible = (keys ?? []).filter((k) => mayRead(allowed, k) && !quiet.has(k))
      // A write that touched only fields the viewer cannot read is not a change to them.
      if (keys && keys.length > 0 && visible.length === 0) continue
      out.edits.set(item, {
        kind: 'edited',
        at: iso(a.timestamp) ?? '',
        by: a.user ?? null,
        fields: visible.map((k) => fieldLabels.get(k) ?? titleWords(k))
      })
    }
    if (a.user) out.actors.add(String(a.user))
  }
  for (const m of moves) {
    const item = instItem.get(String(m.instance).toLowerCase())
    if (!item) continue
    out.moves.set(item, {
      kind: 'moved',
      at: iso(m.timestamp) ?? '',
      by: m.user ?? null,
      to: m.to_state ? (stateLabels.get(String(m.to_state).toLowerCase()) ?? null) : null
    })
    if (m.user) out.actors.add(String(m.user))
  }
  for (const c of comments) {
    const item = String(c.item)
    if (out.comments.has(item)) continue
    if (c.field && !mayRead(allowed, c.field)) continue
    out.comments.set(item, { kind: 'commented', at: iso(c.created_at) ?? '', by: c.user ?? null })
    if (c.user) out.actors.add(String(c.user))
  }
  return out
}

/** People's names for change lines; a redacted account reads "Former user". */
async function actorNames(ids: Set<string>): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  if (ids.size === 0) return out
  const rows = (await db('nivaro_users')
    .whereIn('id', [...ids].slice(0, 500))
    .select('id', 'first_name', 'last_name', 'email', 'is_redacted')
    .catch(() => [])) as Array<{
    id: string
    first_name: string | null
    last_name: string | null
    email: string | null
    is_redacted: boolean | number | null
  }>
  for (const r of rows) {
    const name = r.is_redacted
      ? 'Former user'
      : `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || 'Someone'
    out[String(r.id).toLowerCase()] = name
  }
  return out
}

export async function pickedInstances(
  collection: string,
  ids: string[]
): Promise<
  Array<{
    id: string
    collection: string
    item: string
    template: string
    current_state: string | null
    completed_at: Date | null
    started_at: Date | null
  }>
> {
  if (ids.length === 0) return []
  try {
    const rows = (await whereInList(
      db('nivaro_workflow_instances').where({ collection }),
      'item',
      ids
    ).select(
      'id',
      'collection',
      'item',
      'template',
      'current_state',
      'completed_at',
      'started_at'
    )) as Array<{
      id: string
      collection: string
      item: string
      template: string
      current_state: string | null
      completed_at: Date | null
      started_at: Date | null
    }>
    const { excludeBranchChildren } = await import('../branch-instances.js')
    const { pickInstancePerItem } = await import('../../routes/pipelines.js')
    return pickInstancePerItem(await excludeBranchChildren(rows))
  } catch {
    return []
  }
}

async function stateRows(
  stateIds: string[]
): Promise<Map<string, { key: string; label: string; color: string | null }>> {
  const out = new Map<string, { key: string; label: string; color: string | null }>()
  if (stateIds.length === 0) return out
  const rows = (await db('nivaro_workflow_states')
    .whereIn('id', [...new Set(stateIds)])
    .select('id', 'key', 'label', 'color')
    .catch(() => [])) as Array<{ id: string; key: string; label: string; color: string | null }>
  for (const r of rows)
    out.set(String(r.id).toLowerCase(), { key: r.key, label: r.label, color: r.color ?? null })
  return out
}

/** All states of the templates in play (a move's "to" may be any of them). */
async function templateStateLabels(templates: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (templates.length === 0) return out
  const rows = (await db('nivaro_workflow_states')
    .whereIn('template', [...new Set(templates)])
    .select('id', 'label', 'key')
    .catch(() => [])) as Array<{ id: string; label: string | null; key: string }>
  for (const r of rows) out.set(String(r.id).toLowerCase(), r.label || titleWords(r.key))
  return out
}

export interface WatchReadOptions {
  user: User
  isAdmin: boolean
  workspaceId?: string
  summary?: boolean
  now?: Date
}

/** Pins grouped by collection, in pin order. */
function byCollection(pins: WatchPin[]): Map<string, WatchPin[]> {
  const out = new Map<string, WatchPin[]>()
  for (const p of pins) {
    const list = out.get(p.c)
    if (list) list.push(p)
    else out.set(p.c, [p])
  }
  return out
}

/** Which of these record ids the viewer can open (every gate). */
async function visibleOf(
  user: User,
  isAdmin: boolean,
  collection: string,
  ids: string[]
): Promise<Set<string>> {
  try {
    const { compileAccessGates, visibleIds } = await import('../record-access.js')
    const gates = await compileAccessGates(user, collection, { actingAdmin: isAdmin })
    return await visibleIds(gates, ids)
  } catch {
    return new Set()
  }
}

/**
 * The rows (full) or just the changed keys (summary). `list` is the person's stored watch list.
 */
export async function readWatchRows(
  list: WatchListPrefs,
  opts: WatchReadOptions
): Promise<{ rows: WatchRow[]; changed: string[]; others: Record<string, string> }> {
  const { user, isAdmin } = opts
  const now = opts.now ?? new Date()
  const selfId = String(user.id)
  const groups = byCollection(list.pins)
  const rowByKey = new Map<string, WatchRow>()
  const changed: string[] = []
  const others: Record<string, string> = {}
  const medians = opts.summary ? new Map<string, number>() : await stepMedians()
  const { getCollection, getFields } = await import('../collections.js')
  const { readableName } = await import('../command-center/regions.js')

  await Promise.all(
    [...groups.entries()].map(async ([collection, pins]) => {
      const ids = pins.map((p) => p.id)
      const [meta, fields, allowed] = await Promise.all([
        getCollection(collection).catch(() => undefined),
        getFields(collection).catch(() => []),
        readableFields(user, isAdmin, collection)
      ])
      const collectionLabel = readableName(collection, meta?.singular ?? meta?.display_name)
      // Fields a change line may name: shown ones, not audit stamps. A field missing from the
      // metadata is named in plain words.
      const fieldLabels = new Map<string, string>()
      const quiet = new Set<string>()
      for (const f of fields as Array<{
        field: string
        label?: string | null
        hidden?: boolean | null
        special?: string[] | string | null
      }>) {
        const special = Array.isArray(f.special) ? f.special.join(',') : String(f.special ?? '')
        if (f.hidden || /(date|user)-(updated|created)/.test(special)) quiet.add(f.field)
        else fieldLabels.set(f.field, String(f.label ?? '').trim() || titleWords(f.field))
      }

      // Which pins the viewer can still open — and, in full mode, their rows as they read them.
      const rowsById = new Map<string, Record<string, unknown>>()
      let visible: Set<string>
      if (opts.summary) {
        visible = meta ? await visibleOf(user, isAdmin, collection, ids) : new Set()
      } else {
        visible = new Set()
        if (meta) {
          try {
            const { readItems } = await import('../items.js')
            const res = (await readItems(
              user,
              collection,
              { filter: { id: { _in: ids } }, limit: ids.length, fields: ['*'] } as never,
              undefined,
              opts.workspaceId
            )) as { data?: Array<Record<string, unknown>> }
            for (const r of res.data ?? []) {
              rowsById.set(String(r.id), r)
              visible.add(String(r.id))
            }
          } catch {
            /* no read access at all: every pin here reads "No longer available" */
          }
        }
      }
      const live = ids.filter((id) => visible.has(id))
      const insts = await pickedInstances(collection, live)
      const instByItem = new Map(insts.map((i) => [String(i.item), i]))
      const moveLabels = await templateStateLabels(insts.map((i) => i.template).filter(Boolean))
      const events = await newestEvents(
        collection,
        live,
        new Map(insts.map((i) => [String(i.item), { id: String(i.id), template: i.template }])),
        allowed,
        fieldLabels,
        moveLabels,
        quiet
      )

      if (opts.summary) {
        for (const p of pins) {
          if (!visible.has(p.id)) continue
          // Desktop alerts (rt6 #4) ask "did someone ELSE just change it?" — never the
          // person's own write from another tab or device.
          const other = newestOtherAt(
            [events.edits.get(p.id), events.moves.get(p.id), events.comments.get(p.id)],
            selfId
          )
          if (other) others[pinKey(p.c, p.id)] = other
          const ind = changeIndicator(
            [events.edits.get(p.id), events.moves.get(p.id), events.comments.get(p.id)],
            selfId,
            seenAt(list, p),
            {}
          )
          if (ind?.changed) changed.push(pinKey(p.c, p.id))
        }
        return
      }

      const [names, owners, sla, states, labels] = await Promise.all([
        actorNames(events.actors),
        (async () => {
          if (live.length === 0) return {}
          try {
            const { resolvedOwnerNames } = await import('../../routes/pipelines.js')
            return await resolvedOwnerNames(collection, live)
          } catch {
            return {}
          }
        })(),
        (async () => {
          if (insts.length === 0) return {}
          try {
            const { computeStatusBatch } = await import('../../routes/sla.js')
            return await computeStatusBatch(
              collection,
              insts.map((i) => String(i.item)),
              insts.map((i) => ({
                id: i.id,
                item: String(i.item),
                current_state: i.current_state,
                template: i.template,
                started_at: i.started_at ?? new Date(0)
              }))
            )
          } catch {
            return {}
          }
        })(),
        stateRows(insts.map((i) => i.current_state).filter((s): s is string => !!s)),
        (async () => {
          if (live.length === 0) return {} as Record<string, string>
          try {
            const { recordLabelsAsViewer } = await import('../record-labels-as-viewer.js')
            return await recordLabelsAsViewer(
              user,
              live.map((id) => ({ collection, id }))
            )
          } catch {
            return {} as Record<string, string>
          }
        })()
      ])
      const { pickCardAmounts } = await import('../record-card.js')

      for (const p of pins) {
        const key = pinKey(p.c, p.id)
        const row = rowsById.get(p.id)
        if (!row) {
          rowByKey.set(key, {
            key,
            collection,
            collection_label: collectionLabel,
            id: p.id,
            pinned_at: p.at,
            available: false,
            title: null,
            state: null,
            owners: [],
            figures: [],
            sla: null,
            timing: null,
            change: null,
            updated_at: null
          })
          continue
        }
        const inst = instByItem.get(p.id)
        const st = inst?.current_state ? states.get(String(inst.current_state).toLowerCase()) : null
        const s = (sla as unknown as Record<string, Record<string, unknown>>)[p.id]
        const open = inst && !inst.completed_at
        const change = changeIndicator(
          [events.edits.get(p.id), events.moves.get(p.id), events.comments.get(p.id)],
          selfId,
          seenAt(list, p),
          names
        )
        if (change?.changed) changed.push(key)
        const updated =
          row.date_updated ?? row.updated_at ?? row.date_created ?? row.created_at ?? null
        rowByKey.set(key, {
          key,
          collection,
          collection_label: collectionLabel,
          id: p.id,
          pinned_at: p.at,
          available: true,
          title:
            (labels as Record<string, string>)[key] ||
            String(row.name ?? row.title ?? '') ||
            `${collectionLabel} ${p.id}`,
          state: st ?? null,
          owners: open
            ? ((owners as Record<string, WatchRow['owners']>)[p.id] ?? []).slice(0, 4)
            : [],
          figures: pickCardAmounts(
            row,
            fields as never,
            (meta as { display_template?: string | null } | undefined)?.display_template ?? null
          )
            // Belt and braces: only fields on the viewer's own read list.
            .filter((f) => mayRead(allowed, f.field))
            .slice(0, 2),
          sla:
            open && s
              ? {
                  status: (s.status as 'ok' | 'warning' | 'breached' | null) ?? null,
                  warning_at: iso(s.warning_at),
                  due_at: iso(s.due_at)
                }
              : null,
          timing:
            open && s?.entered_at
              ? stepTiming(
                  s.entered_at as string,
                  inst?.current_state
                    ? (medians.get(String(inst.current_state).toLowerCase()) ?? null)
                    : null,
                  now.getTime()
                )
              : null,
          change,
          updated_at: iso(updated)
        })
      }
    })
  )

  const rows = list.pins
    .map((p) => rowByKey.get(pinKey(p.c, p.id)))
    .filter((r): r is WatchRow => !!r)
  // Pin order, not the order collections finished in.
  const order = new Map(list.pins.map((p, i) => [pinKey(p.c, p.id), i]))
  changed.sort((a, z) => (order.get(a) ?? 0) - (order.get(z) ?? 0))
  return { rows, changed, others }
}

/** The newest event by someone other than `selfId` (ISO), or null. Pure. */
export function newestOtherAt(
  events: Array<ChangeEvent | null | undefined>,
  selfId: string
): string | null {
  let best: string | null = null
  for (const e of events) {
    if (!e?.at || (e.by && e.by.toLowerCase() === selfId.toLowerCase())) continue
    if (!best || e.at > best) best = e.at
  }
  return best
}
