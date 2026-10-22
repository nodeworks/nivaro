import { spawn } from 'node:child_process'
import { setPriority } from 'node:os'
import { peerFileOp, renderPeerUrl, renderUnavailable } from './render-peer.js'

// ffmpeg/ffprobe wrappers. Always argument arrays, never a shell string.
// FFMPEG_PATH / FFPROBE_PATH override the binaries on PATH.
//
// The slim release image has no ffmpeg (#2789). There probeVideo,
// probeStreams and remuxToFile go to the render peer (RENDER_URL) with the
// file streamed both ways, so callers gate on canUseFfmpeg() instead of
// hasFfmpeg(). runFfmpeg (arbitrary graphs over several local files) never
// leaves this process: renders, clips, captions and extras stay with a
// process that has the binaries.

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg'
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe'
let available: Promise<boolean> | null = null

function run(
  bin: string,
  args: string[],
  opts: { onStdout?: (s: string) => void; signal?: AbortSignal; lowPriority?: boolean } = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // A cancel kills at once (SIGKILL: SIGTERM lets ffmpeg flush its encoder
    // for seconds) and settles only once the child has exited, so whatever
    // the caller does next (free the render slot, delete the scratch
    // directory) happens after ffmpeg is gone.
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: opts.signal,
      killSignal: 'SIGKILL'
    })
    if (opts.lowPriority && child.pid) {
      try {
        setPriority(child.pid, 19) // lowest: renders only use CPU that requests leave idle
      } catch {
        /* not permitted on this host — the thread cap still applies */
      }
    }
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => {
      const s = d.toString()
      stdout += s
      opts.onStdout?.(s)
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-8000)
    })
    child.on('error', (err) => {
      // An abort is reported again by 'close' once the process has exited.
      if (opts.signal?.aborted && child.pid !== undefined) return
      reject(err)
    })
    child.on('close', (code) => {
      if (opts.signal?.aborted)
        reject(Object.assign(new Error(`${bin} was cancelled`), { stderr, name: 'AbortError' }))
      else if (code === 0) resolve({ stdout, stderr })
      else
        reject(
          Object.assign(new Error(lastLine(stderr) || `${bin} exited with ${code}`), { stderr })
        )
    })
  })
}

function lastLine(s: string): string {
  return s.trim().split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 300) ?? ''
}

// Never let ffmpeg auto-detect the format of untrusted input: a playlist or
// concat script posing as a recording could read local files or fetch URLs.
const INPUT_FORMATS: Record<string, string> = {
  'video/webm': 'matroska,webm',
  'video/mp4': 'mov,mp4,m4a,3gp,3g2,mj2',
  // Background music (#1547): library files and authors' uploads.
  'audio/mp4': 'mov,mp4,m4a,3gp,3g2,mj2',
  'audio/wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
  'audio/webm': 'matroska,webm'
}
function formatOf(mime?: string): string | undefined {
  return mime ? INPUT_FORMATS[mime.split(';')[0].trim().toLowerCase()] : undefined
}

/** A mime whose demuxer is pinned: the only inputs ffmpeg/ffprobe ever open. */
export function isLockedMime(mime?: string): boolean {
  return !!formatOf(mime)
}

/** The input arguments that pin the demuxer. Throws for any other mime (empty
 *  included): auto-detection would let an ffconcat script or a playlist
 *  posing as a video read local files. */
export function lockedInputArgs(mime?: string): string[] {
  const fmt = formatOf(mime)
  if (!fmt)
    throw Object.assign(new Error(`Unsupported media format: ${String(mime ?? '').slice(0, 80)}`), {
      statusCode: 422,
      code: 'MEDIA_FORMAT_UNSUPPORTED'
    })
  return ['-protocol_whitelist', 'file', '-f', fmt, '-format_whitelist', fmt]
}

export function hasFfmpeg(): Promise<boolean> {
  if (!available) {
    available = Promise.all([run(FFMPEG, ['-version']), run(FFPROBE, ['-version'])])
      .then(() => true)
      .catch(() => false)
  }
  return available
}

/** ffmpeg work can be done for this process: locally, or by the render peer
 *  (probes, remux and the fixed conversions in render-peer ops only). */
export async function canUseFfmpeg(): Promise<boolean> {
  return (await hasFfmpeg()) || !!renderPeerUrl()
}

async function delegate(): Promise<boolean> {
  if (await hasFfmpeg()) return false
  if (renderPeerUrl()) return true
  throw renderUnavailable('ffmpeg')
}

/** Run ffmpeg with our own fixed arguments and hand back what it printed
 *  (encoder lists, a trial encode). Rejects on a non-zero exit or the timeout. */
export async function ffmpegOutput(args: string[], timeoutMs = 15_000): Promise<string> {
  const { stdout, stderr } = await run(FFMPEG, args, { signal: AbortSignal.timeout(timeoutMs) })
  return `${stdout}\n${stderr}`
}

