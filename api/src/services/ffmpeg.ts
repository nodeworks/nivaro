import { spawn } from 'node:child_process'

// ffmpeg/ffprobe wrappers. Always argument arrays, never a shell string.
// FFMPEG_PATH / FFPROBE_PATH override the binaries on PATH.

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg'
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe'
let available: Promise<boolean> | null = null

function run(
  bin: string,
  args: string[],
  opts: { onStdout?: (s: string) => void; signal?: AbortSignal } = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], signal: opts.signal })
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
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr })
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

export function hasFfmpeg(): Promise<boolean> {
  if (!available) {
    available = Promise.all([run(FFMPEG, ['-version']), run(FFPROBE, ['-version'])])
      .then(() => true)
      .catch(() => false)
  }
  return available
}

export async function probeVideo(path: string): Promise<{
  duration_ms: number | null
  width: number | null
  height: number | null
  has_audio: boolean
}> {
  const { stdout } = await run(FFPROBE, [
    '-v',
    'error',
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

/** Rewrite the container without re-encoding: a MediaRecorder WebM gains its
 *  duration and cue index, which is what makes browser seeking work. */
export async function remuxToFile(input: string, output: string): Promise<void> {
  await run(FFMPEG, ['-y', '-v', 'error', '-i', input, '-c', 'copy', output])
}

export async function runFfmpeg(
  args: string[],
  onProgress?: (outTimeMs: number) => void,
  signal?: AbortSignal
): Promise<void> {
  const withProgress = onProgress ? ['-progress', 'pipe:1', '-nostats', ...args] : args
  await run(FFMPEG, withProgress, {
    signal,
    onStdout: onProgress
      ? (chunk) => {
          for (const m of chunk.matchAll(/out_time_ms=(\d+)/g))
            onProgress(Math.round(Number(m[1]) / 1000))
        }
      : undefined
  })
}
