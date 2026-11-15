import type { PresenceState } from '../lib/use-online-users'

/**
 * The small "is this person here" dot beside a name in a people picker or mention list
 * (rt4 #22). A dot only: it never changes the order of the list and says nothing when the
 * person is not visible as present to the viewer (`state` undefined renders nothing).
 * Green = online, hollow amber = idle or away.
 */
export function PresenceDot({
  state,
  className = ''
}: {
  state: PresenceState | undefined
  className?: string
}) {
  if (!state) return null
  const online = state === 'online'
  return (
    <span
      data-presence-dot={state}
      role='img'
      aria-label={online ? 'Online' : 'Idle'}
      data-tip={online ? 'Online now' : 'Idle'}
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${
        online ? 'bg-emerald-500' : 'border border-amber-500 bg-transparent'
      } ${className}`}
    />
  )
}
