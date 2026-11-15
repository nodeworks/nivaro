import { useAttentionPrefs } from '../lib/attention-prefs'
import { useTabAttention } from '../lib/tab-attention'
import { useWaitingCount } from '../lib/waiting-count'

/**
 * Puts what is waiting on the signed-in person in the browser tab: "(3) My Work · App" in
 * the title and a small numbered dot on the tab icon (the host's own icon, white-label
 * included). The number is the My Work figure — records you own, approvals, tasks and
 * questions — and follows it live. Profile → Display → "Count in the tab" turns it off.
 *
 * Mount ONCE per app shell (inside the query, Nivaro and realtime providers); renders nothing.
 * `extra` adds host-side items the My Work figure does not hold.
 */
export function TabCountHost({ extra = 0 }: { extra?: number }) {
  const { tabCount } = useAttentionPrefs()
  const waiting = useWaitingCount(tabCount)
  useTabAttention(waiting + (tabCount ? extra : 0), { enabled: tabCount, favicon: true })
  return null
}
