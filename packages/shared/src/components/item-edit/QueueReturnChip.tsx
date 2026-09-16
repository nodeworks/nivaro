import { ArrowLeft } from 'lucide-react'
import { useNavigation } from '../../context'

/**
 * #50 — "Back to <queue>" breadcrumb on a record opened FROM a queue. The
 * worklist stashes where it was (path, filters, scope, page, scroll) in
 * sessionStorage when it opens a record; this chip reads the stash and, on
 * click, marks it for restore and navigates back — the worklist re-applies
 * the stashed state and scroll position on mount. Host-agnostic: the stash
 * holds the worklist's own URL, so it works in the admin and in a portal.
 */
export const QUEUE_RETURN_KEY = 'nvr:queue-return'
const MAX_AGE_MS = 6 * 60 * 60 * 1000

export interface QueueReturnStash {
  queue_id: string
  name: string
  path: string
  at: number
  scroll: number
  state: {
    scope?: string
    page?: number
    sort?: string
    filters?: Record<string, string | string[]>
    group_by?: string | null
    view?: string
  }
  /** Set by the chip right before navigating back — the worklist consumes it once. */
  restore?: boolean
}

export function readQueueReturn(): QueueReturnStash | null {
  try {
    const raw = sessionStorage.getItem(QUEUE_RETURN_KEY)
    if (!raw) return null
    const s = JSON.parse(raw) as QueueReturnStash
    if (!s || typeof s !== 'object' || !s.path || Date.now() - Number(s.at ?? 0) > MAX_AGE_MS) {
      return null
    }
    return s
  } catch {
    return null
  }
}

export function writeQueueReturn(stash: QueueReturnStash | null): void {
  try {
    if (stash) sessionStorage.setItem(QUEUE_RETURN_KEY, JSON.stringify(stash))
    else sessionStorage.removeItem(QUEUE_RETURN_KEY)
  } catch {
    /* storage may be unavailable — the chip simply never shows */
  }
}

export function QueueReturnChip() {
  const nav = useNavigation()
  const stash = readQueueReturn()
  if (!stash) return null
  return (
    <div className='flex items-center' data-queue-return={stash.queue_id}>
      <button
        type='button'
        onClick={() => {
          writeQueueReturn({ ...stash, restore: true })
          nav.navigate(stash.path)
        }}
        className='inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11.5px] font-medium text-slate-600 transition-colors hover:border-nvr-cyan/50 hover:text-nvr-navy dark:border-border dark:bg-card dark:text-slate-300 dark:hover:text-nvr-cyan'
        data-tip='Return to the queue with its filters and scroll position'
      >
        <ArrowLeft className='h-3.5 w-3.5' />
        Back to {stash.name}
      </button>
    </div>
  )
}
