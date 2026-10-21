import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { useNivaroClient } from '../../../context'
import { del, get, post } from '../../../lib/commands'
import { useInvalidateLayouts } from '../overview/overview-api'

// A/B layouts (#2614) — /api/collection-layouts/:id/ab-test. Admin-only, like the editor.

export interface AbSide {
  id: number
  name: string
  slug: string | null
}

export interface AbTestInfo {
  control: AbSide
  variant: AbSide
  role: { id: string; name: string }
  started_at: string | null
  started_by: { id: string; name: string } | null
  /** Which side the asked-about form is. */
  side?: 'control' | 'variant'
}

export interface AbArm {
  layout_id: number
  half: 'a' | 'b'
  people: number
  opens: number
  saves: number
  abandons: number
  save_rate: number | null
  avg_save_ms: number | null
  timed_saves: number
  created: number
  edited_after_save: number
  edits_per_record: number | null
}

export interface AbResults {
  ready: boolean
  since: string
  a: AbArm
  b: AbArm
}

export const abKeys = {
  test: (layoutId: number) => ['layout-editor', 'ab-test', layoutId] as const,
  results: (layoutId: number) => ['layout-editor', 'ab-test', layoutId, 'results'] as const,
  roles: () => ['layout-editor', 'ab-test', 'roles'] as const
}

const data = <T>(r: unknown, fallback: T): T => ((r as { data?: T } | null)?.data ?? fallback) as T

export function useAbTest(layoutId: number) {
  const client = useNivaroClient()
  return useQuery<AbTestInfo | null>({
    queryKey: abKeys.test(layoutId),
    queryFn: async () =>
      data<AbTestInfo | null>(
        await client.request<unknown>(get(`/collection-layouts/${layoutId}/ab-test`)),
        null
      ),
    staleTime: 30_000,
    retry: false
  })
}

export function useAbResults(layoutId: number, enabled: boolean) {
  const client = useNivaroClient()
  return useQuery<AbResults | null>({
    queryKey: abKeys.results(layoutId),
    queryFn: async () =>
      data<AbResults | null>(
        await client.request<unknown>(get(`/collection-layouts/${layoutId}/ab-test/results`)),
        null
      ),
    enabled,
    staleTime: 5 * 60_000,
    retry: false
  })
}

/** Roles a test can split: administrator roles always get the original form. */
export function useSplittableRoles(enabled: boolean) {
  const client = useNivaroClient()
  return useQuery<Array<{ id: string; name: string }>>({
    queryKey: abKeys.roles(),
    queryFn: async () => {
      const rows = data<Array<{ id: unknown; name: unknown; admin_access?: unknown }>>(
        await client.request<unknown>(get('/roles')),
        []
      )
      return rows
        .filter((r) => !r.admin_access)
        .map((r) => ({ id: String(r.id), name: String(r.name) }))
        .sort((a, b) => a.name.localeCompare(b.name))
    },
    enabled,
    staleTime: 5 * 60_000
  })
}

export function useAbActions(layoutId: number, collection: string) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const invalidateLayouts = useInvalidateLayouts(collection)
  const refresh = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: ['layout-editor', 'ab-test'] })
    invalidateLayouts()
  }, [qc, invalidateLayouts])
  return {
    /** A copy of this form to change and test (create_hidden, never the default). */
    copy: async (name: string): Promise<number> => {
      for (let n = 1; n <= 5; n++) {
        try {
          const r = await client.request<unknown>(
            post(`/collection-layouts/${layoutId}/clone`, {
              name: n === 1 ? `${name} (new version)` : `${name} (new version ${n})`
            })
          )
          const id = Number(data<{ id?: unknown }>(r, {}).id)
          if (Number.isFinite(id) && id > 0) return id
          break
        } catch (err) {
          // 409 = the name is taken: try the next one.
          const status =
            (err as { status?: number })?.status ??
            (err as { response?: { status?: number } })?.response?.status
          if (status !== 409) throw err
        }
      }
      throw new Error('Could not copy this form')
    },
    start: async (variantId: number, roleId: string) => {
      await client.request(
        post(`/collection-layouts/${layoutId}/ab-test`, { variant_id: variantId, role_id: roleId })
      )
      await refresh()
    },
    end: async (keep: 'control' | 'variant') => {
      await client.request(del(`/collection-layouts/${layoutId}/ab-test?keep=${keep}`))
      await refresh()
    }
  }
}
