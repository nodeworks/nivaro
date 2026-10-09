import type { UploadRow } from '../api'
import { plainFailure } from '../recorder/failure'
import { MemoryPartStore, PartUploader } from '../recorder/partQueue'

// A video made elsewhere goes through the recorder's upload path: numbered
// parts sent in order with retries, then finalize. The server checks (and if
// a browser could not play it, converts) the file after finalize, in the
// background; this polls until the upload is finalized.

/** Part size for a picked file (the server takes up to 8 MB a part). */
export const FILE_PART_BYTES = 5 * 1024 * 1024
/** Same limit as a recording. */
export const MAX_FILE_BYTES = Math.round(1.2 * 1024 * 1024 * 1024)
/** The file chooser's filter. The server decides from the bytes, not this. */
export const VIDEO_FILE_ACCEPT = 'video/mp4,video/webm,video/quicktime,.mp4,.m4v,.webm,.mov'
const EXT_RE = /\.(mp4|m4v|webm|mov)$/i
const TYPE_RE = /^video\/(mp4|webm|quicktime|x-m4v)$/i

export type PickedFile = { name: string; size: number; type: string }

/** Why a picked file cannot be sent, said before a byte leaves the browser. */
export function pickedFileProblem(f: PickedFile): string | null {
  if (!f.size) return 'That file is empty.'
  if (f.size > MAX_FILE_BYTES) return 'Videos can be up to 1.2 GB. Choose a smaller file.'
  if (!EXT_RE.test(f.name) && !TYPE_RE.test(f.type)) return 'Choose an MP4, WebM or MOV video.'
  return null
}

/** The title a new video starts with: the file's name without its extension. */
export function titleFromFile(name: string): string {
  return name
    .replace(/\.[^.]+$/, '')
    .replace(/[_]+/g, ' ')
    .trim()
    .slice(0, 200)
}

/** An unfinished upload of this same file (name and size) that can carry on
 *  where it stopped, or null. */
export function resumePoint(
  rows: UploadRow[],
  f: PickedFile,
  partBytes = FILE_PART_BYTES
): { id: string; next_part: number; offset: number } | null {
  const fits = rows
    .filter(
      (r) =>
        r.source === 'upload' &&
        r.status === 'open' &&
        r.name === f.name &&
        r.size === f.size &&
        r.bytes_received <= f.size &&
        // Every part but the last is exactly partBytes long.
        (r.bytes_received === r.next_part * partBytes || r.bytes_received === f.size)
    )
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  const r = fits[0]
  return r ? { id: r.id, next_part: r.next_part, offset: r.bytes_received } : null
}

/** The parts still to send, as byte ranges. */
export function partRanges(
  size: number,
  offset: number,
  startPart: number,
  partBytes = FILE_PART_BYTES
): Array<{ n: number; start: number; end: number }> {
  const out: Array<{ n: number; start: number; end: number }> = []
  for (let start = offset, n = startPart; start < size; start += partBytes, n++) {
    out.push({ n, start, end: Math.min(size, start + partBytes) })
  }
  return out
}

/** The processing note the dialog shows while the server works on the file. */
export function phaseText(phase: string | null | undefined, progress: number | null | undefined) {
  if (phase === 'converting') {
    return `Converting it so every browser can play it${progress != null ? ` · ${progress}%` : ''}`
  }
  if (phase === 'waiting') return 'Waiting for another video to finish converting'
  if (phase === 'saving') return 'Saving the video'
  return 'Checking the video'
}

export type FileUploadProgress =
  | { stage: 'uploading'; sent: number; total: number }
  | { stage: 'processing'; phase: string | null; progress: number | null }

/** A failure the dialog shows: the server's sentence, and whether trying
 *  again (with the same file) could help. */
export class FileUploadError extends Error {
  retryable: boolean
  constructor(message: string, retryable: boolean) {
    super(message)
    this.retryable = retryable
  }
}

