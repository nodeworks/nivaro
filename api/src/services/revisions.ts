import { db } from '../db/index.js'

export interface Revision {
  id: number | null
  activity: number | null
  collection: string
  item: string
  data: Record<string, unknown>
  delta: Record<string, unknown> | null
  parent: number | null
  // Joined from nivaro_activity + nivaro_users
  timestamp?: Date
  action?: string
  user_id?: string | null
  first_name?: string | null
  last_name?: string | null
  user_email?: string | null
  comment?: string | null
  /** A pipeline event folded into the history (no snapshot): a transition
   *  from nivaro_workflow_history, or the instance start. */
  event?: {
    kind: 'transition' | 'start'
    history_id?: number
    from_label: string | null
    to_label: string | null
    transition_label: string | null
    source: string | null
  } | null
}

function parseJson(value: unknown): Record<string, unknown> | null {
  if (!value) return null
  try {
    return typeof value === 'string' ? JSON.parse(value) : (value as Record<string, unknown>)
  } catch {
    return null
  }
}

export function computeDelta(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): Record<string, unknown> {
  const delta: Record<string, unknown> = {}
  for (const key of Object.keys(after)) {
    // `after` is the re-read row, which carries VIRTUAL computed fields the
    // raw `before` select never had (a read-computed figure lands as 0, a
    // rollup as null) — a key absent before is never a change. A key
    // genuinely new to the row (a column added mid-flight) is vanishingly
    // rare and would surface on the next real write anyway.
    if (!(key in before)) continue
    if (JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null)) {
      delta[key] = after[key]
    }
  }
  return delta
}

export async function writeRevision(opts: {
  activity: number | null
  collection: string
  item: string
  data: Record<string, unknown>
  delta: Record<string, unknown> | null
}): Promise<void> {
  try {
    await db('nivaro_revisions').insert({
      activity: opts.activity,
      collection: opts.collection,
      item: opts.item,
      data: JSON.stringify(opts.data),
      delta: opts.delta ? JSON.stringify(opts.delta) : null
    })
  } catch (err) {
    console.error({ err }, 'Failed to write revision')
  }
}

function hydrateRevision(row: Record<string, unknown>): Revision {
  return {
    ...(row as unknown as Revision),
    data: parseJson(row.data) ?? {},
    delta: parseJson(row.delta),
    comment: (row.comment as string | null) ?? null
  }
}

export async function listRevisions(collection: string, item: string): Promise<Revision[]> {
  const [revRows, activityRows, transitionRows] = await Promise.all([
    db('nivaro_revisions as r')
      .leftJoin('nivaro_activity as a', 'r.activity', 'a.id')
      .leftJoin('nivaro_users as u', 'a.user', 'u.id')
      .select(
        'r.id',
        'r.activity',
        'r.collection',
        'r.item',
        'r.data',
        'r.delta',
        'r.parent',
        'a.timestamp',
        'a.action',
        'a.comment',
        'a.user as user_id',
        'u.first_name',
        'u.last_name',
        'u.email as user_email'
      )
      .where('r.collection', collection)
      .where('r.item', item)
      .orderBy('r.id', 'desc')
      .limit(100) as Promise<Record<string, unknown>[]>,

    // Activity-only entries (o2m-* events have no revision row)
    db('nivaro_activity as a')
      .leftJoin('nivaro_users as u', 'a.user', 'u.id')
      .leftJoin('nivaro_revisions as r', 'r.activity', 'a.id')
      .select(
        db.raw('NULL as id'),
        'a.id as activity',
        'a.collection',
        'a.item',
        db.raw('NULL as data'),
        db.raw('NULL as delta'),
        db.raw('NULL as parent'),
        'a.timestamp',
        'a.action',
        'a.comment',
        'a.user as user_id',
        'u.first_name',
        'u.last_name',
        'u.email as user_email'
      )
      .where('a.collection', collection)
      .where('a.item', item)
      .whereIn('a.action', ['o2m-create', 'o2m-update', 'o2m-delete', 'pipeline-start'])
      .whereNull('r.id')
      .limit(100) as Promise<Record<string, unknown>[]>,

    // Pipeline transitions: a state move writes nivaro_workflow_history, not
    // a revision, so the history read them out of order until now — one row
    // per transition of every instance this record has had (an addendum's
    // instance lives on its own record and is not folded in here).
    db('nivaro_workflow_history as h')
      .join('nivaro_workflow_instances as i', 'i.id', 'h.instance')
      .leftJoin('nivaro_workflow_states as fs', 'fs.id', 'h.from_state')
      .leftJoin('nivaro_workflow_states as ts', 'ts.id', 'h.to_state')
      .leftJoin('nivaro_workflow_transitions as t', 't.id', 'h.transition')
      .leftJoin('nivaro_users as u', 'h.user', 'u.id')
      .select(
        'h.id as history_id',
        'h.timestamp',
        'h.comment',
        'h.user as user_id',
        'fs.label as from_label',
        'ts.label as to_label',
        't.label as transition_label',
        'u.first_name',
        'u.last_name',
        'u.email as user_email'
      )
      .where('i.collection', collection)
      .where('i.item', item)
      .orderBy('h.id', 'desc')
      .limit(100)
      .catch(() => []) as Promise<Record<string, unknown>[]>
  ])

  const all = [
    ...(revRows as Record<string, unknown>[]),
    ...(activityRows as Record<string, unknown>[]).map((r) =>
      r.action === 'pipeline-start'
        ? {
            ...r,
            event: {
              kind: 'start',
              from_label: null,
              to_label: null,
              transition_label: null,
              source: null
            }
          }
        : r
    ),
    ...(transitionRows as Record<string, unknown>[]).map((r) => ({
      id: null,
      activity: null,
      collection,
      item,
      data: null,
      delta: null,
      parent: null,
      timestamp: r.timestamp,
      action: 'transition',
      // 'auto: <label>' is the engine's stamp on an automatic move — the
      // event carries that fact, so the comment shows only what a person said.
      comment: /^auto:\s/i.test(String(r.comment ?? ''))
        ? null
        : ((r.comment as string | null) ?? null),
      user_id: (r.user_id as string | null) ?? null,
      first_name: r.first_name,
      last_name: r.last_name,
      user_email: r.user_email,
      event: {
        kind: 'transition',
        history_id: Number(r.history_id),
        from_label: (r.from_label as string | null) ?? null,
        to_label: (r.to_label as string | null) ?? null,
        transition_label: (r.transition_label as string | null) ?? null,
        source: r.user_id ? 'manual' : 'auto'
      }
    }))
  ]
  all.sort((a, b) => {
    const ta = a.timestamp ? new Date(a.timestamp as string).getTime() : 0
    const tb = b.timestamp ? new Date(b.timestamp as string).getTime() : 0
    return tb - ta
  })
  return all.map(hydrateRevision)
}

export async function getRevision(id: number): Promise<Revision | null> {
  const row = (await db('nivaro_revisions as r')
    .leftJoin('nivaro_activity as a', 'r.activity', 'a.id')
    .leftJoin('nivaro_users as u', 'a.user', 'u.id')
    .select(
      'r.id',
      'r.activity',
      'r.collection',
      'r.item',
      'r.data',
      'r.delta',
      'r.parent',
      'a.timestamp',
      'a.action',
      'a.user as user_id',
      'u.first_name',
      'u.last_name',
      'u.email as user_email'
    )
    .where('r.id', id)
    .first()) as Record<string, unknown> | undefined

  return row ? hydrateRevision(row) : null
}
