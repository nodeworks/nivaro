/** Hub config promotion (idea 30): shared types and the one error class. */

export class ConfigPromotionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
    readonly extra: Record<string, unknown> = {}
  ) {
    super(message)
  }
}

export const PROMOTIONS = 'nivaro_hub_config_promotions'

export type ConfigPromotionStatus =
  | 'planned'
  | 'applying'
  | 'applied'
  | 'failed'
  | 'stale'
  | 'superseded'
  | 'undoing'
  | 'undone'
  | 'interrupted'

export interface FieldChange {
  field: string
  /** The target's value now (null for a row the promotion inserts). */
  current: unknown
  /** The value the promotion writes (null for a row it deletes). */
  incoming: unknown
}

export interface RowChange {
  key: string
  op: 'insert' | 'update' | 'delete'
  label: string | null
  fields: FieldChange[]
}

export interface TableChange {
  table: string
  group: string | null
  inserts: number
  updates: number
  deletes: number
  unchanged: number
  /** Rows planned past the ones listed. */
  more: number
  rows: RowChange[]
  dropped_columns: string[]
}

/** A plan as the Hub stores and shows it (values capped and secret-masked by the app). */
export interface PlanView {
  totals: { inserts: number; updates: number; deletes: number; tables: number }
  skipped_inactive_user: number
  tables: TableChange[]
  refused: Array<{ table: string; reason: string }>
  kept: Array<{ table: string; label: string; columns: string[] }>
  held: Array<{ table: string; key: string; label: string | null; reason: string }>
  switched_off: Array<{ table: string; key: string; label: string | null }>
  cascade: Array<{ table: string; child: string; column: string; action: string; rows: number }>
  over_cap: boolean
  cap: number
  warnings: string[]
  /** Changed here, not from promotion, that the write would overwrite (the target's guard). */
  prod_only: { count: number; lines: string[]; refuse: boolean }
  /** Steps (or flows) that need this environment's own values; their flows arrive switched off. */
  needs_setup: Array<{ flow: string | null; step: string | null; reason: string }>
  /** Steps of a promoted flow the source no longer has: removed with it whatever the removal
   *  setting; an undo puts them back. */
  orphans: Array<{ key: string; flow: string; label: string | null }>
  /** Shown before removals: likely renames (same steps, new name). */
  flags: Array<{
    code: 'RENAME_SUSPECTED'
    table: string
    key: string
    label: string | null
    reason: string
  }>
  /** Per step: the outbound / secret option paths the source took off (they stay as set here). */
  stripped_steps: Array<{ key: string; label: string | null; paths: string[] }>
  /** What the target binds the apply to (its engine plan and its procedure plan). */
  hashes: { engine: string; procs: string }
}

export interface ConfigPromotion {
  id: number
  app_id: number
  source_environment_id: number
  target_environment_id: number
  status: ConfigPromotionStatus
  groups: string[]
  tables: string[]
  deletes: boolean
  allow_cascade: boolean
  production: boolean
  plan_hash: string | null
  plan: PlanView | null
  result: Record<string, unknown> | null
  pre_restore_id: number | null
  /** The promotion's key at the target app (idempotency, lost-answer check, undo). */
  run_key: string | null
  /** The Hub's own heartbeat while a server works this promotion (apply, wait, undo). */
  heartbeat_at: string | null
  /** Applied and the newest applied promotion of its target: the one that may be undone. */
  undo_ready: boolean
  undo_result: Record<string, unknown> | null
  source_version: string | null
  target_version: string | null
  error: string | null
  planned_by: string | null
  applied_by: string | null
  undone_by: string | null
  planned_at: string | null
  started_at: string | null
  applied_at: string | null
  undone_at: string | null
}
