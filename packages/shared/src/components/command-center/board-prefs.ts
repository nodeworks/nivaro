import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNivaroClient } from '../../context'
import { del, get, post, put } from '../../lib/commands'
import type { CcLayout, CcPrefs, KioskInfo, KioskLink } from './types'

/**
 * Board prefs, role starting layouts and wallboard links — the shell's own reads and writes
 * (api/src/routes/command-center-shell.ts). Writes are never made from a wallboard link.
 */

export const PREFS_KEY = ['command-center', 'prefs'] as const
export const ROLE_DEFAULTS_KEY = ['command-center', 'role-defaults'] as const
export const KIOSK_LINKS_KEY = ['command-center', 'kiosk-links'] as const

export const DEFAULT_PREFS: CcPrefs = {
  layout: null,
  theme: 'app',
  saved_views: [],
  role_default: null,
  tv_cycle_seconds: 30
}

export function useCcPrefs(enabled: boolean) {
  const client = useNivaroClient()
  return useQuery<CcPrefs>({
    queryKey: PREFS_KEY,
    queryFn: () =>
      client.request<{ data: CcPrefs }>(get('/command-center/prefs')).then((r) => r.data),
    enabled,
    staleTime: 5 * 60_000,
    retry: false
  })
}

export type PrefsChange = Partial<
  Pick<CcPrefs, 'layout' | 'theme' | 'saved_views' | 'tv_cycle_seconds'>
>

/** Save part of the prefs; the board updates at once and settles on the server's answer. */
export function useSaveCcPrefs() {
  const client = useNivaroClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (change: PrefsChange) =>
      client.request<{ data: CcPrefs }>(put('/command-center/prefs', change)).then((r) => r.data),
    onMutate: async (change) => {
      await qc.cancelQueries({ queryKey: PREFS_KEY })
      const before = qc.getQueryData<CcPrefs>(PREFS_KEY)
      qc.setQueryData<CcPrefs>(PREFS_KEY, { ...DEFAULT_PREFS, ...(before ?? {}), ...change })
      return { before }
    },
    onError: (_e, _c, ctx) => {
      if (ctx?.before) qc.setQueryData(PREFS_KEY, ctx.before)
    },
    onSuccess: (data) => qc.setQueryData(PREFS_KEY, data)
  })
}

export function useCcRoleDefaults(enabled: boolean) {
  const client = useNivaroClient()
  return useQuery<Record<string, CcLayout>>({
    queryKey: ROLE_DEFAULTS_KEY,
    queryFn: () =>
      client
        .request<{ data: Record<string, CcLayout> }>(get('/command-center/role-defaults'))
        .then((r) => r.data),
    enabled
  })
}

export function useSaveRoleDefault() {
  const client = useNivaroClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { role_id: string; layout: CcLayout | null }) =>
      client
        .request<{ data: Record<string, CcLayout> }>(put('/command-center/role-defaults', v))
        .then((r) => r.data),
    onSuccess: (data) => {
      qc.setQueryData(ROLE_DEFAULTS_KEY, data)
      void qc.invalidateQueries({ queryKey: PREFS_KEY })
    }
  })
}

export function useKioskLinks(enabled: boolean) {
  const client = useNivaroClient()
  return useQuery<KioskLink[]>({
    queryKey: KIOSK_LINKS_KEY,
    queryFn: () =>
      client.request<{ data: KioskLink[] }>(get('/command-center/kiosk-links')).then((r) => r.data),
    enabled
  })
}

export function useCreateKioskLink() {
  const client = useNivaroClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: {
      label: string
      expires_in_days: number
      region: string | null
      map_collection: string | null
    }) =>
      client
        .request<{ data: KioskLink }>(post('/command-center/kiosk-links', v))
        .then((r) => r.data),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KIOSK_LINKS_KEY })
  })
}

export function useRevokeKioskLink() {
  const client = useNivaroClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => client.request(del(`/command-center/kiosk-links/${id}`)),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KIOSK_LINKS_KEY })
  })
}

/** What a wallboard link opens (only through the link); an error = the link stopped working. */
export function useKioskInfo(kiosk: string | null) {
  const client = useNivaroClient()
  return useQuery<KioskInfo>({
    queryKey: ['command-center', 'kiosk-info', kiosk],
    queryFn: () =>
      client
        .request<{ data: KioskInfo }>(get('/command-center/kiosk', { kiosk }))
        .then((r) => r.data),
    enabled: !!kiosk,
    // Re-checked every few minutes, so a revoked or expired link leaves the wall promptly.
    refetchInterval: 5 * 60_000,
    retry: 1
  })
}
