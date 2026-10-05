import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MailX } from 'lucide-react'
import { toast } from 'sonner'
import { useOptionalNivaroClient } from '../../context'
import { del, get } from '../../lib/commands'
import { cn, formatDate } from '../../lib/utils'

/**
 * Bounce handling (#1299): the mark a person carries while their address is
 * suppressed after a hard bounce. Rendered on the profile header and the
 * contact card; an admin clears it in place. Fetches lazily — the card only
 * asks while it is open — and renders nothing until the answer is "yes".
 */

export interface MailSuppression {
  suppressed: boolean
  id: number | null
  reason: string | null
  since: string | null
  last_seen?: string | null
  count?: number
}

export function useMailSuppression(email: string | null | undefined, enabled = true) {
  const client = useOptionalNivaroClient()
  const address = String(email ?? '')
    .trim()
    .toLowerCase()
  return useQuery<MailSuppression>({
    queryKey: ['mail-suppression', address],
    queryFn: () =>
      client!
        .request<{ data: MailSuppression }>(get('/mail-suppressions/check', { address }))
        .then((r) => r.data),
    enabled: !!client && enabled && address.includes('@'),
    staleTime: 60_000
  })
}

export function MailSuppressedPill({
  email,
  canClear = false,
  enabled = true,
  className
}: {
  email: string | null | undefined
  /** Admins may clear the mark in place; the server enforces it anyway. */
  canClear?: boolean
  /** Fetch only while the hosting surface is visible (a popover's open state). */
  enabled?: boolean
  className?: string
}) {
  const client = useOptionalNivaroClient()
  const qc = useQueryClient()
  const { data } = useMailSuppression(email, enabled)
  const clear = useMutation({
    mutationFn: (id: number) => client!.request(del(`/mail-suppressions/${id}`)),
    onSuccess: () => {
      toast.success(`Cleared — mail to ${String(email ?? '').trim()} will send again`)
      void qc.invalidateQueries({ queryKey: ['mail-suppression'] })
      void qc.invalidateQueries({ queryKey: ['mail-suppressions'] })
    },
    onError: (e: unknown) =>
      toast.error(e instanceof Error && e.message ? e.message : 'Could not clear the mark')
  })
  if (!data?.suppressed) return null
  const since = data.since ? formatDate(data.since) : null
  const tip = [
    'The mail relay refused this address with a hard bounce',
    data.reason ? `Reason: ${data.reason}` : null,
    data.count && data.count > 1 ? `${data.count} bounces` : null,
    'Nothing is sent there until an administrator clears the mark'
  ]
    .filter(Boolean)
    .join('\n')
  return (
    <span
      data-mail-suppressed={data.id ?? ''}
      data-tip={tip}
      className={cn(
        'inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-px text-[10.5px] font-semibold text-rose-700 dark:bg-rose-500/10 dark:text-rose-400',
        className
      )}
    >
      <MailX className='h-3 w-3 shrink-0' aria-hidden />
      Email bouncing{since ? ` · since ${since}` : ''}
      {canClear && data.id != null && (
        <button
          type='button'
          data-mail-suppressed-clear
          disabled={clear.isPending}
          onClick={(e) => {
            e.stopPropagation()
            clear.mutate(data.id as number)
          }}
          className='ml-0.5 rounded px-1 text-[10px] font-semibold text-rose-700 underline decoration-rose-300 underline-offset-2 hover:bg-rose-100 disabled:opacity-50 dark:text-rose-300 dark:decoration-rose-500/40 dark:hover:bg-rose-500/20'
        >
          Clear
        </button>
      )}
    </span>
  )
}
