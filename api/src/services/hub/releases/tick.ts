import { judgeWatches, openWatches } from './auto-rollback.js'
import { runDueSchedules } from './schedules.js'
import { advanceRunningTrains } from './trains.js'

/**
 * The Hub's release-operations minute, two jobs (one leader each, ticking only where
 * cronTicksEnabled):
 *
 *  - `hub-release-rollback` (rollbackTick): opens and judges automatic rollback watches. Its own
 *    job so a rollback is never judged late behind slow GitLab calls of starts.
 *  - `hub-release-ops` (releaseOpsTick): starts due schedules and moves running trains on.
 *
 * Every part is state in the database, so a tick that stops (a restart, a lost lease) is resumed
 * by the next one. A part that throws never stops the others.
 */
export interface TickResult {
  schedules: number
  trains: number
  watches_opened: number
  rolled_back: number
  errors: string[]
}

const empty = (): TickResult => ({
  schedules: 0,
  trains: 0,
  watches_opened: 0,
  rolled_back: 0,
  errors: []
})

async function part(
  out: TickResult,
  name: string,
  run: () => Promise<number>,
  set: (n: number) => void
) {
  try {
    set(await run())
  } catch (err) {
    out.errors.push(`${name}: ${(err as Error | null)?.name ?? 'Error'}`)
  }
}

export async function rollbackTick(): Promise<TickResult> {
  const out = empty()
  await part(
    out,
    'watches',
    () => openWatches(),
    (n) => (out.watches_opened = n)
  )
  await part(
    out,
    'rollbacks',
    () => judgeWatches(),
    (n) => (out.rolled_back = n)
  )
  return out
}

export async function releaseOpsTick(): Promise<TickResult> {
  const out = empty()
  await part(
    out,
    'schedules',
    () => runDueSchedules(),
    (n) => (out.schedules = n)
  )
  await part(
    out,
    'trains',
    () => advanceRunningTrains(),
    (n) => (out.trains = n)
  )
  return out
}
