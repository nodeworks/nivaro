import { toastError } from '@nivaro/shared'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useRef } from 'react'
import { toast } from 'sonner'
import { api } from '@/lib/api'

/**
 * Pinned collections — the list an administrator puts at the top of the Collections page
 * for EVERYONE (GET/PUT /api/collection-pins). Not the person's own favorites: those are
 * sidebar favorites (overview-data.ts useFavoriteCollections).
 *
 * The server answers only collections the reader may read. Admin edits show at once
 * (optimistic) and go out one at a time, in order; a failed save puts the list back to what
 * the server last stored and says why.
 */

export const PINS_QUERY_KEY = ['collection-pins'] as const
export const MAX_PINS = 24

/** One name moved one place up (-1) or down (+1); unchanged at the ends. */
export function movePin(list: string[], name: string, delta: -1 | 1): string[] {
  const from = list.indexOf(name)
  const to = from + delta
  if (from === -1 || to < 0 || to >= list.length) return list
  const next = [...list]
  next.splice(from, 1)
  next.splice(to, 0, name)
  return next
}

export function useSharedPins(enabled = true) {
  const qc = useQueryClient()
  const query = useQuery<string[]>({
    queryKey: PINS_QUERY_KEY,
    queryFn: () =>
      api
        .get('/collection-pins')
        .then((r) => (r.data?.data?.collections as string[] | undefined) ?? []),
    enabled,
    staleTime: 30_000,
    retry: 1
  })

  const chain = useRef<Promise<unknown>>(Promise.resolve())
  const inFlight = useRef(0)
  /** What the server last stored (the rollback point while saves are queued). */
  const stored = useRef<string[]>([])

  const save = useCallback(
    (next: string[], success?: string): Promise<unknown> => {
      const current = qc.getQueryData<string[]>(PINS_QUERY_KEY) ?? []
      if (inFlight.current === 0) stored.current = current
      inFlight.current++
      void qc.cancelQueries({ queryKey: PINS_QUERY_KEY })
      qc.setQueryData(PINS_QUERY_KEY, next)
      const run = chain.current.then(async () => {
        try {
          const res = await api.put('/collection-pins', { collections: next })
          const saved = (res.data?.data?.collections as string[] | undefined) ?? next
          stored.current = saved
          // Only the newest save repaints from the answer; an older one is already superseded.
          if (inFlight.current === 1) qc.setQueryData(PINS_QUERY_KEY, saved)
          if (success) toast.success(success)
        } catch (err) {
          qc.setQueryData(PINS_QUERY_KEY, stored.current)
          toastError(err, 'Could not save the pinned collections')
        } finally {
          inFlight.current--
        }
      })
      chain.current = run
      return run
    },
    [qc]
  )

  const pins = query.data ?? []
  const pin = useCallback(
    (name: string, label: string) => {
      const list = qc.getQueryData<string[]>(PINS_QUERY_KEY) ?? []
      if (list.includes(name)) return Promise.resolve()
      if (list.length >= MAX_PINS) {
        toast.error(`Up to ${MAX_PINS} collections can be pinned`, {
          description: 'Unpin one first.'
        })
        return Promise.resolve()
      }
      return save([...list, name], `Pinned ${label} for everyone`)
    },
    [qc, save]
  )
  const unpin = useCallback(
    (name: string, label: string) => {
      const list = qc.getQueryData<string[]>(PINS_QUERY_KEY) ?? []
      return save(
        list.filter((n) => n !== name),
        `Unpinned ${label}`
      )
    },
    [qc, save]
  )
  const reorder = useCallback((next: string[]) => save(next), [save])

  return {
    pins,
    status: query.isPending && enabled ? 'loading' : query.isError ? 'error' : 'ready',
    error: query.error,
    refetch: query.refetch,
    pin,
    unpin,
    reorder
  } as const
}
