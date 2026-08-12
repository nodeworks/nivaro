import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Lock } from 'lucide-react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'

// ─── Access denied explanation ───────────────────────────────────────────────
// Rendered by ItemEditForm when the record load 403/404s. A scoped user used
// to get a silently empty form — this asks /access-explain WHY and says it in
// plain language (role permission, RLS row filter, or which User Scope
// dimension excludes the record and what the user IS limited to).

interface AccessReason {
  type: 'permission' | 'not_found' | 'row_filter' | 'scope' | 'scope_strict'
  message: string
  dimension?: string
  dimension_label?: string
  allowed_values?: string[]
}

export function AccessDeniedPanel({
  collection,
  itemId,
  onBack
}: {
  collection: string
  itemId: string
  /** Host-provided back action (e.g. navigate(-1)); renders a button when set. */
  onBack?: () => void
}) {
  const client = useNivaroClient()
  const { data, isLoading } = useQuery<{ access: boolean; reasons: AccessReason[] } | null>({
    queryKey: ['access-explain', collection, String(itemId)],
    queryFn: () =>
      client
        .request<{ data: { access: boolean; reasons: AccessReason[] } }>(
          get(`/access-explain/${collection}/${encodeURIComponent(itemId)}`)
        )
        .then((r) => r.data ?? null)
        .catch(() => null),
    staleTime: 30_000
  })

  const reasons = data?.reasons ?? []
  const notFound = reasons.some((r) => r.type === 'not_found')

  return (
    <div className='flex flex-1 items-start justify-center px-6 py-16'>
      <div className='w-full max-w-[560px] rounded-xl border border-slate-200 bg-white p-8 dark:border-border dark:bg-card'>
        <div className='flex items-center gap-3'>
          <span className='flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-100 dark:bg-muted'>
            <Lock className='h-[18px] w-[18px] text-slate-500 dark:text-slate-400' />
          </span>
          <div>
            <h2 className='text-[15px] font-semibold text-slate-800 dark:text-slate-100'>
              {notFound ? 'Record not found' : "You can't view this record"}
            </h2>
            <p className='text-[12px] text-slate-500 dark:text-slate-400'>
              {collection.replace(/_/g, ' ')} · #{itemId}
            </p>
          </div>
        </div>

        <div className='mt-5 space-y-2.5'>
          {isLoading ? (
            <>
              <div className='animate-pulse h-4 w-3/4 rounded bg-slate-200 dark:bg-[hsl(var(--nvr-skeleton))]' />
              <div className='animate-pulse h-4 w-1/2 rounded bg-slate-200 dark:bg-[hsl(var(--nvr-skeleton))]' />
            </>
          ) : reasons.length > 0 ? (
            reasons.map((r, i) => (
              <div
                key={`${r.type}-${r.dimension ?? i}`}
                className='rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-[13px] leading-relaxed text-slate-700 dark:border-border dark:bg-muted/40 dark:text-slate-300'
              >
                {r.message}
              </div>
            ))
          ) : (
            <div className='rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-[13px] leading-relaxed text-slate-700 dark:border-border dark:bg-muted/40 dark:text-slate-300'>
              This record could not be loaded. It may have been deleted, or an access rule may
              be hiding it.
            </div>
          )}
        </div>

        {!notFound && !isLoading && reasons.length > 0 && (
          <p className='mt-4 text-[12px] text-slate-500 dark:text-slate-400'>
            If you need access, contact an administrator — they can adjust your role's
            permissions or your access filters.
          </p>
        )}

        {onBack && (
          <button
            type='button'
            onClick={onBack}
            className='mt-5 inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-3 py-1.5 text-[12px] font-medium text-slate-600 hover:bg-slate-50 dark:border-border dark:text-slate-300 dark:hover:bg-white/[0.03]'
          >
            <ArrowLeft className='h-3.5 w-3.5' />
            Go back
          </button>
        )}
      </div>
    </div>
  )
}
