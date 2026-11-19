/**
 * What an open record refreshes when a `$related` or `$files` notice names it (realtime program
 * 2026-11-14, ideas 3 and 18). The server sends ids and the aspect name only
 * (api services/related-announce.ts); every refetch below goes through the viewer's own
 * permission-checked query. Only queries someone is looking at refetch (react-query's active
 * refetch); the rest are marked stale.
 */

type Key = readonly unknown[]

const same = (a: unknown, b: string) => a != null && String(a) === b

/**
 * Queries that show this record's children and links: its line grids (`o2m-rows`, the parent id
 * is the 4th part), its many-to-many lists (`m2m-items`), the plan grid's compare series, the
 * Summary's related list and the related-records panel. Record widgets follow the grids
 * (WidgetSlot re-renders when a grid read brings back different rows).
 */
export function relatedQueryOfRecord(collection: string, itemId: string) {
  return (key: Key): boolean => {
    const head = key[0]
    if (head === 'o2m-rows' || head === 'o2m-field-snapshots' || head === 'm2m-items')
      return same(key[3], itemId)
    // Low (shared) 1: the panels `$related` is sent for — "Referenced by" and the Summary's
    // many-to-any list — were missing here.
    if (head === 'summary-m2a-items') return same(key[3], itemId)
    if (
      head === 'rrv-related' ||
      head === 'record-links' ||
      head === 'record-graph' ||
      head === 'referenced-by' ||
      // rt-fix C (admin #13): the dynamic attributes panel (server sends `$attributes` + `$related`).
      head === 'attribute-values'
    )
      return key[1] === collection && same(key[2], itemId)
    return head === 'o2m-compare'
  }
}

/** C2: the record's per-state action buttons (Push to Fusion…) — a move by someone else must
 *  refresh them, not wait out their 5-minute cache. The header keys the id as given, the row
 *  menu as a string. */
export function actionQueryOfRecord(collection: string, itemId: string) {
  return (key: Key): boolean =>
    (key[0] === 'item-actions' || key[0] === 'ext-item-actions') &&
    key[1] === collection &&
    same(key[2], itemId)
}

/**
 * rt-fix C (admin #4): what an `$integrations` notice refreshes — the submissions list, the
 * Integrations panel, the obligation ledger lines (header chip, popup, failure banner; keyed
 * `['integration-obligations', 'record', c, id]`) and the partner's external ids. GitLab chips
 * follow the `trackers` ops topic instead (use-tracker-link.ts).
 */
export function integrationQueryOfRecord(collection: string, itemId: string) {
  return (key: Key): boolean => {
    const head = key[0]
    if (
      head === 'erp-submissions' ||
      head === 'record-integrations' ||
      head === 'record-external-ids'
    )
      return key[1] === collection && same(key[2], itemId)
    if (head === 'integration-obligations')
      return key[1] === 'record' && key[2] === collection && same(key[3], itemId)
    return false
  }
}

/** rt-fix C (admin #4): a move can open, close or supersede an obligation — the ledger lines. */
export function obligationQueryOfRecord(collection: string, itemId: string) {
  return (key: Key): boolean =>
    key[0] === 'integration-obligations' &&
    key[1] === 'record' &&
    key[2] === collection &&
    same(key[3], itemId)
}

/** rt-fix C (admin #3): the Change proposals panel (`proposalsQueryKey`). */
export function proposalQueryOfRecord(collection: string, itemId: string) {
  return (key: Key): boolean =>
    key[0] === 'change-proposals' && key[1] === collection && same(key[2], itemId)
}

/** C3: read-only relation-path fields (`purchase_order.workflow.workflow_id`) follow a remote
 *  write to the record — its links may have moved. */
export function resolvedPathQueryOfRecord(collection: string, itemId: string) {
  return (key: Key): boolean =>
    key[0] === 'resolve-paths' && key[1] === collection && same(key[2], itemId)
}

/** C5: an addendum card's own workflow block and lines, alongside the record's addendum list. */
export const ADDENDUM_DETAIL_KEYS: readonly (readonly unknown[])[] = [
  ['pipeline-instance', 'nivaro_addendums'],
  ['addendum-lines']
]

/** Queries that show this record's files: its file links, the files' names, usage and downloads. */
export function fileQueryOfRecord(collection: string, itemId: string) {
  return (key: Key): boolean => {
    const head = key[0]
    if (head === 'm2m-items') return same(key[3], itemId)
    if (head === 'file-usage' || head === 'file-download-stats')
      return key[1] === collection && same(key[2], itemId)
    // A renamed or replaced file: its name/size read (shared across records, cheap, by id).
    return head === 'files-meta' || head === 'file-meta' || head === 'file-health'
  }
}

/**
 * A collection-wide `$related` (`'*'`: a burst named more parents than the server's cap) reaches
 * every open record of the collection at once; each waits a random moment so they do not all
 * re-read in the same second.
 */
export const WIDE_RELATED_SPREAD_MS = 3000

export function wideSpreadDelay(random: () => number = Math.random): number {
  return Math.floor(random() * WIDE_RELATED_SPREAD_MS)
}
