import { rms } from './huddle-audio-logic'

/**
 * The one Web Audio context huddles use (#2845, #2847): level meters for
 * every voice and the speaker test tone. Browsers start a context suspended
 * until the page sees a gesture, so the first click or key after a huddle
 * starts resumes it.
 */

type AudioCtor = typeof AudioContext
let ctx: AudioContext | null = null
let gestureHooked = false

export function huddleAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  if (!ctx) {
    const Ctor: AudioCtor | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext
    if (!Ctor) return null
    try {
      ctx = new Ctor()
    } catch {
      return null
    }
  }
  if (ctx.state === 'suspended') void ctx.resume().catch(() => null)
  if (!gestureHooked) {
    gestureHooked = true
    const resume = () => {
      if (ctx?.state === 'suspended') void ctx.resume().catch(() => null)
    }
    window.addEventListener('pointerdown', resume, { capture: true, passive: true })
    window.addEventListener('keydown', resume, { capture: true })
  }
  return ctx
}

export interface LevelMeter {
  /** Current RMS, 0–1. */
  level(): number
  stop(): void
}

/** An analyser on one stream. Never connected to the speakers — it only listens. */
export function createLevelMeter(stream: MediaStream): LevelMeter | null {
  const ac = huddleAudioContext()
  if (!ac || !stream.getAudioTracks().length) return null
  try {
    const source = ac.createMediaStreamSource(stream)
    const analyser = ac.createAnalyser()
    analyser.fftSize = 512
    analyser.smoothingTimeConstant = 0.2
    source.connect(analyser)
    const buf = new Float32Array(analyser.fftSize)
    return {
      level() {
        analyser.getFloatTimeDomainData(buf)
        return rms(buf)
      },
      stop() {
        try {
          source.disconnect()
        } catch {
          /* already gone */
        }
      }
    }
  } catch {
    return null
  }
}

/** Whether this browser can choose where audio plays (HTMLMediaElement.setSinkId). */
export function speakerChoiceSupported(): boolean {
  return typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype
}

/** A short two-note chime through the chosen output, so you can hear where sound goes. */
export async function playTestTone(sinkId: string): Promise<void> {
  const ac = huddleAudioContext()
  if (!ac) return
  await ac.resume().catch(() => null)
  const dest = ac.createMediaStreamDestination()
  const gain = ac.createGain()
  gain.connect(dest)
  const t = ac.currentTime
  for (const [i, freq] of [523.25, 783.99].entries()) {
    const osc = ac.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(freq, t + i * 0.35)
    const g = ac.createGain()
    g.gain.setValueAtTime(0.0001, t + i * 0.35)
    g.gain.exponentialRampToValueAtTime(0.25, t + i * 0.35 + 0.03)
    g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.35 + 0.5)
    osc.connect(g).connect(gain)
    osc.start(t + i * 0.35)
    osc.stop(t + i * 0.35 + 0.55)
  }
  const el = document.createElement('audio') as HTMLAudioElement & {
    setSinkId?: (id: string) => Promise<void>
  }
  el.srcObject = dest.stream
  if (sinkId && typeof el.setSinkId === 'function') await el.setSinkId(sinkId).catch(() => null)
  await el.play().catch(() => null)
  await new Promise((r) => setTimeout(r, 1000))
  el.pause()
  el.srcObject = null
  gain.disconnect()
}
