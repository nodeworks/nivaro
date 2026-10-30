import { TrafficMiniMap } from '../../monitoring/TrafficMiniMap'
import { useCc } from '../state'
import { useAppIsDark } from '../theme'
import { LiveOnlyBadge } from './TimeBar'

/**
 * Compact Traffic Map card — renders nothing for non-admins (the map route refuses them).
 * Clicking a point on a lane's sparkline rewinds the whole board to that minute (CC-15). The
 * card itself always shows the last few minutes, so a rewound board marks it "Live only".
 */
export function TrafficPanel() {
  const { snapshot, tv, at, setAt } = useCc()
  const dark = useAppIsDark()
  if (!snapshot?.health) return null
  return (
    <div className='flex flex-col gap-1' data-cc-panel='traffic'>
      {at != null && (
        <span className='flex justify-end'>
          <LiveOnlyBadge label='Traffic: live only' />
        </span>
      )}
      <TrafficMiniMap tone={dark || tv ? 'dark' : 'auto'} onPickTime={(ms) => setAt(ms)} />
    </div>
  )
}
