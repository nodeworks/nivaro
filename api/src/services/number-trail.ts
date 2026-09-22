import { db } from '../db/index.js'
import { getLabels } from './queues.js'
import { computeRollupTotal, type NormalizedRollup, parseRollupFormula } from './rollups.js'

/**
 * "What changed my number?" (#510)
 *
 * A budget figure moves and there is no path from the number to the cause;
 * explaining one PO total took DMV queries and revision archaeology. The
 * pieces exist — revisions, activity, trash, the rollup's own sources —
 * and this joins them: for a rollup field, every event since a moment that
 * moved a contributing row (created, edited, deleted, moved in or out of
 * this parent), with who did it, the old and new value and the delta; for a
 * plain or stored field, the parent's own revisions of it. The events sum
 * to the net movement, which is checked against the value now.
 */

export interface TrailEvent {
  at: string
  by: { id: string; name: string } | null
  /** created | changed | deleted | moved_in | moved_out | parent */
  action: string
  collection: string
  item_id: string
  label: string
  field: string | null
  from: number | null
  to: number | null
  delta: number | null
  comment: string | null
  via_import: boolean
}

export interface NumberTrail {
  since: string
  value_now: number | null
  net: number
  /** value_now − net: what the figure was at `since`, as far as the trail can tell. */
  value_then_estimate: number | null
  events: TrailEvent[]
  truncated: boolean
  note: string | null
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const CAP = 300

function num(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** JS twin of applyRollupFilter (rollups.ts) — same ops, same NULL-safe _neq. */
function passesFilter(
  row: Record<string, unknown>,
  filter: Record<string, unknown> | undefined
): boolean {
  if (!filter || typeof filter !== 'object') return true
  for (const [col, spec] of Object.entries(filter)) {
    const v = row[col]
    if (spec !== null && typeof spec === 'object' && !Array.isArray(spec)) {
      for (const [op, want] of Object.entries(spec as Record<string, unknown>)) {
        const same = (a: unknown, b: unknown) => String(a ?? '') === String(b ?? '') && a != null
        switch (op) {
          case '_eq':
            if (!same(v, want)) return false
            break
          case '_neq':
            if (v != null && same(v, want)) return false
            break
          case '_gt':
            if (!(Number(v) > Number(want))) return false
            break
          case '_gte':
            if (!(Number(v) >= Number(want))) return false
            break
          case '_lt':
            if (!(Number(v) < Number(want))) return false
            break
          case '_lte':
            if (!(Number(v) <= Number(want))) return false
            break
          case '_null':
            if ((v == null) !== !!want) return false
            break
          case '_nnull':
            if ((v != null) !== !!want) return false
            break
          case '_in':
            if (!Array.isArray(want) || !want.some((w) => same(v, w))) return false
            break
          default:
            break
        }
      }
    } else if (!(String(v ?? '') === String(spec ?? '') && v != null)) return false
  }
  return true
}

function parse<T>(raw: unknown): T | null {
  if (raw == null) return null
  if (typeof raw !== 'string') return raw as T
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

interface RevRow {
  id: number
  item: string
  data: string | null
  delta: string | null
  timestamp: Date
  action: string
  user: string | null
  first_name: string | null
  last_name: string | null
  comment: string | null
}

async function revisionsSince(
  collection: string,
  since: Date,
  filter: (q: import('knex').Knex.QueryBuilder) => void
) {
  return (await db('nivaro_revisions as r')
    .join('nivaro_activity as a', 'a.id', 'r.activity')
    .leftJoin('nivaro_users as u', 'u.id', 'a.user')
    .where('r.collection', collection)
    .where('a.timestamp', '>=', since)
    .modify(filter)
    .orderBy('r.id', 'asc')
    .limit(CAP + 1)
    .select(
      'r.id',
      'r.item',
      'r.data',
      'r.delta',
      'a.timestamp',
      'a.action',
      'a.user',
      'a.comment',
      'u.first_name',
      'u.last_name'
    )) as RevRow[]
}

/** The row's state just before a revision: the newest earlier revision's snapshot. */
async function snapshotBefore(
  collection: string,
  item: string,
  revisionId: number
): Promise<Record<string, unknown> | null> {
  const prev = (await db('nivaro_revisions')
    .where({ collection, item })
    .where('id', '<', revisionId)
    .orderBy('id', 'desc')
    .first('data')) as { data: string | null } | undefined
  return prev ? parse<Record<string, unknown>>(prev.data) : null
}

export async function numberTrail(
  collection: string,
  itemId: string,
  field: string,
  since: Date
): Promise<NumberTrail> {
  const fieldRow = (await db('nivaro_fields')
    .where({ collection, field })
    .first('computed_type', 'computed_formula')) as
    | { computed_type: string | null; computed_formula: string | null }
    | undefined
  const cfg =
    fieldRow?.computed_type === 'rollup' ? parseRollupFormula(fieldRow.computed_formula) : null
  const events: TrailEvent[] = []
  let truncated = false
  let note: string | null = null

  const who = (r: { user: string | null; first_name: string | null; last_name: string | null }) =>
    r.user
      ? {
          id: String(r.user),
          name: `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || String(r.user)
        }
      : null
  const importish = (r: { action: string; comment: string | null }) =>
    /^import|staged-import|^cron-|legacy/i.test(r.action) || /^import:/.test(r.comment ?? '')

  if (cfg) {
    await Promise.all(cfg.sources.map((src) => trailSource(src)))
  } else {
    // A plain or stored field: the parent's own revisions of it.
    const revs = await revisionsSince(collection, since, (q) => q.where('r.item', String(itemId)))
    if (revs.length > CAP) truncated = true
    for (const r of revs.slice(0, CAP)) {
      const delta = parse<Record<string, unknown>>(r.delta)
      if (!delta || !(field in delta)) continue
      const before = await snapshotBefore(collection, String(itemId), r.id)
      const from = num(before?.[field])
      const to = num(delta[field])
      events.push({
        at: r.timestamp.toISOString(),
        by: who(r),
        action: 'parent',
        collection,
        item_id: String(itemId),
        label: 'this record',
        field,
        from,
        to,
        delta: from != null && to != null ? to - from : null,
        comment: r.comment,
        via_import: importish(r)
      })
    }
  }

  async function trailSource(src: NormalizedRollup['sources'][number]) {
    if (!IDENT.test(src.related_collection) || !IDENT.test(src.fk_field)) return
    if (src.recursive) {
      note = 'Recursive rollup — the trail covers direct children only.'
    }
    const child = src.related_collection
    const fk = src.fk_field
    const valueField = src.value_field && IDENT.test(src.value_field) ? src.value_field : null
    const isCount = src.aggregate === 'count'
    if (!isCount && !valueField) {
      note = 'Formula rollup — rows are listed, deltas are not computed for the formula.'
    }
    const parentKey = String(itemId)
    // Rows linked now, plus any revision in the window whose snapshot names
    // this parent (a row that moved out is not linked now).
    const current = (await db(child)
      .where(fk, itemId as never)
      .select('id')) as Array<{ id: unknown }>
    const currentIds = current.map((c) => String(c.id))
    const revs = await revisionsSince(child, since, (q) =>
      q.where((b) => {
        if (currentIds.length) b.whereIn('r.item', currentIds.slice(0, 1500))
        b.orWhere(
          'r.data',
          'like',
          `%"${fk}":${/^\d+$/.test(parentKey) ? parentKey : `"${parentKey}"`}%`
        )
        b.orWhere('r.data', 'like', `%"${fk}":"${parentKey}"%`)
      })
    )
    if (revs.length > CAP) truncated = true
    const ids = new Set<string>()
    const pending: Array<{
      r: RevRow
      before: Record<string, unknown> | null
      after: Record<string, unknown> | null
    }> = []
    for (const r of revs.slice(0, CAP)) {
      const after = parse<Record<string, unknown>>(r.data)
      const before =
        r.action === 'create' ? null : await snapshotBefore(child, String(r.item), r.id)
      pending.push({ r, before, after })
      ids.add(String(r.item))
    }
    // Deleted children live only in trash.
    const trashed = (await db('nivaro_trash as t')
      .leftJoin('nivaro_users as u', 'u.id', 't.deleted_by')
      .where('t.collection', child)
      .where('t.deleted_at', '>=', since)
      .where((b) => {
        b.where(
          't.data',
          'like',
          `%"${fk}":${/^\d+$/.test(parentKey) ? parentKey : `"${parentKey}"`}%`
        )
        b.orWhere('t.data', 'like', `%"${fk}":"${parentKey}"%`)
      })
      .limit(CAP)
      .select(
        't.item_id',
        't.data',
        't.deleted_at',
        't.deleted_by',
        'u.first_name',
        'u.last_name'
      )) as Array<{
      item_id: string
      data: string | null
      deleted_at: Date
      deleted_by: string | null
      first_name: string | null
      last_name: string | null
    }>
    for (const t of trashed) ids.add(String(t.item_id))
    const labels = await getLabels(new Map([[child, ids]])).catch(
      () => ({}) as Record<string, string>
    )
    const labelOf = (id: string) => labels[`${child}:${id}`] ?? labels[id] ?? `#${id}`
    // The source's own row filter (`line_type _neq 4`) decides membership
    // too — a row that fails it never counted, however it points here.
    const belongs = (row: Record<string, unknown> | null) =>
      row != null && String(row[fk] ?? '') === parentKey && passesFilter(row, src.filter)
    const val = (row: Record<string, unknown> | null): number | null =>
      row == null ? null : isCount ? 1 : valueField ? num(row[valueField]) : null

    for (const { r, before, after } of pending) {
      const inBefore = belongs(before)
      const inAfter = belongs(after)
      if (!inBefore && !inAfter) continue
      let action = 'changed'
      if (r.action === 'create' || (!inBefore && inAfter))
        action = r.action === 'create' ? 'created' : 'moved_in'
      else if (inBefore && !inAfter) action = 'moved_out'
      else if (r.action === 'delete') action = 'deleted'
      const from = inBefore ? val(before) : isCount ? 0 : null
      const to = inAfter && r.action !== 'delete' ? val(after) : isCount ? 0 : null
      // A change that did not touch the value contributes nothing — skip it
      // unless it moved the row in or out.
      if (action === 'changed' && from === to) continue
      if (action === 'changed' && !isCount && valueField) {
        const delta = parse<Record<string, unknown>>(r.delta)
        if (delta && !(valueField in delta) && !(fk in delta)) continue
      }
      events.push({
        at: r.timestamp.toISOString(),
        by: who(r),
        action,
        collection: child,
        item_id: String(r.item),
        label: labelOf(String(r.item)),
        field: isCount ? null : valueField,
        from,
        to,
        delta:
          from != null && to != null ? to - from : to != null ? to : from != null ? -from : null,
        comment: r.comment,
        via_import: importish(r)
      })
    }
    for (const t of trashed) {
      const row = parse<Record<string, unknown>>(t.data)
      const from = val(row)
      events.push({
        at: t.deleted_at.toISOString(),
        by: t.deleted_by
          ? {
              id: String(t.deleted_by),
              name: `${t.first_name ?? ''} ${t.last_name ?? ''}`.trim() || String(t.deleted_by)
            }
          : null,
        action: 'deleted',
        collection: child,
        item_id: String(t.item_id),
        label: labelOf(String(t.item_id)),
        field: isCount ? null : valueField,
        from,
        to: isCount ? 0 : null,
        delta: from != null ? -from : null,
        comment: null,
        via_import: false
      })
    }
  }

  events.sort((a, b) => b.at.localeCompare(a.at))
  const net = Math.round(events.reduce((n, e) => n + (e.delta ?? 0), 0) * 100) / 100
  let valueNow: number | null = null
  if (cfg) valueNow = await computeRollupTotal(cfg, itemId, collection).catch(() => null)
  else {
    const row = (await db(collection)
      .where('id', itemId as never)
      .first(field)) as Record<string, unknown> | undefined
    valueNow = num(row?.[field])
  }
  return {
    since: since.toISOString(),
    value_now: valueNow,
    net,
    value_then_estimate: valueNow == null ? null : Math.round((valueNow - net) * 100) / 100,
    events,
    truncated,
    note
  }
}
