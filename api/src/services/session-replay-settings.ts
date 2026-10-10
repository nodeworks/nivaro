/**
 * Session replay settings keys and their PATCH validation, in one place so
 * routes/settings.ts carries one call site for all of them.
 */
import {
  bustReplayCapCache,
  validateDailyCapMb,
  validateReplaySampling
} from './session-replay-cost.js'
import { validateReplayMasking } from './session-replay-masking.js'

export const REPLAY_SETTINGS_KEYS = ['replay_masking', 'replay_daily_cap_mb', 'replay_sampling']

/**
 * Validate and normalise the replay keys present in a settings patch, in
 * place. Returns an error message for a 400, or null.
 */
export function applyReplaySettingsPatch(patch: Record<string, unknown>): string | null {
  if ('replay_masking' in patch) {
    const r = validateReplayMasking(patch.replay_masking)
    if ('error' in r) return r.error
    patch.replay_masking = r.value
  }
  if ('replay_daily_cap_mb' in patch) {
    const r = validateDailyCapMb(patch.replay_daily_cap_mb)
    if ('error' in r) return r.error
    patch.replay_daily_cap_mb = r.value
    bustReplayCapCache()
  }
  if ('replay_sampling' in patch) {
    const r = validateReplaySampling(patch.replay_sampling)
    if ('error' in r) return r.error
    patch.replay_sampling = r.value
  }
  return null
}
