import { useQueries, useQueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { renderDisplayTemplate, USER_SYSTEM_COLS, userDisplayLabel } from '../pipeline/relations'

/**
 * Display labels for records named only by id — a related record's id shown
 * where a person expects its name ("was 33", "→ 33"). Each id reads as the
 * viewer (null when unreadable, so the caller keeps whatever it had). Only
 * plain ids (numbers / uuids) are looked up; a value that already reads as
 * text is left alone.
 */
export function useRecordLabels(
  collection: string | null | undefined,
  ids: Array<unknown>,
  enabled = true
): Map<string, string> {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const wanted = useMemo(
    () =>
      [
        ...new Set(
          ids
            .filter((v) => v != null && v !== '' && typeof v !== 'object')
            .map(String)
            .filter((v) => /^\d+$/.test(v) || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(v))
        )
      ].slice(0, 20),
    [ids]
  )
  const results = useQueries({
    queries: wanted.map((id) => ({
      queryKey: ['record-label', collection, id],
      enabled: enabled && !!collection,
      staleTime: 10 * 60_000,
      retry: false,
      queryFn: async (): Promise<string | null> => {
        const col = collection as string
        const isUser = USER_SYSTEM_COLS.has(col)
        const item = await client
          .request<{ data: Record<string, unknown> | null }>(
            isUser ? get(`/users/${id}`) : get(`/items/${col}/${encodeURIComponent(id)}`)
          )
          .then((r) => r.data)
          .catch(() => null)
        if (!item) return null
        if (isUser) return userDisplayLabel(item)
        const meta = await qc.fetchQuery({
          queryKey: ['record-label-meta', col],
          staleTime: 10 * 60_000,
          queryFn: () =>
            client
              .request<{ data: { display_template?: string | null } }>(get(`/collections/${col}`))
              .then((r) => r.data)
              .catch(() => null)
        })
        const text = renderDisplayTemplate(meta?.display_template ?? null, item)
        return text && text !== id ? text : ((item.name as string) ?? null)
      }
    }))
  })
  const key = JSON.stringify(results.map((r) => r.data ?? null))
  return useMemo(() => {
    const labels = JSON.parse(key) as Array<string | null>
    const out = new Map<string, string>()
    wanted.forEach((id, i) => {
      if (labels[i]) out.set(id, labels[i] as string)
    })
    return out
  }, [wanted, key])
}
