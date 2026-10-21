import { db } from '../db/index.js'
import { getTenantId } from '../db/tenant-context.js'
import { sharedGatedRead } from './read-gate.js'

/**
 * How full each column of a collection is (#2588): the Table Editor's Field
 * usage card and the layout editor's "filled on N%" hints read the same
 * numbers. One COUNT(col) scan per 60 columns, so the answer is cached per
 * tenant for five minutes and computed under the heavy-read gate (one flight
 * per table: two editors opening at once share it).
 */

export interface FieldUsage {
  total: number
  fields: Array<{ field: string; populated: number; pct: number }>
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const TTL_MS = 5 * 60_000
const cache = new Map<string, { at: number; value: FieldUsage }>()

export function isUsageTable(table: string): boolean {
  return IDENT.test(table) && !/^nivaro_|^directus_/i.test(table)
}

/** null = no such table. */
export async function computeFieldUsage(table: string): Promise<FieldUsage | null> {
  const cols = (
    (await db.raw(`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ?`, [
      table
    ])) as Array<{ COLUMN_NAME: string }>
  )
    .map((c) => c.COLUMN_NAME)
    .filter((c) => IDENT.test(c))
  if (cols.length === 0) return null
  const usage: Array<{ field: string; populated: number }> = []
  let total = 0
  for (let i = 0; i < cols.length; i += 60) {
    const chunk = cols.slice(i, i + 60)
    const exprs = chunk.map((c) => `COUNT([${c}]) AS [${c}]`).join(', ')
    const rows = (await db.raw(`SELECT COUNT(*) AS __total, ${exprs} FROM [${table}]`)) as Array<
      Record<string, number>
    >
    const row = rows[0] ?? {}
    total = Number(row.__total ?? 0)
    for (const c of chunk) usage.push({ field: c, populated: Number(row[c] ?? 0) })
  }
  return {
    total,
    fields: usage
      .map((u) => ({
        ...u,
        pct: total > 0 ? Math.round((u.populated / total) * 1000) / 10 : 0
      }))
      .sort((a, b) => a.pct - b.pct)
  }
}

/** computeFieldUsage, cached 5 min per tenant and table, under the read gate. */
export async function cachedFieldUsage(
  table: string,
  who: string | null | undefined,
  opts: { fresh?: boolean } = {}
): Promise<FieldUsage | null> {
  const key = `${getTenantId() ?? ''}|${table}`
  const hit = cache.get(key)
  if (!opts.fresh && hit && Date.now() - hit.at < TTL_MS) return hit.value
  const { value } = await sharedGatedRead(`field-usage|${table}`, who, () =>
    computeFieldUsage(table)
  )
  if (value) {
    cache.set(key, { at: Date.now(), value })
    if (cache.size > 500) cache.delete(cache.keys().next().value as string)
  }
  return value
}