export async function probeVideo(
  path: string,
  mime?: string
): Promise<{
  duration_ms: number | null
  width: number | null
  height: number | null
  has_audio: boolean
}> {
  if (await delegate()) return peerFileOp('probe-video', path, { mime })
  return probeVideoLocal(path, mime)
}

export async function probeVideoLocal(
  path: string,
  mime?: string
): Promise<{
  duration_ms: number | null
  width: number | null
  height: number | null
  has_audio: boolean
}> {
  const { stdout } = await run(FFPROBE, [
    '-v',
    'error',
    ...lockedInputArgs(mime),
    '-show_entries',
    'format=duration:stream=codec_type,width,height',
    '-of',
    'json',
    path
  ])
  const j = JSON.parse(stdout) as {
    format?: { duration?: string }
    streams?: Array<{ codec_type?: string; width?: number; height?: number }>
  }
  const video = j.streams?.find((s) => s.codec_type === 'video')
  const d = Number(j.format?.duration)
  return {
    duration_ms: Number.isFinite(d) ? Math.round(d * 1000) : null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    has_audio: !!j.streams?.some((s) => s.codec_type === 'audio')
  }
}

/** Every stream of a file (codec, profile, pixel format, size) and its length,
 *  with the container pinned. Used to decide how an uploaded file is kept. */
export async function probeStreams(
  path: string,
  mime: string
): Promise<{
  duration_ms: number | null
  streams: Array<{
    index: number
    codec_type: string
    codec_name: string
    profile?: string
    pix_fmt?: string
    width?: number
    height?: number
    attached_pic?: boolean
  }>
}> {
  if (await delegate()) return peerFileOp('probe-streams', path, { mime })
  return probeStreamsLocal(path, mime)
}

export async function probeStreamsLocal(
  path: string,
  mime: string
): Promise<Awaited<ReturnType<typeof probeStreams>>> {
  const { stdout } = await run(FFPROBE, [
    '-v',
    'error',
    ...lockedInputArgs(mime),
    '-show_entries',
    'format=duration:stream=index,codec_type,codec_name,profile,pix_fmt,width,height:stream_disposition=attached_pic',
    '-of',
    'json',
    path
  ])
  const j = JSON.parse(stdout) as {
    format?: { duration?: string }
    streams?: Array<{
      index?: number
      codec_type?: string
      codec_name?: string
      profile?: string
      pix_fmt?: string
      width?: number
      height?: number
      disposition?: { attached_pic?: number }
    }>
  }
  const d = Number(j.format?.duration)
  return {
    duration_ms: Number.isFinite(d) && d > 0 ? Math.round(d * 1000) : null,
    streams: (j.streams ?? []).map((s) => ({
      index: Number(s.index ?? 0),
      codec_type: String(s.codec_type ?? ''),
      codec_name: String(s.codec_name ?? ''),
      profile: s.profile,
      pix_fmt: s.pix_fmt,
      width: s.width,
      height: s.height,
      attached_pic: s.disposition?.attached_pic === 1
    }))
  }
}

/** Rewrite the container without re-encoding: a MediaRecorder WebM gains its
 *  duration and cue index, which is what makes browser seeking work. */
export async function remuxToFile(input: string, output: string, mime?: string): Promise<void> {
  if (await delegate()) {
    await peerFileOp('remux', input, { mime, output })
    return
  }
  await remuxToFileLocal(input, output, mime)
}

/** Remux, then probe the result: on the render peer that is ONE round trip
 *  (the probe rides back with the file) instead of sending the file twice. */
export async function remuxAndProbe(
  input: string,
  output: string,
  mime?: string
): Promise<Awaited<ReturnType<typeof probeVideoLocal>>> {
  if (await delegate()) return peerFileOp('remux', input, { mime, output })
  await remuxToFileLocal(input, output, mime)
  return probeVideoLocal(output, mime)
}

export async function remuxToFileLocal(
  input: string,
  output: string,
  mime?: string
): Promise<void> {
  await run(FFMPEG, [
    '-y',
    '-v',
    'error',
    ...lockedInputArgs(mime),
    '-i',
    input,
    '-c',
    'copy',
    output
  ])
}

export async function runFfmpeg(
  args: string[],
  onProgress?: (outTimeMs: number) => void,
  signal?: AbortSignal,
  opts: { lowPriority?: boolean } = {}
): Promise<void> {
  const withProgress = onProgress ? ['-progress', 'pipe:1', '-nostats', ...args] : args
  await run(FFMPEG, withProgress, {
    signal,
    lowPriority: opts.lowPriority,
    onStdout: onProgress
      ? (chunk) => {
          for (const m of chunk.matchAll(/out_time_ms=(\d+)/g))
            onProgress(Math.round(Number(m[1]) / 1000))
        }
      : undefined
  })
}
