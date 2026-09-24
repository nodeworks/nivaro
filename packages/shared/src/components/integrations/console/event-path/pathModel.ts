import type { EventPath, PathNode } from '../types'

/** Every node in the tree — children and a group's folded members alike. */
function walk(n: PathNode, fn: (n: PathNode) => void) {
  fn(n)
  for (const c of n.children) walk(c, fn)
  for (const m of n.members ?? []) walk(m, fn)
}

/** One line for the path's header: who, which record, how many records it
 *  changed and how its pushes went — "LinX · CM26-79811 · 3 records changed
 *  · 1 push (1 failed)". */
export function summarySentence(
  path: EventPath,
  ev?: { label?: string | null; item_label?: string | null }
): string {
  const records = new Set<string>()
  let pushes = 0
  let failedPushes = 0
  walk(path.root, (n) => {
    if (n.kind === 'write' && n.record) records.add(`${n.record.collection}:${n.record.item}`)
    if (n.kind === 'push') {
      pushes++
      if (n.failed) failedPushes++
    }
  })
  const parts = [ev?.label, ev?.item_label].filter(Boolean) as string[]
  parts.push(`${records.size} ${records.size === 1 ? 'record' : 'records'} changed`)
  if (pushes) {
    const failed = failedPushes ? ` (${failedPushes} failed)` : ''
    parts.push(`${pushes} ${pushes === 1 ? 'push' : 'pushes'}${failed}`)
  }
  return parts.join(' · ')
}

/** The rows on screen: every node whose ancestors are all expanded, in tree
 *  order, with its depth for indentation. */
export function flattenVisible(
  root: PathNode,
  expanded: Set<string>
): Array<{ node: PathNode; depth: number }> {
  const out: Array<{ node: PathNode; depth: number }> = []
  const go = (n: PathNode, depth: number) => {
    out.push({ node: n, depth })
    if (!expanded.has(n.key)) return
    for (const c of n.children) go(c, depth + 1)
    for (const m of n.members ?? []) go(m, depth + 1)
  }
  go(root, 0)
  return out
}

/** The keys to expand, root first, so the step `key` is on screen. Empty when
 *  the step is not in the tree. */
export function ancestorsOf(root: PathNode, key: string): string[] {
  const trail: string[] = []
  const go = (n: PathNode): boolean => {
    if (n.key === key) return true
    trail.push(n.key)
    for (const c of [...n.children, ...(n.members ?? [])]) if (go(c)) return true
    trail.pop()
    return false
  }
  return go(root) ? trail : []
}

/** Time since the root step: "+420 ms", "+1.5 s", "+2m 5s", "+47h 44m",
 *  "+3d 2h". An inferred step can precede the root, so a negative offset
 *  reads "−500 ms" / "−1.2 s" with a true minus sign. */
export function formatOffset(ms: number): string {
  const sign = ms < 0 ? '\u2212' : '+'
  const abs = Math.abs(ms)
  if (Math.round(abs) === 0) return '+0 ms'
  if (abs < 1000) return `${sign}${Math.round(abs)} ms`
  if (abs < 59_950) return `${sign}${(abs / 1000).toFixed(1)} s`
  // Round to the smallest unit shown first so 119 999 ms reads "+2m 0s",
  // never "+1m 60s" (and likewise for minutes and hours).
  const secs = Math.round(abs / 1000)
  if (secs < 3600) return `${sign}${Math.floor(secs / 60)}m ${secs % 60}s`
  const mins = Math.round(abs / 60_000)
  if (mins < 24 * 60) return `${sign}${Math.floor(mins / 60)}h ${mins % 60}m`
  const hours = Math.round(abs / 3_600_000)
  return `${sign}${Math.floor(hours / 24)}d ${hours % 24}h`
}
