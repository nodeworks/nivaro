/**
 * Hub verification limits, ONE copy for both sides (the Hub's suite validation and link timeout,
 * services/hub/verify/*; the app's read runner, services/hub-link/verify.ts), so a suite the Hub
 * saves is always one the app accepts and the Hub never stops waiting before the app is done.
 */

/** Signed-in reads + saved queries per run (the app refuses more; the Hub refuses to save more). */
export const MAX_READS = 10
/** One read's own limit on the app. */
export const READ_TIMEOUT_MS = 15_000
/** Reads the app runs at once. */
export const READ_CONCURRENCY = 3
/** What the Hub adds on top of the app's budget (the link, the key mint, the answer). */
export const LINK_MARGIN_MS = 15_000

/** The longest the app can take for `reads` reads: batches of READ_CONCURRENCY, each ≤ READ_TIMEOUT_MS. */
export function appReadBudgetMs(reads: number): number {
  return Math.ceil(Math.max(1, reads) / READ_CONCURRENCY) * READ_TIMEOUT_MS
}

/** How long the Hub waits for a run of `reads` reads over the link. */
export function hubReadTimeoutMs(reads: number): number {
  return appReadBudgetMs(reads) + LINK_MARGIN_MS
}
