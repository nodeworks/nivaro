/**
 * A submission's status is its obligation's truth.
 *
 * Several separate places write nivaro_erp_submissions.status — the transition
 * action, the manual retry route, the bulk-retry route and the automatic
 * retry sweep — and an obligation frozen at `pending` while its submission was
 * accepted an hour ago is exactly the kind of quiet disagreement this whole
 * feature exists to stop. So the mapping lives here and every writer calls it.
 */
import { db } from '../db/index.js'
import { resolveObligation } from './integration-obligations.js'
import { classifyError } from './integration-remediation.js'

export type SubmissionStatus = 'submitted' | 'pending' | 'accepted' | 'rejected' | 'failed'

/** What a submission status means for the obligation behind it. */
export function outcomeForSubmission(status: SubmissionStatus): 'sent' | 'failed' | 'pending' {
  if (status === 'accepted') return 'sent'
  if (status === 'rejected' || status === 'failed') return 'failed'
  return 'pending'
}

/**
 * Move the obligation a submission belongs to. No obligation = no-op.
 *
 * `obligationId` is required, not looked up: every one of this function's
 * callers (the manual retry route, the bulk-retry route, the PATCH status
 * override, the automatic retry sweep, and Task 19's `resendSubmission`)
 * already has the submission row in hand and passes `row.obligation_id`
 * straight through — including when that value is null, for a submission
 * that predates the ledger or was never attributed to a registered kind. A
 * second query for a field the caller already read would only repeat the
 * null it already found.
 */
export async function propagateSubmissionStatus(opts: {
  submissionId: number
  status: SubmissionStatus
  error?: string | null
  obligationId: number | null
}): Promise<void> {
  try {
    if (opts.obligationId == null) return
    await resolveObligation(opts.obligationId, {
      outcome: outcomeForSubmission(opts.status),
      reason: opts.error?.slice(0, 500) ?? null,
      submission_id: opts.submissionId
    })
  } catch {
    /* propagation is bookkeeping — never fail a send because of it */
  }
}

/** Columns this function decides for itself — never overridable via `extra`
 *  below, so a caller can pass extra bookkeeping without any risk of it
 *  accidentally clobbering the shared column set. */
const OWNED_COLUMNS = new Set([
  'status',
  'response',
  'external_ref',
  'attempts',
  'last_error',
  'error_class',
  'updated_at'
])

/**
 * The submission-row update that follows any send attempt — one function,
 * so the manual retry route, the bulk-retry route, the status-override
 * route, the automatic sweep and Task 19's send-now / retry-ladder /
 * re-fire all write the SAME columns. `attempts` in particular: it is what
 * every backoff ladder counts, so a writer that skipped it would leave that
 * row's ladder stuck on rung zero forever.
 *
 * `error_class` (#628, migration 343) is written here too, for every
 * failure or rejection: `null` when the send did not fail, otherwise
 * `classifyError` over the outcome's own `http_status` (when the sender
 * supplied one — `sendPayload` always does now) and its response body,
 * falling back to text-pattern matching on the error string for a network
 * failure that never got a response at all. That classification is what
 * decides whether `runRetryPass` may ever pick the row back up.
 *
 * `extra` merges additional columns into this SAME `.update()` call — for a
 * caller with its own bookkeeping this function knows nothing about (the
 * automatic sweep's `retry_count`/`next_retry_at`), so a send attempt is
 * ever only ONE write to the row, not one from here plus a second from the
 * caller.
 *
 * `attempted: false` is for the ONE caller that records an outcome without
 * having made an attempt — `PATCH /erp-submissions/:id/status`, where an
 * admin writes down what a partner told us some other way (a webhook, a
 * phone call). That route never contacts anyone, so counting it as an
 * attempt would silently spend a rung of the retry ladder every time someone
 * corrected a status.
 */
export async function applySendOutcome(opts: {
  submissionId: number
  outcome: {
    status: SubmissionStatus
    external_ref: string | null
    error: string | null
    response: unknown
    http_status?: number | null
  }
  priorExternalRef: string | null
  priorAttempts: number
  extra?: Record<string, unknown>
  /** Default true: this outcome came from a request we actually made. */
  attempted?: boolean
}): Promise<void> {
  const { serializeResponseBody } = await import('./workflow-actions.js')
  const failed = opts.outcome.status === 'failed' || opts.outcome.status === 'rejected'
  const extra = Object.fromEntries(
    Object.entries(opts.extra ?? {}).filter(([k]) => !OWNED_COLUMNS.has(k))
  )
  await db('nivaro_erp_submissions')
    .where({ id: opts.submissionId })
    .update({
      status: opts.outcome.status,
      response: serializeResponseBody(opts.outcome.response),
      external_ref: opts.outcome.external_ref ?? opts.priorExternalRef,
      attempts: opts.attempted === false ? opts.priorAttempts : opts.priorAttempts + 1,
      last_error: opts.outcome.error,
      error_class: failed
        ? classifyError(opts.outcome.http_status ?? null, opts.outcome.response, opts.outcome.error)
        : null,
      updated_at: new Date(),
      ...extra
    })
}
