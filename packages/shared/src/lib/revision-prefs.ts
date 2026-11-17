import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useOptionalNivaroClient } from '../context'
import { get, patch as patchCmd, put } from './commands'

/**
 * The signed-in person's Revision history choices, saved on their own account
 * (PATCH /users/me/preferences): the view they last opened (`revision_view`) and, per
 * collection, the Table columns they picked in their order (`revision_table_columns`).
 * Same query key and shape as the profile page, so every open panel follows a change.
 */
export type RevisionView = 'timeline' | 'table'

type Prefs = Record<string, unknown>
const KEY = ['nvr-profile-prefs'] as const

export interface NamedColumnSet {
  id?: string
  name: string
  fields: string[]
  /** Shared sets only, admins only: the roles this set is the default for. */
  default_roles?: string[]
  /** Shared sets only: the collection's default for everyone. */
  is_default?: boolean
}

function personalSetsOf(prefs: Prefs | undefined, collection: string): NamedColumnSet[] {
  const map = prefs?.revision_personal_sets
  if (!map || typeof map !== 'object' || Array.isArray(map)) return []
  const list = (map as Record<string, unknown>)[collection]
  return Array.isArray(list)
    ? (list as NamedColumnSet[]).filter(
        (s) => s && typeof s.name === 'string' && Array.isArray(s.fields)
      )
    : []
}

/** The collection's shared column sets (admin-made) and the one that is the default for the
 *  caller's role. */
export function useSharedColumnSets(collection: string) {
  const client = useOptionalNivaroClient()
  const qc = useQueryClient()
  const key = ['revision-column-sets', collection] as const
  const { data } = useQuery({
    queryKey: key,
    queryFn: () =>
      client!
        .request<{
          data: { sets: NamedColumnSet[]; role_default: NamedColumnSet | null }
        }>(get(`/revision-column-sets/${collection}`))
        .then((r) => r.data),
    enabled: !!client && !!collection,
    staleTime: 60_000,
    retry: false
  })
  return {
    sets: data?.sets ?? [],
    roleDefault: data?.role_default ?? null,
    /** Admins: replace the collection's shared sets. */
    save: async (sets: NamedColumnSet[]) => {
      if (!client) return
      await client.request(put(`/revision-column-sets/${collection}`, { sets }))
      await qc.invalidateQueries({ queryKey: key })
    }
  }
}

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
    /** The person's own named sets for this collection. */
    personalSets: personalSetsOf(data, collection),
    setPersonalSets: (sets: NamedColumnSet[] | null) =>
      save(
        {
          revision_personal_sets: {
            collection,
            sets: sets?.map((s) => ({ name: s.name, fields: s.fields })) ?? null
          }
        },
        (p) => {
          const prev = p.revision_personal_sets
          const map: Record<string, unknown> =
            prev && typeof prev === 'object' && !Array.isArray(prev)
              ? { ...(prev as Record<string, unknown>) }
              : {}
          if (sets === null) delete map[collection]
          else map[collection] = sets
          return { ...p, revision_personal_sets: map }
        }
      ),
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
