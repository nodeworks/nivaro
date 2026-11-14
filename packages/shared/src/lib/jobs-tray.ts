import { useSyncExternalStore } from 'react'

/**
 * The Jobs tray's state (#1724): what the signed-in person started and is still waiting on or
 * has not dismissed — bulk runs, backfills, imports, exports, PDFs. One model for all of them:
 * the server sends `job:progress { key, kind, label, status, progress?, outcome?, error?, href?,
 * file_id?, position?, eta_seconds? }` to the starter's own sockets, and `GET /my-jobs` seeds a
 * fresh page. The list is kept in localStorage so it follows the person across pages and tabs
 * until they dismiss an entry.
 */

export type TrayStatus = 'queued' | 'running' | 'completed' | 'error' | 'canceled'

export interface TrayJob {
  key: string
  kind: string
  label: string
  status: TrayStatus
  progress?: Record<string, unknown> | null
  outcome?: string | null
  error?: string | null
  href?: string | null
  file_id?: string | null
  /** API path the tray POSTs to cancel the job while it runs (#2456). */
  cancel_path?: string | null
  position?: number | null
  eta_seconds?: number | null
  /** ms epoch of the last update — orders the list and ages finished entries out. */
  at: number
}

export interface JobProgressPayload {
  key?: string
  kind?: string
  label?: string | null
  status?: TrayStatus
  progress?: Record<string, unknown> | null
  outcome?: string | null
  error?: string | null
  href?: string | null
  file_id?: string | null
  cancel_path?: string | null
  position?: number | null
  eta_seconds?: number | null
}

const STORAGE_KEY = 'nvr:jobs-tray:v1'
const DISMISSED_KEY = 'nvr:jobs-tray:dismissed:v1'
const MAX_JOBS = 20
/** A finished entry nobody dismissed leaves after a day. */
const FINISHED_TTL_MS = 24 * 60 * 60 * 1000

let jobs: TrayJob[] = []
let dismissed = new Set<string>()
let loaded = false
let version = 0
const listeners = new Set<() => void>()

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

/**
 * A job this TAB runs itself (`local:` keys — the collection list's CSV, built in the browser)
 * lives only as long as the tab: never stored, so a closed tab cannot leave another tab a
 * "running" entry nobody will ever finish. Its Cancel is a function, not an API path.
 */
export const LOCAL_JOB_PREFIX = 'local:'
const isLocal = (key: string) => key.startsWith(LOCAL_JOB_PREFIX)
const localCancels = new Map<string, () => void>()

/** Register the Cancel of a tab-local job (its `cancel_path` is its key). */
export function setLocalCancel(key: string, cancel: (() => void) | null): void {
  if (cancel) localCancels.set(key, cancel)
  else localCancels.delete(key)
}

/** Cancel a tab-local job; false when the path is not one. */
export function cancelLocalJob(path: string): boolean {
  const fn = localCancels.get(path)
  if (!fn) return false
  fn()
  return true
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(jobs.filter((j) => !isLocal(j.key))))
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...dismissed].slice(-200)))
  } catch {
    /* private window or blocked storage: the tray still works for this page */
  }
}

function notify(): void {
  version++
  for (const l of listeners) l()
}

function prune(): void {
  const cutoff = Date.now() - FINISHED_TTL_MS
  jobs = jobs
    .filter((j) => j.status === 'queued' || j.status === 'running' || j.at >= cutoff)
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_JOBS)
}

function load(): void {
  if (loaded || typeof window === 'undefined') return
  loaded = true
  jobs = read<TrayJob[]>(STORAGE_KEY, []).filter((j) => !isLocal(j.key))
  dismissed = new Set(read<string[]>(DISMISSED_KEY, []))
  prune()
  // Another tab changed the list (an update or a dismissal): follow it.
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY && e.key !== DISMISSED_KEY) return
    // This tab's own local jobs are not in storage: keep them.
    const mine = jobs.filter((j) => isLocal(j.key))
    jobs = [...mine, ...read<TrayJob[]>(STORAGE_KEY, []).filter((j) => !isLocal(j.key))]
    dismissed = new Set(read<string[]>(DISMISSED_KEY, []))
    notify()
  })
}

/** A key is dismissed for good once its run has finished; a re-run gets a fresh key anyway. */
function isDismissed(key: string, status: TrayStatus): boolean {
  return (
    dismissed.has(key) && (status === 'completed' || status === 'error' || status === 'canceled')
  )
}

