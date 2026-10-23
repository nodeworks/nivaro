// ─── Can a stored submission be sent again? ──────────────────────────────────
// A payload template that refused to render records a failed nivaro_erp_submissions row whose
// stored body is null: there is nothing to send. Every resend path (retry, bulk retry, the
// retry sweeps, Send now, re-fire) asks hasResendableBody first and answers NO_BODY (409 on a
// route); sendPayload itself throws NoBodyToResendError as the last line. Pure — no imports — so
// tests that stub the senders still get the real guard.

/** What a resend of a body-less submission answers (HTTP 409). */
export const NO_BODY = {
  error: 'no_body',
  message: 'This submission has no body to resend'
} as const

export class NoBodyToResendError extends Error {
  readonly code = NO_BODY.error
  constructor() {
    super(NO_BODY.message)
    this.name = 'NoBodyToResendError'
  }
}

/** Whether a stored payload carries a body a resend can send (a render failure stores null). */
export function hasResendableBody(stored: { body?: unknown } | null | undefined): boolean {
  return stored?.body != null && typeof stored.body === 'object'
}
