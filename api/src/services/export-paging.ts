/**
 * Export paging (fix round 1). An export reads LIST_READ_MAX rows per read. Its default order is
 * `id` alone, and then it pages by KEYSET — the next page is `id > <last id of this page>` —
 * instead of OFFSET: an OFFSET read skips every earlier row again (quadratic over a 230k-row
 * export) and skips or repeats rows when rows are inserted or deleted while it runs. Any other
 * sort, a projection without `id`, or a non-numeric id keeps OFFSET paging.
 *
 * Fix round 2: keyset only where it is exact — a real table (not a view / virtual collection,
 * whose "id" may repeat) whose primary key is the single integer column `id` (`keysetEligible`).
 * Digits in an nvarchar id sort as text but `_gt` would compare them as numbers: OFFSET there.
 */

const INTEGER_TYPES = new Set(['int', 'bigint', 'smallint', 'tinyint'])
const eligibleCache = new Map<string, { at: number; ok: boolean }>()

/**
 * Is `collection` a base table whose primary key is exactly one integer column named `id`?
 * Read from the catalog (SQL Server: sys.indexes / sys.columns through OBJECT_ID, which resolves
 * a bare name like the server does), cached 5 minutes per tenant + collection. Anything it
 * cannot tell (another dialect, an error) answers false: OFFSET is always correct.
 */
export async function keysetEligible(collection: string): Promise<boolean> {
  const { currentTenantKey } = await import('./tenant-rooms.js')
  const key = `${currentTenantKey() || '-'}:${collection}`
  const hit = eligibleCache.get(key)
  if (hit && Date.now() - hit.at < 300_000) return hit.ok
  let ok = false
  try {
    const { db } = await import('../db/index.js')
    const { isMssql } = await import('../db/dialect.js')
    if (isMssql(db)) {
      const res = (await db.raw(
        `SELECT c.name AS col, ty.name AS type
           FROM sys.indexes i
           JOIN sys.tables t ON t.object_id = i.object_id
           JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
           JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
           JOIN sys.types ty ON ty.user_type_id = c.user_type_id
          WHERE i.is_primary_key = 1 AND i.object_id = OBJECT_ID(?)`,
        [collection]
      )) as unknown
      const { rawRows } = await import('../db/raw-rows.js')
      ok = pkIsIntegerId(rawRows<{ col?: string; type?: string }>(res))
    }
  } catch {
    ok = false
  }
  eligibleCache.set(key, { at: Date.now(), ok })
  return ok
}

/** One primary-key column, named id, of an integer type. */
export function pkIsIntegerId(rows: ReadonlyArray<{ col?: string; type?: string }>): boolean {
  return (
    rows.length === 1 &&
    String(rows[0].col ?? '').toLowerCase() === 'id' &&
    INTEGER_TYPES.has(String(rows[0].type ?? '').toLowerCase())
  )
}

/** Tests: forget cached answers. */
export function __resetKeysetEligibility(): void {
  eligibleCache.clear()
}

/** Does this sort allow keyset paging (exactly `id`, ascending)? */
export function keysetSort(sort: readonly string[] | undefined): boolean {
  return !!sort && sort.length === 1 && sort[0].toLowerCase() === 'id'
}

/** Does this field list return `id` (no list = every field)? */
export function projectsId(fields: readonly string[] | undefined): boolean {
  return !fields || fields.length === 0 || fields.some((f) => f === '*' || f.toLowerCase() === 'id')
}

/** `filter` AND `id > after` (after null = the filter as is). */
export function afterIdFilter(
  filter: Record<string, unknown> | undefined,
  after: number | null
): Record<string, unknown> | undefined {
  if (after == null) return filter
  const gt = { id: { _gt: after } }
  return filter && Object.keys(filter).length > 0 ? { _and: [filter, gt] } : gt
}

/** The keyset of a page: its last row's id when it is a whole number, else null (stop keyset). */
export function lastNumericId(rows: ReadonlyArray<Record<string, unknown>>): number | null {
  const v = rows.at(-1)?.id
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN
  return Number.isSafeInteger(n) ? n : null
}

/**
 * The paging state of one export. `page(offset)` answers the offset and filter of the next read;
 * `saw(rows)` moves the keyset on after each page.
 */
export class ExportPager {
  private keyset: boolean
  private after: number | null = null

  /** `eligible`: keysetEligible(collection) — the table's key allows keyset at all. */
  constructor(
    sort: readonly string[] | undefined,
    fields: readonly string[] | undefined,
    private readonly filter: Record<string, unknown> | undefined,
    eligible: boolean
  ) {
    this.keyset = eligible && keysetSort(sort) && projectsId(fields)
  }

  /** The read for the page that starts `offset` rows in. */
  page(offset: number): { offset: number; filter: Record<string, unknown> | undefined } {
    if (this.keyset && this.after != null)
      return { offset: 0, filter: afterIdFilter(this.filter, this.after) }
    return { offset, filter: this.filter }
  }

  saw(rows: ReadonlyArray<Record<string, unknown>>): void {
    if (!this.keyset || rows.length === 0) return
    const last = lastNumericId(rows)
    // A non-numeric id, or ids that did not move forward (the read ignored the order): OFFSET.
    if (last == null || (this.after != null && last <= this.after)) {
      // A non-numeric id: OFFSET from here on (the offset counts every row read so far).
      this.keyset = false
      this.after = null
      return
    }
    this.after = last
  }

  get usesKeyset(): boolean {
    return this.keyset
  }
}
