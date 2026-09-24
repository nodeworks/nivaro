import { HISTORY_WINDOW_MS } from '../submission-detail.js'

/** Kept beside the submission drill's windows so the two can never disagree. */
export const INBOUND_SLACK_MS = 1000
export const POLL_WINDOW_MS = 10_000
export const PUSH_AFTER_MS = HISTORY_WINDOW_MS

/** The API log is written when the response finished; the writes happened during it. */
export function inboundWindow(createdAt: Date, latencyMs: number): { from: Date; to: Date } {
  const end = createdAt.getTime()
  return {
    from: new Date(end - Math.max(0, latencyMs) - INBOUND_SLACK_MS),
    to: new Date(end + INBOUND_SLACK_MS)
  }
}
