import {
  type HubEnvStatus,
  type HubStatusTarget,
  readEnvironmentStatus,
  type StatusCache
} from '../status.js'
import { eachBounded, type ProbeSample, probeEnvironment } from './probe.js'
import {
  listProbeTargets,
  type ProbeTarget,
  readFleetStatus,
  recordSample,
  writeFleetStatus
} from './store.js'

/**
 * The fleet probe tick (cron hub-fleet-probe, every minute, Hub only, one leader through the cron
 * lease): for every active environment one uptime probe (stored as a sample), and every
 * STATUS_EVERY_MS one status read through the Hub's own status reader (hub link, public, or the
 * shared deployment's link) with `fresh` — which also refreshes the 30 s Redis status cache the
 * Apps page reads. Both land in nivaro_hub_fleet_status, which is all the fleet page reads: a page
 * load never fans out to the apps.
 *
 * At most PROBE_WIDTH environments at once; no new environment starts after TICK_BUDGET_MS, so a
 * tick ends before the next one (an environment left out this minute simply has no sample — no
 * sample never counts as down).
 */

export const STATUS_EVERY_MS = 5 * 60_000
export const PROBE_WIDTH = 8
export const TICK_BUDGET_MS = 45_000

export interface TickDeps {
  now?: () => Date
  redis?: StatusCache | null
  probe?: (baseUrl: string) => Promise<ProbeSample>
  status?: (env: HubStatusTarget, redis: StatusCache | null) => Promise<HubEnvStatus>
  targets?: () => Promise<ProbeTarget[]>
}

export interface TickResult {
  environments: number
  probed: number
  status_reads: number
  skipped: number
  down: number
}

export async function runFleetProbeTick(deps: TickDeps = {}): Promise<TickResult> {
  const now = deps.now ?? (() => new Date())
  const started = now().getTime()
  const probe = deps.probe ?? ((url: string) => probeEnvironment(url))
  const status =
    deps.status ??
    ((env: HubStatusTarget, redis: StatusCache | null) =>
      readEnvironmentStatus(env, { fresh: true, redis }))
  const targets = await (deps.targets ?? listProbeTargets)()
  const known = await readFleetStatus(targets.map((t) => t.id))
  let statusReads = 0
  let down = 0
  const out = await eachBounded(
    targets,
    PROBE_WIDTH,
    async (t) => {
      const last = known.get(t.id)?.checked_at
      const due = !last || started - new Date(last).getTime() >= STATUS_EVERY_MS - 5_000
      const [sample, st] = await Promise.all([
        probe(t.base_url),
        due
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
      await recordSample(t.id, sample, at)
      if (!sample.up) down++
      if (st) statusReads++
      await writeFleetStatus(t.id, t.app_id, { probe: sample, ...(st ? { status: st } : {}) }, at)
    },
    started + TICK_BUDGET_MS,
    () => now().getTime()
  )
  return {
    environments: targets.length,
    probed: out.done,
    status_reads: statusReads,
    skipped: out.skipped,
    down
  }
}
