import { refreshSightings, settleExtensionPromotions } from './extensions.js'
import { queueNewRuns, runDueRuns } from './smoke.js'

/**
 * The Hub verification jobs (one leader each, ticking only where cronTicksEnabled):
 *
 *  - `hub-verify-smoke` (every minute): queues a smoke run for each deploy, move and shared
 *    upgrade that finished since the last tick, runs the runs that are due, and settles extension
 *    promotions whose deploy ended.
 *  - `hub-verify-extensions` (every 30 minutes): reads which extensions each environment runs and
 *    what the Hub pins there.
 *
 * Every part is state in the database, so a stopped tick is picked up by the next one; a part
 * that throws never stops the others.
 */
export interface VerifyTickResult {
  queued: number
  ran: number
  settled: number
  read: number
  errors: string[]
}

const empty = (): VerifyTickResult => ({ queued: 0, ran: 0, settled: 0, read: 0, errors: [] })

async function part(
  out: VerifyTickResult,
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

export async function smokeTick(): Promise<VerifyTickResult> {
  const out = empty()
  await part(
    out,
    'queue',
    () => queueNewRuns(),
    (n) => (out.queued = n)
  )
  await part(
    out,
    'run',
    () => runDueRuns(),
    (n) => (out.ran = n)
  )
  await part(
    out,
    'settle',
    () => settleExtensionPromotions(),
    (n) => (out.settled = n)
  )
  return out
}

export async function extensionsTick(): Promise<VerifyTickResult> {
  const out = empty()
  await part(
    out,
    'sightings',
    () => refreshSightings(),
    (n) => (out.read = n)
  )
  return out
}
