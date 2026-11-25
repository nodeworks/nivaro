import { judgeWatches, openWatches } from './auto-rollback.js'
import { runDueSchedules } from './schedules.js'
import { advanceRunningTrains } from './trains.js'

/**
 * The Hub's release-operations minute (cron `hub-release-ops`, one leader, ticks only where
 * cronTicksEnabled): starts due schedules, moves running trains on, opens and judges automatic
 * rollback watches. Every part is state in the database, so a tick that stops (a restart, a
 * lost lease) is resumed by the next one. A part that throws never stops the others.
 */
export interface TickResult {
  schedules: number
  trains: number
  watches_opened: number
  rolled_back: number
  errors: string[]
}

export async function releaseOpsTick(): Promise<TickResult> {
  const out: TickResult = { schedules: 0, trains: 0, watches_opened: 0, rolled_back: 0, errors: [] }
  const part = async (name: string, run: () => Promise<number>, set: (n: number) => void) => {
    try {
      set(await run())
    } catch (err) {
      out.errors.push(`${name}: ${(err as Error | null)?.name ?? 'Error'}`)
    }
  }
  await part(
    'schedules',
    () => runDueSchedules(),
    (n) => (out.schedules = n)
  )
  await part(
    'trains',
    () => advanceRunningTrains(),
    (n) => (out.trains = n)
  )
  await part(
    'watches',
    () => openWatches(),
    (n) => (out.watches_opened = n)
  )
  await part(
    'rollbacks',
    () => judgeWatches(),
    (n) => (out.rolled_back = n)
  )
  return out
}
