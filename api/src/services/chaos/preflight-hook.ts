import { setDrillHooks } from './drill.js'
import { runPreflight } from './preflight.js'

/**
 * Hooks the pre-flight (#2848) into the drill lifecycle: POST /runs re-runs every check with
 * the caller's override; a failed list refuses the run (stored with status `refused` and the
 * checks in meta.preflight). Separate from preflight.ts so the checks stay a leaf for tests.
 */
let wired = false
export function wirePreflight(): void {
  if (wired) return
  wired = true
  setDrillHooks({
    preflight: async (input) => {
      const r = await runPreflight({
        override: input.override ?? null,
        gameday_id: input.gameday_id ?? null
      })
      return { ok: r.ok, checks: r.checks }
    }
  })
}
