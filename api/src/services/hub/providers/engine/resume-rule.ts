import type { HubResourceChangeRow } from '../store.js'

/**
 * When resume may run a change again (Task 11c item 4). An interrupted change always may. A
 * failed one may when its last failed step is retryable, or when it failed AUTH_FAILED (the
 * provider refused the connection's keys) and the connection's keys changed since: the step
 * records the connection's `secret_fingerprint` at the failure, and resume compares it with the
 * fingerprint now. A step with no recorded fingerprint (failed before this rule) stays refused.
 */

export const AUTH_FAILED = 'AUTH_FAILED'

const lastFailed = (change: Pick<HubResourceChangeRow, 'steps'>) =>
  [...(change.steps ?? [])].reverse().find((s) => s.status === 'failed') ?? null

/** True when the last failed step failed on the connection's keys and they changed since. */
export function keysChangedSinceAuthFailure(
  change: Pick<HubResourceChangeRow, 'status' | 'steps'>,
  currentFingerprint: string | null | undefined
): boolean {
  if (change.status !== 'failed') return false
  const step = lastFailed(change)
  if (step?.error?.code !== AUTH_FAILED) return false
  if (step.connectionFingerprint === undefined) return false
  return (step.connectionFingerprint ?? null) !== (currentFingerprint ?? null)
}

/**
 * Whether resume would run the change. `currentFingerprint` is the change connection's
 * `secret_fingerprint` now; leave it undefined when it is unknown (then AUTH_FAILED stays refused).
 */
export function changeResumable(
  change: Pick<HubResourceChangeRow, 'status' | 'steps'>,
  currentFingerprint?: string | null
): boolean {
  if (change.status === 'interrupted') return true
  if (change.status !== 'failed') return false
  if (lastFailed(change)?.error?.retryable === true) return true
  return currentFingerprint !== undefined && keysChangedSinceAuthFailure(change, currentFingerprint)
}
