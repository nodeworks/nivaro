import { db } from '../db/index.js'
import { castText } from '../db/sql-dialect.js'
import { selectInChunks, whereInList } from './db-batch.js'

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
    /** Where its pipeline stands — what views name instead of the storage
     *  status ('draft' for every addendum still in its approvals). */
    workflow_state?: { key: string; label: string } | null
  } | null
}

export const FINAL_ADDENDUM_STATUSES = new Set(['approved', 'rejected'])

/**
 * Is an addendum of this record going through approval? Addendums run their
 * own pipeline (instances on `nivaro_addendums`, item = the addendum id), so
 * "in progress" is read from THAT pipeline, never the addendum's status
 * column: an addendum whose instance sits in a step that is not terminal.
 * An addendum that never entered a pipeline (no instance) is not in
 * progress — unless it was submitted for approval anyway (status 'review':
 * /submit and /approve work without an instance, and a failed instance
 * start is swallowed), which counts as in progress. One whose instance has
 * no step, or a step that is gone, is not known to be finished and counts as
 * in progress (fail closed). One read.
 * Used only by the `$addendum_active` condition field (open_when and
 * condition_rules) — the list summaries above keep their own meaning.
 */
export async function addendumInProgress(
  collection: string,
  itemId: string,
  database: typeof db = db
): Promise<boolean> {
  const rows = (await database('nivaro_addendums as a')
    // LEFT joins: an addendum with no instance is judged by its status; an
    // instance whose step is missing or gone is not known to be finished —
    // it counts as in progress (fail closed for open_when).
    .leftJoin('nivaro_workflow_instances as wi', function () {
      this.on('wi.collection', database.raw('?', ['nivaro_addendums'])).andOn(
        'wi.item',
        database.raw(castText(database, 'a.id', 36))
      )
    })
    .leftJoin('nivaro_workflow_states as s', 's.id', 'wi.current_state')
    .where('a.parent_collection', collection)
    .where('a.parent_id', String(itemId))
    .select('a.status', 'wi.id as instance_id', 's.id as state_id', 's.is_terminal')) as StepRow[]
  return addendumStepsInProgress(rows.map(stepRow))
}

type StepRow = { status: unknown; instance_id: unknown; state_id: unknown; is_terminal: unknown }

const stepRow = (r: StepRow) => ({
  is_terminal: r.is_terminal,
  missing_step: r.state_id == null,
  no_instance: r.instance_id == null,
  status: r.status
})

/** addendumInProgress for a page of records: the ids (as given) that have an
 *  addendum going through approval. One read per 2000 ids. */
export async function addendumsInProgressFor(
  collection: string,
  ids: string[],
  database: typeof db = db
): Promise<Set<string>> {
  const out = new Set<string>()
  const wanted = [...new Set(ids.map(String))]
  if (wanted.length === 0) return out
  const rows = (await selectInChunks(wanted, 2000, (chunk) =>
    whereInList(
      database('nivaro_addendums as a')
        .leftJoin('nivaro_workflow_instances as wi', function () {
          this.on('wi.collection', database.raw('?', ['nivaro_addendums'])).andOn(
            'wi.item',
            database.raw(castText(database, 'a.id', 36))
          )
        })
        .leftJoin('nivaro_workflow_states as s', 's.id', 'wi.current_state')
        .where('a.parent_collection', collection),
      'a.parent_id',
      chunk
    ).select('a.parent_id', 'a.status', 'wi.id as instance_id', 's.id as state_id', 's.is_terminal')
  )) as Array<StepRow & { parent_id: unknown }>
  const byParent = new Map<string, Array<ReturnType<typeof stepRow>>>()
  for (const r of rows) {
    const k = String(r.parent_id).toLowerCase()
    const list = byParent.get(k) ?? []
    list.push(stepRow(r))
    byParent.set(k, list)
  }
  for (const id of wanted)
    if (addendumStepsInProgress(byParent.get(id.toLowerCase()) ?? [])) out.add(id)
  return out
}

/** Pure: an addendum is going through approval when its instance's step is
 *  not terminal (null = not terminal) or is missing / gone (unknown = in
 *  progress); with no instance at all, only when it was submitted for
 *  approval (status 'review') — one that never went into approval doesn't
 *  count. */
export function addendumStepsInProgress(
  steps: Array<{
    is_terminal: unknown
    missing_step?: boolean
    no_instance?: boolean
    status?: unknown
  }>
): boolean {
  const terminal = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true'
  return steps.some((s) =>
    s.no_instance === true
      ? String(s.status ?? '').toLowerCase() === 'review'
      : s.missing_step === true || !terminal(s.is_terminal)
  )
}

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
  const wanted = [...new Set(ids.map(String))]
  if (wanted.length === 0) return new Map()
  return activeAddendumInstancesQuery(collection, wanted, database)
}

/** Every in-flight addendum instance in the collection (queue membership needs
 *  the ones whose PARENT is not yet in the candidate set). Active addendums are
 *  a small set by nature — this is one query, not a per-record probe. */
export async function activeAddendumInstancesForCollection(
  collection: string,
  database: typeof db = db
): Promise<Map<string, ActiveAddendumInstance>> {
  return activeAddendumInstancesQuery(collection, null, database)
}

async function activeAddendumInstancesQuery(
  collection: string,
  wanted: string[] | null,
  database: typeof db
): Promise<Map<string, ActiveAddendumInstance>> {
  const out = new Map<string, ActiveAddendumInstance>()
  const chunks = wanted ?? [null]
  const rows = (await selectInChunks(chunks as string[], 2000, (chunk) =>
    database('nivaro_addendums as a')
      .join('nivaro_workflow_instances as wi', function () {
        this.on('wi.collection', database.raw('?', ['nivaro_addendums'])).andOn(
          'wi.item',
          database.raw(castText(database, 'a.id', 36))
        )
      })
      .leftJoin('nivaro_workflow_states as s', 'wi.current_state', 's.id')
      .where('a.parent_collection', collection)
      .modify((qb) => {
        if (chunk[0] !== null) whereInList(qb, 'a.parent_id', chunk)
      })
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
      .modify((qb) => whereInList(qb, 'parent_id', chunk))
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
  // The latest addendum's pipeline state, one read for the whole page.
  const latestIds = [...out.values()].flatMap((s) => (s.latest ? [s.latest.id] : []))
  if (latestIds.length > 0) {
    try {
      const insts = (await selectInChunks(latestIds, 2000, (chunk) =>
        database('nivaro_workflow_instances as i')
          .join('nivaro_workflow_states as s', 's.id', 'i.current_state')
          .where('i.collection', 'nivaro_addendums')
          .modify((qb) => whereInList(qb, 'i.item', chunk))
          .select('i.item', 's.key', 's.label')
      )) as Array<{ item: string; key: string; label: string }>
      const byItem = new Map(insts.map((x) => [String(x.item).toUpperCase(), x]))
      for (const s of out.values()) {
        if (!s.latest) continue
        const x = byItem.get(s.latest.id.toUpperCase())
        s.latest.workflow_state = x ? { key: x.key, label: x.label } : null
      }
    } catch {
      /* the storage status still reads */
    }
  }
  return out
}
