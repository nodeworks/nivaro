import { db } from '../db/index.js'
import { selectInChunks } from './db-batch.js'
import { type OwnerResolutionRequest, resolveStateOwnersBatch } from './pipeline-engine.js'

/**
 * #71 — owner load: open records per owner per state, with how many of them
 * are past or near their SLA. Computed live over every open instance (same
 * cost profile as coverage gaps — seconds, never persisted): owners come from
 * the same batched resolver the queues use, SLA from the same batch
 * evaluator the queue tables show, so the report never disagrees with a
 * person's own worklist.
 */
export interface OwnerLoadRow {
  user: string
  name: string
  email: string | null
  status: string | null
  is_out_of_office: boolean
  total: number
  sla_breached: number
  sla_warning: number
  by_state: Array<{ key: string; label: string; count: number }>
  by_collection: Array<{ collection: string; count: number }>
}

export interface OwnerLoadReport {
  open_instances: number
  evaluated: number
  truncated: boolean
  unowned: number
  rows: OwnerLoadRow[]
  states: Array<{ key: string; label: string }>
}

const EVAL_CAP = 4000

export async function buildOwnerLoadReport(opts: {
  collection?: string | null
}): Promise<OwnerLoadReport> {
  let q = db('nivaro_workflow_instances as wi')
    .join('nivaro_workflow_states as s', 'wi.current_state', 's.id')
    .where('s.is_terminal', 0)
    .whereNull('wi.completed_at')
  if (opts.collection) q = q.where('wi.collection', opts.collection)
  const instances = (await q
    .orderBy('wi.started_at', 'desc')
    .limit(EVAL_CAP + 1)
    .select(
      'wi.id as instance_id',
      'wi.collection',
      'wi.item',
      'wi.current_state',
      's.key as state_key',
      's.label as state_label'
    )) as Array<{
    instance_id: string
    collection: string
    item: string
    current_state: string
    state_key: string
    state_label: string
  }>
  const truncated = instances.length > EVAL_CAP
  const sample = instances.slice(0, EVAL_CAP)

  const requests: OwnerResolutionRequest[] = sample.map((i) => ({
    key: i.instance_id,
    stateId: i.current_state,
    instanceId: i.instance_id,
    collection: i.collection,
    itemId: String(i.item)
  }))
  const ownersByKey = await resolveStateOwnersBatch(requests)

  // SLA per collection (the batch evaluator is collection-scoped).
  const { computeStatusBatch } = await import('../routes/sla.js')
  const slaByKey = new Map<string, 'ok' | 'warning' | 'breached' | null>()
  const byCollection = new Map<string, string[]>()
  for (const i of sample)
    byCollection.set(i.collection, [...(byCollection.get(i.collection) ?? []), String(i.item)])
  for (const [collection, ids] of byCollection) {
    try {
      const res = await computeStatusBatch(collection, ids)
      for (const [item, entry] of Object.entries(res)) {
        slaByKey.set(
          `${collection}:${item}`,
          (entry as { status?: 'ok' | 'warning' | 'breached' | null }).status ?? null
        )
      }
    } catch {
      /* SLA is decoration here — the load numbers stand without it */
    }
  }

  const rows = new Map<string, OwnerLoadRow>()
  const states = new Map<string, string>()
  let unowned = 0
  for (const i of sample) {
    states.set(i.state_key, i.state_label)
    const owners = ownersByKey.get(i.instance_id) ?? []
    if (owners.length === 0) {
      unowned += 1
      continue
    }
    const sla = slaByKey.get(`${i.collection}:${i.item}`) ?? null
    for (const o of owners) {
      const id = String(o.id).toUpperCase()
      let row = rows.get(id)
      if (!row) {
        row = {
          user: id,
          name: '',
          email: null,
          status: null,
          is_out_of_office: false,
          total: 0,
          sla_breached: 0,
          sla_warning: 0,
          by_state: [],
          by_collection: []
        }
        rows.set(id, row)
      }
      row.total += 1
      if (sla === 'breached') row.sla_breached += 1
      else if (sla === 'warning') row.sla_warning += 1
      const st = row.by_state.find((s) => s.key === i.state_key)
      if (st) st.count += 1
      else row.by_state.push({ key: i.state_key, label: i.state_label, count: 1 })
      const c = row.by_collection.find((s) => s.collection === i.collection)
      if (c) c.count += 1
      else row.by_collection.push({ collection: i.collection, count: 1 })
    }
  }

  if (rows.size > 0) {
    const users = (await selectInChunks([...rows.keys()], 2000, (chunk) =>
      db('nivaro_users')
        .whereIn('id', chunk)
        .select('id', 'first_name', 'last_name', 'email', 'status', 'is_out_of_office')
    ).catch(() => [])) as Array<Record<string, unknown>>
    for (const u of users) {
      const row = rows.get(String(u.id).toUpperCase())
      if (!row) continue
      row.name = `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || String(u.email ?? '')
      row.email = (u.email as string) ?? null
      row.status = (u.status as string) ?? null
      row.is_out_of_office = u.is_out_of_office === true || u.is_out_of_office === 1
    }
  }
  return {
    open_instances: instances.length,
    evaluated: sample.length,
    truncated,
    unowned,
    rows: [...rows.values()]
      .map((r) => ({
        ...r,
        by_state: r.by_state.sort((a, b) => b.count - a.count),
        by_collection: r.by_collection.sort((a, b) => b.count - a.count)
      }))
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)),
    states: [...states.entries()].map(([key, label]) => ({ key, label }))
  }
}
