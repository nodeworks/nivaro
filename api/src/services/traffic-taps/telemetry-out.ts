// api/src/services/traffic-taps/telemetry-out.ts
/**
 * Topology tap `telemetry-out` (#2544): one structured `nvr: "out"` line per finished partner
 * call, next to the per-request access line, so the telemetry stack can keep the Traffic Map's
 * partner nodes (`d:<down id>`) for 13 months. Same gate as the access line
 * (TELEMETRY_ACCESS_LOG=on; never in cloud mode). The line is built by `outLogLine` (ids,
 * status, timing — no names, paths or error text).
 */
import { getApp } from '../io-holder.js'
import { instanceKey } from '../settings-overrides.js'
import { accessLogEnabled, outLogLine } from '../telemetry-store.js'
import { registerTrafficTap } from '../traffic-taps.js'

export const TELEMETRY_OUT_TAP = 'telemetry-out'

let instance: string | null = null
const inst = () => {
  instance ??= instanceKey().slice(0, 60)
  return instance
}

registerTrafficTap({
  id: TELEMETRY_OUT_TAP,
  onOutbound: (c) => {
    if (!accessLogEnabled()) return
    const log = (getApp() as { log?: { info(o: object, msg: string): void } } | null)?.log
    if (!log) return
    log.info(
      outLogLine({
        down: c.downId,
        entity: c.entityKey,
        status: c.ev.status,
        ms: c.ev.durationMs,
        failed: c.failed,
        instance: inst()
      }),
      'api-out'
    )
  }
})
