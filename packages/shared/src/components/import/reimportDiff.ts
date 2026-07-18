export interface ReimportLineDiff {
  creates: Record<string, unknown>[]
  updates: { id: string; changes: Record<string, unknown> }[]
  deletes: string[]
  matchedUnchanged: number
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

function matchKey(row: Record<string, unknown>, matchBy: string[]): string {
  return matchBy.map((col) => normalize(row[col])).join('\x00')
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
