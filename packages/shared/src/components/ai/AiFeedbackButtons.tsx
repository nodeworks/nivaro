import { ThumbsDown, ThumbsUp } from 'lucide-react'
import { useState } from 'react'
import { useOptionalNivaroClient } from '../../context'
import { post } from '../../lib/commands'
import { cn } from '../../lib/utils'

/**
 * Thumbs up / down on one assistant answer, keyed by the chat request id the
 * API returned. One rating per person per question (a second click replaces
 * it). Renders nothing without a request id or a NivaroProvider.
 */
export function AiFeedbackButtons({
  requestId,
  className
}: {
  requestId?: string | null
  className?: string
}) {
  const client = useOptionalNivaroClient()
  const [rating, setRating] = useState<1 | -1 | null>(null)
  const [busy, setBusy] = useState(false)
  if (!requestId || !client) return null

  const send = async (next: 1 | -1) => {
    if (busy) return
    setBusy(true)
    const prev = rating
    setRating(next)
    try {
      await client.request(post('/ai/feedback', { request_id: requestId, rating: next }))
    } catch {
      setRating(prev)
    } finally {
      setBusy(false)
    }
  }

  const btn = (value: 1 | -1, Icon: typeof ThumbsUp, label: string) => (
    <button
      type='button'
      onClick={() => send(value)}
      aria-label={label}
      aria-pressed={rating === value}
      data-ai-feedback={value > 0 ? 'up' : 'down'}
      className={cn(
        'inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
        rating === value &&
          (value > 0
            ? 'text-emerald-600 dark:text-emerald-400'
            : 'text-rose-600 dark:text-rose-400')
      )}
    >
      <Icon className='h-3.5 w-3.5' />
    </button>
  )

  return (
    <div className={cn('inline-flex items-center gap-0.5', className)} data-ai-feedback-row>
      {btn(1, ThumbsUp, 'Helpful answer')}
      {btn(-1, ThumbsDown, 'Not helpful')}
      {rating != null && (
        <span className='ml-1 text-[10.5px] text-muted-foreground'>
          {rating > 0
            ? 'Thanks — this answer will be reused.'
            : 'Noted — this answer will not be reused.'}
        </span>
      )}
    </div>
  )
}
