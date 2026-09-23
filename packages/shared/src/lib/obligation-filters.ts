/**
 * Pure filter-state helpers for the integration obligations board
 * (`IntegrationObligationsView`). Kept separate from the component so the
 * query-param and tone rules are unit-testable without a DOM.
 */

export interface ObligationFilterState {
  api: string | null
  kind: string | null
  outcome: string[]
  ageHours: number | null
}

/** Unset filters are omitted entirely — an empty string would narrow the
 *  query to rows whose column is empty, which is never what a cleared filter
 *  means. */
export function obligationQueryParams(s: ObligationFilterState): Record<string, string> {
  const out: Record<string, string> = {}
  if (s.api) out.api = s.api
  if (s.kind) out.kind = s.kind
  if (s.outcome.length > 0) out.outcome = s.outcome.join(',')
  if (s.ageHours != null) out.age_hours = String(s.ageHours)
  return out
}

/** Which of the four alert tones an outcome reads as — overdue/failed/missing
 *  are the record still does NOT have what it should (danger); pending and
 *  skipped are in flight or a deliberate no with a reason (warning, worth a
 *  look, not an alarm); sent is the good outcome (positive); anything else
 *  (superseded) is informational (neutral). */
export function toneForOutcome(outcome: string): 'danger' | 'warning' | 'neutral' | 'positive' {
  if (outcome === 'overdue' || outcome === 'failed' || outcome === 'missing') return 'danger'
  if (outcome === 'pending' || outcome === 'skipped') return 'warning'
  if (outcome === 'sent') return 'positive'
  return 'neutral'
}

/**
 * Does an obligation row point at a record a person can open?
 *
 * Most do — the row's (collection, item) is a real record. But a kind may
 * derive its expectation from something that is not a record at all: an
 * inbound kind reads the API log, so its collection is `nivaro_api_logs` and
 * its item is a BUCKET KEY (`workflows:371396`, `/graphql@2026-09-23T14`).
 * A `nivaro_` table is never a registered collection, so a record link built
 * from that pair cannot resolve — such a row is shown, and simply is not
 * clickable. The server applies the same test when it picks a
 * notification's target (services/integration-alerts.ts).
 */
export function isRoutableRecord(collection: string): boolean {
  return !!collection && !/^nivaro_/i.test(collection)
}
