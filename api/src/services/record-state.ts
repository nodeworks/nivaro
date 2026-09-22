/**
 * `$state` — a record's pipeline state as a virtual read field.
 *
 * Opt-in on the items API (`fields=id,$state`): one batched instance ⨝ states
 * read per page, plus one history aggregate for entered_at. Never part of `*`.
 * The record's OWN instance (open first, else newest) — addendum overlays are
 * the browser's job, not the projection's. Filter twin: `filter={"$state":
 * {"_in": ["started"]}}`, the same EXISTS the conditions path already compiles.
 */
import type { Knex } from 'knex'
import { db, dbRead } from '../db/index.js'
import { selectInChunks } from './db-batch.js'

export const STATE_FIELD = '$state'

export interface RecordState {
  key: string
  label: string
  external_label: string | null
  color: string | null
  is_terminal: boolean
  entered_at: string | null
  instance_id: string
}

export function splitStateField(fields: string[]): { fields: string[]; wantsState: boolean } {
  const wantsState = fields.includes(STATE_FIELD)
  return { fields: wantsState ? fields.filter((f) => f !== STATE_FIELD) : fields, wantsState }
}

interface InstanceRow {
  id: string
  item: string
  completed_at: Date | null
  started_at: Date | null
}

// Timestamps arrive as Date from tedious, but a driver handing back a string
// must not throw inside a projection — read both, treat anything else as absent.
function ms(value: Date | string | null | undefined): number {
  if (value == null) return 0
  const t = new Date(value).getTime()
  return Number.isNaN(t) ? 0 : t
}

function iso(value: Date | string | null | undefined): string | null {
  if (value == null) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** Open instance wins; otherwise the newest by started_at. */
export function pickInstance<T extends InstanceRow>(rows: T[]): T | undefined {
  return [...rows].sort((a, b) => {
    const ao = a.completed_at == null ? 0 : 1
    const bo = b.completed_at == null ? 0 : 1
    if (ao !== bo) return ao - bo
    return ms(b.started_at) - ms(a.started_at)
  })[0]
}

export function stateKeysFromOps(ops: Record<string, unknown>): {
  include: string[]
  exclude: string[]
} {
  const str = (v: unknown) =>
    (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === 'string' && x.length > 0)
  return {
    include: [...str(ops._eq), ...str(ops._in)],
    exclude: [...str(ops._neq), ...str(ops._nin)]
  }
}

type StateInstanceRow = InstanceRow & {
  key: string
  label: string
  external_label: string | null
  color: string | null
  is_terminal: unknown
}

/** Sets `row.$state` to the record's state, or null when it runs no pipeline. */
export async function attachRecordState(
  collection: string,
  rows: Record<string, unknown>[]
): Promise<void> {
  if (rows.length === 0) return
  const ids = rows.map((r) => String(r.id))
  const instances = (await selectInChunks(ids, 1500, (chunk) =>
    dbRead('nivaro_workflow_instances as i')
      .join('nivaro_workflow_states as s', 's.id', 'i.current_state')
      .where('i.collection', collection)
      .whereIn('i.item', chunk)
      .select(
        'i.id',
        'i.item',
        'i.completed_at',
        'i.started_at',
        's.key',
        's.label',
        's.external_label',
        's.color',
        's.is_terminal'
      )
  )) as StateInstanceRow[]

  const byItem = new Map<string, StateInstanceRow[]>()
  for (const i of instances) {
    const list = byItem.get(i.item)
    if (list) list.push(i)
    else byItem.set(i.item, [i])
  }

  const chosen = new Map<string, StateInstanceRow>()
  for (const [item, list] of byItem) {
    const pick = pickInstance(list)
    if (pick) chosen.set(item, pick)
  }

  // entered_at: the newest history row INTO the state the instance sits in.
  // A record that started in its state has none — started_at is the fallback.
  const entered = new Map<string, Date | string>()
  const chosenIds = [...chosen.values()].map((c) => c.id)
  if (chosenIds.length) {
    const hist = (await selectInChunks(chosenIds, 1500, (chunk) =>
      dbRead('nivaro_workflow_history as h')
        .join('nivaro_workflow_instances as i', 'i.id', 'h.instance')
        .whereIn('h.instance', chunk)
        .whereRaw('h.to_state = i.current_state')
        .groupBy('h.instance')
        .select('h.instance', db.raw('MAX(h.timestamp) as at'))
    )) as Array<{ instance: string; at: Date | string }>
    for (const h of hist) entered.set(h.instance, h.at)
  }

  for (const row of rows) {
    const c = chosen.get(String(row.id))
    row[STATE_FIELD] = c
      ? ({
          key: c.key,
          label: c.label,
          external_label: c.external_label ?? null,
          color: c.color ?? null,
          is_terminal: c.is_terminal === true || c.is_terminal === 1,
          entered_at: iso(entered.get(c.id) ?? c.started_at),
          instance_id: c.id
        } satisfies RecordState)
      : null
  }
}

/** filter={"$state": {...}} — EXISTS on the instance in the given key set. */
export function applyStateFilter(
  q: Knex.QueryBuilder,
  collection: string,
  ops: Record<string, unknown>
): void {
  const { include, exclude } = stateKeysFromOps(ops)
  const exists = (keys: string[]) =>
    function (this: Knex.QueryBuilder) {
      this.select(db.raw('1'))
        .from('nivaro_workflow_instances as wfi')
        .join('nivaro_workflow_states as wfs', 'wfi.current_state', 'wfs.id')
        .where('wfi.collection', collection)
        .whereRaw('wfi.item = CAST(??.?? AS NVARCHAR(255))', [collection, 'id'])
        .whereIn('wfs.key', keys)
    }
  if (include.length) q.whereExists(exists(include))
  if (exclude.length) q.whereNotExists(exists(exclude))
}
