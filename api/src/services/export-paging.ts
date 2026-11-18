/**
 * Export paging (fix round 1). An export reads LIST_READ_MAX rows per read. Its default order is
 * `id` alone, and then it pages by KEYSET — the next page is `id > <last id of this page>` —
 * instead of OFFSET: an OFFSET read skips every earlier row again (quadratic over a 230k-row
 * export) and skips or repeats rows when rows are inserted or deleted while it runs. Any other
 * sort, a projection without `id`, or a non-numeric id keeps OFFSET paging.
 */

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

  constructor(
    sort: readonly string[] | undefined,
    fields: readonly string[] | undefined,
    private readonly filter: Record<string, unknown> | undefined
  ) {
    this.keyset = keysetSort(sort) && projectsId(fields)
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
