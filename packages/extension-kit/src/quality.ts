import type { Knex } from 'knex'

/** One comparable value. Numbers compare with the check's tolerance; null and '' are equal. */
export type QualityValue = string | number | boolean | null

export interface QualityRow {
  /** Stable identity, e.g. 'workflow:371367' or 'forecast:371367:2026'. */
  key: string
  /** Human label for the key, e.g. 'CM26-79811'. Optional. */
  label?: string
  values: Record<string, QualityValue>
  /** Grouping dimensions for mismatch clusters, e.g. { state: 'Waiting on PO', zone: 'Zone 1' }. */
  cluster?: Record<string, string>
  /** Facts carried for expected()/explain(): stored with the row, never compared and never grouped. */
  context?: Record<string, string>
}

export interface QualityCheckContext {
  /** Knex bound to the database being checked (the rebuilt copy). */
  db: Knex
  /** That database's name. */
  database: string
  log(message: string): void
}

export interface QualityCheck {
  id: string // /^[a-z][a-z0-9_.-]{1,80}$/
  area: string // owners | states | forecasts | lines | po | people | history | counts | budget
  label: string
  description: string
  /** ms; default 180_000. */
  budgetMs?: number
  /** Legacy shape, run on the fresh clone before migrations. */
  baseline(ctx: QualityCheckContext): Promise<QualityRow[]>
  /** Converted shape, run after the conversions. A LIST check returns [] from
   *  baseline(): every current row is then a finding (shown red unless expected). */
  current(ctx: QualityCheckContext): Promise<QualityRow[]>
  /** Numeric tolerance; absent = exact (after rounding to 4 decimals). */
  tolerance?: { abs?: number; pct?: number }
  /** A built-in known difference: return the reason when this mismatch is expected. */
  expected?(base: QualityRow | null, cur: QualityRow | null, fields: string[]): string | null
  /** Plain sentence for an unexpected mismatch. */
  explain?(base: QualityRow | null, cur: QualityRow | null, fields: string[]): string | null
  /** Link to the record in legacy production Directus (absolute URL) or undefined. */
  legacyLink?(key: string): string | undefined
}

/** What an extension module named by `quality_checks` exports. */
export interface QualityCheckModule {
  default?: QualityCheck[]
  qualityChecks?: QualityCheck[]
}
