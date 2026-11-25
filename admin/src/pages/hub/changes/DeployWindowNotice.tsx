import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Clock } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/lib/auth'
import { formatDateTime } from '@/lib/utils'
import { hubToast } from '../hub-api'
import { ghostButton } from '../hub-parts'
import { changeKeys, queuePromotion } from './changes-api'

/**
 * The Promote panel's notice when a deploy window governs the environment and none is open: the
 * Hub will refuse the start (409 OUTSIDE_WINDOW). An administrator can queue it instead — a
 * scheduled promotion a minute into the next opening — once they typed the environment key.
 */
export function DeployWindowNotice({
  envId,
  envKey,
  version,
  confirm,
  opensAt,
  message
}: {
  envId: number
  envKey?: string
  version?: string
  confirm?: string
  opensAt: string
  message: string
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
      className='flex flex-wrap items-start gap-x-3 gap-y-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200'
    >
      <Clock className='mt-0.5 h-3.5 w-3.5 shrink-0' aria-hidden />
      <p className='m-0 min-w-0 flex-[1_1_260px]'>
        {windowPart}. The next window opens {formatDateTime(opensAt)} — the Hub refuses this start
        until then.
      </p>
      {isAdmin && version && (
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
    </div>
  )
}
