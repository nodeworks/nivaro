/**
 * Parallel-branch lanes for the state track (#1240).
 *
 * The split/join engine (routes/workflows.ts) records a split as a history row
 * on the PARENT instance whose comment is JSON `{action:'split', children,
 * join_state}`; each branch is its own child instance (same collection/item)
 * whose first history row carries `{action:'branch', parent}`; when every
 * branch is terminal the parent gets `{action:'join', children}` and moves to
 * the join state. This module turns that into one lane per branch — pure, no
 * database, so the shape is unit-tested over synthetic history.
 */

export interface LaneHistoryRow {
  id: number
  /** Child instance the row belongs to (child history only). */
  instance?: string
  /** Transition that wrote the row — lifecycle rows have none (see below). */
  transition?: string | null
  from_state: string | null
  to_state: string
  comment: string | null
  timestamp: Date | string
  user?: string | null
  first_name?: string | null
  last_name?: string | null
  user_email?: string | null
}

export interface LaneChildInstance {
  id: string
  current_state: string | null
  completed_at: Date | string | null
  started_at: Date | string | null
}

export interface LaneState {
  id: string
  label: string
  color: string | null
  is_terminal: boolean | number | string | null
}

export interface LaneStateRef {
  id: string
  label: string
  color: string | null
}

export interface LaneStep {
  state: LaneStateRef
  entered_at: string
  left_at: string | null
  /** Who moved the branch INTO this state (null = the split itself / engine). */
  by: string | null
}

export interface BranchLane {
  instance_id: string
  /** The branch's first state — what the lane is called. */
  label: string
  steps: LaneStep[]
  current: LaneStateRef | null
  /** When the branch entered its current state. */
  entered_at: string | null
  terminal: boolean
  finished_at: string | null
}

export interface BranchLanes {
  split_state: LaneStateRef | null
  join_state: LaneStateRef | null
  split_at: string
  joined_at: string | null
  /** True while the split has not joined. */
  open: boolean
  lanes: BranchLane[]
  /** Lanes still running (not terminal), in split order. */
  waiting_on: string[]
}

interface SplitComment {
  action: 'split'
  children: string[]
  join_state: string
}

/** The engine's lifecycle JSON from a history comment, or null. */
export function parseLifecycleComment(
  comment: string | null | undefined
): { action: string; [k: string]: unknown } | null {
  const s = String(comment ?? '').trim()
  if (!s.startsWith('{')) return null
  try {
    const parsed = JSON.parse(s) as { action?: unknown }
    if (parsed && typeof parsed.action === 'string') {
      return parsed as { action: string; [k: string]: unknown }
    }
  } catch {
    // not engine JSON
  }
  return null
}

/** Engine lifecycle JSON on a history row — only rows the engine wrote
 *  (no transition). A person's comment always rides a transition row, so a
 *  typed '{"action":"split",…}' is never read as a split. */
export function lifecycleOf(
  row: Pick<LaneHistoryRow, 'comment' | 'transition'>
): { action: string; [k: string]: unknown } | null {
  if (row.transition != null && row.transition !== '') return null
  return parseLifecycleComment(row.comment)
}

