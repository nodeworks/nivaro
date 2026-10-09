import {
  captionsToVtt,
  EditsError,
  editedDuration,
  normalizeEdits,
  sourceToEdited,
  type VideoEdits
} from './help-video-edits.js'
import { pickStreamFile, type StreamVersion } from './help-video-views.js'

// Downloading a help video to the desktop. The same rule as playback decides
// which file a person gets (pickStreamFile): viewers get the current render,
// or the original only when the edits hide nothing; authors get the render
// when current, else the original. A per-video switch ("Allow downloads",
// stored in the visibility JSON as `downloads: false`) turns it off for
// viewers; authors and admins can always download.

export type DownloadFile = 'video' | 'captions.vtt' | 'captions.srt'
export const DOWNLOAD_FILES: readonly DownloadFile[] = ['video', 'captions.vtt', 'captions.srt']

export function isDownloadFile(v: unknown): v is DownloadFile {
  return typeof v === 'string' && (DOWNLOAD_FILES as readonly string[]).includes(v)
}

/** Downloads are on unless the stored visibility says `downloads: false`.
 *  An unreadable value reads as on (the playback rules still apply). */
export function downloadsAllowed(rawVisibility: unknown): boolean {
  let v: unknown = rawVisibility
  if (typeof rawVisibility === 'string') {
    try {
      v = JSON.parse(rawVisibility)
    } catch {
      return true
    }
  }
  return !(v && typeof v === 'object' && (v as { downloads?: unknown }).downloads === false)
}

/** The stored visibility JSON with the downloads switch set, every other key kept. */
export function withDownloads(rawVisibility: unknown, allowed: boolean): string {
  let v: Record<string, unknown> = {}
  if (typeof rawVisibility === 'string') {
    try {
      const parsed = JSON.parse(rawVisibility)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) v = parsed
    } catch {
      v = {}
    }
  } else if (rawVisibility && typeof rawVisibility === 'object') {
    v = { ...(rawVisibility as Record<string, unknown>) }
  }
  if (!v.mode) {
    v.mode = 'everyone'
    v.role_ids = []
  }
  if (allowed) delete v.downloads
  else v.downloads = false
  return JSON.stringify(v)
}

