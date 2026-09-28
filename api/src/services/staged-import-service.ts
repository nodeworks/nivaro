import type { ImportRunItem, ImportRunPhase, ImportRunUnmatched } from './import-run-report.js'
import { parseTableConfig, runTableImport, type TableImportConfig } from './table-import.js'

/**
 * Service-mode processor for staged imports.
 *
 * The stored-procedure path MERGEs staging rows straight into the target table
 * — raw SQL, so no revisions, no activity, no field rules, no hooks. This
 * processor takes the same parsed + header-mapped rows and instead:
 *
 *   1. batch-resolves lookup columns (warehouse name → id, part number → id),
 *   2. builds one target payload per file row (derived month, type coercion),
 *   3. dedupes last-wins on the natural key,
 *   4. DIFFS against the existing rows and only writes real changes —
 *      `updateOne` for changed rows, `createOne` for new ones,
 *
 * so every write goes through the full items service (revisions, activity,
 * rules, validation, computed fields) and an unchanged re-import writes
 * nothing at all. Rows a procedure would have silently dropped (unresolvable
 * lookup) are counted and reported instead.
 *
 * Config lives on the definition row as `service_config` JSON. The keys below
 * are the ones every service-mode definition has used from the start; the
 * importer itself is `table-import.ts`, whose configuration adds links to
 * many, computed values, set-based writes and follow-up procedures.
 */

export interface ServiceColumnConfig {
  /** Target collection field this staging column maps to. */
  field: string
  /** Coercion applied before diff/write; default 'string'. Empty string → null. */
  type?: 'string' | 'number' | 'int' | 'date' | 'datetime' | 'boolean'
  /** Resolve the file value to a related row's id. Duplicate match values
   *  collapse to the LOWEST id (the legacy procs' MIN(id) convention).
   *  on_missing 'create' inserts a stub row ({match_field: value}) through
   *  the items service for every unmatched value; 'null' keeps the file row
   *  with an empty link (the procs' LEFT JOIN semantics). Default (absent)
   *  drops the row — the original warehouse-import behavior. */
  lookup?: {
    collection: string
    /** Column the file value is matched against (case-insensitive). */
    match_field?: string
    /** Match the file value against the collection's DISPLAY LABEL instead —
     *  for targets with no single name column (categories render as
     *  "Core -> Sub"). Whole collection labelled once, cap 5,000 rows;
     *  separators/punctuation are normalized so "ISP Power - Materials" and
     *  "ISP Power -> Materials" both hit. on_missing 'create' is not
     *  possible for label matches (there is no column to write). */
    match_label?: boolean
    on_missing?: 'create' | 'null'
  }
}

export interface ServiceImportConfig {
  collection: string
  /** Target fields forming the natural key rows are matched on. */
  match_by: string[]
  /** Staging column name → target mapping. */
  columns: Record<string, ServiceColumnConfig>
  /** Derived calendar-month date field built from two numeric file columns
   *  (year 2000–2100, month 1–12; out-of-range rows are skipped+counted). */
  month_from?: { field: string; year_column: string; month_column: string }
  /** Target fields that must be non-null after coercion or the row is
   *  skipped (the procs' `qty IS NOT NULL` filter). */
  require_value?: string[]
  /** Audit stamp columns on the target table (legacy Directus convention —
   *  the items service does not stamp these itself). */
  timestamps?: { create?: string; update?: string }
  /** Never create: a file row whose natural key matches nothing is skipped
   *  and counted ("no existing … match") — for sheets that annotate a
   *  reference table (project-type defaults), where a typo must not mint a
   *  new project type. */
  update_only?: boolean
}

export interface ServiceImportSampleChange {
  field: string
  from: unknown
  to: unknown
}

/** What a dry run would do, with enough rows to explain itself. */
export interface ServiceImportSamples {
  /** First file row per natural key that would be created (payload). */
  creates: Array<{ key: string; values: Record<string, unknown> }>
  /** Existing rows that would change, field by field. */
  updates: Array<{ key: string; id: unknown; changes: ServiceImportSampleChange[] }>
  /** Rows dropped before writing — the file row number (1-based, header
   *  excluded), the natural key when it could be built, and the reason. */
  skipped_rows: Array<{ row: number; key: string | null; reason: string }>
  /** Lookup values with no match that a real run would stub-create. */
  would_create_lookups: Array<{ column: string; collection: string; values: string[] }>
}

export interface ServiceImportSummary {
  created: number
  updated: number
  /** Records a `mode: 'remove'` run removed. */
  removed?: number
  unchanged: number
  /** Rows dropped before writing, with per-reason counts. */
  skipped: Record<string, number>
  /** Present on a dry run only. */
  samples?: ServiceImportSamples
  failed: number
  log: string
  /** Records the run changed, per collection. */
  affected?: Record<string, Array<string | number>>
  /** Every stored record the file named, changed or not, per collection. */
  matched?: Record<string, Array<string | number>>
  /** Where the time went, which values matched nothing, what else to know. */
  report?: {
    phases: ImportRunPhase[]
    unmatched: ImportRunUnmatched[]
    notes: string[]
    other: Array<{ label: string; count: number }>
  }
  /** One entry per record created or changed and per file row left out. */
  items?: ImportRunItem[]
}

export function parseServiceConfig(raw: unknown): TableImportConfig | null {
  return parseTableConfig(raw)
}

export interface RunServiceImportOptions {
  config: TableImportConfig
  /** Parsed + header-mapped rows (staging column names as keys). */
  rows: Array<Record<string, string>>
  createdBy: string | null
  onProgress?: (written: number, total: number) => void | Promise<void>
  /** Classify every row and diff against existing data, write NOTHING —
   *  the Import Console's preview. Lookup stubs are reported, not created. */
  dryRun?: boolean
  /** Sample rows kept per bucket on a dry run (default 25). */
  sampleLimit?: number
  /** Change reason stamped on every create/update (#60 — the record's Notes
   *  thread lists the runs that touched it): `import:<label>:run-<id>`. */
  stamp?: string | null
}

export async function runServiceImport(
  opts: RunServiceImportOptions
): Promise<ServiceImportSummary> {
  return runTableImport(opts)
}
