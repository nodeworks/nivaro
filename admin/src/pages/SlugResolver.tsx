import { useQuery } from '@tanstack/react-query'
import { Navigate, useParams } from 'react-router'
import { api } from '@/lib/api'

// #619 — human-readable record URLs. /collections/:collection/s/:slug resolves
// through GET /items/:c/by-slug/:slug (server matches the collection's
// configured slug_field, RBAC applies) and lands on the normal record page.
export function SlugResolverPage() {
  const { collection = '', slug = '' } = useParams()
  const { data, isError, isFetched } = useQuery({
    queryKey: ['slug-resolve', collection, slug],
    enabled: !!collection && !!slug,
    retry: false,
    queryFn: () =>
      api
        .get<{ data: { id: string | number } }>(
          `/items/${collection}/by-slug/${encodeURIComponent(slug)}`
        )
        .then((r) => r.data.data)
  })
  if (data?.id != null) return <Navigate to={`/collections/${collection}/${data.id}`} replace />
  if (isFetched && (isError || data == null)) {
    return (
      <div className='flex flex-1 items-center justify-center'>
        <div className='text-center'>
          <p className='text-[14px] font-medium text-slate-700 dark:text-foreground'>
            No record found for &ldquo;{slug}&rdquo;
          </p>
          <p className='mt-1 text-[12px] text-slate-400'>
            The value may have changed, or this collection has no URL alias configured (Data Model → Settings → URL alias).
          </p>
        </div>
      </div>
    )
  }
  return (
    <div className='flex flex-1 items-center justify-center text-[12.5px] text-slate-400'>
      Resolving…
    </div>
  )
}