function iso(v: Date | string | null | undefined): string | null {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function byTime<T extends { id: number; timestamp: Date | string }>(a: T, b: T): number {
  const ta = new Date(a.timestamp).getTime()
  const tb = new Date(b.timestamp).getTime()
  return ta - tb || a.id - b.id
}

function truthy(v: unknown): boolean {
  return v === true || v === 1 || v === '1'
}

/**
 * Build lanes for the MOST RECENT split on an instance (open, or the last one
 * that joined). Returns null when the instance never split.
 */
export function buildBranchLanes(input: {
  /** The record's own instance — a child counts only if its branch row names it. */
  parentInstanceId: string
  parentHistory: LaneHistoryRow[]
  children: LaneChildInstance[]
  childHistory: LaneHistoryRow[]
  states: LaneState[]
}): BranchLanes | null {
  const parentRows = [...input.parentHistory].sort(byTime)
  let splitIndex = -1
  let split: SplitComment | null = null
  for (let i = 0; i < parentRows.length; i++) {
    const c = lifecycleOf(parentRows[i])
    if (c?.action === 'split' && Array.isArray(c.children) && typeof c.join_state === 'string') {
      splitIndex = i
      split = c as unknown as SplitComment
    }
  }
  if (splitIndex < 0 || split === null) return null
  const splitCfg: SplitComment = split
  const splitRow = parentRows[splitIndex]
  const joinRow =
    parentRows.slice(splitIndex + 1).find((row) => lifecycleOf(row)?.action === 'join') ?? null

  const stateById = new Map(input.states.map((s) => [s.id, s]))
  const ref = (id: string | null | undefined): LaneStateRef | null => {
    if (!id) return null
    const s = stateById.get(id)
    return s ? { id: s.id, label: s.label, color: s.color ?? null } : null
  }
  const nameOf = (row: LaneHistoryRow): string | null => {
    const n = [row.first_name, row.last_name].filter(Boolean).join(' ')
    return n || row.user_email || null
  }

  // uniqueidentifier ids come back upper-case; the engine's JSON holds the
  // lower-case uuid it generated — compare case-insensitively.
  const lc = (v: string) => v.toLowerCase()
  const childById = new Map(input.children.map((c) => [lc(c.id), c]))
  const historyByChild = new Map<string, LaneHistoryRow[]>()
  for (const row of input.childHistory) {
    if (!row.instance) continue
    const list = historyByChild.get(lc(row.instance)) ?? []
    list.push(row)
    historyByChild.set(lc(row.instance), list)
  }

  const lanes: BranchLane[] = []
  for (const childId of splitCfg.children) {
    const child = childById.get(lc(childId))
    if (!child) continue
    const rows = (historyByChild.get(lc(childId)) ?? []).sort(byTime)
    // Mutual reference: the child's own engine-written branch row must name
    // this parent. A split comment alone (or one a person typed) never pulls
    // another instance into the record's lanes.
    const parentKey = input.parentInstanceId.toLowerCase()
    const namesParent = rows.some((row) => {
      const life = lifecycleOf(row)
      return (
        life?.action === 'branch' &&
        typeof life.parent === 'string' &&
        life.parent.toLowerCase() === parentKey
      )
    })
    if (!namesParent) continue
    const steps: LaneStep[] = []
    rows.forEach((row, i) => {
      const state = ref(row.to_state)
      if (!state) return
      const entered = iso(row.timestamp) ?? ''
      const next = rows[i + 1]
      const lifecycle = lifecycleOf(row)
      steps.push({
        state,
        entered_at: entered,
        left_at: next ? iso(next.timestamp) : null,
        by: lifecycle ? null : nameOf(row)
      })
    })
    const current = ref(child.current_state) ?? steps[steps.length - 1]?.state ?? null
    const currentState = child.current_state ? stateById.get(child.current_state) : undefined
    const terminal = !!child.completed_at || truthy(currentState?.is_terminal)
    const lastIntoCurrent = [...steps].reverse().find((s) => s.state.id === current?.id)
    lanes.push({
      instance_id: child.id,
      label: steps[0]?.state.label ?? current?.label ?? 'Branch',
      steps,
      current,
      entered_at: lastIntoCurrent?.entered_at ?? iso(child.started_at),
      terminal,
      finished_at: terminal
        ? (iso(child.completed_at) ?? lastIntoCurrent?.entered_at ?? null)
        : null
    })
  }

  return {
    split_state: ref(splitRow.from_state) ?? ref(splitRow.to_state),
    join_state: ref(splitCfg.join_state),
    split_at: iso(splitRow.timestamp) ?? '',
    joined_at: joinRow ? iso(joinRow.timestamp) : null,
    open: !joinRow,
    lanes,
    waiting_on: joinRow ? [] : lanes.filter((l) => !l.terminal).map((l) => l.instance_id)
  }
}
