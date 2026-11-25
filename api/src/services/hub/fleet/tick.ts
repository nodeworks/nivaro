import {
  type HubEnvStatus,
  type HubStatusTarget,
  readEnvironmentStatus,
  type StatusCache
} from '../status.js'
import { eachBounded, type ProbeSample, probeEnvironment } from './probe.js'
import {
  busyEnvironments,
  listProbeTargets,
  type ProbeTarget,
  readFleetStatus,
  recordSample,
  writeFleetStatus
} from './store.js'

/**
 * The fleet probe tick (cron hub-fleet-probe every minute, or Check now; Hub only; one at a time
 * through the nvr:hub:fleet-probe lock, lock.ts): for every active environment one uptime probe,
 * stored as a sample, and every STATUS_EVERY_MS (or on Check now) one status read through the
 * Hub's own status reader with `fresh` — which also refreshes the 30 s Redis status cache the Apps
 * page reads. Both land in nivaro_hub_fleet_status, which is all the fleet page reads.
 *
 *  - At most one sample per environment per minute: a probe within SAMPLE_GAP_MS of the last one
 *    stores no sample (Check now right after the cron tick refreshes status only).
 *  - Environments a Hub run is busy with (a running promotion/rollback/stack apply, an open move)
 *    store no sample: the Hub restarting them is a declared window, not an outage.
 *  - At most PROBE_WIDTH at once; no new environment starts after TICK_BUDGET_MS. The order rotates
 *    every tick, so an environment left out under a slow tick is a different one each time; one
 *    left out has no sample (never counted, up or down) and its row shows when it was last probed.
 */

export const STATUS_EVERY_MS = 5 * 60_000
export const PROBE_WIDTH = 8
export const TICK_BUDGET_MS = 45_000
export const SAMPLE_GAP_MS = 50_000

export interface TickDeps {
  now?: () => Date
  redis?: StatusCache | null
  probe?: (baseUrl: string) => Promise<ProbeSample>
  status?: (env: HubStatusTarget, redis: StatusCache | null) => Promise<HubEnvStatus>
  targets?: () => Promise<ProbeTarget[]>
  busy?: () => Promise<Set<number>>
  /** Check now: read every environment's status, whatever its age. */
  forceStatus?: boolean
}

export interface TickResult {
  environments: number
  probed: number
  samples: number
  status_reads: number
  skipped: number
  busy: number
  down: number
}

/** `items` starting at `offset` (wrapping), so each tick leads with different environments. */
export function rotate<T>(items: T[], offset: number): T[] {
  if (!items.length) return items
  const k = ((offset % items.length) + items.length) % items.length
  return [...items.slice(k), ...items.slice(0, k)]
}

export async function runFleetProbeTick(deps: TickDeps = {}): Promise<TickResult> {
  const now = deps.now ?? (() => new Date())
  const started = now().getTime()
  const probe = deps.probe ?? ((url: string) => probeEnvironment(url))
  const status =
    deps.status ??
    ((env: HubStatusTarget, redis: StatusCache | null) =>
      readEnvironmentStatus(env, { fresh: true, redis }))
  const all = await (deps.targets ?? listProbeTargets)()
  const busy = await (deps.busy ?? busyEnvironments)()
  // A different lead every minute: with N environments and 8 lanes, skipped ones move round.
  const targets = rotate(all, Math.floor(started / 60_000) * PROBE_WIDTH)
  const known = await readFleetStatus(targets.map((t) => t.id))
  let statusReads = 0
  let samples = 0
  let down = 0
  const out = await eachBounded(
    targets,
    PROBE_WIDTH,
    async (t) => {
      const last = known.get(t.id)
      const statusDue =
        deps.forceStatus ||
        !last?.checked_at ||
        started - new Date(last.checked_at).getTime() >= STATUS_EVERY_MS - 5_000
      const sampleDue =
        !busy.has(t.id) &&
        (!last?.probed_at || started - new Date(last.probed_at).getTime() >= SAMPLE_GAP_MS)
      const [sample, st] = await Promise.all([
        sampleDue ? probe(t.base_url) : Promise.resolve(null),
        statusDue
          ? status(
              {
                id: t.id,
                key: t.key,
                base_url: t.base_url,
                hub_token: t.hub_token,
                placement_id: t.placement_id
              },
              deps.redis ?? null
            ).catch(() => null)
          : Promise.resolve(null)
      ])
      const at = now()
      if (sample) {
        await recordSample(t.id, sample, at)
        samples++
        if (!sample.up) down++
      }
      if (st) statusReads++
      if (sample || st)
        await writeFleetStatus(
          t.id,
          t.app_id,
          { ...(sample ? { probe: sample } : {}), ...(st ? { status: st } : {}) },
          at
        )
    },
    started + TICK_BUDGET_MS,
    () => now().getTime()
  )
  return {
    environments: targets.length,
    probed: out.done,
    samples,
    status_reads: statusReads,
    skipped: out.skipped,
    busy: targets.filter((t) => busy.has(t.id)).length,
    down
  }
}