/** Merge one server update. Exported for tests. */
export function applyJobUpdate(p: JobProgressPayload, now = Date.now()): void {
  load()
  if (!p?.key || !p.status) return
  const prev = jobs.find((j) => j.key === p.key)
  // A late progress tick must not drag a finished entry back to running.
  if (
    prev &&
    (prev.status === 'completed' || prev.status === 'error' || prev.status === 'canceled') &&
    p.status === 'running'
  )
    return
  // A run queued again (an import re-queued) is news even if its last run was dismissed.
  if (p.status === 'queued') dismissed.delete(p.key)
  if (isDismissed(p.key, p.status)) return
  const next: TrayJob = {
    key: p.key,
    kind: p.kind ?? prev?.kind ?? 'job',
    label: (p.label ?? prev?.label ?? 'Background job').slice(0, 200),
    status: p.status,
    progress: p.progress ?? (p.status === 'running' ? prev?.progress : null) ?? null,
    outcome: p.outcome ?? null,
    error: p.error ?? null,
    href: p.href ?? prev?.href ?? null,
    file_id: p.file_id ?? prev?.file_id ?? null,
    // Only a running job can be cancelled; a progress tick without it keeps the earlier one.
    cancel_path:
      p.status === 'running' || p.status === 'queued'
        ? (p.cancel_path ?? prev?.cancel_path ?? null)
        : null,
    position: p.position ?? null,
    eta_seconds: p.eta_seconds ?? null,
    at: now
  }
  jobs = [next, ...jobs.filter((j) => j.key !== p.key)]
  prune()
  persist()
  notify()
}

export interface TrayHeadline {
  /** Which mark the header carries: spinner, red alert, green check or the neutral stop. */
  tone: 'running' | 'failed' | 'done' | 'cancelled'
  text: string
  /** While something still runs: what already failed beside it ("1 failed"), else null. */
  note: string | null
}

const jobsWord = (n: number) => `${n} job${n === 1 ? '' : 's'}`

/**
 * The tray header in words that say what happened (go-live week review): a failed run never
 * reads as "finished" under a green check, and mixed results name each part, failures first —
 * "1 job failed, 2 done". A run still going leads; a failure beside it rides as the note.
 */
export function trayHeadline(list: TrayJob[]): TrayHeadline {
  let running = 0
  let failed = 0
  let done = 0
  let cancelled = 0
  for (const j of list) {
    if (j.status === 'running' || j.status === 'queued') running++
    else if (j.status === 'error') failed++
    else if (j.status === 'canceled') cancelled++
    else done++
  }
  if (running > 0)
    return {
      tone: 'running',
      text: `${jobsWord(running)} running`,
      note: failed > 0 ? `${failed} failed` : null
    }
  const parts: Array<[number, string]> = [
    [failed, 'failed'],
    [done, done && (failed || cancelled) ? 'done' : 'finished'],
    [cancelled, 'cancelled']
  ]
  const text = parts
    .filter(([n]) => n > 0)
    .map(([n, word], i) => (i === 0 ? `${jobsWord(n)} ${word}` : `${n} ${word}`))
    .join(', ')
  const tone = failed > 0 ? 'failed' : done > 0 ? 'done' : 'cancelled'
  return { tone, text, note: null }
}

/** Seed from `GET /my-jobs` (server truth for the keys it names). */
export function seedJobs(list: Array<JobProgressPayload & { at?: string }>): void {
  load()
  for (const p of list) applyJobUpdate(p, p.at ? new Date(p.at).getTime() : Date.now())
}

export function dismissJob(key: string): void {
  load()
  dismissed.add(key)
  jobs = jobs.filter((j) => j.key !== key)
  persist()
  notify()
}

export function dismissFinishedJobs(): void {
  load()
  for (const j of jobs) {
    if (j.status !== 'queued' && j.status !== 'running') dismissed.add(j.key)
  }
  jobs = jobs.filter((j) => j.status === 'queued' || j.status === 'running')
  persist()
  notify()
}

/** Follow every change of the list (export-runs.ts downloads a finished export with it). */
export function subscribeJobs(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** The current list (newest first). */
export function trayJobs(): TrayJob[] {
  load()
  return jobs
}

export function useTrayJobs(): TrayJob[] {
  load()
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => version,
    () => 0
  )
  return jobs
}

/** Test seam. */
export function __resetJobsTray(): void {
  localCancels.clear()
  jobs = []
  dismissed = new Set()
  loaded = true
  version = 0
}
export function __trayJobs(): TrayJob[] {
  return jobs
}
