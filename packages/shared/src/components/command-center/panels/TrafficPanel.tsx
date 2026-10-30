import { TrafficMiniMap } from '../../monitoring/TrafficMiniMap'
import { useCc } from '../state'
import { useAppIsDark } from '../theme'

/** Compact Traffic Map card — renders nothing for non-admins (the map route refuses them). */
export function TrafficPanel() {
  const { snapshot, tv } = useCc()
  const dark = useAppIsDark()
  if (!snapshot?.health) return null
  return <TrafficMiniMap tone={dark || tv ? 'dark' : 'auto'} />
}
