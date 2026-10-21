import { toast } from 'sonner'
import { speakerChoiceSupported } from './huddle-audio'
import { type DeviceLike, isPseudoDevice, micChange } from './huddle-audio-logic'
import {
  type HuddleDevicePrefs,
  loadDevicePrefs,
  micConstraints,
  saveDevicePrefs
} from './huddle-device-prefs'
import { huddleStore } from './huddle-store'

/**
 * Microphone and speaker choice (#2847). A change while in a huddle opens
 * the new microphone and swaps it into every link with replaceTrack (no
 * renegotiation); the old one is closed after. Plugging in a headset moves
 * the call onto it; unplugging the microphone in use falls back to the
 * default — both say so in a toast.
 */

export interface AudioDevices {
  mics: DeviceLike[]
  speakers: DeviceLike[]
}

export async function listAudioDevices(): Promise<AudioDevices> {
  const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined
  if (!md?.enumerateDevices) return { mics: [], speakers: [] }
  const all = await md.enumerateDevices().catch(() => [] as MediaDeviceInfo[])
  const plain = (d: MediaDeviceInfo): DeviceLike => ({
    deviceId: d.deviceId,
    kind: d.kind,
    label: d.label,
    groupId: d.groupId
  })
  return {
    mics: all.filter((d) => d.kind === 'audioinput').map(plain),
    speakers: all.filter((d) => d.kind === 'audiooutput').map(plain)
  }
}

/** A microphone stream for the given choices (the pre-join check, and swaps). */
export function openMic(prefs: HuddleDevicePrefs): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({ audio: micConstraints(prefs) })
}

const MIC_KEYS: Array<keyof HuddleDevicePrefs> = [
  'micId',
  'noiseSuppression',
  'echoCancellation',
  'autoGainControl'
]

function inHuddle(): boolean {
  const s = huddleStore.getSnapshot()
  return s.status === 'live' || s.status === 'joining'
}

/** Remember a choice and, in a huddle, apply it now. Resolves false when the microphone would not open. */
export async function applyDevicePrefs(patch: Partial<HuddleDevicePrefs>): Promise<boolean> {
  const prefs = saveDevicePrefs(patch)
  if ('speakerId' in patch && speakerChoiceSupported())
    huddleStore.setSpeaker(prefs.speakerId ?? '')
  if (!inHuddle() || !MIC_KEYS.some((k) => k in patch)) return true
  try {
    await huddleStore.swapMic(await openMic(prefs))
    return true
  } catch {
    return false
  }
}

/** The device id of the microphone being sent, if the browser says. */
export function currentMicId(): string | null {
  const track = huddleStore.localMic()?.getAudioTracks()[0]
  return track?.getSettings?.().deviceId ?? null
}

class DeviceWatcher {
  private started = false
  private bound = false
  private known: DeviceLike[] = []

  start() {
    if (this.started || typeof window === 'undefined') return
    this.started = true
    huddleStore.subscribe(() => this.sync())
    this.sync()
  }

  private sync() {
    const md = navigator.mediaDevices
    const live = huddleStore.getSnapshot().status === 'live'
    if (live && !this.bound && md?.addEventListener) {
      this.bound = true
      md.addEventListener('devicechange', this.onChange)
      void this.snapshot()
      const speaker = loadDevicePrefs().speakerId
      if (speaker && speakerChoiceSupported()) huddleStore.setSpeaker(speaker)
    } else if (!live && this.bound) {
      this.bound = false
      md?.removeEventListener?.('devicechange', this.onChange)
      this.known = []
    }
  }

  private async snapshot() {
    const d = await listAudioDevices()
    this.known = [...d.mics, ...d.speakers]
  }

  private onChange = async () => {
    const before = this.known
    const d = await listAudioDevices()
    const after = [...d.mics, ...d.speakers]
    this.known = after
    if (huddleStore.getSnapshot().status !== 'live') return
    const change = micChange(before, after, currentMicId())
    if (change.kind === 'switch') {
      const ok = await applyDevicePrefs({ micId: change.device.deviceId })
      if (!ok) return
      // A headset is usually both ends: play through it too when it brought an output.
      const out = d.speakers.find(
        (s) => !isPseudoDevice(s) && change.device.groupId && s.groupId === change.device.groupId
      )
      if (out && speakerChoiceSupported()) await applyDevicePrefs({ speakerId: out.deviceId })
      toast(`Switched to ${change.device.label || 'the new headset'}`, { id: 'huddle-device' })
    } else if (change.kind === 'fallback') {
      const ok = await applyDevicePrefs({ micId: null })
      const label = huddleStore.getSnapshot().micLabel
      if (ok) {
        toast(`Microphone disconnected — switched to ${label || 'the default microphone'}`, {
          id: 'huddle-device'
        })
      }
    }
    // The output in use vanished: the browser already plays through the default; forget the choice.
    const speaker = loadDevicePrefs().speakerId
    if (speaker && !d.speakers.some((s) => s.deviceId === speaker)) {
      await applyDevicePrefs({ speakerId: null })
    }
  }
}

export const huddleDevices = new DeviceWatcher()
