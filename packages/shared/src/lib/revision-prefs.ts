import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useOptionalNivaroClient } from '../context'
import { get, patch as patchCmd } from './commands'

/**
 * The signed-in person's Revision history choices, saved on their own account
 * (PATCH /users/me/preferences): the view they last opened (`revision_view`) and, per
 * collection, the Table columns they picked in their order (`revision_table_columns`).
 * Same query key and shape as the profile page, so every open panel follows a change.
 */
export type RevisionView = 'timeline' | 'table'

type Prefs = Record<string, unknown>
const KEY = ['nvr-profile-prefs'] as const

function columnsOf(prefs: Prefs | undefined, collection: string): string[] | null {
  const map = prefs?.revision_table_columns
  if (!map || typeof map !== 'object' || Array.isArray(map)) return null
  const list = (map as Record<string, unknown>)[collection]
  return Array.isArray(list) ? list.filter((f): f is string => typeof f === 'string') : null
}

export function useRevisionPrefs(collection: string) {
  const client = useOptionalNivaroClient()
  const qc = useQueryClient()
  const { data, isSuccess } = useQuery({
    queryKey: KEY,
    queryFn: () =>
      client!
        .request<{ data: { preferences?: Prefs | null } }>(get('/users/me'))
        .then((r) => (r.data?.preferences ?? {}) as Prefs),
    enabled: !!client,
    staleTime: 60_000,
    retry: false
  })
  const view: RevisionView | null =
    data?.revision_view === 'table' || data?.revision_view === 'timeline'
      ? (data.revision_view as RevisionView)
      : null

  const save = (body: Record<string, unknown>, apply: (p: Prefs) => Prefs) => {
    qc.setQueryData<Prefs>(KEY, (old) => apply({ ...(old ?? {}) }))
    if (!client) return
    void client.request(patchCmd('/users/me/preferences', body)).catch(() => {
      // Not saved: the next read puts the stored choice back.
      void qc.invalidateQueries({ queryKey: KEY })
    })
  }

  return {
    /** True once the person's stored choices have been read (or there is no client). */
    loaded: isSuccess || !client,
    view,
    /** This collection's picked columns in order; null = never picked (use the default). */
    columns: columnsOf(data, collection),
    setView: (v: RevisionView) => save({ revision_view: v }, (p) => ({ ...p, revision_view: v })),
    setColumns: (fields: string[] | null) =>
      save({ revision_table_columns: { collection, fields } }, (p) => {
        const prev = p.revision_table_columns
        const map: Record<string, string[]> =
          prev && typeof prev === 'object' && !Array.isArray(prev)
            ? { ...(prev as Record<string, string[]>) }
            : {}
        if (fields === null) delete map[collection]
        else map[collection] = fields
        return { ...p, revision_table_columns: map }
      })
  }
}
