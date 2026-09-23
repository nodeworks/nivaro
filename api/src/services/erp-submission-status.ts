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

export type SubmissionStatus = 'submitted' | 'pending' | 'accepted' | 'rejected' | 'failed'

/** What a submission status means for the obligation behind it. */
export function outcomeForSubmission(status: SubmissionStatus): 'sent' | 'failed' | 'pending' {
  if (status === 'accepted') return 'sent'
  if (status === 'rejected' || status === 'failed') return 'failed'
  return 'pending'
}

/** Move the obligation a submission belongs to. No obligation = no-op. */
export async function propagateSubmissionStatus(opts: {
  submissionId: number
  status: SubmissionStatus
  error?: string | null
  /** Pass it when the caller already has it; otherwise it is read. */
  obligationId?: number | null
}): Promise<void> {
  try {
    let obligationId = opts.obligationId ?? null
    if (obligationId == null) {
      const row = (await db('nivaro_erp_submissions')
        .where({ id: opts.submissionId })
        .first('obligation_id')) as { obligation_id: number | null } | undefined
      obligationId = row?.obligation_id ?? null
    }
    if (obligationId == null) return
    await resolveObligation(Number(obligationId), {
      outcome: outcomeForSubmission(opts.status),
      reason: opts.error?.slice(0, 500) ?? null,
      submission_id: opts.submissionId
    })
  } catch {
    /* propagation is bookkeeping — never fail a send because of it */
  }
}
