import type { Command, NivaroClient } from '@nivaro/sdk'
import { useEffect, useRef, useState } from 'react'

export type RelationOption = {
  id: string | number
  label: string
  raw: Record<string, unknown>
}

function get<T>(path: string, params?: Record<string, unknown>): Command<T> {
  return { _method: 'GET', _path: path, _params: params } as Command<T>
}

/**
 * Render a display template like "{{first_name}} {{last_name}}" against a row.
 * Falls back to the row id (as string) when no template / no fields resolve.
 */
function renderLabel(
  row: Record<string, unknown>,
  template: string | null | undefined,
  idValue: unknown
): string {
  if (template) {
    let any = false
    const out = template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path: string) => {
      const val = resolvePath(row, path)
      if (val != null && val !== '') {
        any = true
        return String(val)
      }
      return ''
    })
    const trimmed = out.replace(/\s+/g, ' ').trim()
    if (any && trimmed) return trimmed
  }
  // Common label fallbacks before resorting to the id.
  for (const key of ['name', 'title', 'label', 'display_name']) {
    const v = row[key]
    if (typeof v === 'string' && v.trim()) return v
  }
  return String(idValue ?? '')
}

function resolvePath(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, seg) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[seg]
    return undefined
  }, obj)
}

function pickId(row: Record<string, unknown>): string | number {
  const id = row.id ?? row.uuid ?? row._id
  if (typeof id === 'string' || typeof id === 'number') return id
  return String(id ?? '')
}

/**
 * Fetch selectable options for a relation field's related collection.
 * Re-fetches when `search` changes. Pass `enabled: false` to skip fetching
 * (e.g. while the related collection name is still unknown).
 */
export function useRelationOptions(
  client: NivaroClient | null,
  relatedCollection: string,
  options?: {
    search?: string
    limit?: number
    displayTemplate?: string | null
    enabled?: boolean
  }
): { options: RelationOption[]; loading: boolean; error: Error | null } {
  const { search, limit = 50, displayTemplate = null, enabled = true } = options ?? {}
  const [opts, setOpts] = useState<RelationOption[]>([])
  const [loading, setLoading] = useState<boolean>(false)
  const [error, setError] = useState<Error | null>(null)
  const reqIdRef = useRef(0)

  useEffect(() => {
    if (!client || !relatedCollection || !enabled) {
      setOpts([])
      setLoading(false)
      return
    }

    const reqId = ++reqIdRef.current
    let active = true
    setLoading(true)
    setError(null)

    const params: Record<string, unknown> = { limit }
    if (search) params.search = search

    client
      .request<{ data: Record<string, unknown>[] }>(get(`/items/${relatedCollection}`, params))
      .then((res) => {
        if (!active || reqId !== reqIdRef.current) return
        const rows = res.data ?? []
        setOpts(
          rows.map((row) => {
            const id = pickId(row)
            return { id, label: renderLabel(row, displayTemplate, id), raw: row }
          })
        )
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (!active || reqId !== reqIdRef.current) return
        setError(err instanceof Error ? err : new Error(String(err)))
        setLoading(false)
      })

    return () => {
      active = false
    }
  }, [client, relatedCollection, search, limit, displayTemplate, enabled])

  return { options: opts, loading, error }
}
