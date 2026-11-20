import { infoColumns, infoSelect } from '../db/dialect/users-ai-config.js'
import { db } from '../db/index.js'
import { getImportProcessor, runImportProcessor } from './import-processors.js'
import {
  parseServiceConfig,
  runServiceImport,
  type ServiceImportSummary
} from './staged-import-service.js'
import { parseStagingColumns, validateStagedRows } from './staged-import-validation.js'
import { type ImportDefinition, mapRowsToDeclaredAsync, rowKeysAsync } from './staged-imports.js'

/**
 * `POST /api/staged-imports/preview` — what the Import Console shows before a file is queued:
 * the first rows, the columns, the pre-flight validation and, for service-mode and processor
 * definitions, a dry run (what a run would create, update and skip, nothing written).
 *
 * This runs on a WEB process, so it never holds the event loop for long (EFP prod 2026-11-19,
 * build 0.3.193: the stall watchdog caught a preview of a 30 MB file blocking a web process for
 * 3.7 s in one piece — every other request there waited). The file is read on a worker thread
 * (parseImportFileAsync, in the route); every pass over the rows here yields as it goes
 * (rowKeysAsync, mapRowsToDeclaredAsync, the paced validation and table-import loops); and the
 * answer carries only what the dialog reads — a dry run's per-record lists (`matched`, `items`,
 * `affected`, `report`) could name every row of the file.
 */

/** Rows the dialog shows. */
export const PREVIEW_ROWS = 20

/** The part of a dry run the dialog reads (packages/shared imports/types.ts ImportDryRun). */
export type PreviewDryRun = Pick<
  ServiceImportSummary,
  'created' | 'updated' | 'removed' | 'unchanged' | 'skipped' | 'failed' | 'log' | 'samples'
>

export interface StagedImportPreview {
  row_count: number
  columns: string[]
  rows: Array<Record<string, string>>
  file_name: string
  staging_table: string | null
  staging_columns: string[] | null
  unknown_columns: string[]
  missing_columns: string[]
  validation: Awaited<ReturnType<typeof validateStagedRows>>
  dry_run: PreviewDryRun | null
}

/** A dry run's answer without its per-record lists. */
export function previewDryRun(r: PreviewDryRun): PreviewDryRun {
  return {
    created: r.created,
    updated: r.updated,
    ...(r.removed != null ? { removed: r.removed } : {}),
    unchanged: r.unchanged,
    skipped: r.skipped,
    failed: r.failed,
    log: r.log,
    ...(r.samples ? { samples: r.samples } : {})
  }
}

const failedDryRun = (err: unknown): PreviewDryRun => ({
  created: 0,
  updated: 0,
  unchanged: 0,
  skipped: {},
  failed: 1,
  log: `Dry run failed: ${(err as Error).message}`
})

export async function buildStagedImportPreview(opts: {
  definition: ImportDefinition | null
  rows: Array<Record<string, string>>
  fileName: string
  userId: string | null
}): Promise<StagedImportPreview> {
  const { definition, rows, fileName, userId } = opts
  const columns = (await rowKeysAsync(rows)).filter((c) => c !== 'id')

  // The staging table may not exist yet — the worker creates it on first run,
  // which is a valid state, not a problem to report.
  let stagingColumns: string[] | null = null
  const table = definition?.staging_table || (definition ? `staging_${definition.key}` : null)
  if (table && /^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
    const existing = (
      (await infoColumns(db)
        .where('table_name', table)
        .select(infoSelect(db, 'column_name'))) as Array<{ column_name: string }>
    ).map((r) => r.column_name)
    if (existing.length > 0) stagingColumns = existing.filter((c) => c !== 'id')
  }

  // Pre-flight validation: file-keyed checks (duplicates, required, numeric,
  // declared-schema coverage) plus target/lookup checks against live tables.
  // The procedure never runs; a definition with no config reports clean.
  const validation = definition
    ? await validateStagedRows(definition, rows)
    : { errors: [], warnings: [], stats: {}, truncated: false }

  // Service-mode definitions can say EXACTLY what a run would do — the same
  // code path as the worker with nothing written: creates, field-level
  // updates, unchanged, and every skipped row with the reason that dropped it.
  // A registered processor answers the same question for files that span
  // several collections.
  let dryRun: PreviewDryRun | null = null
  const serviceConfig =
    definition?.processor === 'service' ? parseServiceConfig(definition.service_config) : null
  const processor = getImportProcessor(definition?.processor)
  if (definition && (serviceConfig || processor)) {
    let mapped: Array<Record<string, string>> | null = null
    try {
      mapped = await mapRowsToDeclaredAsync(definition, rows)
      if (serviceConfig) {
        dryRun = previewDryRun(
          await runServiceImport({
            config: serviceConfig,
            rows: mapped,
            createdBy: userId,
            dryRun: true
          })
        )
      }
    } catch (err) {
      dryRun = failedDryRun(err)
    }
    if (processor && mapped) {
      try {
        dryRun = previewDryRun(
          await runImportProcessor({
            processor,
            definition,
            rows: mapped,
            createdBy: userId,
            dryRun: true
          })
        )
      } catch (err) {
        dryRun = failedDryRun(err)
      }
    }
  }

  // A declared schema decides which columns load, and the validation report
  // above already names what the file lacks or carries beyond it. Comparing
  // the file with the physical staging table as well would report columns
  // nothing reads (left there by older files) as missing.
  const declaredSchema = definition ? parseStagingColumns(definition.staging_columns) : null
  const compareWithTable = !!stagingColumns && !declaredSchema
  const stagingSet = new Set(stagingColumns ?? [])
  const columnSet = new Set(columns)

  return {
    row_count: rows.length,
    columns,
    rows: rows.slice(0, PREVIEW_ROWS),
    file_name: fileName,
    staging_table: table,
    staging_columns: stagingColumns,
    unknown_columns: compareWithTable ? columns.filter((c) => !stagingSet.has(c)) : [],
    missing_columns:
      compareWithTable && stagingColumns ? stagingColumns.filter((c) => !columnSet.has(c)) : [],
    validation,
    dry_run: dryRun
  }
}
