import { useSyncExternalStore } from 'react'
import { huddleDevices } from './huddle-devices'
import { huddleQuality, type QualityState } from './huddle-link-quality'
import { huddleShortcuts, type ShortcutState } from './huddle-shortcuts'
import { huddleSpeaking, type SpeakingSnapshot } from './huddle-speaking'

/**
 * Audio quality and control for huddles (#2845–#2848): speaking detection,
 * keyboard shortcuts, device handling and connection quality. Each engine
 * watches the huddle store and runs only while I am in a huddle; starting
 * them is idempotent, so every useHuddle() call may ask.
 */
export function startHuddleExtras() {
  huddleSpeaking.start()
  huddleQuality.start()
  huddleShortcuts.start()
  huddleDevices.start()
}

export function useHuddleSpeaking(): SpeakingSnapshot {
  return useSyncExternalStore(
    huddleSpeaking.subscribe,
    huddleSpeaking.getSnapshot,
    huddleSpeaking.getSnapshot
  )
}

export function useHuddleQuality(): QualityState {
  return useSyncExternalStore(
    huddleQuality.subscribe,
    huddleQuality.getSnapshot,
    huddleQuality.getSnapshot
  )
}

export function useHuddleShortcuts(): ShortcutState {
  return useSyncExternalStore(
    huddleShortcuts.subscribe,
    huddleShortcuts.getSnapshot,
    huddleShortcuts.getSnapshot
  )
}
