import type { HelpVideoContext } from '../types'

const isRow = (c: HelpVideoContext, collection: string) =>
  c.kind === 'collection' && c.key === collection

/** The collections a video is listed on, in the order they were added. */
export function collectionKeysOf(contexts: HelpVideoContext[]): string[] {
  return [...new Set(contexts.filter((c) => c.kind === 'collection').map((c) => c.key))]
}

/** The steps chosen for one collection. Empty means every step. */
export function stepsOf(contexts: HelpVideoContext[], collection: string): string[] {
  return contexts
    .filter((c) => isRow(c, collection) && c.state_key)
    .map((c) => c.state_key as string)
}

/** Lists a collection (every step). A collection already listed is left as it is. */
export function addCollection(
  contexts: HelpVideoContext[],
  collection: string
): HelpVideoContext[] {
  if (contexts.some((c) => isRow(c, collection))) return contexts
  return [...contexts, { kind: 'collection', key: collection, state_key: null }]
}

/** Takes a collection off the video, with all its steps. */
export function removeCollection(
  contexts: HelpVideoContext[],
  collection: string
): HelpVideoContext[] {
  return contexts.filter((c) => !isRow(c, collection))
}

/**
 * Turns one step on or off for a collection. The server shows a video at
 * every step of a collection when it holds a row with no step, so the first
 * chosen step replaces that row, and removing the last chosen step puts it
 * back (the collection stays listed, for every step). Pages are untouched.
 */
export function toggleStep(
  contexts: HelpVideoContext[],
  collection: string,
  stateKey: string
): HelpVideoContext[] {
  const chosen = stepsOf(contexts, collection)
  const next = chosen.includes(stateKey)
    ? chosen.filter((s) => s !== stateKey)
    : [...chosen, stateKey]
  const rows: HelpVideoContext[] = next.length
    ? next.map((s) => ({ kind: 'collection', key: collection, state_key: s }))
    : [{ kind: 'collection', key: collection, state_key: null }]
  // Keep the collection where it was in the list.
  let placed = false
  const out: HelpVideoContext[] = []
  for (const c of contexts) {
    if (!isRow(c, collection)) out.push(c)
    else if (!placed) {
      out.push(...rows)
      placed = true
    }
  }
  return placed ? out : [...out, ...rows]
}
