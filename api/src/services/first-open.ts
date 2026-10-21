import { db } from '../db/index.js'
import { rawRows } from '../db/raw-rows.js'
import { selectInChunks } from './db-batch.js'
import { type OwnerResolutionRequest, resolveStateOwnersBatch } from './pipeline-engine.js'

/**
 * #1078 — time until an owner first opens a record. SLA measures time IN a
 * state; this measures how long a record waits after entering a state before
 * any of its owners looks at it. Workflow history gives the state entries,
 * the owner resolver names who should be looking (as the pipeline resolves
 * them today for that state), nivaro_record_views says when they did.
 *
 * nivaro_record_views keeps only two watermarks per person and record
 * (last_viewed_at, prev_viewed_at), not a view log. The "first open" is the
 * earliest of those two inside the stay in the state, so it can overstate a
 * wait when the person opened the record several times; it never understates.
 * An entry nobody opened before the record left the state counts as
 * "never opened" and stays out of the median.
 */

const ENTRY_CAP = 4000
const MAX_RANGE_DAYS = 365

export interface FirstOpenEntry {
  id: string
  item: string
  stateKey: string
  stateLabel: string
  at: number
  /** When the record left this state (null = still there). */
  leftAt: number | null
  /** Who moved the record in; their own view is not a wait. */
  actor: string | null
}

export interface ViewMarks {
  last: number | null
  prev: number | null
}

export interface FirstOpenGroup {
  key: string
  label: string
  entries: number
  opened: number
  never_opened: number
  still_waiting: number
  opened_rate: number | null
  median_minutes: number | null
  p90_minutes: number | null
}

const median = (xs: number[]) => {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}
const p90 = (xs: number[]) => {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.9) - 1)]
}

/** Earliest recorded view of one person inside [from, to), or null. */
export function firstViewIn(marks: ViewMarks | undefined, from: number, to: number): number | null {
  if (!marks) return null
  const hits = [marks.last, marks.prev].filter((t): t is number => t != null && t >= from && t < to)
  return hits.length ? Math.min(...hits) : null
}

type Acc = { label: string; entries: number; waits: number[]; never: number; waiting: number }

function finish(m: Map<string, Acc>): FirstOpenGroup[] {
  return [...m.entries()]
    .map(([key, a]) => {
      const rounded = a.waits.map((w) => Math.round(w * 10) / 10)
      return {
        key,
        label: a.label,
        entries: a.entries,
        opened: a.waits.length,
        never_opened: a.never,
        still_waiting: a.waiting,
        opened_rate: a.entries ? a.waits.length / a.entries : null,
        median_minutes: median(rounded),
        p90_minutes: p90(rounded)
      }
    })
    .sort((x, y) => y.entries - x.entries)
}

export interface FirstOpenResult {
  by_state: FirstOpenGroup[]
  by_owner: FirstOpenGroup[]
  overall: Omit<FirstOpenGroup, 'key' | 'label'>
  entries_evaluated: number
  no_owner: number
}

/**
 * Pure core. `owners` maps an entry id to the people who should open it;
 * `views` maps `${item}|${USER}` to their watermarks. The state rollup counts
 * an entry as opened when ANY owner opened it (wait = the earliest); the owner
 * rollup scores each owner on their own first open.
 */
export function computeFirstOpen(
  entries: FirstOpenEntry[],
  owners: Map<string, string[]>,
  views: Map<string, ViewMarks>,
  names: Map<string, string>,
  now: number
): FirstOpenResult {
  const byState = new Map<string, Acc>()
  const byOwner = new Map<string, Acc>()
  const all: Acc = { label: '', entries: 0, waits: [], never: 0, waiting: 0 }
  let noOwner = 0
  const bump = (
    m: Map<string, Acc>,
    key: string,
    label: string,
    wait: number | null,
    e: FirstOpenEntry
  ) => {
    const a = m.get(key) ?? { label, entries: 0, waits: [], never: 0, waiting: 0 }
    a.entries++
    if (wait != null) a.waits.push(wait)
    else if (e.leftAt == null) a.waiting++
    else a.never++
    m.set(key, a)
  }
  for (const e of entries) {
    const end = e.leftAt ?? now + 1
    const who = (owners.get(e.id) ?? []).filter(
      (u) => !e.actor || u.toUpperCase() !== e.actor.toUpperCase()
    )
    if (who.length === 0) {
      noOwner++
      continue
    }
    let best: number | null = null
    for (const u of who) {
      const t = firstViewIn(views.get(`${e.item}|${u.toUpperCase()}`), e.at, end)
      const wait = t == null ? null : (t - e.at) / 60_000
      if (wait != null && (best == null || wait < best)) best = wait
      bump(byOwner, u.toUpperCase(), names.get(u.toUpperCase()) ?? u, wait, e)
    }
    bump(byState, e.stateKey, e.stateLabel, best, e)
    all.entries++
    if (best != null) all.waits.push(best)
    else if (e.leftAt == null) all.waiting++
    else all.never++
  }
  const [overall] = finish(new Map([['all', all]]))
  const { key: _k, label: _l, ...rest } = overall
  return {
    by_state: finish(byState),
    by_owner: finish(byOwner),
    overall: rest,
    entries_evaluated: entries.length,
    no_owner: noOwner
  }
}

