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
