import { useQuery } from '@tanstack/react-query'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { renderDisplayTemplate, USER_SYSTEM_COLS, userDisplayLabel } from '@/lib/relations'

interface RelationLabelProps {
  relatedCollection: string
  id: unknown
}

export function RelationLabel({ relatedCollection, id }: RelationLabelProps) {
  const hasId = id !== null && id !== undefined && id !== ''

  const SYSTEM_COLS = new Set(['directus_users', 'directus_files', 'directus_activity', 'directus_roles', 'nivaro_users'])
  const isSystemCol = SYSTEM_COLS.has(relatedCollection)
  // User relations resolve via /users — system tables have no /items route
  const isUserCol = USER_SYSTEM_COLS.has(relatedCollection)

  const { data: colMeta } = useQuery({
    queryKey: ['collection-meta', relatedCollection],
    queryFn: () => api.get(`/collections/${relatedCollection}`).then((r) => r.data.data),
    staleTime: 10 * 60 * 1000,
    enabled: !isSystemCol,
    retry: false,
  })

  const displayTemplate = colMeta?.display_template ?? null

  const { data: item, isLoading } = useQuery({
    queryKey: ['relation-item', relatedCollection, String(id)],
    queryFn: () =>
      isUserCol
        ? api.get(`/users/${id}`).then((r) => r.data.data)
        : api
            .get(`/items/${relatedCollection}/${id}`, { params: { fields: '*' } })
            .then((r) => r.data.data),
    enabled: hasId && (isUserCol || !isSystemCol),
    staleTime: 30 * 60 * 1000,
    retry: false,
  })

  if (!hasId) {
    return <span className='text-slate-300'>—</span>
  }

  if (isLoading) {
    return <Skeleton className='h-3.5 w-24 rounded' />
  }

  const label = item
    ? isUserCol
      ? userDisplayLabel(item)
      : renderDisplayTemplate(displayTemplate, item)
    : String(id)
  return (
    <span className='text-[12px] text-slate-700'>
      {label ?? <span className='font-mono text-slate-400'>{String(id)}</span>}
    </span>
  )
}
