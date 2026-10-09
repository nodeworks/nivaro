import { devNull } from 'node:os'
import { ffmpegOutput, hasFfmpeg } from './ffmpeg.js'
import type { EncoderSettings } from './help-video-settings.js'

// How a help-video render encodes its picture (#1561).
//
// Software (libx264): the settings' preset and CRF, exactly today's encode at
// the defaults (veryfast / 23). Two-pass, for videos over a set length, aims at
// a bitrate derived from the CRF (CRF itself is a one-pass mode).
//
// Hardware, when the settings say 'auto' and this host has a working encoder:
//   - VideoToolbox (macOS): h264_videotoolbox
//   - VAAPI (Linux, /dev/dri): h264_vaapi
// Hardware encoders have no x264 presets and no CRF. VideoToolbox gets a
// target bitrate derived from the CRF (the same one two-pass uses); VAAPI runs
// constant-QP with the CRF number as the QP, which is close in quality.
//
// Detection runs once per process: `ffmpeg -encoders`, then a one-frame trial
// encode per candidate (an encoder can be compiled in yet have no device).
// A hardware encode that fails mid-render is retried once in software by the
// renderer; the failing encoder is then skipped for an hour on this process.

export type VideoEncoderKind = 'libx264' | 'videotoolbox' | 'vaapi'
export const HARDWARE_KINDS: VideoEncoderKind[] = ['videotoolbox', 'vaapi']

/** The video-side encoder arguments a render hands buildRenderArgs. */
export interface VideoEncodePlan {
  kind: VideoEncoderKind
  /** Global arguments placed before the inputs (a hardware device). */
  inputArgs: string[]
  /** Appended to the finished picture inside the graph (hardware upload). */
  hwFilter: string | null
  /** The codec arguments, pixel format included. */
  videoArgs: string[]
  /** Two passes (libx264 only). */
  twoPass: boolean
  /** One line for the job run and the log: "libx264 veryfast crf 23". */
  label: string
}

/** Today's arguments: what every render used before #1561. */
export const DEFAULT_VIDEO_ARGS = [
  '-c:v',
  'libx264',
  '-preset',
  'veryfast',
  '-crf',
  '23',
  '-pix_fmt',
  'yuv420p'
]

export function vaapiDevice(): string {
  return process.env.HELP_VIDEO_VAAPI_DEVICE?.trim() || '/dev/dri/renderD128'
}

/** A target bitrate (kbit/s) for a CRF: about 0.07 bits per pixel per frame at
 *  CRF 23 and 30 fps, doubling every 6 CRF steps down (x264's own scale).
 *  1080p at 23 ≈ 4.4 Mbit/s, 720p ≈ 1.9 Mbit/s. */
export function targetKbps(width: number, height: number, crf: number): number {
  const bpp = 0.07 * 2 ** ((23 - crf) / 6)
  return Math.max(300, Math.round((width * height * 30 * bpp) / 1000))
}

function rateArgs(kbps: number): string[] {
  return ['-b:v', `${kbps}k`, '-maxrate', `${Math.round(kbps * 1.5)}k`, '-bufsize', `${kbps * 2}k`]
}

export function softwarePlan(
  s: EncoderSettings,
  size: { width: number; height: number },
  editedMs: number
): VideoEncodePlan {
  const twoPass = s.two_pass_over_minutes > 0 && editedMs > s.two_pass_over_minutes * 60_000
  if (twoPass) {
    const kbps = targetKbps(size.width, size.height, s.crf)
    return {
      kind: 'libx264',
      inputArgs: [],
      hwFilter: null,
      videoArgs: ['-c:v', 'libx264', '-preset', s.preset, ...rateArgs(kbps), '-pix_fmt', 'yuv420p'],
      twoPass: true,
      label: `libx264 ${s.preset} two-pass ${kbps} kbit/s`
    }
  }
  return {
    kind: 'libx264',
    inputArgs: [],
    hwFilter: null,
    videoArgs: [
      '-c:v',
      'libx264',
      '-preset',
      s.preset,
      '-crf',
      String(s.crf),
      '-pix_fmt',
      'yuv420p'
    ],
    twoPass: false,
    label: `libx264 ${s.preset} crf ${s.crf}`
  }
}

/** A hardware encoder may be told to fail (dev only) to exercise the
 *  software fallback: HELP_VIDEO_HARDWARE_TEST_FAIL=1. */
function testFailArgs(): string[] {
  if (process.env.NODE_ENV === 'production') return []
  return process.env.HELP_VIDEO_HARDWARE_TEST_FAIL === '1'
    ? ['-profile:v', 'nivaro-test-failure']
    : []
}

