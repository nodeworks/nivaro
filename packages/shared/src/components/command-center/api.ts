import { type UseQueryOptions, useQuery } from '@tanstack/react-query'
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

export function useCcQuery<T>(
  path: string,
  extra?: Record<string, unknown>,
  opts?: Omit<UseQueryOptions<T>, 'queryKey' | 'queryFn'> & { lenses?: boolean }
) {
  const client = useNivaroClient()
  const { region, at, kiosk } = useCc()
  const { lenses, ...queryOpts } = opts ?? {}
  const useLenses = lenses !== false
  const params = {
    ...(useLenses ? ccParams({ region, at }, extra) : (extra ?? {})),
    ...(kiosk ? { kiosk } : {})
  }
  return useQuery<T>({
    queryKey: ['command-center', path, params],
    queryFn: () =>
      client.request<{ data: T }>(get(`/command-center${path}`, params)).then((r) => r.data),
    ...queryOpts
  })
}
