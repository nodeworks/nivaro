/**
 * What the recorders are told alongside the enabled flags
 * (GET /session-recordings/enabled): the masking rules (#1361), per-route
 * sampling and whether today's byte cap is already reached (#1368).
 */
import { db } from '../db/index.js'
import { dailyCapStatus, type ReplaySampling, readReplaySampling } from './session-replay-cost.js'
import {
  DEFAULT_REPLAY_MASKING,
  parseReplayMasking,
  type ReplayMaskingRules
} from './session-replay-masking.js'

export interface ReplayClientPolicy {
  masking: ReplayMaskingRules
  sampling: ReplaySampling
  /** Today's recording cap is reached: don't start (the server would refuse). */
  cap_reached: boolean
}

export async function replayClientPolicy(): Promise<ReplayClientPolicy> {
  let masking = DEFAULT_REPLAY_MASKING
  try {
    const row = (await db('nivaro_settings').where({ id: 1 }).first('replay_masking')) as
      | { replay_masking?: unknown }
      | undefined
    masking = parseReplayMasking(row?.replay_masking)
  } catch {
    // Pre-migration database: everything stays masked.
  }
  const [sampling, cap] = await Promise.all([readReplaySampling(), dailyCapStatus()])
  return { masking, sampling, cap_reached: cap.reached }
}