export function hardwarePlan(
  kind: Exclude<VideoEncoderKind, 'libx264'>,
  s: EncoderSettings,
  size: { width: number; height: number }
): VideoEncodePlan {
  if (kind === 'videotoolbox') {
    const kbps = targetKbps(size.width, size.height, s.crf)
    return {
      kind,
      inputArgs: [],
      hwFilter: null,
      videoArgs: [
        '-c:v',
        'h264_videotoolbox',
        ...rateArgs(kbps),
        '-profile:v',
        'high',
        ...testFailArgs(),
        '-pix_fmt',
        'yuv420p'
      ],
      twoPass: false,
      label: `h264_videotoolbox ${kbps} kbit/s`
    }
  }
  return {
    kind,
    inputArgs: ['-init_hw_device', `vaapi=nvrva:${vaapiDevice()}`, '-filter_hw_device', 'nvrva'],
    hwFilter: 'format=nv12,hwupload',
    // The frames are on the device: no -pix_fmt here.
    videoArgs: ['-c:v', 'h264_vaapi', '-rc_mode', 'CQP', '-qp', String(s.crf), ...testFailArgs()],
    twoPass: false,
    label: `h264_vaapi qp ${s.crf}`
  }
}

// ── detection ──────────────────────────────────────────────────────────────

const TRIAL_INPUT = ['-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=30:d=0.2', '-frames:v', '1']

/** The one-frame trial encode for a candidate. */
export function trialArgs(kind: Exclude<VideoEncoderKind, 'libx264'>): string[] {
  if (kind === 'videotoolbox') {
    return [
      '-hide_banner',
      '-v',
      'error',
      ...TRIAL_INPUT,
      '-c:v',
      'h264_videotoolbox',
      '-b:v',
      '500k',
      '-f',
      'null',
      devNull
    ]
  }
  return [
    '-hide_banner',
    '-v',
    'error',
    '-init_hw_device',
    `vaapi=nvrva:${vaapiDevice()}`,
    '-filter_hw_device',
    'nvrva',
    ...TRIAL_INPUT,
    '-vf',
    'format=nv12,hwupload',
    '-c:v',
    'h264_vaapi',
    '-f',
    'null',
    devNull
  ]
}

const CODEC_NAME: Record<Exclude<VideoEncoderKind, 'libx264'>, string> = {
  videotoolbox: 'h264_videotoolbox',
  vaapi: 'h264_vaapi'
}

export interface HardwareReport {
  /** Encoders that passed the trial encode, best first. */
  available: Array<Exclude<VideoEncoderKind, 'libx264'>>
  /** Compiled in but the trial failed, with ffmpeg's reason. */
  failed: Array<{ kind: Exclude<VideoEncoderKind, 'libx264'>; reason: string }>
  checked_at: string
}

let detection: Promise<HardwareReport> | null = null
const brokenUntil = new Map<VideoEncoderKind, number>()
const BROKEN_MS = 3_600_000

/** What this process can use (once per process; `fresh` asks again). */
export function detectHardwareEncoders(fresh = false): Promise<HardwareReport> {
  if (!detection || fresh) {
    detection = (async (): Promise<HardwareReport> => {
      const report: HardwareReport = {
        available: [],
        failed: [],
        checked_at: new Date().toISOString()
      }
      if (!(await hasFfmpeg())) return report
      let list = ''
      try {
        list = await ffmpegOutput(['-hide_banner', '-encoders'])
      } catch {
        return report
      }
      for (const kind of ['videotoolbox', 'vaapi'] as const) {
        if (!new RegExp(`\\b${CODEC_NAME[kind]}\\b`).test(list)) continue
        try {
          await ffmpegOutput(trialArgs(kind))
          report.available.push(kind)
        } catch (err) {
          report.failed.push({
            kind,
            reason: (err instanceof Error ? err.message : String(err)).slice(0, 200)
          })
        }
      }
      return report
    })()
  }
  return detection
}

export function markHardwareFailed(kind: VideoEncoderKind): void {
  if (kind !== 'libx264') brokenUntil.set(kind, Date.now() + BROKEN_MS)
}

/** Test seam: forget the detection and any broken encoders. */
export function resetEncoderDetection(): void {
  detection = null
  brokenUntil.clear()
}

/** The plan a render starts with: hardware when allowed and working here,
 *  otherwise software. */
export async function planVideoEncode(
  s: EncoderSettings,
  size: { width: number; height: number },
  editedMs: number
): Promise<VideoEncodePlan> {
  if (s.hardware === 'auto') {
    const report = await detectHardwareEncoders().catch(() => null)
    for (const kind of report?.available ?? []) {
      if ((brokenUntil.get(kind) ?? 0) > Date.now()) continue
      return hardwarePlan(kind, s, size)
    }
  }
  return softwarePlan(s, size, editedMs)
}
