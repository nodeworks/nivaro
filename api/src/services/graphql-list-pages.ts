/**
 * GraphQL list reads honour the caller's limit (Rob 2026-11-10: `vendors(limit: -1)`
 * returned 1,000 of 1,206 vendors and dropped J JOHNSON ELECTRICAL SERVICES).
 *
 * One items read returns at most LIST_READ_MAX rows. GraphQL has no meta channel a
 * client reads, so a cut there is silent: `limit: -1` = every row and an explicit
 * limit above one read = exactly that many, gathered page by page.
 */
export interface PageAnswer {
  data: unknown[]
  [k: string]: unknown
}

/** True when the asked limit needs more than one items read (and no keyset cursor rides). */
export function wantsManyPages(limit: unknown, pageSize: number, after: unknown): boolean {
  if (typeof after === 'string') return false
  return typeof limit === 'number' && (limit < 0 || limit > pageSize)
}

/**
 * Reads pages of `pageSize` from `offset` until `limit` rows are gathered (limit < 0 = until a
 * short page). The first page's answer carries the facts (total …); `limit`/`offset` are the
 * caller's own and the cut flags are dropped, since nothing was cut.
 */
export async function readAllPages(
  readPage: (limit: number, offset: number, first: boolean) => Promise<PageAnswer>,
  limit: number,
  offset: number,
  pageSize: number
): Promise<PageAnswer> {
  const all = limit < 0
  const rows: unknown[] = []
  let first: PageAnswer | undefined
  for (let at = offset; ; at += pageSize) {
    const take = all ? pageSize : Math.min(pageSize, limit - rows.length)
    if (take <= 0) break
    const page = await readPage(take, at, first === undefined)
    first ??= page
    rows.push(...page.data)
    if (page.data.length < take) break
  }
  const { limit_capped: _c, applied_limit: _a, ...facts } = first ?? { data: [] }
  return { ...facts, data: rows, limit, offset }
}
