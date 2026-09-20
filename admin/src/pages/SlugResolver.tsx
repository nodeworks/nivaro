import { useQuery } from '@tanstack/react-query'
import { Navigate, useLocation, useParams } from 'react-router'
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

// A record URL may carry the human alias in the id slot
// (/collections/workflows/HQ26-79667) — a link someone pasted, or the value
// they know the record by. The server resolves the alias when it reads the
// record, but nothing else does: every child query, presence room and widget
// downstream sends that segment on as a foreign key, and an int column raises
// "Conversion failed" rather than simply not matching, so the page fills with
// 500s around a record that loaded fine.
//
// So the alias is turned into the real key HERE, once, and the URL is
// rewritten to it — the same resolution /collections/:c/s/:slug already does.
// A segment that looks like a key, or that resolves to nothing, renders
// straight through and keeps its existing behaviour (including 404).
export function RecordAliasRedirect({ children }: { children: React.ReactNode }) {
  const { collection = '', id = '' } = useParams()
  const location = useLocation()
  const looksLikeKey =
    !id ||
    id === 'new' ||
    /^\d+$/.test(id) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)

  const { data, isFetched } = useQuery({
    queryKey: ['record-alias', collection, id],
    enabled: !!collection && !!id && !looksLikeKey,
    retry: false,
    staleTime: 300_000,
    queryFn: () =>
      api
        .get<{ data: { id: string | number } }>(
          `/items/${collection}/by-slug/${encodeURIComponent(id)}`
        )
        .then((r) => r.data.data)
        .catch(() => null)
  })

  if (looksLikeKey) return <>{children}</>
  if (data?.id != null && String(data.id) !== id)
    return (
      <Navigate to={`/collections/${collection}/${data.id}${location.search}${location.hash}`} replace />
    )
  // Unresolvable (or already canonical): let the record page answer for it.
  if (isFetched) return <>{children}</>
  return (
    <div className='flex flex-1 items-center justify-center text-[12.5px] text-slate-400'>
      Resolving…
    </div>
  )
}
