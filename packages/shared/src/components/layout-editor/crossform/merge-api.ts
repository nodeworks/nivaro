import { useCallback } from 'react'
import { useNivaroClient } from '../../../context'
import { post } from '../../../lib/commands'

// Merge two forms (#2661): the client side of api/src/routes/layout-merge.ts.
// The server plans, previews and applies; the client says which form stays.

export interface MergeViewTally {
  label: string
  plain: { before: number | null; after: number | null }
  sampled: number
  kept: number
  carried: number
  lost: Array<{ from: number; to: number | null; count: number }>
  gained: Array<{ from: number | null; count: number }>
}

export interface MergePreview {
  keep: { id: number; name: string; rev: string }
  fold: { id: number; name: string; rev: string }
  changes: string[]
  assignment: string[]
  retire: string[]
  notes: string[]
  counts: {
    sections_added: number
    fields_added: number
    fields_moved: number
    rules_added: number
    differing: number
  }
  ops_count: number
  references: Array<{ kind: string; label: string }>
  records: { views: MergeViewTally[]; names: Record<string, string>; sampled_newest: number } | null
  needs_note: 'note' | 'note_ticket' | null
}

export interface MergeSideResult {
  layout_id: number
  name: string
  version_id: number | null
  rev: string
}

export interface MergeApplied {
  keep: MergeSideResult
  fold: MergeSideResult
}

const dataOf = <T>(res: unknown): T => (res as { data: T }).data

export function useMergeCalls() {
  const client = useNivaroClient()
  const preview = useCallback(
    async (collection: string, keepId: number, foldId: number) =>
      dataOf<MergePreview>(
        await client.request(
          post('/collection-layouts/merge/preview', {
            collection,
            keep_id: keepId,
            fold_id: foldId
          })
        )
      ),
    [client]
  )
  const apply = useCallback(
    async (collection: string, p: MergePreview, note?: { reason: string; ticket: string }) =>
      dataOf<MergeApplied>(
        await client.request(
          post('/collection-layouts/merge/apply', {
            collection,
            keep_id: p.keep.id,
            fold_id: p.fold.id,
            revs: { keep: p.keep.rev, fold: p.fold.rev },
            ...(note ? { reason: note.reason, ticket: note.ticket } : {})
          })
        )
      ),
    [client]
  )
  const undo = useCallback(
    async (collection: string, r: MergeApplied) =>
      dataOf<{ forms: Array<{ layout_id: number; status: string; reason: string | null }> }>(
        await client.request(
          post('/collection-layouts/merge/undo', {
            collection,
            keep: { layout_id: r.keep.layout_id, version_id: r.keep.version_id, rev: r.keep.rev },
            fold: { layout_id: r.fold.layout_id, version_id: r.fold.version_id, rev: r.fold.rev }
          })
        )
      ),
    [client]
  )
  return { preview, apply, undo }
}
