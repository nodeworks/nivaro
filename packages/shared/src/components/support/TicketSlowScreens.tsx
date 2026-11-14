import { Gauge } from 'lucide-react'
import { useState } from 'react'
import { useItemEditAuth } from '../../context'
import { looksLikeSlowness, SlowScreensCard } from '../profile/SlowScreensCard'

/**
 * On a support ticket, for administrators: the requester's slowest screens. Open at once when
 * the ticket talks about slowness ("slow", "takes forever", "spinning"…); otherwise one press
 * away, so a ticket about something else does not read their timings.
 */
export function TicketSlowScreens({
  userId,
  name,
  text
}: {
  userId: string | null | undefined
  name: string | null | undefined
  text: string
}) {
  const auth = useItemEditAuth()
  const aboutSlowness = looksLikeSlowness(text)
  const [open, setOpen] = useState(aboutSlowness)
  if (!auth?.isAdmin || !userId) return null
  const first = name?.split(' ')[0] ?? null
  if (!open)
    return (
      <button
        type='button'
        onClick={() => setOpen(true)}
        data-ticket-slow-screens-open
        className='inline-flex items-center gap-1.5 text-[12px] font-medium text-nvr-navy hover:underline dark:text-nvr-cyan'
      >
        <Gauge className='h-3.5 w-3.5' />
        Show {first ? `${first}’s` : 'their'} slowest screens
      </button>
    )
  return (
    <div data-ticket-slow-screens={aboutSlowness ? 'auto' : 'asked'}>
      <SlowScreensCard userId={userId} name={first} compact />
    </div>
  )
}