// Control characters, path separators and characters Windows refuses in a
// file name. The title is the person's own text, never trusted as a path.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
const UNSAFE_NAME = /[\u0000-\u001f\u007f-\u009f/\\:*?"<>|]+/g

/** A safe file name from a video title: separators and control characters
 *  removed, whitespace collapsed, at most 120 characters, never empty and
 *  never a dot file. `ext` is given without the dot. */
export function safeDownloadName(title: unknown, ext: string): string {
  const cleanExt =
    String(ext)
      .replace(/[^a-z0-9]/gi, '')
      .slice(0, 8) || 'bin'
  let base = String(title ?? '')
    .normalize('NFC')
    .replace(UNSAFE_NAME, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '')
  if ([...base].length > 120) base = [...base].slice(0, 120).join('').trim()
  if (!base) base = 'help-video'
  return `${base}.${cleanExt}`
}

/** `attachment` with a plain ASCII fallback name and the full UTF-8 name
 *  (RFC 6266 + RFC 5987 `filename*`). */
export function contentDisposition(name: string): string {
  const ascii =
    name
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\x20-\x7e]/g, '_')
      .replace(/["\\]/g, '_')
      .replace(/%/g, '_') || 'download'
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  )
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

export type DownloadVersion = StreamVersion & { edits?: unknown; source_duration_ms?: unknown }

/** Which recording a download hands over — exactly what playback would
 *  play, except an author may ask for the original (`source`). */
export function pickDownloadFile(
  version: DownloadVersion,
  opts: { author: boolean; source: boolean }
): { fileId: string; kind: 'rendered' | 'source' } | null {
  return pickStreamFile(version, { author: opts.author, forceSource: opts.author && opts.source })
}

function parseEdits(version: DownloadVersion): VideoEdits | null {
  const sourceMs = Number(version.source_duration_ms ?? 30 * 60_000)
  let raw: unknown = version.edits
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (raw == null) return null
  try {
    return normalizeEdits(raw, sourceMs > 0 ? sourceMs : 30 * 60_000)
  } catch (err) {
    if (err instanceof EditsError) return null
    throw err
  }
}

export function hasCaptions(version: DownloadVersion): boolean {
  return (parseEdits(version)?.captions.length ?? 0) > 0
}

function cueTime(ms: number, sep: '.' | ','): string {
  const t = Math.max(0, Math.round(ms))
  const h = Math.floor(t / 3_600_000)
  const m = Math.floor((t % 3_600_000) / 60_000)
  const s = Math.floor((t % 60_000) / 1000)
  const f = t % 1000
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(f, 3)}`
}

/** Captions on the timeline of the file the same person downloads: the
 *  render plays in edited time; an original plays in source time. */
export function captionsVtt(version: DownloadVersion, timeline: 'edited' | 'source'): string {
  const e = parseEdits(version)
  if (!e) return 'WEBVTT\n\n'
  if (timeline === 'edited') return captionsToVtt(e)
  const cues = e.captions
    .filter((c) => c.end_ms > c.start_ms)
    .sort((a, b) => a.start_ms - b.start_ms)
    .map(
      (c, i) =>
        `${i + 1}\n${cueTime(c.start_ms, '.')} --> ${cueTime(c.end_ms, '.')}\n${c.text.replace(/\n{2,}/g, '\n')}`
    )
  return `WEBVTT\n\n${cues.join('\n\n')}${cues.length ? '\n' : ''}`
}

function clock(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const sec = String(t % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

/** VTT cue start times (ms) and text, in file order. */
function vttCues(vtt: string): Array<{ at: number; text: string }> {
  const out: Array<{ at: number; text: string }> = []
  for (const block of vtt.replace(/\r\n/g, '\n').split(/\n{2,}/)) {
    const lines = block.split('\n')
    const i = lines.findIndex((l) => l.includes('-->'))
    if (i < 0) continue
    const m = lines[i].match(/(\d+):(\d{2}):(\d{2})[.,](\d{3})/)
    if (!m) continue
    const at = ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4])
    const text = lines
      .slice(i + 1)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (text) out.push({ at, text })
  }
  return out
}

/** A plain-text transcript (#1529): the title, then every caption with its
 *  time, under a heading for each chapter. On the timeline of the file this
 *  person plays (see captionsVtt). Null when the version has no captions. */
export function transcriptText(
  version: DownloadVersion,
  title: unknown,
  timeline: 'edited' | 'source'
): string | null {
  const e = parseEdits(version)
  if (!e?.captions.length) return null
  const cues = vttCues(captionsVtt(version, timeline))
  if (!cues.length) return null
  const chapters = e.chapters
    .map((c) => ({
      title: c.title.trim() || 'Chapter',
      at: timeline === 'edited' ? sourceToEdited(e, c.at_ms) : c.at_ms
    }))
    .filter((c): c is { title: string; at: number } => c.at !== null)
    .sort((a, b) => a.at - b.at)
  const name = String(title ?? '').trim() || 'Help video'
  const length = timeline === 'edited' ? editedDuration(e) : Number(version.source_duration_ms ?? 0)
  const lines: string[] = [name, `Transcript${length > 0 ? ` · ${clock(length)}` : ''}`, '']
  let next = 0
  for (const cue of cues) {
    while (next < chapters.length && chapters[next].at <= cue.at) {
      const c = chapters[next++]
      if (lines[lines.length - 1] !== '') lines.push('')
      lines.push(`${c.title} (${clock(c.at)})`, '')
    }
    lines.push(`[${clock(cue.at)}] ${cue.text}`)
  }
  return `${lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`
}

/** WebVTT (as captionsVtt writes it) to SubRip: drop the header, number the
 *  cues from 1, decimal commas in the times. */
export function vttToSrt(vtt: string): string {
  const blocks = vtt
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter((b) => b && !b.startsWith('WEBVTT') && !b.startsWith('NOTE'))
  const out: string[] = []
  for (const b of blocks) {
    const lines = b.split('\n')
    const at = lines.findIndex((l) => l.includes('-->'))
    if (at < 0) continue
    const time = lines[at]
      .replace(/(\d{2}:\d{2}:\d{2})\.(\d{3})/g, '$1,$2')
      .replace(/(^|\s)(\d{2}:\d{2})\.(\d{3})/g, '$100:$2,$3')
      .split(/\s+(?=[a-z]+:)/i)[0]
    const text = lines.slice(at + 1).join('\n')
    if (!text.trim()) continue
    out.push(`${out.length + 1}\n${time}\n${text}`)
  }
  return out.length ? `${out.join('\n\n')}\n` : ''
}

/** Does this request start a download (and so deserve one activity row)?
 *  A resumed or seeking request (`Range` past the first byte) does not. */
export function startsDownload(rangeHeader: string | undefined): boolean {
  if (!rangeHeader) return true
  return /^bytes=0-/.test(rangeHeader.trim())
}

/** The extension for a stored recording's mime type. */
export function videoExtension(kind: 'rendered' | 'source', mime: unknown): string {
  if (kind === 'rendered') return 'mp4'
  return String(mime ?? '').includes('mp4') ? 'mp4' : 'webm'
}
