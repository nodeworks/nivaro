/**
 * Document-autofill runs the app is watching — a module-level store, so a
 * run keeps polling while the person navigates and the app shell can show
 * a chip for it on every page. The new-record form subscribes to the same
 * run when it opens `?autofill=<id>`, so nothing polls twice.
 */
import { useSyncExternalStore } from 'react'
import { pollProposal } from './autofill-poll'

export type AutofillRunStatus = 'reading' | 'ready' | 'failed'

export type AutofillRun = {
  id: string
  collection: string
  /** What the person picked, or what the server says once it answers. */
  documentName: string
  layoutId?: number | null
  status: AutofillRunStatus
  proposal: unknown | null
  error: string | null
  startedAt: number
  /** A form is showing this run's dialog right now — the shell chip hides it. */
  presented: boolean
}

type FetchCfg = {
  apiBase: string
  authHeaders: Record<string, string>
  credentials: RequestCredentials
}

type Listener = () => void

let runs: AutofillRun[] = []
const stops = new Map<string, () => void>()
const listeners = new Set<Listener>()

const STORAGE_KEY = 'nvr:autofill-runs'

/** The runs survive a reload: ids + names ride sessionStorage and the shell
 *  re-watches them on mount (a landed run answers 200 at once). */
function persist() {
  try {
    const slim = runs.map((r) => ({
      id: r.id,
      collection: r.collection,
      documentName: r.documentName,
      layoutId: r.layoutId ?? null
    }))
    if (slim.length) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(slim))
    else sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    /* private mode / no storage */
  }
}

function emit() {
  runs = [...runs]
  persist()
  for (const l of listeners) l()
}

function patch(id: string, p: Partial<AutofillRun>) {
  const i = runs.findIndex((r) => r.id === id)
  if (i < 0) return
  runs[i] = { ...runs[i], ...p }
  emit()
}

export function getAutofillRuns(): AutofillRun[] {
  return runs
}

export function getAutofillRun(id: string): AutofillRun | undefined {
  return runs.find((r) => r.id === id)
}

export function subscribeAutofillRuns(l: Listener): () => void {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

/** Every run the shell should show or a form may pick up. */
export function useAutofillRuns(): AutofillRun[] {
  return useSyncExternalStore(subscribeAutofillRuns, getAutofillRuns, getAutofillRuns)
}

export function useAutofillRun(id: string | null | undefined): AutofillRun | undefined {
  const all = useAutofillRuns()
  return id ? all.find((r) => r.id === id) : undefined
}

/**
 * Start watching a run (idempotent — a known id is left alone). Polls until
 * the proposal lands or fails; the run stays in the store until it is
 * dismissed or its proposal is consumed by a form.
 */
export function startAutofillRun(
  cfg: FetchCfg,
  run: { id: string; collection: string; documentName?: string; layoutId?: number | null },
  deps: { poll?: typeof pollProposal } = {}
): AutofillRun {
  const existing = getAutofillRun(run.id)
  if (existing) return existing
  const entry: AutofillRun = {
    id: run.id,
    collection: run.collection,
    documentName: run.documentName ?? 'the document',
    layoutId: run.layoutId ?? null,
    status: 'reading',
    proposal: null,
    error: null,
    startedAt: Date.now(),
    presented: false
  }
  runs = [...runs, entry]
  emit()
  const poll = deps.poll ?? pollProposal
  const stop = poll({
    fetchResult: async () => {
      const res = await fetch(`${cfg.apiBase}/ai/extract-record/result/${run.id}`, {
        headers: cfg.authHeaders,
        credentials: cfg.credentials
      })
      const json = await res.json().catch(() => ({}))
      return { status: res.status, ok: res.ok, json }
    },
    onRunning: (name) => {
      if (name && !run.documentName) patch(run.id, { documentName: name })
    },
    onDone: (data) => patch(run.id, { status: 'ready', proposal: data }),
    onError: (message) => patch(run.id, { status: 'failed', error: message }),
    onSettled: () => stops.delete(run.id)
  })
  stops.set(run.id, stop)
  return entry
}

/** A form is (or is no longer) showing this run's dialog. */
export function setAutofillRunPresented(id: string, presented: boolean): void {
  const r = getAutofillRun(id)
  if (r && r.presented !== presented) patch(id, { presented })
}

/** Forget a run: stops watching it (the server run continues on its own). */
export function dismissAutofillRun(id: string): void {
  stops.get(id)?.()
  stops.delete(id)
  if (!getAutofillRun(id)) return
  runs = runs.filter((r) => r.id !== id)
  emit()
}

/** Re-watch the runs a previous page load left in sessionStorage. Call once
 *  from the app shell (the chip does); a known id is left alone. */
export function hydrateAutofillRuns(cfg: FetchCfg): void {
  let stored: Array<{
    id: string
    collection: string
    documentName?: string
    layoutId?: number | null
  }> = []
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    stored = raw ? (JSON.parse(raw) as typeof stored) : []
  } catch {
    stored = []
  }
  for (const r of stored) {
    if (r && typeof r.id === 'string' && typeof r.collection === 'string') startAutofillRun(cfg, r)
  }
}

/** Test hook: drop every run. */
export function resetAutofillRuns(): void {
  for (const s of stops.values()) s()
  stops.clear()
  runs = []
  emit()
}
