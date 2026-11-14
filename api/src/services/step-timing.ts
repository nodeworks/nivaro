import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import { firstViewIn, type ViewMarks } from './first-open.js'
import { resolveStateOwnersBatch } from './pipeline-engine.js'

/**
 * Waiting vs working per step visit (Rob 2026-11-13, #18).
 *
 * Every entry into a state (one workflow-history row) is a VISIT; a send-back
 * that brings the record to a step again is a second visit, timed on its own.
 * A visit's time splits at the FIRST OWNER TOUCH:
 *   - WAITING = entry → first touch (nobody who owns the step did anything),
 *   - WORKING = first touch → the visit's end (it left the step, or now).
 * A touch is anything an owner did to the record during the visit: an edit
 * or any other logged action on it (nivaro_activity), a comment, a task made
 * or finished on it, an open of the record (nivaro_record_views keeps only
 * each person's last two opens, so an open counts only when one of those
 * falls inside the visit — it can overstate a wait, never understate it),
 * and finally the move that took the record out of the step. No touch before
 * the move out = the whole visit was waiting ("decided at once").
 *
 * The step's owners are who the pipeline resolves for that step on this
 * record now (owner groups, instance owners, delegates) plus whoever moved the
 * record out of the visit. The person who moved the record IN is not
 * working on it during the first minute (the move's own writes and the page
 * reload after it), nor is the person who moves it OUT in the minute before
 * their move (its own writes); otherwise they count like anyone else.
 * Machine, import and integration writes never count.
 */

export type TouchKind = 'edit' | 'comment' | 'task' | 'view' | 'move'

export interface TimingVisit {
  /** The history row that entered the state. */
  id: number
  state: string
  entered_at: number
  /** When the next history row moved it on (null = still there). */
  left_at: number | null
  entered_by: string | null
  left_by: string | null
  terminal: boolean
}

export interface Touch {
  user: string
  at: number
  kind: Exclude<TouchKind, 'move' | 'view'>
}

export interface VisitTiming {
  history_id: number
  state: string
  entered_at: string
  left_at: string | null
  current: boolean
  waiting_ms: number
  working_ms: number
  first_touch_at: string | null
  first_touch_kind: TouchKind | null
  /** False when nobody owns the step: all of it is waiting, nobody to blame. */
  owners_known: boolean
}

/** The move's own writes and the reload after it are not work. */
export const ENTRY_GRACE_MS = 60_000

const up = (v: string | null | undefined) => String(v ?? '').toUpperCase()

