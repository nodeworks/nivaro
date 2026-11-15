import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useOptionalNivaroClient } from '../context'
import { get, patch } from './commands'
import { announceLocalPrefs, userSyncScoped } from './user-sync'

/**
 * Row density of every list and table (the Compact / Comfortable toggle), shared by the
 * collection browser and the queue worklists (rt4 #19).
 *
 * The browser keeps its own copy (localStorage `nvr_table_density`, so the first paint needs no
 * request and a signed-out page still works) and the person's preferences (`table_density`)
 * carry it between devices:
 *   - another TAB of this browser: the `storage` event, at once;
 *   - another DEVICE: `prefs:changed` refetches ['nvr-profile-prefs'] (useUserSync), and the
 *     value that arrives is adopted — except for 5 s after this tab's own change, so a stale
 *     answer can never flip what the person just chose back.
 */

export type TableDensity = 'compact' | 'comfortable'

export const TABLE_DENSITY_KEY = 'nvr_table_density'
const OWN_CHANGE_GRACE_MS = 5000

export function readLocalDensity(): TableDensity {
  try {
    return localStorage.getItem(TABLE_DENSITY_KEY) === 'comfortable' ? 'comfortable' : 'compact'
  } catch {
    return 'compact'
  }
}

/** The preference's value as a density, or null when unset or not a density. */
export function densityFromPrefs(prefs: unknown): TableDensity | null {
  const v = (prefs as { table_density?: unknown } | null | undefined)?.table_density
  return v === 'compact' || v === 'comfortable' ? v : null
}

export function useTableDensity(): [TableDensity, (next: TableDensity) => void] {
  const client = useOptionalNivaroClient()
  const [density, setDensity] = useState<TableDensity>(readLocalDensity)
  const ownChangeAt = useRef(0)

  // Another tab of this browser changed it.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === TABLE_DENSITY_KEY) setDensity(readLocalDensity())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  // The preference, on any device (the same cached read the Profile card makes).
  const { data: prefs } = useQuery({
    queryKey: ['nvr-profile-prefs'],
    queryFn: () =>
      client!
        .request<{ data: { preferences?: Record<string, unknown> | null } }>(get('/users/me'))
        .then((r) => (r.data?.preferences ?? {}) as Record<string, unknown>),
    enabled: !!client,
    staleTime: 60_000,
    retry: false
  })
  const fromServer = densityFromPrefs(prefs)
  useEffect(() => {
    if (!fromServer || userSyncScoped()) return
    if (Date.now() - ownChangeAt.current < OWN_CHANGE_GRACE_MS) return
    setDensity((cur) => (cur === fromServer ? cur : fromServer))
    try {
      localStorage.setItem(TABLE_DENSITY_KEY, fromServer)
    } catch {
      /* private mode */
    }
  }, [fromServer])

  const set = useCallback(
    (next: TableDensity) => {
      ownChangeAt.current = Date.now()
      setDensity(next)
      if (!userSyncScoped()) {
        try {
          localStorage.setItem(TABLE_DENSITY_KEY, next)
        } catch {
          /* private mode */
        }
      }
      // A View-as tab saves nothing: it is someone else on this browser.
      if (!client || userSyncScoped()) return
      void client
        .request(patch('/users/me/preferences', { table_density: next }))
        .then(() => announceLocalPrefs(['table_density']))
        .catch(() => {
          /* this device keeps the choice; the next change tries again */
        })
    },
    [client]
  )
  return [density, set]
}