export interface FileUploadDeps {
  api: {
    myUploads: () => Promise<UploadRow[]>
    openFileUpload: (f: PickedFile) => Promise<{ id: string; next_part: number }>
    finalizeFileUpload: (id: string) => Promise<unknown>
    uploadStatus: (id: string) => Promise<UploadRow>
  }
  send: (uploadId: string, n: number, blob: Blob, signal?: AbortSignal) => Promise<void>
  sleep?: (ms: number) => Promise<void>
  pollMs?: number
  partBytes?: number
}

const CANCELLED = 'cancelled'
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function check(signal: AbortSignal) {
  if (signal.aborted) throw new FileUploadError(CANCELLED, false)
}

/**
 * Sends a picked video file and waits until the server has kept it. Resolves
 * with the finalized upload id (ready for `create`). `onUploadId` hands the id
 * over as soon as it exists, so a cancel can discard it.
 */
export async function uploadVideoFile(
  deps: FileUploadDeps,
  file: Blob & PickedFile,
  opts: {
    signal: AbortSignal
    onProgress: (p: FileUploadProgress) => void
    onUploadId: (id: string) => void
  }
): Promise<string> {
  const { signal } = opts
  const partBytes = deps.partBytes ?? FILE_PART_BYTES
  const sleep = deps.sleep ?? wait
  const problem = pickedFileProblem(file)
  if (problem) throw new FileUploadError(problem, false)
  const fail = (err: unknown): never => {
    if (err instanceof FileUploadError) throw err
    check(signal)
    const f = plainFailure(err)
    throw new FileUploadError(f.message, f.retryable)
  }

  const rows = await deps.api.myUploads().catch(() => [] as UploadRow[])
  check(signal)
  const resume = resumePoint(rows, file, partBytes)
  let id: string
  let startPart = 0
  let offset = 0
  if (resume) {
    ;({ id, next_part: startPart, offset } = resume)
  } else {
    id = (await deps.api.openFileUpload(file).catch(fail)).id
  }
  opts.onUploadId(id)
  check(signal)

  let sent = offset
  opts.onProgress({ stage: 'uploading', sent, total: file.size })
  const uploader = new PartUploader({
    uploadId: id,
    store: new MemoryPartStore(),
    startAt: startPart,
    sleep,
    send: async (n, blob) => {
      check(signal)
      await deps.send(id, n, blob, signal)
      sent += blob.size
      opts.onProgress({ stage: 'uploading', sent, total: file.size })
    }
  })
  for (const r of partRanges(file.size, offset, startPart, partBytes)) {
    uploader.enqueue(file.slice(r.start, r.end))
  }
  await uploader.drain().catch(fail)
  check(signal)

  opts.onProgress({ stage: 'processing', phase: 'checking', progress: null })
  try {
    await deps.api.finalizeFileUpload(id)
  } catch (err) {
    // An earlier finalize (a retry after a dropped answer) is still working.
    const e = err as { response?: { code?: unknown } }
    if (e.response?.code !== 'UPLOAD_CLOSED') fail(err)
  }

  let misses = 0
  for (;;) {
    check(signal)
    let row: UploadRow
    try {
      row = await deps.api.uploadStatus(id)
      misses = 0
    } catch (err) {
      if (++misses >= 10) fail(err)
      await sleep(deps.pollMs ?? 1200)
      continue
    }
    if (row.status === 'finalized' || row.status === 'used') return id
    if (row.status === 'abandoned') {
      throw new FileUploadError(row.error ?? 'The video was not kept.', false)
    }
    if (row.status === 'open') {
      throw new FileUploadError(row.error ?? 'The video could not be saved.', true)
    }
    opts.onProgress({
      stage: 'processing',
      phase: row.phase ?? null,
      progress: row.progress ?? null
    })
    await sleep(deps.pollMs ?? 1200)
  }
}

export function isCancelled(err: unknown): boolean {
  return err instanceof FileUploadError && err.message === CANCELLED
}
