/**
 * What the recorders are told alongside the enabled flags
 * (GET /session-recordings/enabled): the masking rules (#1361).
 */
import { db } from '../db/index.js'
import {
  DEFAULT_REPLAY_MASKING,
  parseReplayMasking,
  type ReplayMaskingRules
} from './session-replay-masking.js'

export interface ReplayClientPolicy {
  masking: ReplayMaskingRules
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
  return { masking }
}