export function parseFirstOpenParams(
  q: Record<string, unknown>
): { ok: true; collection: string; from: Date; to: Date } | { ok: false; error: string } {
  const collection = typeof q.collection === 'string' ? q.collection.trim() : ''
  if (!collection) return { ok: false, error: 'collection is required' }
  const toStr = q.to ? String(q.to) : undefined
  const to = toStr ? new Date(toStr) : new Date()
  const from = q.from ? new Date(String(q.from)) : new Date(to.getTime() - 90 * 86_400_000)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()))
    return { ok: false, error: 'from/to must be ISO dates' }
  if (from > to) return { ok: false, error: 'from must be before to' }
  if ((to.getTime() - from.getTime()) / 86_400_000 > MAX_RANGE_DAYS)
    return { ok: false, error: `date range capped at ${MAX_RANGE_DAYS} days` }
  // a date-only `to` names a whole day (same rule as Team Throughput)
  const dateOnly = toStr && /^\d{4}-\d{2}-\d{2}$/.test(toStr)
  return { ok: true, collection, from, to: dateOnly ? new Date(to.getTime() + 86_400_000) : to }
}

export async function buildFirstOpenReport(opts: {
  collection: string
  from: Date
  to: Date
}): Promise<FirstOpenResult & { truncated: boolean }> {
  const raw = await db.raw(
    `SELECT TOP (${ENTRY_CAP + 1}) * FROM (
       SELECT h.id AS id, h.instance AS instance, i.item AS item, h.to_state AS to_state,
              st.[key] AS state_key, st.label AS state_label,
              h.[timestamp] AS ts, h.[user] AS actor,
              LEAD(h.[timestamp]) OVER (PARTITION BY h.instance ORDER BY h.[timestamp], h.id) AS left_ts
       FROM nivaro_workflow_history h
       JOIN nivaro_workflow_instances i ON i.id = h.instance AND i.collection = ?
       JOIN nivaro_workflow_states st ON st.id = h.to_state AND st.is_terminal = 0
     ) x
     WHERE x.ts >= ? AND x.ts < ?
     ORDER BY x.ts DESC`,
    [opts.collection, opts.from, opts.to] as any
  )
  const rows = rawRows<{
    id: unknown
    instance: unknown
    item: unknown
    to_state: unknown
    state_key: string
    state_label: string
    ts: Date | string
    actor: unknown
    left_ts: Date | string | null
  }>(raw)
  const truncated = rows.length > ENTRY_CAP
  const sample = rows.slice(0, ENTRY_CAP)
  const entries: FirstOpenEntry[] = sample.map((r) => ({
    id: String(r.id),
    item: String(r.item),
    stateKey: r.state_key,
    stateLabel: r.state_label,
    at: new Date(r.ts).getTime(),
    leftAt: r.left_ts ? new Date(r.left_ts).getTime() : null,
    actor: r.actor == null ? null : String(r.actor)
  }))

  const requests: OwnerResolutionRequest[] = sample.map((r) => ({
    key: String(r.id),
    stateId: String(r.to_state),
    instanceId: String(r.instance),
    collection: opts.collection,
    itemId: String(r.item)
  }))
  const resolved = await resolveStateOwnersBatch(requests)
  const owners = new Map<string, string[]>()
  const people = new Map<string, string>()
  for (const [key, list] of resolved) {
    owners.set(
      key,
      list.map((o) => String(o.id))
    )
    for (const o of list)
      people.set(
        String(o.id).toUpperCase(),
        [o.first_name, o.last_name].filter(Boolean).join(' ') || o.email
      )
  }

  const itemIds = [...new Set(entries.map((e) => e.item))]
  const viewRows = await selectInChunks(itemIds, 1500, (chunk) =>
    db('nivaro_record_views')
      .where({ collection: opts.collection })
      .whereIn('item_id', chunk)
      .select('item_id', 'user', 'last_viewed_at', 'prev_viewed_at')
  )
  const views = new Map<string, ViewMarks>()
  const ms = (v: unknown) => (v ? new Date(v as string).getTime() : null)
  for (const v of viewRows as Array<{
    item_id: string
    user: string
    last_viewed_at: unknown
    prev_viewed_at: unknown
  }>)
    views.set(`${v.item_id}|${String(v.user).toUpperCase()}`, {
      last: ms(v.last_viewed_at),
      prev: ms(v.prev_viewed_at)
    })

  const out = computeFirstOpen(entries, owners, views, people, Date.now())
  return { ...out, truncated }
}
