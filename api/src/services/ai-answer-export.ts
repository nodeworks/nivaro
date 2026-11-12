import { rowsFromToolResult } from './ai-conversations.js'
import { buildExportTable, type DateKind, type ExportTable } from './ai-export-table.js'
import { fieldInfoResolver } from './ai-field-info.js'
import { userTimeZone } from './user-time.js'

/**
 * The rows behind an Ask AI answer as the table its download writes (#1841).
 *
 * The rows are a tool result the caller just re-ran AS THEMSELVES — linked
 * records were opened and labelled through their own access, so nothing here
 * reads data. This only adds what makes the file readable: the fields' labels
 * as headers, which columns are timestamps (shown in the reader's time zone)
 * and which are dates kept as written.
 */

const AGGREGATE_WORDS: Record<string, string> = {
  sum: 'Sum of',
  avg: 'Average',
  min: 'Lowest',
  max: 'Highest'
}

export interface AnswerExport extends ExportTable {
  /** Every row that matches, when the tool said — more than `rows` means the file was cut. */
  total: number | null
}

export async function answerExportTable(
  user: { preferences?: unknown },
  tool: string,
  input: Record<string, unknown>,
  result: unknown
): Promise<AnswerExport> {
  const rows = rowsFromToolResult(result)
  const timeZone = await userTimeZone(user)
  const reported =
    result && typeof result === 'object' && !Array.isArray(result)
      ? (result as { total?: unknown }).total
      : null
  const total = typeof reported === 'number' ? reported : null

  const collection = typeof input.collection === 'string' ? input.collection : ''
  // Only a collection read has fields to name; other tools' columns are their own.
  if (!collection || (tool !== 'query_items' && tool !== 'aggregate')) {
    return { ...buildExportTable(rows, { timeZone }), total }
  }

  const fields =
    tool === 'query_items' && Array.isArray(input.fields) ? input.fields.map(String) : undefined
  const paths = new Set<string>()
  for (const f of fields ?? []) {
    paths.add(f)
    paths.add(f.split('.')[0])
  }
  for (const r of rows.slice(0, 200)) for (const k of Object.keys(r)) paths.add(k)
  const measured = tool === 'aggregate' && typeof input.field === 'string' ? input.field : null
  if (measured) paths.add(measured)

  const info = fieldInfoResolver(collection)
  const labels = new Map<string, string>()
  const kinds = new Map<string, DateKind>()
  await Promise.all(
    [...paths].map(async (p) => {
      const found = await info(p.split('.')).catch(() => null)
      if (found?.label) labels.set(p, found.label)
      if (found?.kind) kinds.set(p, found.kind)
    })
  )

  if (tool === 'aggregate') {
    // The figure's column says what it is: "Count", "Sum of Amount".
    const op = String(input.op ?? 'count')
    const of = measured ? (labels.get(measured) ?? null) : null
    const word = AGGREGATE_WORDS[op]
    labels.set('value', word && measured ? `${word} ${of ?? measured.replace(/_/g, ' ')}` : 'Count')
    // The lowest / highest of a date column is a date of the same kind.
    const kind = measured && (op === 'min' || op === 'max') ? kinds.get(measured) : undefined
    if (kind) kinds.set('value', kind)
  }

  const table = buildExportTable(rows, {
    fields,
    label: (p) => labels.get(p),
    kind: (p) => kinds.get(p),
    timeZone
  })
  return { ...table, total }
}
