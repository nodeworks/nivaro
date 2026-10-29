import { useQueries } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'
import { useNivaroClient } from '../context'
import { post } from '../lib/commands'

/** Query-key root of the per-page exclusion sets; a toggle invalidates `[ROOT, collection]`. */
export const PICKER_EXCLUSIONS_PAGE_KEY = 'picker-exclusions-page'

/**
 * Which of the rows on screen are left out of every relation picker
 * (nivaro_picker_exclusions) — one POST /picker-exclusions/batch-status per
 * collection on the page (a queue mixes collections). Off unless `enabled`,
 * so a list costs nothing extra for people who never manage exclusions.
 */
export function usePickerExcludedRows(
  rows: Array<{ collection: string; id: string | number }>,
  enabled: boolean
): (collection: string, id: string | number) => boolean {
  const client = useNivaroClient()
  const byCollection = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const r of rows) {
      if (!r.collection || r.id == null) continue
      const list = m.get(r.collection) ?? []
      list.push(String(r.id))
      m.set(r.collection, list)
    }
    return [...m.entries()].map(([collection, ids]) => ({
      collection,
      ids: [...new Set(ids)].sort()
    }))
  }, [rows])
  const results = useQueries({
    queries: byCollection.map(({ collection, ids }) => ({
      queryKey: [PICKER_EXCLUSIONS_PAGE_KEY, collection, ids.join(',')],
      queryFn: () =>
        client
          .request<{ data: { excluded: string[] } }>(
            post('/picker-exclusions/batch-status', { collection, ids })
          )
          .then((r) => r.data?.excluded ?? []),
      enabled: enabled && ids.length > 0,
      staleTime: 60_000,
      retry: false
    }))
  })
  // One string per answer set: `results` is a new array every render.
  const answerKey = results.map((r) => (r.data ?? []).join(',')).join('|')
  // biome-ignore lint/correctness/useExhaustiveDependencies: answerKey carries every result's data
  const excluded = useMemo(() => {
    const set = new Set<string>()
    byCollection.forEach(({ collection }, i) => {
      for (const id of results[i]?.data ?? []) set.add(`${collection}|${String(id).toUpperCase()}`)
    })
    return set
  }, [byCollection, answerKey])
  return useCallback(
    (collection: string, id: string | number) =>
      excluded.has(`${collection}|${String(id).toUpperCase()}`),
    [excluded]
  )
}

/** Hover text for a row that is left out of every relation picker. */
export const PICKER_EXCLUDED_TITLE =
  'Excluded from pickers — not offered in any dropdown. Actions → Include in pickers to offer it again.'

/**
 * A row left out of every relation picker reads as "not on offer": muted
 * italics over a faint diagonal hatch — no icon column, nothing that moves
 * (Rob 2026-10-29: an eye-off column was too loud; italics alone too quiet).
 * Plain text and relation links (buttons/anchors, which set their own colour
 * and don't inherit font-style) go slate-500 / dark slate-400, both ≥4.5:1;
 * state chips and other coloured values keep their colour. The hatch is a
 * background-IMAGE on each cell, so it lies over every cell's own opaque
 * colour (pinned columns, selected / at-risk tints) instead of replacing it.
 * The row's hover text says why.
 */
export const PICKER_EXCLUDED_ROW_CLASS = [
  '[&>td]:italic [&>td_*]:italic',
  '[&>td]:!text-slate-500 [&>td_a]:!text-slate-500 [&>td_button]:!text-slate-500',
  'dark:[&>td]:!text-slate-400 dark:[&>td_a]:!text-slate-400 dark:[&>td_button]:!text-slate-400',
  '[&>td]:bg-[repeating-linear-gradient(135deg,rgb(100_116_139/0.09)_0_1px,transparent_1px_6px)]',
  'dark:[&>td]:bg-[repeating-linear-gradient(135deg,rgb(148_163_184/0.10)_0_1px,transparent_1px_6px)]'
].join(' ')
