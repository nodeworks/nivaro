// Videos made elsewhere and uploaded as a file (not recorded in the browser).
// The client's file name and mime are never trusted: the container is sniffed
// from the first bytes, and what the file holds is probed before anything is
// kept. The stored file must play in any browser the player runs in, because
// viewers get the original whenever the cut hides nothing:
//   - H.264 (8-bit 4:2:0) video, AAC/MP3 or no audio  -> MP4, streams copied, faststart
//   - VP8/VP9 (4:2:0) video, Opus/Vorbis or no audio  -> WebM, streams copied
//   - H.264/VP8/VP9 video with other audio (PCM, ...)  -> video copied, audio to AAC/
//                                                        (WebM: the whole file to MP4)
//   - anything else (HEVC, ProRes, AV1, 10-bit, 4:4:4) -> H.264 + AAC MP4, at most
//                                                        2560 px on the long side

export type UploadContainer = 'video/mp4' | 'video/webm'

/** The container from the first bytes: EBML (WebM/Matroska) or an ISO-BMFF /
 *  QuickTime atom (MP4, MOV). Null for anything else. */
export function sniffContainer(head: Buffer): UploadContainer | null {
  if (
    head.length >= 4 &&
    head[0] === 0x1a &&
    head[1] === 0x45 &&
    head[2] === 0xdf &&
    head[3] === 0xa3
  )
    return 'video/webm'
  if (head.length >= 8) {
    const atom = head.subarray(4, 8).toString('latin1')
    // MP4 always opens with ftyp; older QuickTime files may open with another atom.
    if (['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip', 'pnot'].includes(atom)) return 'video/mp4'
  }
  return null
}

export interface ProbedStream {
  index: number
  codec_type: string
  codec_name: string
  profile?: string
  pix_fmt?: string
  width?: number
  height?: number
  attached_pic?: boolean
}
export interface ProbedMedia {
  duration_ms: number | null
  streams: ProbedStream[]
}

export interface UploadPlan {
  /** Mime of the file kept. */
  container: UploadContainer
  video: { index: number; mode: 'copy' | 'encode' }
  audio: { index: number; mode: 'copy' | 'encode' } | null
  /** One plain word for the log and the progress note. */
  kind: 'copy' | 'audio' | 'convert'
}

export type PlanResult = UploadPlan | { error: { code: string; message: string } }

const H264_PIX = new Set(['yuv420p', 'yuvj420p'])
const VPX_PIX = new Set(['yuv420p'])
const MP4_AUDIO = new Set(['aac', 'mp3'])
const WEBM_AUDIO = new Set(['opus', 'vorbis'])

function h264Playable(s: ProbedStream): boolean {
  if (s.codec_name !== 'h264') return false
  if (!s.pix_fmt || !H264_PIX.has(s.pix_fmt)) return false
  return !/10|4:2:2|4:4:4/.test(s.profile ?? '')
}
function vpxPlayable(s: ProbedStream): boolean {
  return (s.codec_name === 'vp8' || s.codec_name === 'vp9') && !!s.pix_fmt && VPX_PIX.has(s.pix_fmt)
}

/** How an uploaded file becomes the stored source (rules at the top). */
export function planUploadedVideo(p: ProbedMedia): PlanResult {
  const video = p.streams.find((s) => s.codec_type === 'video' && !s.attached_pic)
  if (!video) {
    return { error: { code: 'UPLOAD_NO_VIDEO', message: 'That file has no video in it' } }
  }
  const audioStream = p.streams.find((s) => s.codec_type === 'audio')
  const convert = (): UploadPlan => ({
    container: 'video/mp4',
    video: { index: video.index, mode: 'encode' },
    audio: audioStream ? { index: audioStream.index, mode: 'encode' } : null,
    kind: 'convert'
  })
  if (h264Playable(video)) {
    const audioOk = !audioStream || MP4_AUDIO.has(audioStream.codec_name)
    return {
      container: 'video/mp4',
      video: { index: video.index, mode: 'copy' },
      audio: audioStream ? { index: audioStream.index, mode: audioOk ? 'copy' : 'encode' } : null,
      kind: audioOk ? 'copy' : 'audio'
    }
  }
  if (vpxPlayable(video)) {
    if (audioStream && !WEBM_AUDIO.has(audioStream.codec_name)) return convert()
    return {
      container: 'video/webm',
      video: { index: video.index, mode: 'copy' },
      audio: audioStream ? { index: audioStream.index, mode: 'copy' } : null,
      kind: 'copy'
    }
  }
  return convert()
}

/** Longest side a converted upload keeps (a 4K phone clip becomes 2560 px). */
export const MAX_CONVERT_SIDE = 2560

/** ffmpeg arguments for a plan. The input format is pinned (never probed). */
export function buildUploadArgs(
  plan: UploadPlan,
  input: { path: string; inputLock: string[] },
  output: string,
  threads: number
): string[] {
  const args = ['-y', '-v', 'error', ...input.inputLock, '-i', input.path]
  args.push('-map', `0:${plan.video.index}`)
  if (plan.audio) args.push('-map', `0:${plan.audio.index}`)
  if (plan.video.mode === 'copy') {
    args.push('-c:v', 'copy')
  } else {
    const m = MAX_CONVERT_SIDE
    args.push(
      '-vf',
      // Even sizes (yuv420p needs them), the long side at most MAX_CONVERT_SIDE.
      `scale=w='if(gte(iw,ih),trunc(min(${m},iw)/2)*2,-2)':h='if(gte(iw,ih),-2,trunc(min(${m},ih)/2)*2)'`,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-pix_fmt',
      'yuv420p',
      '-threads',
      String(threads)
    )
  }
  if (plan.audio) {
    if (plan.audio.mode === 'copy') args.push('-c:a', 'copy')
    else args.push('-c:a', 'aac', '-b:a', '128k')
  }
  if (plan.container === 'video/mp4') args.push('-movflags', '+faststart', '-f', 'mp4')
  else args.push('-f', 'webm')
  args.push(output)
  return args
}
