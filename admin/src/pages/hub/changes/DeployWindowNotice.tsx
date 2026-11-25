import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Clock } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/lib/auth'
import { cn, formatDateTime } from '@/lib/utils'
import { hubToast } from '../hub-api'
import { ghostButton } from '../hub-parts'
import { changeKeys, queuePromotion } from './changes-api'
import { OutsideWindowOverride } from './WindowGate'

/**
 * The Promote panel's notice when a deploy window governs the environment and none is open: the
 * Hub will refuse the start (409 OUTSIDE_WINDOW, or WINDOW_INVALID when a window cannot be
 * read). An administrator can queue it for the next opening (once they typed the environment
 * key), or — an emergency — start it outside the window with a typed reason.
 */
export function DeployWindowNotice({
  envId,
  envKey,
  version,
  confirm,
  opensAt,
  invalid,
  message,
  onOutsideReason
}: {
  envId: number
  envKey?: string
  version?: string
  confirm?: string
  /** The next opening; null = none within 14 days (or the window cannot be read). */
  opensAt: string | null
  invalid?: boolean
  message: string
  onOutsideReason?: (reason: string | null) => void
}) {
  const { user } = useAuth()
  const isAdmin = !!(user as { is_admin?: boolean } | null)?.is_admin
  const qc = useQueryClient()
  const typed = !!envKey && confirm?.trim() === envKey
  const queue = useMutation({
    mutationFn: () => queuePromotion(envId, version ?? '', confirm?.trim() ?? ''),
    onSuccess: (s) => {
      toast.success(`Queued for ${formatDateTime(s.run_at)}`, {
        description: 'It shows under Releases → Scheduled and on the change calendar.'
      })
      void qc.invalidateQueries({ queryKey: changeKeys.all })
      void qc.invalidateQueries({ queryKey: ['hub-releases'] })
    },
    onError: (err) => hubToast(err, 'Could not queue the promotion')
  })
  // The server's sentence names the window; the opening is shown in the viewer's own time.
  const windowPart = message.split('. ')[0]
  return (
    <div
      role='status'
      className={cn(
        'flex flex-wrap items-start gap-x-3 gap-y-2 rounded-md border px-3 py-2 text-[12px]',
        invalid
          ? 'border-red-200 bg-red-50 text-red-900 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200'
          : 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200'
      )}
    >
      <Clock className='mt-0.5 h-3.5 w-3.5 shrink-0' aria-hidden />
      <p className='m-0 min-w-0 flex-[1_1_260px]'>
        {invalid
          ? `${windowPart}.`
          : opensAt
            ? `${windowPart}. The next window opens ${formatDateTime(opensAt)} — the Hub refuses this start until then.`
            : `${windowPart}. No window opens in the next 14 days.`}
      </p>
      {isAdmin && version && opensAt && !invalid && (
        <button
          type='button'
          className={ghostButton}
          disabled={!typed || queue.isPending || queue.isSuccess}
          data-tip={typed ? undefined : `Type ${envKey} below first`}
          onClick={() => queue.mutate()}
        >
          {queue.isSuccess ? 'Queued' : queue.isPending ? 'Queuing…' : 'Queue for the next window'}
        </button>
      )}
      {onOutsideReason && <OutsideWindowOverride what='promotion' onReason={onOutsideReason} />}
    </div>
  )
}
