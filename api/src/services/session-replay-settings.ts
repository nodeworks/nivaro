/**
 * Session replay settings keys and their PATCH validation, in one place so
 * routes/settings.ts carries one call site for all of them.
 */
import { validateReplayMasking } from './session-replay-masking.js'

export const REPLAY_SETTINGS_KEYS = ['replay_masking']

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
  return null
}
