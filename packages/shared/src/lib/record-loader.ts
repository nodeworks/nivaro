import { type QueryClient, useQueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useOptionalNivaroClient } from '../context'
import { get } from './commands'

/**
 * Record read coalescing (#739). A record form reads the same related records
 * several times: the header strip's label, the picker's current value, the
 * read view, cross-record defaults and pinned options each ask for
 * `/items/<collection>/<id>` under their own cache keys, seconds apart — so
 * neither react-query nor in-flight GET coalescing ever joins them.
 *
 * Label and default readers go through one shared cache entry per record
 * instead: the full row, fetched once and kept for a short window, with a
 * caller that wants specific PLAIN fields handed just those. A caller asking
 * for dotted (nested) fields still goes to the server — only the single-read
 * endpoint expands relations. The form's own record query does NOT use this:
 * it must refetch the moment it is invalidated.
 */
export const RECORD_ROW_KEY = 'nvr-record-row'

/** How long a shared row answers a repeat read. Short on purpose: another
 *  person's edit to a related record shows within this window. */
const ROW_STALE_MS = 10_000

interface RequestClient {
  request<T>(cmd: unknown): Promise<T>
}

function fieldList(fields: string | string[] | null | undefined): string[] | null {
  if (fields == null) return null
  const list = (Array.isArray(fields) ? fields : fields.split(','))
    .map((f) => f.trim())
    .filter(Boolean)
  return list.length ? list : null
}

export async function readRecordRow(
  client: RequestClient,
  qc: QueryClient | null,
  collection: string,
  id: string | number,
  fields?: string | string[] | null
): Promise<Record<string, unknown> | null> {
  const list = fieldList(fields)
  const plain = !list || list.every((f) => !f.includes('.') && !f.includes('*'))
  if (!qc || !plain) {
    return client
      .request<{ data: Record<string, unknown> | null }>(
        get(`/items/${collection}/${id}`, list ? { fields: list.join(',') } : undefined)
      )
      .then((r) => r.data ?? null)
  }
  const row = await qc.fetchQuery({
    queryKey: [RECORD_ROW_KEY, collection, String(id)],
    queryFn: () =>
      client
        .request<{ data: Record<string, unknown> | null }>(get(`/items/${collection}/${id}`))
        .then((r) => r.data ?? null),
    staleTime: ROW_STALE_MS
  })
  if (!row || !list) return row
  const out: Record<string, unknown> = {}
  for (const f of ['id', ...list]) if (f in row) out[f] = row[f]
  return out
}

/** `(collection, id, fields?) => row` bound to this component's client + cache. */
export function useRecordReader() {
  const client = useOptionalNivaroClient()
  const qc = useQueryClient()
  return useMemo(
    () => (collection: string, id: string | number, fields?: string | string[] | null) => {
      if (!client) return Promise.resolve(null)
      return readRecordRow(client, qc, collection, id, fields)
    },
    [client, qc]
  )
}

/** After a write to a record: drop its shared row so the next label read refetches. */
export function invalidateRecordRow(qc: QueryClient, collection: string, id?: string | number) {
  void qc.invalidateQueries({
    queryKey: id == null ? [RECORD_ROW_KEY, collection] : [RECORD_ROW_KEY, collection, String(id)]
  })
}
