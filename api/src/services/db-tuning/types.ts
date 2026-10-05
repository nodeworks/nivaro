export const TUNING_KINDS = [
  'index_create',
  'index_drop',
  'proc_rewrite',
  'rollup_store',
  'query_cache'
] as const
export type TuningKind = (typeof TUNING_KINDS)[number]

export const TUNING_STATUSES = [
  'proposed',
  'rejected_by_proof',
  'stale',
  'applying',
  'watching',
  'applied',
  'rolled_back',
  'dismissed',
  'failed'
] as const
export type TuningStatus = (typeof TUNING_STATUSES)[number]
/** Statuses the nightly run may update in place (evidence, proof, estimate). */
export const OPEN_STATUSES: readonly TuningStatus[] = ['proposed', 'stale', 'rejected_by_proof']

export type TuningRisk = 'reversible' | 'review'

/** The exact change Apply runs, or Undo reverses. Built from catalog names only. */
export type ApplySpec =
  | { type: 'sql'; statements: string[] }
  | { type: 'proc_body'; proc: string; body: string; hash: string }
  | { type: 'field_patch'; collection: string; field: string; patch: { computed_store: boolean } }
  | {
      type: 'query_patch'
      id: number
      slug: string
      patch: { cache_ttl: number; warm_daily: boolean }
    }

export interface Candidate {
  kind: TuningKind
  target: string
  /** Part of the fingerprint beside kind+target: index columns, new body hash, config patch. */
  change_key: string
  title: string
  evidence: Record<string, unknown>
  estimate_ms_per_day: number
  risk: TuningRisk
  apply: ApplySpec
  undo: ApplySpec
  replicated?: boolean
  dialect_note?: string | null
}

export interface WatchSample {
  at: string
  value: number | null
}

export type ProofMethod =
  | 'hypothetical'
  | 'dmv-estimate'
  | 'usage-stats'
  | 'twin'
  | 'cost-model'
  | 'freshness'
  | 'refused'

export interface ProofResult {
  passed: boolean
  method: ProofMethod
  before: Record<string, number | string | null>
  after: Record<string, number | string | null>
  detail: string
  rows_diff?: Array<{ set: number; added: string[]; removed: string[] }>
  watch?: WatchSample[]
}

/** A `refused` proof whose detail starts with this failed on an error, not on policy. */
export const PROOF_ERROR_PREFIX = 'error: '

/** The proof could not run (a catalog or evidence read threw) — it judged nothing. */
export const isErrorRefusal = (p: Pick<ProofResult, 'method' | 'detail'>): boolean =>
  p.method === 'refused' && p.detail.startsWith(PROOF_ERROR_PREFIX)

export interface ProposalRow {
  id: string
  kind: TuningKind
  target: string
  fingerprint: string
  status: TuningStatus
  title: string
  evidence: Record<string, unknown>
  proof: ProofResult | null
  estimate_ms_per_day: number
  risk: TuningRisk
  replicated: boolean
  dialect_note: string | null
  apply: ApplySpec
  undo: ApplySpec
  applied_at: string | null
  applied_by: string | null
  watch_until: string | null
  watch_baseline: {
    before: Record<string, number | null>
    after: Record<string, number | null>
  } | null
  rolled_back_at: string | null
  rollback_reason: string | null
  dismissed_at: string | null
  dismissed_by: string | null
  dismiss_note: string | null
  first_seen: string
  last_seen: string
  run_id: number | null
}

export const KIND_RISK: Record<TuningKind, TuningRisk> = {
  index_create: 'reversible',
  index_drop: 'reversible',
  proc_rewrite: 'review',
  rollup_store: 'reversible',
  query_cache: 'reversible'
}

export const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
