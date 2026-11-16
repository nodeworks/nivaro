import { hashKey, type QueryKey, type QueryState, useQueryClient } from '@tanstack/react-query'
import { useCallback, useSyncExternalStore } from 'react'

/**
 * Watch one react-query cache entry WITHOUT becoming an observer of it: the entry's state
 * (data, dataUpdatedAt, error…) or undefined while it does not exist. Never fetches.
 *
 * Use this — never a useQuery whose queryFn is skipToken — to read an entry another
 * component fetches. Every observer writes its options onto the shared Query, so a skipToken
 * observer that renders after the real one leaves the Query's queryFn as skipToken; the next
 * `invalidateQueries`/`refetchQueries` then runs the Query with its own options and fails with
 * "Missing queryFn" without sending anything (report "Reset cache", 2026-11-16: every query
 * widget showed "Couldn't load this query").
 */
export function useQueryEntryState<TData = unknown, TError = unknown>(
  queryKey: QueryKey
): QueryState<TData, TError> | undefined {
  const qc = useQueryClient()
  const hash = hashKey(queryKey)
  const subscribe = useCallback(
    (onChange: () => void) =>
      qc.getQueryCache().subscribe((event) => {
        if (event.query.queryHash === hash) onChange()
      }),
    [qc, hash]
  )
  // The state object is replaced on every change and stable otherwise — a valid snapshot.
  const read = () => qc.getQueryCache().get<TData, TError>(hash)?.state
  return useSyncExternalStore(subscribe, read, read)
}
