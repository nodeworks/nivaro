/**
 * Readable operations — the shapes an extension hands the core so failures and job runs read as
 * plain sentences. Mirrors api/src/services/integration-error-explain.ts and
 * api/src/services/job-run-sentences.ts (extensions never import api/src).
 */

export type IntegrationErrorCause =
  | 'credentials'
  | 'not_found'
  | 'validation'
  | 'body_rejection'
  | 'conflict'
  | 'timeout'
  | 'unreachable'
  | 'rate_limited'
  | 'partner_down'
  | 'unknown'

export type IntegrationFixTarget =
  | { kind: 'record'; collection: string; item: string; field?: string | null }
  | {
      kind: 'external_api'
      id: number
      section?: 'auth' | 'endpoints' | 'connection' | 'response' | null
    }
  | { kind: 'partner'; id: number }
  | { kind: 'payload_template'; api_id: number; key: string }

/** What the core knows about one failed outbound call. */
export interface IntegrationErrorInput {
  partner?: string | null
  apiId?: number | null
  httpStatus?: number | null
  error?: string | null
  body?: unknown
  collection?: string | null
  item?: string | null
  recordLabel?: string | null
  endpoint?: string | null
  fields?: Array<{ field: string; label?: string | null }> | null
  payloadTemplateKey?: string | null
}

/** Facts the core works out once per explanation. */
export interface IntegrationErrorFacts {
  status: number | null
  partner: string
  record: string
  hasRecord: boolean
  /** The partner's own message (masked, short), or null. */
  message: string | null
  /** Lower-cased error + body text, for pattern matching. */
  text: string
  bodyRejected: boolean
  field: { field: string; label: string } | null
}

export interface IntegrationErrorRuleResult {
  sentence: string
  cause?: IntegrationErrorCause
  fix?: IntegrationFixTarget | null
  fix_label?: string | null
  field?: string | null
  detail?: string | null
}

/** A partner rule: `match` returns null to pass, or the sentence (+ cause, Fix it target). */
export interface IntegrationErrorRule {
  id: string
  /** Only for this external API name (case-insensitive) — absent = every partner. */
  partner?: string | RegExp
  match(
    input: IntegrationErrorInput,
    facts: IntegrationErrorFacts
  ): IntegrationErrorRuleResult | null
}

/** One recorded run, as a job-run formatter sees it (progress already parsed). */
export interface JobRunFacts {
  id: number
  kind: string
  job_id: string
  label: string | null
  status: string
  duration_ms: number | null
  outcome: string | null
  /** First line of the error, ≤ 300 chars. */
  error: string | null
  progress: Record<string, unknown> | null
}

/** Returns the run as one sentence, or null to fall back to the generic reading. */
export type JobRunFormatter = (run: JobRunFacts) => string | null

/** One row a job passed over — the optional `skipped` list of the progress JSON (≤ 200). */
export interface JobRunSkip {
  id: string | number
  collection?: string | null
  reason?: string | null
}
