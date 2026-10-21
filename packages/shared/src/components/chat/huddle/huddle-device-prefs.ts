/**
 * Huddle device choices (#2847), remembered per browser. Device ids are
 * per-origin and per-browser anyway, so localStorage is the right home; every
 * read and write survives a private window or blocked storage.
 */

export interface HuddleDevicePrefs {
  /** null = the system default microphone. */
  micId: string | null
  /** null = the system default output. */
  speakerId: string | null
  noiseSuppression: boolean
  echoCancellation: boolean
  autoGainControl: boolean
}

export const DEFAULT_DEVICE_PREFS: HuddleDevicePrefs = {
  micId: null,
  speakerId: null,
  noiseSuppression: true,
  echoCancellation: true,
  autoGainControl: true
}

const KEY = 'nvr-huddle-devices'

export function parseDevicePrefs(raw: string | null): HuddleDevicePrefs {
  if (!raw) return { ...DEFAULT_DEVICE_PREFS }
  try {
    const v = JSON.parse(raw) as Partial<HuddleDevicePrefs>
    const str = (x: unknown) => (typeof x === 'string' && x ? x : null)
    const bool = (x: unknown, d: boolean) => (typeof x === 'boolean' ? x : d)
    return {
      micId: str(v.micId),
      speakerId: str(v.speakerId),
      noiseSuppression: bool(v.noiseSuppression, true),
      echoCancellation: bool(v.echoCancellation, true),
      autoGainControl: bool(v.autoGainControl, true)
    }
  } catch {
    return { ...DEFAULT_DEVICE_PREFS }
  }
}

export function loadDevicePrefs(): HuddleDevicePrefs {
  try {
    return parseDevicePrefs(globalThis.localStorage?.getItem(KEY) ?? null)
  } catch {
    return { ...DEFAULT_DEVICE_PREFS }
  }
}

export function saveDevicePrefs(patch: Partial<HuddleDevicePrefs>): HuddleDevicePrefs {
  const next = { ...loadDevicePrefs(), ...patch }
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(next))
  } catch {
    /* storage blocked: the choice lasts for this page only */
  }
  return next
}

/** getUserMedia audio constraints for the chosen microphone and processing. */
export function micConstraints(p: HuddleDevicePrefs): MediaTrackConstraints {
  return {
    // `ideal`, not `exact`: a microphone unplugged since last time falls back to the default.
    ...(p.micId ? { deviceId: { ideal: p.micId } } : {}),
    echoCancellation: p.echoCancellation,
    noiseSuppression: p.noiseSuppression,
    autoGainControl: p.autoGainControl
  }
}
