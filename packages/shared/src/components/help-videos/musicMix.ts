import { useEffect, useRef } from 'react'
import { useApiFetchConfig } from '../../context'
import { editedDuration, musicShare, segmentIndexAt } from './edits'
import type { MusicBed, VideoEdits } from './types'

// Background music played live (#1547): the editor's preview draws the edits
// over the original recording, so it mixes the music itself with Web Audio.
// The render bakes the same mix with ffmpeg (help-video-render-plan.ts:
// MUSIC_FADE_IN_S / MUSIC_FADE_OUT_S — keep the fades in step). The render
// lowers the music with a compressor fed by the narration; live, the
// recorder's microphone levels (one per 100 ms of source time) stand in for
// it, so the preview ducks only for recordings that have levels.

export const MUSIC_FADE_IN_S = 1
export const MUSIC_FADE_OUT_S = 1.5
/** Microphone level above which someone counts as speaking. */
export const MUSIC_DUCK_LEVEL = 0.08
/** The music's level while someone speaks (about −15 dB). */
export const MUSIC_DUCK_GAIN = 0.18
const LEVEL_STEP_MS = 100

/** Where a library track or an uploaded music file is served (API-relative). */
export function musicTrackPath(videoId: string, music: Pick<MusicBed, 'source' | 'track'>): string {
  return music.source === 'library'
    ? `/help-videos/music/${encodeURIComponent(music.track)}`
    : `/help-videos/${encodeURIComponent(videoId)}/music/${encodeURIComponent(music.track)}`
}

/** Is someone speaking at this source moment (by the recorded levels)? */
export function speakingAt(levels: number[] | null | undefined, srcMs: number): boolean {
  if (!levels?.length) return false
  const i = Math.floor(srcMs / LEVEL_STEP_MS)
  // A word's edges: the samples either side count too, so the music does
  // not swell back between two syllables.
  for (const k of [i - 1, i, i + 1]) if ((levels[k] ?? 0) > MUSIC_DUCK_LEVEL) return true
  return false
}

/**
 * The music's gain at one moment of the edited timeline (0–1, before the
 * player's own volume): its volume, the piece's share (cards: full), the
 * fades at either end, and the duck while someone speaks.
 */
export function musicGainAt(
  edits: VideoEdits,
  at: {
    editedMs: number
    srcMs: number
    phase: 'intro' | 'body' | 'outro'
    levels?: number[] | null
  }
): number {
  const m = edits.music
  if (!m) return 0
  let g = m.volume
  if (at.phase === 'body') {
    const i = segmentIndexAt(edits, at.srcMs)
    if (i >= 0) g *= musicShare(edits.segments[i].music)
    if (m.duck && speakingAt(at.levels, at.srcMs)) g *= MUSIC_DUCK_GAIN
  }
  const t = at.editedMs / 1000
  const total = editedDuration(edits) / 1000
  if (t < MUSIC_FADE_IN_S) g *= Math.max(0, t / MUSIC_FADE_IN_S)
  const left = total - t
  if (left < MUSIC_FADE_OUT_S) g *= Math.max(0, left / MUSIC_FADE_OUT_S)
  return g
}

type AudioCtor = typeof AudioContext
let ctx: AudioContext | null = null
function audioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  if (ctx) return ctx
  const AC =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext
  if (!AC) return null
  try {
    ctx = new AC()
  } catch {
    return null
  }
  return ctx
}

const buffers = new Map<string, Promise<AudioBuffer | null>>()

/** Fetches and decodes a track once per page (null when it cannot be had). */
export function loadMusicBuffer(
  url: string,
  init: { headers?: Record<string, string>; credentials?: RequestCredentials }
): Promise<AudioBuffer | null> {
  let p = buffers.get(url)
  if (!p) {
    p = (async () => {
      const ac = audioContext()
      if (!ac) return null
      const res = await fetch(url, { headers: init.headers, credentials: init.credentials })
      if (!res.ok) throw new Error(`Music answered ${res.status}`)
      return await ac.decodeAudioData(await res.arrayBuffer())
    })().catch(() => {
      buffers.delete(url)
      return null
    })
    buffers.set(url, p)
  }
  return p
}

/**
 * Plays a video's music in step with the live player. Never throws: a
 * browser without Web Audio, or a track that will not load, stays quiet.
 */
