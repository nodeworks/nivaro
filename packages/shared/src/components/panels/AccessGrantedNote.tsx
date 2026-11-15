import { useQuery } from '@tanstack/react-query'
import { Check, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { cn } from '../../lib/utils'

// ─── Access came back while the page was open (rt4 #11) ──────────────────────
// A record or list that answered "you can't view this" re-reads itself when this person's
// permissions move (`access:changed`, lib/user-sync.ts) — typically an administrator granting
// their access request. When the read now works the content simply appears, with one quiet
// line saying so: "Access granted by Beth". No toast, no sound.

/**
 * True from the moment a page that was refused becomes readable, until it shows another
 * record (`resetKey`). `denied` = the read is refused now; `readable` = it answered.
 * Exported for tests.
 */
export function useAccessRegained(denied: boolean, readable: boolean, resetKey: string): boolean {
  const [regainedFor, setRegainedFor] = useState<string | null>(null)
  useEffect(() => {
    if (denied) {
      noteRefused(resetKey)
      return
    }
    if (readable && takeRefused(resetKey)) setRegainedFor(resetKey)
  }, [denied, readable, resetKey])
  return regainedFor === resetKey
}

/**
 * Pages refused in this tab lately. Kept outside the component: a host may mount the form
 * afresh once the record reads (a page-level wrapper switching from its own loading state),
 * and the note must still appear there.
 */
const REFUSED_TTL_MS = 30 * 60_000
const refused = new Map<string, number>()
function noteRefused(key: string): void {
  const now = Date.now()
  refused.set(key, now)
  if (refused.size > 200)
    for (const [k, at] of refused) if (now - at > REFUSED_TTL_MS) refused.delete(k)
}
function takeRefused(key: string): boolean {
  const at = refused.get(key)
  if (at == null) return false
  refused.delete(key)
  return Date.now() - at < REFUSED_TTL_MS
}

interface MineAnswer {
  status: string
  resolved_by_first: string | null
}

/** "Access granted by Beth" / "Access granted" — the words alone. Exported for tests. */
export function accessGrantedText(answer: MineAnswer | null | undefined): string {
  const by = answer?.status === 'granted' ? answer.resolved_by_first?.trim() : ''
  return by ? `Access granted by ${by}` : 'Access granted'
}

export function AccessGrantedNote({
  collection,
  itemId,
  className
}: {
  collection: string
  /** The record; omitted for a whole list. */
  itemId?: string | null
  className?: string
}) {
  const client = useNivaroClient()
  const [hidden, setHidden] = useState(false)
  const { data, isFetched } = useQuery<MineAnswer | null>({
    queryKey: ['access-request-mine', collection, itemId ?? ''],
    queryFn: () =>
      client
        .request<{ data: MineAnswer | null }>(
          get('/access-requests/mine', {
            collection,
            ...(itemId ? { item: String(itemId) } : {})
          })
        )
        .then((r) => r.data ?? null)
        .catch(() => null),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false
  })
  // Wait for the name rather than show "Access granted" and then grow it.
  if (hidden || !isFetched) return null
  return (
    <div
      role='status'
      data-access-granted
      className={cn(
        'nvr-fade-in flex items-start gap-1.5 text-[12px] leading-5 text-slate-600 dark:text-slate-300',
        className
      )}
    >
      <Check
        className='mt-[3px] h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400'
        aria-hidden
      />
      <span className='min-w-0'>{accessGrantedText(data)}</span>
      <button
        type='button'
        onClick={() => setHidden(true)}
        aria-label='Dismiss'
        className='ml-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-muted hover:text-slate-600 dark:hover:text-slate-200'
      >
        <X className='h-3 w-3' />
      </button>
    </div>
  )
}
