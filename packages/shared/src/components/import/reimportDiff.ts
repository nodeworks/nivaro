export interface ReimportLineDiff {
  creates: Record<string, unknown>[]
  updates: { id: string; changes: Record<string, unknown> }[]
  deletes: string[]
  matchedUnchanged: number
  /** The review dialog already ran the grid's row rules over `creates`. */
  rulesEvaluated?: boolean
  /** Per field: how many new lines a rule wrote it on (vs the file). */
  ruleFields?: Record<string, number>
}

const O2M_PREFIX = '__o2m_'

function normalize(v: unknown): string {
  return String(v ?? '').trim()
}

function valuesEqual(a: unknown, b: unknown): boolean {
  const normA = normalize(a)
  const normB = normalize(b)
  if (normA !== '' && normB !== '') {
    const numA = Number(normA)
    const numB = Number(normB)
    if (Number.isFinite(numA) && Number.isFinite(numB)) {
      return numA === numB
    }
  }
  return normA === normB
}

// Canonicalizes a match-key component so numeric-format drift between the file
// and the DB (e.g. '26.0' vs 26) doesn't defeat matching — an unmatched numeric
// key would otherwise degenerate upsert_delete into delete+create, destroying
// the existing line's id.
function normalizeMatchComponent(v: unknown): string {
  const trimmed = normalize(v)
  if (trimmed !== '') {
    const num = Number(trimmed)
    if (Number.isFinite(num)) return String(num)
  }
  return trimmed
}

function matchKey(row: Record<string, unknown>, matchBy: string[]): string {
  return matchBy.map((col) => normalizeMatchComponent(row[col])).join('\x00')
}

/** The match key a file row or an existing line is paired by — the one
 *  normalization, shared with the form's nested-payload re-association. */
export const reimportMatchKey = matchKey

/**
 * Lines the person removed on the form (staged, not saved) that the file
 * still lists. On apply the file wins: the removal is taken back and the
 * line is updated in place — otherwise the same line would be both queued
 * for delete and queued for an edit, and the save would PATCH a row it had
 * just deleted (army 10 item 3: remove a material line, then BOM Re-Upload).
 */
export function reimportRestoredDeletes(
  fileRows: Record<string, unknown>[],
  existingRows: Record<string, unknown>[],
  matchBy: string[],
  pendingDeletes: ReadonlySet<string>
): string[] {
  if (pendingDeletes.size === 0 || matchBy.length === 0) return []
  const fileKeys = new Set(fileRows.map((row) => matchKey(row, matchBy)))
  const restored: string[] = []
  for (const row of existingRows) {
    const id = String(row.id)
    if (!pendingDeletes.has(id)) continue
    if (fileKeys.has(matchKey(row, matchBy))) restored.push(id)
  }
  return restored
}

/**
 * What the review dialog says when the record already has unsaved work. The
 * form used to ask this through a native `window.confirm` — a modal the
 * browser blocks the page on, which an automated tab (and some embedded
 * hosts) can never answer, so the tab looked frozen for good. The review
 * dialog is the confirmation; this is its one extra line. Null = nothing to say.
 */
export function reimportPendingNotice(input: {
  headerDirty: boolean
  pendingRows: number
  pendingEdits: number
  pendingDeletes: number
  restored: number
}): string | null {
  const { headerDirty, pendingRows, pendingEdits, pendingDeletes, restored } = input
  const hasWork = headerDirty || pendingRows > 0 || pendingEdits > 0 || pendingDeletes > 0
  if (!hasWork) return null
  const parts = ['Your unsaved changes on this record stay in place; the file is applied on top.']
  if (restored > 0) {
    parts.push(
      restored === 1
        ? 'One line you removed is still in the file, so it comes back.'
        : `${restored} lines you removed are still in the file, so they come back.`
    )
  }
  return parts.join(' ')
}

export function diffReimportLines(
  fileRows: Record<string, unknown>[],
  existingRows: Record<string, unknown>[],
  cfg: { lines: 'replace' | 'upsert' | 'upsert_delete' | 'append'; match_by: string[] }
): ReimportLineDiff {
  if (cfg.lines === 'replace') {
    return {
      creates: fileRows.map((row) => ({ ...row })),
      updates: [],
      deletes: existingRows.map((row) => String(row.id)),
      matchedUnchanged: 0
    }
  }

  if (cfg.lines === 'append') {
    return {
      creates: fileRows.map((row) => ({ ...row })),
      updates: [],
      deletes: [],
      matchedUnchanged: 0
    }
  }

  const existingByKey = new Map<string, Record<string, unknown>>()
  for (const row of existingRows) {
    const key = matchKey(row, cfg.match_by)
    if (existingByKey.has(key)) {
      throw new Error(`Duplicate match key among existing lines: ${key}`)
    }
    existingByKey.set(key, row)
  }

  const seenFileKeys = new Set<string>()
  const matchedExistingIds = new Set<string>()
  const creates: Record<string, unknown>[] = []
  const updates: { id: string; changes: Record<string, unknown> }[] = []
  let matchedUnchanged = 0

  for (const fileRow of fileRows) {
    const key = matchKey(fileRow, cfg.match_by)
    if (seenFileKeys.has(key)) {
      throw new Error(`Duplicate match key: ${key}`)
    }
    seenFileKeys.add(key)

    const existingRow = existingByKey.get(key)
    if (!existingRow) {
      creates.push({ ...fileRow })
      continue
    }

    const id = String(existingRow.id)
    matchedExistingIds.add(id)

    const changes: Record<string, unknown> = {}
    for (const [col, value] of Object.entries(fileRow)) {
      if (col.startsWith(O2M_PREFIX)) continue
      if (!valuesEqual(value, existingRow[col])) {
        changes[col] = value
      }
    }

    if (Object.keys(changes).length > 0) {
      updates.push({ id, changes })
    } else {
      matchedUnchanged += 1
    }
  }

  const deletes: string[] =
    cfg.lines === 'upsert_delete'
      ? existingRows.map((row) => String(row.id)).filter((id) => !matchedExistingIds.has(id))
      : []

  return { creates, updates, deletes, matchedUnchanged }
}
