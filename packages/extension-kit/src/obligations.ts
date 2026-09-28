import type { Knex } from 'knex'

export type ObligationOutcome =
  | 'sent'
  | 'skipped'
  | 'failed'
  | 'pending'
  | 'overdue'
  | 'missing'
  | 'superseded'

export type ObligationTrigger = 'transition' | 'hook' | 'flow' | 'cron' | 'reconcile' | 'manual'

/** The decision point at which a partner starts expecting a message. */
export interface ObligationTriggerContext {
  collection: string
  item: string
  api: string
  source: 'erp_submit' | 'flow' | 'hook' | 'cron' | 'manual'
  endpoint_path?: string | null
  transition_label?: string | null
  to_state_key?: string | null
  flow_name?: string | null
  /** The action's own declared shape — its context-query keys and skip
   *  gates. Two actions on one endpoint are told apart by this. */
  action_context_keys?: string[]
  action_skip_unless_any?: string[]
  action_skip_when_empty?: string | null
}

export interface ExpectedObligation {
  item: string
  due_at: Date
  signature?: string | null
  detail?: string | null
}

export interface ObligationResolvePatch {
  outcome: ObligationOutcome
  reason?: string | null
  submission_id?: number | null
  signature?: string | null
  resolved_by?: string | null
  detail?: unknown
}

/** An outbound obligation kind: what the partner expects, how a decision
 *  point is attributed to it, and how to derive from DATA the records the
 *  partner is currently behind on. Core owns the ledger and the sweep; the
 *  extension owns the sends. */
export interface ObligationKindDef {
  api: string
  kind: string
  collection: string
  label: string
  /** Minutes after due_at before the sweep calls an unmet expectation
   *  overdue. Falls back to the API's skip_grace_minutes. */
  grace_minutes?: number
  matches?(ctx: ObligationTriggerContext): boolean
  /** Records the partner is BEHIND on, derived from data alone. A returned
   *  row means "the partner does not have this", never "this happened". A
   *  kind's own WHERE must exclude anything whose relevant moment predates
   *  `epoch`, or the first sweep floods `missing`. */
  expect(database: Knex, opts: { epoch: Date }): Promise<ExpectedObligation[]>
  /** May the sweep re-fire a `missing` row by itself? Opt-in: only ever
   *  correct for a kind whose stored body cannot go stale. */
  safe_to_refire?: boolean
  /** The send is a person's to make (a button on the record), never the
   *  sweep's. */
  human?: boolean
  /** The kind's "record" is not a business record (an API log bucket). */
  inbound?: boolean
  /** The endpoint this kind's send goes to, as stored on the submission.
   *  Required before the sweep may re-fire anything. */
  endpoint_path?: string | null
}