export function useLiveMusic(opts: {
  enabled: boolean
  videoId: string
  edits: VideoEdits | null | undefined
  levels: number[] | null | undefined
  editedMs: number
  srcMs: number
  phase: 'intro' | 'body' | 'outro'
  playing: boolean
  video: HTMLVideoElement | null
  rate: number
}): void {
  const { apiBase, authHeaders, credentials } = useApiFetchConfig()
  const music = opts.enabled ? (opts.edits?.music ?? null) : null
  const url = music ? `${apiBase}${musicTrackPath(opts.videoId, music)}` : null
  const buffer = useRef<AudioBuffer | null>(null)
  const node = useRef<{
    src: AudioBufferSourceNode
    gain: GainNode
    startCtx: number
    startPos: number
    rate: number
  } | null>(null)
  const latest = useRef(opts)
  latest.current = opts

  const stop = () => {
    const n = node.current
    node.current = null
    if (!n) return
    try {
      n.gain.gain.setTargetAtTime(0, n.gain.context.currentTime, 0.03)
      n.src.stop(n.gain.context.currentTime + 0.12)
    } catch {
      /* already stopped */
    }
  }

  // The track: (re)loaded when the music changes, dropped when it is off.
  // biome-ignore lint/correctness/useExhaustiveDependencies: auth config is stable for the page
  useEffect(() => {
    buffer.current = null
    stop()
    if (!url) return
    let gone = false
    void loadMusicBuffer(url, { headers: authHeaders, credentials }).then((b) => {
      if (!gone) buffer.current = b
    })
    return () => {
      gone = true
      stop()
    }
  }, [url])

  // biome-ignore lint/correctness/useExhaustiveDependencies: stop reads refs only; runs on unmount
  useEffect(() => () => stop(), [])

  // Every clock tick: keep the music playing in step, at the right level.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the clock values are the trigger; the body reads the latest props through a ref
  useEffect(() => {
    const o = latest.current
    const b = buffer.current
    const ac = audioContext()
    if (!o.edits?.music || !b || !ac) return
    if (!o.playing) {
      stop()
      return
    }
    if (ac.state === 'suspended') void ac.resume().catch(() => null)
    const want = (((o.editedMs / 1000) % b.duration) + b.duration) % b.duration
    let n = node.current
    if (n) {
      const pos =
        ((((ac.currentTime - n.startCtx) * n.rate + n.startPos) % b.duration) + b.duration) %
        b.duration
      const drift = Math.min(Math.abs(pos - want), b.duration - Math.abs(pos - want))
      // A seek, a jump over a cut or a speed change: start again in step.
      if (drift > 0.25 || n.rate !== o.rate) {
        stop()
        n = null
      }
    }
    if (!n) {
      try {
        const src = ac.createBufferSource()
        src.buffer = b
        src.loop = true
        src.playbackRate.value = o.rate
        const gain = ac.createGain()
        gain.gain.value = 0
        src.connect(gain).connect(ac.destination)
        src.start(ac.currentTime, want)
        n = { src, gain, startCtx: ac.currentTime, startPos: want, rate: o.rate }
        node.current = n
      } catch {
        return
      }
    }
    const v = o.video
    const playerVolume = v ? (v.muted ? 0 : v.volume) : 1
    const target =
      musicGainAt(o.edits, {
        editedMs: o.editedMs,
        srcMs: o.srcMs,
        phase: o.phase,
        levels: o.levels
      }) * playerVolume
    const now = ac.currentTime
    const cur = n.gain.gain.value
    // Duck fast, come back slowly (the render's attack and release).
    n.gain.gain.setTargetAtTime(target, now, target < cur ? 0.03 : 0.15)
  }, [opts.editedMs, opts.playing, opts.rate, opts.srcMs, opts.phase])
}

/**
 * Plays the first seconds of a track (the editor's "Listen"), fading out at
 * the end. Returns a function that stops it; `onEnd` runs when it stops by
 * itself. Never throws.
 */
export function previewMusic(
  url: string,
  init: { headers?: Record<string, string>; credentials?: RequestCredentials },
  volume: number,
  onEnd: () => void,
  seconds = 10
): () => void {
  let stopped = false
  let stopNow: (() => void) | null = null
  void loadMusicBuffer(url, init).then((b) => {
    const ac = audioContext()
    if (stopped || !b || !ac) {
      if (!stopped) onEnd()
      return
    }
    try {
      if (ac.state === 'suspended') void ac.resume().catch(() => null)
      const src = ac.createBufferSource()
      src.buffer = b
      src.loop = true
      const gain = ac.createGain()
      const t = ac.currentTime
      const len = Math.min(seconds, Math.max(2, b.duration))
      gain.gain.setValueAtTime(0, t)
      gain.gain.linearRampToValueAtTime(volume, t + 0.3)
      gain.gain.setValueAtTime(volume, t + len - 1)
      gain.gain.linearRampToValueAtTime(0, t + len)
      src.connect(gain).connect(ac.destination)
      src.start(t)
      src.stop(t + len)
      src.onended = () => {
        if (!stopped) {
          stopped = true
          onEnd()
        }
      }
      stopNow = () => {
        try {
          gain.gain.cancelScheduledValues(ac.currentTime)
          gain.gain.setTargetAtTime(0, ac.currentTime, 0.03)
          src.stop(ac.currentTime + 0.1)
        } catch {
          /* already stopped */
        }
      }
    } catch {
      onEnd()
    }
  })
  return () => {
    stopped = true
    stopNow?.()
  }
}
