import type { PathNode, PathStep } from './types.js'

/** More writes than this to one collection under one parent fold into a group. */
export const FOLD_THRESHOLD = 25
/** A path never carries more steps than this; the rest are dropped and flagged. */
export const STEP_CAP = 2000
/** A partner call this close to a push to the same API is that push's call. */
const CALL_ADOPT_MS = 5000

function humanCollection(c: string): string {
  return c.replace(/_/g, ' ')
}

/**
 * Sit each partner call under the sibling push to the same API that made it.
 * A push row is written once its call has answered, so a call belongs to the
 * NEAREST push at or after it (same parent, same API, within 5 s), one call
 * per push — two pushes to one API from one transition keep their own calls.
 * A call no push claims that way falls back to any push within 5 s.
 */
export function reparentCallsUnderPushes(steps: PathStep[]): PathStep[] {
  const pushes = steps.filter((s) => s.kind === 'push' && s.api_id != null)
  if (pushes.length === 0) return steps
  const calls = steps
    .filter((s) => s.kind === 'partner_call' && s.api_id != null)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  const claimed = new Set<string>()
  const owner = new Map<string, string>()
  for (const c of calls) {
    const t = Date.parse(c.at)
    let best: PathStep | null = null
    let bestGap = Number.POSITIVE_INFINITY
    for (const p of pushes) {
      if (claimed.has(p.key) || p.parent !== c.parent || p.api_id !== c.api_id) continue
      const gap = Date.parse(p.at) - t
      if (gap < 0 || gap > CALL_ADOPT_MS || gap >= bestGap) continue
      best = p
      bestGap = gap
    }
    if (best) {
      claimed.add(best.key)
      owner.set(c.key, best.key)
      continue
    }
    const loose = pushes.find(
      (p) =>
        p.parent === c.parent &&
        p.api_id === c.api_id &&
        Math.abs(Date.parse(p.at) - t) <= CALL_ADOPT_MS
    )
    if (loose) owner.set(c.key, loose.key)
  }
  return steps.map((s) => {
    const key = s.kind === 'partner_call' ? owner.get(s.key) : undefined
    return key ? { ...s, parent: key } : s
  })
}

function fold(children: PathNode[]): PathNode[] {
  const buckets = new Map<string, PathNode[]>()
  for (const c of children) {
    if (c.kind !== 'write' || !c.record?.collection || c.children.length > 0) continue
    const k = c.record.collection
    const list = buckets.get(k) ?? []
    list.push(c)
    buckets.set(k, list)
  }
  const folded = new Set<string>()
  const groups: PathNode[] = []
  for (const [collection, list] of buckets) {
    if (list.length <= FOLD_THRESHOLD) continue
    for (const n of list) folded.add(n.key)
    const first = list[0]
    const verb = list.every((n) => /created/i.test(n.summary)) ? 'created' : 'updated'
    groups.push({
      key: `group:${first.parent ?? 'root'}:${collection}`,
      parent: first.parent,
      kind: 'group',
      at: first.at,
      offset_ms: first.offset_ms,
      summary: `${list.length} ${humanCollection(collection)} ${verb}`,
      failed: list.some((n) => n.failed),
      children: [],
      members: list
    })
  }
  if (groups.length === 0) return children
  return [...children.filter((c) => !folded.has(c.key)), ...groups].sort(
    (a, b) => Date.parse(a.at) - Date.parse(b.at)
  )
}

const byTime = (a: PathStep, b: PathStep) => Date.parse(a.at) - Date.parse(b.at)

/**
 * Over the cap, writes go first: every transition, flow, push, attempt and
 * call is kept (they carry the path's failures), and only the newest writes
 * are dropped.
 */
function capSteps(steps: PathStep[]): PathStep[] {
  const others = steps.filter((s) => s.kind !== 'write').sort(byTime)
  if (others.length >= STEP_CAP) return others.slice(0, STEP_CAP)
  const writes = steps
    .filter((s) => s.kind === 'write')
    .sort(byTime)
    .slice(0, STEP_CAP - others.length)
  return [...others, ...writes]
}

/**
 * Drop steps on records the viewer may not read, WITH their subtrees: a
 * hidden push takes its attempts and calls with it. A descendant carrying its
 * own readable record is kept (it re-attaches to the root). Parents are
 * resolved before anything is dropped. Returns the kept steps and how many
 * were dropped.
 */
export function filterHiddenSubtrees(
  steps: PathStep[],
  canRead: (record: { collection: string; item: string }) => boolean
): { steps: PathStep[]; hidden: number } {
  const byKey = new Map(steps.map((s) => [s.key, s]))
  const memo = new Map<string, boolean>()
  const dropped = (s: PathStep, seen: Set<string>): boolean => {
    const known = memo.get(s.key)
    if (known !== undefined) return known
    let out: boolean
    if (s.record) out = !canRead(s.record)
    else {
      const p = s.parent && s.parent !== s.key ? byKey.get(s.parent) : undefined
      out = p && !seen.has(p.key) ? dropped(p, new Set(seen).add(s.key)) : false
    }
    memo.set(s.key, out)
    return out
  }
  const kept = steps.filter((s) => !dropped(s, new Set([s.key])))
  return { steps: kept, hidden: steps.length - kept.length }
}

/**
 * Nest steps under their parents (an unknown, missing or self parent = the
 * root), order siblings by time, fold bulk writes, and cap the step count.
 */
export function buildTree(
  rootStep: PathStep,
  steps: PathStep[]
): { root: PathNode; truncated: boolean; count: number } {
  const truncated = steps.length > STEP_CAP
  const kept = truncated ? capSteps(steps) : steps.slice()
  const t0 = Date.parse(rootStep.at)
  const toNode = (s: PathStep): PathNode => ({
    ...s,
    children: [],
    offset_ms: Math.max(0, Date.parse(s.at) - t0)
  })
  const root = toNode(rootStep)
  const byKey = new Map<string, PathNode>([[root.key, root]])
  const nodes = kept.filter((s) => s.key !== root.key).map(toNode)
  for (const n of nodes) if (!byKey.has(n.key)) byKey.set(n.key, n)
  for (const n of nodes) {
    const found = n.parent && n.parent !== n.key ? byKey.get(n.parent) : undefined
    ;(found ?? root).children.push(n)
  }
  // A parent cycle (a → b → a) never reaches the root; re-attach it there.
  const reachable = new Set<PathNode>()
  const mark = (n: PathNode) => {
    if (reachable.has(n)) return
    reachable.add(n)
    for (const c of n.children) mark(c)
  }
  mark(root)
  for (const n of nodes) {
    if (reachable.has(n)) continue
    const p = n.parent ? byKey.get(n.parent) : undefined
    if (p) p.children = p.children.filter((c) => c !== n)
    root.children.push(n)
    mark(n)
  }
  const walk = (n: PathNode) => {
    n.children.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    for (const c of n.children) walk(c)
    n.children = fold(n.children)
  }
  walk(root)
  return { root, truncated, count: kept.length }
}

/** The earliest failed step in tree order (depth-first, earliest child first). */
export function firstFailure(root: PathNode): string | null {
  const stack: PathNode[] = [root]
  while (stack.length) {
    const n = stack.shift() as PathNode
    if (n.failed && n !== root) return n.key
    stack.unshift(...n.children)
  }
  return null
}
