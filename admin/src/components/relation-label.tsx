import { useQuery } from '@tanstack/react-query'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { renderDisplayTemplate } from '@/lib/relations'

interface RelationLabelProps {
  relatedCollection: string
  id: unknown
}

export function RelationLabel({ relatedCollection, id }: RelationLabelProps) {
  const hasId = id !== null && id !== undefined && id !== ''

  const { data: colMeta } = useQuery({
    queryKey: ['collection-meta', relatedCollection],
    queryFn: () => api.get(`/collections/${relatedCollection}`).then((r) => r.data.data),
    staleTime: 10 * 60 * 1000
  })

  const displayTemplate = colMeta?.display_template ?? null

  // Single-item fetch — shares cache with RelationPicker so only one request fires
  // per (collection, id) pair regardless of how many labels render for the same id.
  const { data: item, isLoading } = useQuery({
    queryKey: ['relation-item', relatedCollection, String(id)],
    queryFn: () =>
      api
        .get(`/items/${relatedCollection}/${id}`, { params: { fields: '*' } })
        .then((r) => r.data.data),
    enabled: hasId,
    staleTime: 30 * 60 * 1000
  })

  if (!hasId) {
    return <span className='text-slate-300'>—</span>
  }

  if (isLoading) {
    return <Skeleton className='h-3.5 w-24 rounded' />
  }

  const label = item ? renderDisplayTemplate(displayTemplate, item) : String(id)
  return (
    <span className='text-[12px] text-slate-700'>
      {label ?? <span className='font-mono text-slate-400'>{String(id)}</span>}
    </span>
  )
}
