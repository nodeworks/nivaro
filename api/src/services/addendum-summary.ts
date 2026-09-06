import { db } from '../db/index.js'
import { selectInChunks } from './db-batch.js'

/**
 * Per-record addendum summary for list surfaces (collection browser, queues):
 * how many addendums are still in flight, and the newest one. "Active" is any
 * status that is not a final decision (draft / submitted / review) — the
 * record is being amended and reviewers should see it at a glance.
 */
export interface AddendumSummary {
  active: number
  total: number
  latest: {
    id: string
    title: string | null
    status: string
    cost_impact: number | null
    created_at: string | null
  } | null
}

export const FINAL_ADDENDUM_STATUSES = new Set(['approved', 'rejected'])

/**
 * The newest ACTIVE addendum's workflow instance per parent record. While an
 * addendum is being approved, ITS state and owners are what a list should
 * show for the record — the record's own instance sits at Completed with no
 * owners, which is exactly the wrong signal for reviewers scanning a queue.
 */
export interface ActiveAddendumInstance {
  addendum_id: string
  title: string | null
  instance_id: string
  template: string
  state_id: string
  state_key: string | null
  state_label: string | null
  state_color: string | null
}

export async function activeAddendumInstances(
  collection: string,
  ids: string[],
  database: typeof db = db
): Promise<Map<string, ActiveAddendumInstance>> {
  const out = new Map<string, ActiveAddendumInstance>()
  const wanted = [...new Set(ids.map(String))]
  if (wanted.length === 0) return out
  const rows = (await selectInChunks(wanted, 2000, (chunk) =>
    database('nivaro_addendums as a')
      .join('nivaro_workflow_instances as wi', function () {
        this.on('wi.collection', database.raw('?', ['nivaro_addendums'])).andOn(
          'wi.item',
          database.raw('CAST(a.id AS NVARCHAR(36))')
        )
      })
      .leftJoin('nivaro_workflow_states as s', 'wi.current_state', 's.id')
      .where('a.parent_collection', collection)
      .whereIn('a.parent_id', chunk)
      .whereNotIn('a.status', [...FINAL_ADDENDUM_STATUSES])
      .whereNull('wi.completed_at')
      .whereNotNull('wi.current_state')
      .select(
        'a.id as addendum_id',
        'a.parent_id',
        'a.title',
        'a.created_at',
        'wi.id as instance_id',
        'wi.template',
        'wi.current_state as state_id',
        's.key as state_key',
        's.label as state_label',
        's.color as state_color'
      )
      .orderBy('a.created_at', 'desc')
  )) as Array<Record<string, unknown>>
  for (const r of rows) {
    const key = String(r.parent_id)
    if (out.has(key)) continue // newest wins
    out.set(key, {
      addendum_id: String(r.addendum_id),
      title: (r.title as string | null) ?? null,
      instance_id: String(r.instance_id),
      template: String(r.template),
      state_id: String(r.state_id),
      state_key: (r.state_key as string | null) ?? null,
      state_label: (r.state_label as string | null) ?? null,
      state_color: (r.state_color as string | null) ?? null
    })
  }
  return out
}

export async function addendumSummaryBatch(
  collection: string,
  ids: string[],
  database: typeof db = db
): Promise<Map<string, AddendumSummary>> {
  const out = new Map<string, AddendumSummary>()
  const wanted = [...new Set(ids.map(String))]
  if (wanted.length === 0) return out
  const rows = (await selectInChunks(wanted, 2000, (chunk) =>
    database('nivaro_addendums')
      .where({ parent_collection: collection })
      .whereIn('parent_id', chunk)
      .select('id', 'parent_id', 'title', 'status', 'cost_impact', 'created_at')
      .orderBy('created_at', 'desc')
  )) as Array<{
    id: string
    parent_id: string
    title: string | null
    status: string
    cost_impact: number | string | null
    created_at: Date | string | null
  }>
  for (const r of rows) {
    const key = String(r.parent_id)
    const cur = out.get(key) ?? { active: 0, total: 0, latest: null }
    cur.total += 1
    if (!FINAL_ADDENDUM_STATUSES.has(String(r.status))) cur.active += 1
    if (!cur.latest) {
      cur.latest = {
        id: String(r.id),
        title: r.title,
        status: String(r.status),
        cost_impact: r.cost_impact == null ? null : Number(r.cost_impact),
        created_at: r.created_at ? new Date(r.created_at).toISOString() : null
      }
    }
    out.set(key, cur)
  }
  return out
}
