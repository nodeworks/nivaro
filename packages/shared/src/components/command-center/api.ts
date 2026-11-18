import { keepPreviousData, type UseQueryOptions, useQuery } from '@tanstack/react-query'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { useCc } from './state'

/**
 * Every Command Center read goes through here: it adds the board lenses (region, at) to the
 * query string, keys the cache under ['command-center', path, params] (the shell's Refresh
 * invalidates the whole prefix) and, on a wallboard link, sends the link token as `kiosk`
 * (the SDK has no per-call headers; the API redacts it from logged query strings).
 */
export function ccParams(
  lenses: { region: string | null; at: number | null },
  extra?: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...(extra ?? {}),
    ...(lenses.region ? { region: lenses.region } : {}),
    ...(lenses.at ? { at: new Date(lenses.at).toISOString() } : {})
  }
}

/** The query string (and cache key part) of one Command Center read. `live`: a live-only
 *  answer (the server ignores a rewind) — no `at`, so scrubbing the time bar neither re-keys
 *  nor refetches it (R9). */
export function ccQueryParams(
  board: { region: string | null; at: number | null; kiosk?: string | null },
  extra: Record<string, unknown> | undefined,
  opts: { lenses?: boolean; live?: boolean } = {}
): Record<string, unknown> {
  const useLenses = opts.lenses !== false
  return {
    ...(useLenses
      ? ccParams({ region: board.region, at: opts.live ? null : board.at }, extra)
      : (extra ?? {})),
    ...(board.kiosk ? { kiosk: board.kiosk } : {})
  }
}

export function useCcQuery<T>(
  path: string,
  extra?: Record<string, unknown>,
  opts?: Omit<UseQueryOptions<T>, 'queryKey' | 'queryFn'> & { lenses?: boolean; live?: boolean }
) {
  const client = useNivaroClient()
  const { region, at, kiosk } = useCc()
  const { lenses, live, ...queryOpts } = opts ?? {}
  const params = ccQueryParams({ region, at, kiosk }, extra, { lenses, live })
  return useQuery<T>({
    queryKey: ['command-center', path, params],
    queryFn: () =>
      client.request<{ data: T }>(get(`/command-center${path}`, params)).then((r) => r.data),
    // R9: a rewind scrub or a region pick keeps each panel's last answer on screen until the
    // new one arrives, instead of blanking every panel at once. A read about ONE thing (the
    // peek) opts out with `placeholderData: undefined`.
    placeholderData: keepPreviousData,
    ...queryOpts
  })
}
