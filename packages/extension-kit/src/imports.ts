import type { Knex } from 'knex'

export type ImportRunItemKind = 'created' | 'updated' | 'removed' | 'skipped' | 'failed'

export interface ImportRunChange {
  field: string
  from: unknown
  to: unknown
}

export interface ImportRunItem {
  kind: ImportRunItemKind
  collection?: string | null
  item_id?: string | number | null
  /** How a person names the record or the file row. */
  label: string
  /** 1-based row in the file, header excluded. */
  row?: number | null
  /** Why it was left out, or what went wrong. */
  message?: string | null
  changes?: ImportRunChange[]
}

export interface ImportRunPhase {
  key: string
  label: string
  ms: number
  /** Rows or records the phase handled. */
  count?: number
  failed?: number
}

export interface ImportRunUnmatched {
  column: string
  /** 'vendor', 'purchase order key' — as a person says it. */
  label: string
  /** Distinct values, first 50. */
  values: string[]
  distinct: number
  /** File rows that carry one of them. */
  rows: number
  /** What the import did about it. */
  effect: string
}

export interface ImportSampleChange {
  field: string
  from: unknown
  to: unknown
}

/** What a dry run would do, with enough rows to explain itself. */
export interface ImportSamples {
  /** First file row per natural key that would be created (payload). */
  creates: Array<{ key: string; values: Record<string, unknown> }>
  /** Existing rows that would change, field by field. */
  updates: Array<{ key: string; id: unknown; changes: ImportSampleChange[] }>
  /** Rows dropped before writing — the file row number (1-based, header
   *  excluded), the natural key when it could be built, and the reason. */
  skipped_rows: Array<{ row: number; key: string | null; reason: string }>
  /** Lookup values with no match that a real run would stub-create. */
  would_create_lookups: Array<{ column: string; collection: string; values: string[] }>
}

export interface ImportProcessorResult {
  created: number
  updated: number
  unchanged: number
  /** Rows dropped before writing, with per-reason counts. */
  skipped: Record<string, number>
  failed: number
  /** First line is the summary the run list shows; the rest is detail. */
  log: string
  /** Present on a dry run. */
  samples?: ImportSamples
  /** Records the run changed, per collection — handed to the post-run flows. */
  affected?: Record<string, Array<string | number>>
  /** What the run did, for the run's detail view. */
  report?: {
    phases?: ImportRunPhase[]
    unmatched?: ImportRunUnmatched[]
    notes?: string[]
    other?: Array<{ label: string; count: number }>
  }
  /** One entry per record created or changed and per file row left out. */
  items?: ImportRunItem[]
}

export interface ImportWriteOutcome {
  done: number
  failed: number
  /** First few failure messages, already prefixed with the job's label. */
  failures: string[]
  ms: number
}

export interface ImportWriteJob {
  /** Names the row in a failure message ('line 102-300001123 / 2'). */
  label: string
  run: () => Promise<void>
}

/** The only way a processor writes: through the items service, as the
 *  person who queued the file. Every write tool throws on a dry run. */
export interface ImportProcessorTools {
  /** Read access for batched lookups. Writes go through create / update / remove. */
  db: Knex
  /** value → id for one reference column, matched case-insensitively; when a
   *  value matches several rows the lowest id wins. */
  lookup(table: string, column: string, values: Iterable<string>): Promise<Map<string, unknown>>
  /** Run `fn` over `values` in chunks small enough for one statement. */
  inChunks<T>(values: unknown[], fn: (chunk: unknown[]) => Promise<T[]>): Promise<T[]>
  create(collection: string, body: Record<string, unknown>): Promise<unknown>
  update(collection: string, id: string | number, patch: Record<string, unknown>): Promise<void>
  remove(collection: string, id: string | number): Promise<void>
  /** Run write jobs several at a time. A failed job never stops the others. */
  runWrites(jobs: ImportWriteJob[], opts?: { width?: number }): Promise<ImportWriteOutcome>
  /** Recompute every stored rollup on these records, once each. */
  recalcStoredRollups(collection: string, ids: Array<string | number>): Promise<number>
  /** EXEC a stored procedure on its own long-running request. Returns ms. */
  runProcedure(name: string): Promise<number>
}

export interface ImportProcessorInput {
  definition: { key: string; label: string | null; config: Record<string, unknown> }
  /** Parsed + header-mapped rows, staging column names as keys. */
  rows: Array<Record<string, string>>
  /** Classify and report only — every write tool refuses. */
  dryRun: boolean
  sampleLimit: number
  tools: ImportProcessorTools
  /** Rows classified so far, for the run's progress bar. */
  progress(done: number, total: number): void
}

/** A processor for staged imports whose file spans several collections. */
export interface ImportProcessorDef {
  /** `<extension>:<name>` — what `nivaro_import_definitions.processor` holds. */
  key: string
  label: string
  description?: string
  run(input: ImportProcessorInput): Promise<ImportProcessorResult>
}