/** Pure core — unit-tested over synthetic visits and touches. */
export function computeStepTiming(input: {
  visits: TimingVisit[]
  touches: Touch[]
  /** state id → the step's owner ids. */
  ownersByState: Map<string, string[]>
  /** user id (any case) → their record-view watermarks. */
  views: Map<string, ViewMarks>
  /** When the instance completed — a terminal visit is not timed. */
  completedAt?: number | null
  now: number
  graceMs?: number
}): VisitTiming[] {
  const grace = input.graceMs ?? ENTRY_GRACE_MS
  const views = new Map([...input.views].map(([k, v]) => [up(k), v]))
  const owners = new Map([...input.ownersByState].map(([k, v]) => [up(k), v.map(up)]))
  const touches = [...input.touches].sort((a, b) => a.at - b.at)
  const out: VisitTiming[] = []
  for (const v of [...input.visits].sort((a, b) => a.entered_at - b.entered_at || a.id - b.id)) {
    if (v.terminal) continue
    const end = v.left_at ?? Math.max(v.entered_at, input.completedAt ?? input.now)
    const who = new Set(owners.get(up(v.state)) ?? [])
    if (v.left_at != null && v.left_by) who.add(up(v.left_by))
    const enteredBy = up(v.entered_by)
    const leftBy = v.left_at != null ? up(v.left_by) : ''
    // The mover-in's writes right after the move, and the mover-out's writes
    // in the minute before theirs (the transition's own activity rows), are
    // part of those moves, not work on the step.
    const counts = (user: string, at: number) =>
      who.has(user) &&
      !(enteredBy && user === enteredBy && at - v.entered_at < grace) &&
      !(leftBy && user === leftBy && v.left_at != null && v.left_at - at < grace)

    let first: { at: number; kind: TouchKind } | null = null
    for (const t of touches) {
      if (t.at <= v.entered_at) continue
      if (t.at >= end) break
      if (counts(up(t.user), t.at)) {
        first = { at: t.at, kind: t.kind }
        break
      }
    }
    for (const u of who) {
      const marks = views.get(u)
      // Each watermark on its own: one inside the entry grace must not hide the other.
      for (const mark of [marks?.prev ?? null, marks?.last ?? null]) {
        const seen = firstViewIn({ last: mark, prev: null }, v.entered_at + 1, end)
        if (seen != null && counts(u, seen) && (!first || seen < first.at))
          first = { at: seen, kind: 'view' }
      }
    }
    if (!first && v.left_at != null) first = { at: v.left_at, kind: 'move' }

    const firstAt = first ? Math.min(Math.max(first.at, v.entered_at), end) : end
    out.push({
      history_id: v.id,
      state: v.state,
      entered_at: new Date(v.entered_at).toISOString(),
      left_at: v.left_at != null ? new Date(v.left_at).toISOString() : null,
      current: v.left_at == null && input.completedAt == null,
      waiting_ms: Math.max(0, firstAt - v.entered_at),
      working_ms: Math.max(0, end - firstAt),
      first_touch_at: first ? new Date(firstAt).toISOString() : null,
      first_touch_kind: first?.kind ?? null,
      owners_known: who.size > 0
    })
  }
  return out
}

const ms = (v: Date | string | null | undefined): number | null => {
  if (v == null) return null
  const t = (v instanceof Date ? v : new Date(v)).getTime()
  return Number.isFinite(t) ? t : null
}

/** Activity actions that are not a person working on the record. */
const NOT_A_TOUCH = new Set(['login', 'logout'])
const MACHINE_ORIGINS = new Set(['machine', 'import', 'integration'])

/** Rows read per source — a long-lived record's activity stays a bounded read. */
const TOUCH_CAP = 20_000

/**
 * Timing for every visit of one instance. Six small reads side by side, each
 * keyed by the record (history by instance; activity, comments, tasks and
 * views by collection + item, all indexed) plus one batched owner resolution
 * for the visited steps. A source that fails reads as empty.
 */
