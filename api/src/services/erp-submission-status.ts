/**
 * A submission's status is its obligation's truth.
 *
 * Several separate places write nivaro_erp_submissions.status — the transition
 * action, the manual retry route, the bulk-retry route and the automatic
 * retry sweep — and an obligation frozen at `pending` while its submission was
 * accepted an hour ago is exactly the kind of quiet disagreement this whole
 * feature exists to stop. So the mapping lives here and every writer calls it.
 */
import { resolveObligation } from './integration-obligations.js'

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
 * four callers (the manual retry route, the bulk-retry route, the PATCH
 * status override and the automatic retry sweep) already has the submission
 * row in hand and passes `row.obligation_id` straight through — including
 * when that value is null, for a submission that predates the ledger or was
 * never attributed to a registered kind. A second query for a field the
 * caller already read would only repeat the null it already found.
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
