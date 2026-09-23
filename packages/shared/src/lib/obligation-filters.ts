/**
 * Pure filter-state helpers for the integration obligations board
 * (`IntegrationObligationsView`). Kept separate from the component so the
 * query-param and tone rules are unit-testable without a DOM.
 */

export interface ObligationFilterState {
  api: string | null
  kind: string | null
  /** A single collection name, OR — same shape as `outcome` on the route —
   *  the caller may still only ever hold one at a time here; the route
   *  itself takes a single `collection` value, unlike `kind`/`outcome`
   *  which accept comma lists. */
  collection: string | null
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
  if (s.collection) out.collection = s.collection
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

/** The submission fields the board's Attempts/Last response columns read —
 *  the row's own `LEFT JOIN nivaro_erp_submissions` on `submission_id`, a
 *  1:1 relation (`submission_id` is that table's PK), so a row with no
 *  submission at all (never attempted — a `skipped` or `missing` outcome
 *  most of the time) carries every field `null`, never a zero. */
export interface ObligationSubmissionInfo {
  attempts: number | null
  status: string | null
  last_error: string | null
  response: string | null
}

/** "3", or "3 · gave up" once the retry ladder has surrendered on this row —
 *  its `reason` carries the `gave up:` prefix `runRetryPass` writes
 *  (services/integration-remediation.ts) the one time it stops retrying.
 *  No submission at all reads as "—", never "0" — an obligation nothing has
 *  ever tried to send is a different fact than one tried and given up on. */
export function attemptsLabel(
  submission: Pick<ObligationSubmissionInfo, 'attempts'> | null,
  reason: string | null
): string {
  if (!submission || submission.attempts == null) return '—'
  const gaveUp = typeof reason === 'string' && reason.startsWith('gave up:')
  return gaveUp ? `${submission.attempts} · gave up` : String(submission.attempts)
}

/** The first `max` characters of a body, trimmed, with an ellipsis marker
 *  when it was cut — the FULL text is what the caller puts on `data-tip`
 *  instead, never dropped, just not in the cell. Empty/whitespace-only text
 *  is "nothing to show", same as no text at all. */
export function responseSnippet(text: string | null | undefined, max = 60): string | null {
  if (!text) return null
  const s = text.trim()
  if (!s) return null
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/** "ACCEPTED · <snippet>" — or bare "ACCEPTED" with nothing else stored — for
 *  a row with a submission attached. "—" for a `skipped` outcome (it never
 *  sent anything, so there is nothing to answer with — forced regardless of
 *  whatever a stray joined submission might otherwise say) and for a row
 *  with no submission at all.
 *
 *  There is no raw HTTP status code column on `nivaro_erp_submissions` —
 *  only the submission's own application-level lifecycle `status`
 *  (submitted/pending/accepted/failed), which `httpStatus` is used to
 *  CLASSIFY at write time but never persisted itself
 *  (services/workflow-actions.ts `recordSubmission`). That lifecycle status
 *  is the closest thing to "what the partner answered" this table has, so
 *  it stands in for it here. */
export function lastResponseLabel(
  outcome: string,
  submission: ObligationSubmissionInfo | null
): string {
  if (outcome === 'skipped' || !submission || !submission.status) return '—'
  const snippet = responseSnippet(submission.response ?? submission.last_error)
  return snippet ? `${submission.status.toUpperCase()} · ${snippet}` : submission.status.toUpperCase()
}

/** The UNTRUNCATED response/error text for the cell's `data-tip` — `null`
 *  renders no tooltip at all (`TipLayer` precedent — the same convention the
 *  board's own Why column already uses for `reason`). */
export function lastResponseFull(submission: ObligationSubmissionInfo | null): string | null {
  if (!submission) return null
  return submission.response ?? submission.last_error ?? null
}

/** A registered obligation kind, trimmed to the fields the board's
 *  partner-derived tabs need — the same shape `listObligationKinds()`
 *  (api/src/services/integration-obligations.ts) serves over the wire. */
export interface ObligationKindFlags {
  api: string
  kind: string
  collection: string
  human?: boolean
  inbound?: boolean
}

/** Is a kind "inbound"-shaped — its `expect()` reads something that is not a
 *  record at all (an API log entry, keyed by a bucket rather than an id)?
 *  An explicit `inbound: true` on the def is authoritative; absent that, the
 *  same `nivaro_` collection test `isRoutableRecord` already uses to decide
 *  whether a row is clickable is the fallback — an inbound kind's
 *  "collection" is routinely a system table for exactly that reason. */
export function isInboundKind(k: Pick<ObligationKindFlags, 'inbound' | 'collection'>): boolean {
  return k.inbound === true || !isRoutableRecord(k.collection)
}

/** Which kinds of ONE api belong in each partner-derived sub-tab (spec
 *  §2.4.1): a `human: true` kind is "Waiting on a person" — the send is a
 *  person's to make, never the sweep's — and an inbound-shaped kind is
 *  "Inbound rejected". Both come back as KIND NAMES, not defs, so the
 *  caller can join them straight into the board's `kind` query param (which
 *  already accepts a comma list, same as `outcome`). A tab with an empty
 *  list means this api has none of that shape — the caller hides the tab
 *  rather than rendering an always-empty one. */
export function obligationTabsFor(
  kinds: ObligationKindFlags[],
  api: string | null
): { waiting: string[]; inbound: string[] } {
  if (!api) return { waiting: [], inbound: [] }
  const forApi = kinds.filter((k) => k.api === api)
  return {
    waiting: forApi.filter((k) => k.human === true).map((k) => k.kind),
    inbound: forApi.filter(isInboundKind).map((k) => k.kind)
  }
}