export async function loadStepTiming(instance: {
  id: string
  collection: string
  item: string
  template: string
  /** The record's real current step. History can lag it (a legacy import or a raw state
   *  write set the step without a history row); the open visit is then not timed. */
  current_state?: string | null
  completed_at: Date | string | null
}): Promise<VisitTiming[]> {
  const { collection } = instance
  const item = String(instance.item)
  const [history, states] = await Promise.all([
    db('nivaro_workflow_history')
      .where('instance', instance.id)
      .orderBy('timestamp', 'asc')
      .orderBy('id', 'asc')
      .select('id', 'to_state', 'user', 'timestamp') as Promise<
      Array<{ id: number; to_state: string; user: string | null; timestamp: Date | string }>
    >,
    db('nivaro_workflow_states')
      .where('template', instance.template)
      .select('id', 'is_terminal') as Promise<
      Array<{ id: string; is_terminal: boolean | number | null }>
    >
  ])
  if (history.length === 0) return []
  const terminal = new Set(
    states.filter((s) => s.is_terminal === true || s.is_terminal === 1).map((s) => up(s.id))
  )
  const visits: TimingVisit[] = history.map((h, i) => {
    const next = history[i + 1]
    return {
      id: Number(h.id),
      state: String(h.to_state),
      entered_at: ms(h.timestamp) ?? 0,
      left_at: next ? ms(next.timestamp) : null,
      entered_by: h.user ? String(h.user) : null,
      left_by: next?.user ? String(next.user) : null,
      terminal: terminal.has(up(h.to_state))
    }
  })
  // History that ends on another step than the record's (dev 2026-11-14: IR 22718 sat in
  // Warehouse Submission with its last history row moving it to Draft in January) cannot
  // say when the record entered its step or left the last one: leave that open visit out.
  const last = visits[visits.length - 1]
  if (
    instance.current_state &&
    !instance.completed_at &&
    last.left_at == null &&
    up(last.state) !== up(instance.current_state)
  )
    visits.pop()
  if (visits.length === 0) return []
  const since = new Date(visits[0].entered_at)

  const [hasOrigin, hasCompletedBy] = await Promise.all([
    hasColumn('nivaro_activity', 'origin').catch(() => false),
    hasColumn('nivaro_tasks', 'completed_by').catch(() => false)
  ])
  const stateIds = [...new Set(visits.filter((v) => !v.terminal).map((v) => v.state))]
  const [activity, comments, tasks, viewRows, owners] = await Promise.all([
    db('nivaro_activity')
      .where({ collection, item })
      .whereNotNull('user')
      .where('timestamp', '>=', since)
      .orderBy('timestamp', 'asc')
      .limit(TOUCH_CAP)
      .select('user', 'timestamp', 'action', ...(hasOrigin ? ['origin'] : []))
      .catch(() => []) as Promise<
      Array<{ user: string; timestamp: Date | string; action: string; origin?: string | null }>
    >,
    db('nivaro_comments')
      .where({ collection, item })
      .where('created_at', '>=', since)
      .orderBy('created_at', 'asc')
      .limit(TOUCH_CAP)
      .select('user', 'created_at')
      .catch(() => []) as Promise<Array<{ user: string; created_at: Date | string }>>,
    db('nivaro_tasks')
      .where({ collection, item })
      .limit(TOUCH_CAP)
      .select(
        'created_by',
        'created_at',
        'completed_at',
        ...(hasCompletedBy ? ['completed_by'] : [])
      )
      .catch(() => []) as Promise<
      Array<{
        created_by: string | null
        created_at: Date | string | null
        completed_at: Date | string | null
        completed_by?: string | null
      }>
    >,
    db('nivaro_record_views')
      .where({ collection, item_id: item })
      .select('user', 'last_viewed_at', 'prev_viewed_at')
      .catch(() => []) as Promise<
      Array<{
        user: string
        last_viewed_at: Date | string | null
        prev_viewed_at: Date | string | null
      }>
    >,
    stateIds.length
      ? resolveStateOwnersBatch(
          stateIds.map((stateId) => ({
            key: stateId,
            stateId,
            instanceId: String(instance.id),
            collection,
            itemId: item
          }))
        ).catch(() => new Map())
      : Promise.resolve(new Map())
  ])

  const touches: Touch[] = []
  for (const a of activity) {
    if (NOT_A_TOUCH.has(String(a.action))) continue
    if (a.origin && MACHINE_ORIGINS.has(String(a.origin).toLowerCase())) continue
    const at = ms(a.timestamp)
    if (at != null) touches.push({ user: String(a.user), at, kind: 'edit' })
  }
  for (const c of comments) {
    const at = ms(c.created_at)
    if (at != null && c.user) touches.push({ user: String(c.user), at, kind: 'comment' })
  }
  for (const t of tasks) {
    const made = ms(t.created_at)
    if (made != null && t.created_by)
      touches.push({ user: String(t.created_by), at: made, kind: 'task' })
    const done = ms(t.completed_at)
    if (done != null && t.completed_by)
      touches.push({ user: String(t.completed_by), at: done, kind: 'task' })
  }
  const views = new Map<string, ViewMarks>()
  for (const r of viewRows)
    views.set(up(r.user), { last: ms(r.last_viewed_at), prev: ms(r.prev_viewed_at) })
  const ownersByState = new Map<string, string[]>()
  for (const [stateId, list] of owners as Map<string, Array<{ id: string }>>)
    ownersByState.set(
      stateId,
      list.map((o) => String(o.id))
    )

  return computeStepTiming({
    visits,
    touches,
    ownersByState,
    views,
    completedAt: ms(instance.completed_at),
    now: Date.now()
  })
}
