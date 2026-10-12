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

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(jobs))
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
  jobs = read<TrayJob[]>(STORAGE_KEY, [])
  dismissed = new Set(read<string[]>(DISMISSED_KEY, []))
  prune()
  // Another tab changed the list (an update or a dismissal): follow it.
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY && e.key !== DISMISSED_KEY) return
    jobs = read<TrayJob[]>(STORAGE_KEY, [])
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
    position: p.position ?? null,
    eta_seconds: p.eta_seconds ?? null,
    at: now
  }
  jobs = [next, ...jobs.filter((j) => j.key !== p.key)]
  prune()
  persist()
  notify()
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
  jobs = []
  dismissed = new Set()
  loaded = true
  version = 0
}
export function __trayJobs(): TrayJob[] {
  return jobs
}
