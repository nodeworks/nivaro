import { useQuery } from '@tanstack/react-query'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'

/** GET /collections/:c as the API answers it. */
export interface CollectionBody {
  fields?: any[]
  relations?: any[]
  display_name?: string | null
  display_template?: string | null
  [key: string]: unknown
}

/**
 * The one key every layout-editor read of GET /collections/:c uses, holding the
 * body as answered; each reader picks what it needs with `select`. Namespaced:
 * other readers keep other shapes under ['collection-meta', c] (RelationCombobox
 * stores a relations array there), which crashed readers expecting `.fields`.
 */
export const collectionMetaKey = (collection: string | null | undefined) =>
  ['layout-editor', 'collection-meta', collection] as const

function asBody(v: unknown): CollectionBody | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as CollectionBody) : null
}

export function useCollectionBody<T = CollectionBody | null>(
  collection: string | null | undefined,
  opts: {
    select?: (body: CollectionBody | null) => T
    enabled?: boolean
    retry?: boolean
  } = {}
) {
  const client = useNivaroClient()
  return useQuery<CollectionBody | null, Error, T>({
    queryKey: collectionMetaKey(collection),
    queryFn: () =>
      client
        .request<{ data: unknown }>(get(`/collections/${collection}`))
        .then((r) => asBody(r?.data)),
    enabled: !!collection && (opts.enabled ?? true),
    staleTime: 5 * 60_000,
    ...(opts.select ? { select: opts.select } : {}),
    ...(opts.retry === undefined ? {} : { retry: opts.retry })
  })
}
