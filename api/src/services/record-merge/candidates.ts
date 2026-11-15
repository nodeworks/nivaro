/**
 * "Merge with…" from a record: which records to offer. First the record's likely
 * duplicates (the collection's duplicate rules, services/duplicate-check.ts, run on the
 * record's own values), then — when the person types — a plain list search. Both read as
 * the caller; labels come from recordLabelsAsViewer (never a primary key, never a hint
 * that an unreadable record exists).
 */
import type { FastifyRequest } from 'fastify'
import type { User } from '../../types.js'

export interface MergeCandidate {
  id: string
  label: string
  /** Why it is offered: 'exact' / 'close' duplicate, or a search hit. */
  match: 'exact' | 'close' | 'search'
}

const sameId = (a: unknown, b: unknown) =>
  String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase()

export async function mergeCandidates(
  req: FastifyRequest,
  collection: string,
  opts: { of: string | null; q: string }
): Promise<{ self: string | null; likely: MergeCandidate[]; results: MergeCandidate[] }> {
  const user = req.user as User
  const { readOne, readItems } = await import('../items.js')
  const likely: MergeCandidate[] = []
  if (opts.of) {
    const row = (await readOne(user, collection, opts.of, req.workspaceId ?? undefined).catch(
      () => null
    )) as Record<string, unknown> | null
    if (row) {
      try {
        const { findDuplicates } = await import('../duplicate-check.js')
        const answer = await findDuplicates(user, collection, row, { excludeId: opts.of, req })
        for (const list of Object.values(answer.matches ?? {}))
          for (const m of list ?? []) {
            if (sameId(m.id, opts.of) || likely.some((x) => sameId(x.id, m.id))) continue
            likely.push({
              id: String(m.id),
              label: m.label,
              match: m.match === 'exact' ? 'exact' : 'close'
            })
          }
      } catch {
        /* no duplicate rules here — the search still works */
      }
    }
  }
  const results: MergeCandidate[] = []
  const q = opts.q.trim()
  if (q.length >= 1) {
    const res = (await readItems(
      user,
      collection,
      { search: q, search_rank: true, fields: ['id'], limit: 12, count: false },
      req,
      req.workspaceId ?? undefined
    ).catch(() => ({ data: [] }))) as { data?: Array<{ id: unknown }> }
    const ids = (res.data ?? [])
      .map((r) => String(r.id))
      .filter((id) => !opts.of || !sameId(id, opts.of))
    const { recordLabelsAsViewer } = await import('../record-labels-as-viewer.js')
    const labels = await recordLabelsAsViewer(
      user,
      ids.map((id) => ({ collection, id }))
    ).catch(() => ({}) as Record<string, string>)
    for (const id of ids)
      results.push({ id, label: labels[`${collection}:${id}`] ?? id, match: 'search' })
  }
  let self: string | null = null
  if (opts.of) {
    const { recordLabelsAsViewer } = await import('../record-labels-as-viewer.js')
    const labels = await recordLabelsAsViewer(user, [{ collection, id: opts.of }]).catch(
      () => ({}) as Record<string, string>
    )
    self = labels[`${collection}:${opts.of}`] ?? null
  }
  return { self, likely: likely.slice(0, 8), results: results.slice(0, 10) }
}
