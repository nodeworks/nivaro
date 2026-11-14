import { toast } from 'sonner'
import { toastError } from './error-toast'
import {
  applyJobUpdate,
  type JobProgressPayload,
  LOCAL_JOB_PREFIX,
  setLocalCancel,
  subscribeJobs,
  type TrayJob,
  trayJobs
} from './jobs-tray'

/**
 * Exports with visible progress (#2122 follow-up).
 *
 * Every export shows up as a row in the Jobs tray — "Exporting Workflows · 12,400 of 86,000
 * rows", a bar, Cancel — and when it is done THIS tab downloads the file at once (other tabs
 * and later visits get the tray's Download chip and the "Your export is ready" notice).
 *
 *  - Server exports (`followExportRun`): an export endpoint answered 202 with a background
 *    run; the server reads the rows as the person and saves a private file. The tray follows
 *    the run over the socket (`job:progress`) and, as a net, `GET /export-runs/:id`.
 *  - Exports this tab builds itself (`startLocalExport`, the list's "CSV — visible columns"):
 *    the same tray row, fed by the page; Cancel stops it between reads.
 */

/** The 202 body of an export endpoint in background mode. */
export interface StartedExportRun {
  mode: 'background'
  run_id: number
  key: string
  label: string
  total: number | null
  cancel_path: string
}

export function isStartedExportRun(v: unknown): v is StartedExportRun {
  const r = v as StartedExportRun | null
  return !!r && r.mode === 'background' && typeof r.run_id === 'number' && typeof r.key === 'string'
}

/** "86,000 rows · Workflows.xlsx → file <id>" without the file reference the chip reads. */
export function withoutFileRef(outcome: string | null | undefined): string {
  return (outcome ?? '').replace(/\s*→ file [0-9a-fA-F-]{8,}\s*$/, '')
}

export const exportFileUrl = (fileId: string) =>
  `/api/files/${encodeURIComponent(fileId)}?download=1`

/** Hand the browser a download (no navigation away from the page). */
export function downloadUrl(url: string, filename?: string): void {
  if (typeof document === 'undefined') return
  const a = document.createElement('a')
  a.href = url
  if (filename) a.download = filename
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

/** Keys this tab started: their finish downloads / tells, once. */
const watched = new Map<string, { label: string; poll?: ReturnType<typeof setInterval> }>()
let unsubscribe: (() => void) | null = null

function settle(job: TrayJob): void {
  const w = watched.get(job.key)
  if (!w) return
  if (job.status === 'running' || job.status === 'queued') return
  watched.delete(job.key)
  if (w.poll) clearInterval(w.poll)
  if (watched.size === 0 && unsubscribe) {
    unsubscribe()
    unsubscribe = null
  }
  if (job.status === 'completed' && job.file_id) {
    const url = exportFileUrl(job.file_id)
    downloadUrl(url)
    toast.success('Your export is ready', {
      description: withoutFileRef(job.outcome) || w.label,
      action: { label: 'Download again', onClick: () => downloadUrl(url) }
    })
  } else if (job.status === 'error') {
    // The stored error is written for the log: describeError keeps raw text in the details.
    toastError({ message: job.error ?? '' }, 'The export did not finish')
  } else if (job.status === 'canceled') {
    toast('Export cancelled', { description: w.label })
  }
}

function check(): void {
  for (const job of trayJobs()) if (watched.has(job.key)) settle(job)
}

function watch(key: string, label: string, read?: () => Promise<JobProgressPayload | null>) {
  const entry: { label: string; poll?: ReturnType<typeof setInterval> } = { label }
  watched.set(key, entry)
  if (!unsubscribe) unsubscribe = subscribeJobs(check)
  // The socket carries every step; a read every few seconds is the net under it.
  if (read)
    entry.poll = setInterval(() => {
      read()
        .then((p) => {
          if (p) applyJobUpdate(p)
        })
        .catch(() => {})
    }, 4000)
}

/**
 * Follow a server export run in this tab: the tray row appears at once (before the first
 * socket event), and the file downloads when it is ready.
 */
export function followExportRun(
  run: StartedExportRun,
  opts: { read?: () => Promise<JobProgressPayload | null> } = {}
): void {
  applyJobUpdate({
    key: run.key,
    kind: 'export',
    label: run.label,
    status: 'running',
    progress: { phase: 'Starting', done: 0, total: run.total, unit: 'rows' },
    cancel_path: run.cancel_path
  })
  watch(run.key, run.label, opts.read)
  toast.info(`${run.label} in the background`, {
    description:
      'Follow it in the Jobs tray — it downloads here when it is ready, and you get a notice with the link.'
  })
}

export interface LocalExport {
  key: string
  /** Aborted by the tray's Cancel. */
  signal: AbortSignal
  progress(done: number, total?: number | null, phase?: string): void
  /** The file was handed to the browser. */
  finish(outcome: string): void
  fail(err: unknown): void
  /** Stopped by the person (signal aborted). */
  cancelled(): void
}

let localSeq = 0

/** A tray row for an export this tab builds itself. */
export function startLocalExport(what: string, total: number | null): LocalExport {
  const key = `${LOCAL_JOB_PREFIX}export:${Date.now().toString(36)}:${++localSeq}`
  const label = `Exporting ${what}`.slice(0, 200)
  const controller = new AbortController()
  let last = { done: 0, total, phase: 'Reading rows' }
  const push = (p: Partial<JobProgressPayload>) =>
    applyJobUpdate({ key, kind: 'export', label, status: 'running', ...p })
  setLocalCancel(key, () => controller.abort())
  push({ progress: { ...last, unit: 'rows' }, cancel_path: key })
  const end = (p: Partial<JobProgressPayload>) => {
    setLocalCancel(key, null)
    applyJobUpdate({ key, kind: 'export', label, status: 'completed', ...p })
  }
  return {
    key,
    signal: controller.signal,
    progress(done, t, phase) {
      last = { done, total: t === undefined ? last.total : t, phase: phase ?? last.phase }
      push({ progress: { ...last, unit: 'rows' } })
    },
    finish(outcome) {
      end({ outcome })
    },
    fail(err) {
      setLocalCancel(key, null)
      const d = toastError(err, 'The export did not finish')
      applyJobUpdate({ key, kind: 'export', label, status: 'error', error: d.title })
    },
    cancelled() {
      setLocalCancel(key, null)
      applyJobUpdate({ key, kind: 'export', label, status: 'canceled', outcome: 'Cancelled' })
      toast('Export cancelled', { description: what })
    }
  }
}

/** Thrown between reads once the person cancelled a local export. */
export class ExportCancelledError extends Error {
  constructor() {
    super('Export cancelled')
    this.name = 'ExportCancelledError'
  }
}

export function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new ExportCancelledError()
}

/** Test seam. */
export function __resetExportRuns(): void {
  for (const w of watched.values()) if (w.poll) clearInterval(w.poll)
  watched.clear()
  unsubscribe?.()
  unsubscribe = null
}
