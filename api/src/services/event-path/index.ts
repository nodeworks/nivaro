import { replayLinks } from '../chain-roots.js'
import { getEvent } from '../integration-event-sources.js'
import { getLabels } from '../queues.js'
import { loadChainSteps } from './exact.js'
import { inferSteps } from './inferred.js'
import { buildTree, firstFailure, reparentCallsUnderPushes } from './tree.js'
import type { EventPath, PathNode, PathStep } from './types.js'

export interface PathViewer {
  isAdmin: boolean
  /** "collection:item" keys the viewer may read; omitted = everything (admin). */
  canReadRecords?: (refs: Array<{ collection: string; item: string }>) => Promise<Set<string>>
}

/**
 * The full path one integration event set off: exact when the event carries
 * a chain id (every stamped row, nested by chain_parent), else reconstructed
 * by clock and marked inferred.
 */
export async function buildEventPath(
  source: string,
  id: string,
  viewer: PathViewer
): Promise<EventPath | null> {
  const ev = await getEvent(source, id)
  if (!ev) return null
  let steps: PathStep[]
  let rootStep: PathStep
  let warnings: string[]
  let mode: 'exact' | 'inferred'
  if (ev.chain_id) {
    const exact = await loadChainSteps(ev.chain_id, { withBodies: viewer.isAdmin })
    warnings = exact.warnings
    steps = exact.steps
    rootStep = exact.rootStep ?? {
      // A cron / import / feed chain has no request log: name the root the
      // key its top steps point at, so they nest under it.
      key: rootKeyOf(exact.steps) ?? `event:${ev.source}:${ev.id}`,
      parent: null,
      kind: ev.direction === 'in' ? 'request' : ev.direction === 'out' ? 'push' : 'feed',
      at: ev.created_at,
      who: ev.label,
      record:
        ev.collection && ev.item_id
          ? { collection: ev.collection, item: ev.item_id, label: ev.item_label ?? null }
          : null,
      summary: ev.text,
      failed: ev.status === 'error'
    }
    mode = 'exact'
  } else {
    const inf = await inferSteps(ev)
    steps = inf.steps
    rootStep = inf.rootStep
    warnings = inf.warnings
    mode = 'inferred'
  }

  // Permission filter (record side): a step on a record the viewer may not
  // read is dropped and counted; its children re-attach to the root.
  let hidden = 0
  if (viewer.canReadRecords) {
    const refs = steps
      .filter((s) => s.record)
      .map((s) => ({
        collection: (s.record as { collection: string }).collection,
        item: (s.record as { item: string }).item
      }))
    const allowed = refs.length ? await viewer.canReadRecords(refs) : new Set<string>()
    const before = steps.length
    steps = steps.filter((s) => !s.record || allowed.has(`${s.record.collection}:${s.record.item}`))
    hidden = before - steps.length
  }

  await labelRecords([rootStep, ...steps])
  const { root, truncated, count } = buildTree(rootStep, reparentCallsUnderPushes(steps))
  const links = ev.chain_id
    ? await replayLinks(ev.chain_id)
    : { replay_of: null, replayed_as: [] as string[] }
  return {
    root,
    mode,
    truncated,
    step_count: count,
    first_failure: firstFailure(root),
    replay_of: links.replay_of,
    replayed_as: links.replayed_as,
    hidden_steps: hidden || undefined,
    warnings
  }
}

/** Keys a chain's root carries (fallback parents like `auto` never name a root). */
const ROOT_KEY = /^(request|cron|import_run|root):/

/** The root key the chain's top steps point at, when no request log names it. */
export function rootKeyOf(steps: PathStep[]): string | null {
  const keys = new Set(steps.map((s) => s.key))
  const dangling = steps.map((s) => s.parent).filter((p): p is string => !!p && !keys.has(p))
  return dangling.find((p) => ROOT_KEY.test(p)) ?? null
}

async function labelRecords(steps: PathStep[]): Promise<void> {
  const by = new Map<string, Set<string>>()
  for (const s of steps) {
    if (!s.record?.collection || !s.record.item || s.record.label) continue
    const set = by.get(s.record.collection) ?? new Set<string>()
    set.add(s.record.item)
    by.set(s.record.collection, set)
  }
  if (by.size === 0) return
  try {
    const labels = await getLabels(by)
    for (const s of steps) {
      if (s.record && !s.record.label) {
        s.record.label = labels[`${s.record.collection}:${s.record.item}`] ?? null
      }
    }
  } catch {
    // unlabelled records fall back to their raw ids client-side
  }
}

export { chainsTouchingRecord } from './record-ref.js'
export type { EventPath, PathNode }
