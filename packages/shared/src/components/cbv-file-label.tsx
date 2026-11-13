import { useQuery } from '@tanstack/react-query'
import { useApiFetchConfig, useNivaroClient } from '../context'
import { get } from '../lib/commands'
import { relatedMissing } from './item-edit/related-missing'

/**
 * A list cell for a link to a file (a file field, or a relation path that ends on one, such as
 * "MWF Queue → File"). Files have no collection registry row and no /items read: the label comes
 * from /files/:id/meta — read as the viewer, so a file they may not open stays hidden — and a
 * click opens the file itself, the same as the record page's FileValue.
 */
export function CbvFileLabel({ id }: { id: unknown }) {
  const client = useNivaroClient()
  const { apiBase } = useApiFetchConfig()
  const hasId = id != null && id !== ''
  const { data: meta, isPending } = useQuery({
    queryKey: ['cbv-file-meta', String(id)],
    queryFn: () =>
      client
        .request<{ data: { title?: string | null; filename_download?: string | null } }>(
          get(`/files/${encodeURIComponent(String(id))}/meta`)
        )
        .then((r) => r.data ?? null)
        .catch(() => null),
    enabled: hasId,
    staleTime: 5 * 60_000,
    retry: false
  })

  if (!hasId) return <span className='text-[12px] text-slate-300'>—</span>
  if (isPending)
    return (
      <span className='inline-block h-3.5 w-24 animate-pulse rounded bg-slate-100 dark:bg-[hsl(var(--nvr-skeleton))]' />
    )
  const label = meta?.title || meta?.filename_download
  if (!label) {
    const missing = relatedMissing(null)
    return (
      <span
        data-relation-missing
        data-tip={missing.tip}
        className='text-[12px] italic text-slate-500 dark:text-slate-400'
      >
        {missing.text}
      </span>
    )
  }
  return (
    <a
      href={`${apiBase}/files/${encodeURIComponent(String(id))}`}
      target='_blank'
      rel='noreferrer'
      onClick={(e) => e.stopPropagation()}
      className='text-[12px] text-slate-700 underline decoration-slate-300 underline-offset-2 transition-colors hover:text-[#007a99] hover:decoration-[#007a99] dark:text-slate-200 dark:decoration-slate-600 dark:hover:text-nvr-cyan dark:hover:decoration-nvr-cyan'
    >
      {label}
    </a>
  )
}
