// api/src/services/traffic-taps/channels.ts
/**
 * Topology tap `channels` (#1140): email, SMS, web push and Teams as downstream nodes — every
 * send attempt with its outcome (sent / failed / dropped / deferred) and the sends test mode
 * redirected to the test recipient, fed by the senders themselves (mail.ts, sms.ts,
 * web-push.ts, microsoft.ts).
 */
import { noteDown } from '../traffic-map.js'
import { registerTrafficTap, tapState } from '../traffic-taps.js'
import { noteSourceDown } from './sources.js'
import { currentEntityKey, MinuteTotals } from './util.js'

export const CHANNELS_TAP = 'channels'
export type Channel = 'mail' | 'sms' | 'push' | 'teams'
export type ChannelOutcome = 'sent' | 'failed' | 'dropped' | 'deferred'
export const CHANNEL_LABELS: Record<Channel, string> = {
  mail: 'Email',
  sms: 'SMS',
  push: 'Web push',
  teams: 'Teams'
}
const OUTCOMES: Array<ChannelOutcome | 'redirected'> = [
  'sent',
  'failed',
  'dropped',
  'deferred',
  'redirected'
]

function state(): { counts: MinuteTotals } {
  return tapState(CHANNELS_TAP, () => ({ counts: new MinuteTotals(30) }))
}

/**
 * One send attempt on a channel. `n` = recipients/devices it reached (default 1); `ms` = how long
 * the transport took. Never throws.
 */
export function noteChannel(
  channel: Channel,
  outcome: ChannelOutcome,
  opts: { ms?: number; n?: number } = {}
): void {
  if (process.env.CLOUD_META_DB_URL) return
  try {
    const at = Date.now()
    state().counts.add(`${channel}|${outcome}`, Math.floor(at / 1000), opts.n ?? 1)
    noteDown({
      id: channel,
      label: CHANNEL_LABELS[channel],
      kind: 'channel',
      ok: outcome !== 'failed',
      ms: opts.ms,
      at,
      entityKey: currentEntityKey()
    })
    noteSourceDown(channel, at)
  } catch {
    /* never */
  }
}

/** Sends test mode sent to the test recipient instead of the intended one. */
export function noteChannelRedirect(channel: Channel, n = 1): void {
  if (process.env.CLOUD_META_DB_URL || n <= 0) return
  try {
    state().counts.add(`${channel}|redirected`, Math.floor(Date.now() / 1000), n)
  } catch {
    /* never */
  }
}

registerTrafficTap({
  id: CHANNELS_TAP,
  snapshot(windowS, sec) {
    const counts = state().counts
    const out: Record<string, Record<string, number>> = {}
    for (const ch of Object.keys(CHANNEL_LABELS)) {
      const row: Record<string, number> = {}
      let any = false
      for (const o of OUTCOMES) {
        const n = counts.sum(`${ch}|${o}`, windowS, sec)
        row[o] = n
        if (n) any = true
      }
      if (any) out[ch] = row
    }
    return Object.keys(out).length ? out : undefined
  },
  sweep(sec) {
    state().counts.sweep(sec)
  }
})
