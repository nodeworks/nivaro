import { useSyncExternalStore } from 'react'
import type { WalkStep } from '../types'

// Two small module stores: the help-video page key of the screen on show
// (registered by a mounted HelpVideoButton with `page`), and the guided walk
// in progress. Module level so they outlive the component that started them:
// a walk keeps going when the sheet that started it closes.

type Listener = () => void

function makeStore<T>(initial: T) {
  let value = initial
  const subs = new Set<Listener>()
  return {
    get: () => value,
    set(next: T) {
      value = next
      for (const l of [...subs]) l()
    },
    subscribe(l: Listener) {
      subs.add(l)
      return () => subs.delete(l)
    }
  }
}

// ── Page key ─────────────────────────────────────────────────────────────────
const pages = makeStore<string[]>([])

/** Marks `key` as the screen's page key until the returned function runs. */
export function registerHelpVideoPage(key: string): () => void {
  pages.set([...pages.get(), key])
  return () => {
    const list = [...pages.get()]
    const i = list.lastIndexOf(key)
    if (i >= 0) list.splice(i, 1)
    pages.set(list)
  }
}

/** The page key of the screen on show (the latest mounted), or null. */
export function currentHelpVideoPage(): string | null {
  const list = pages.get()
  return list[list.length - 1] ?? null
}

export function useCurrentHelpVideoPage(): string | null {
  return useSyncExternalStore(pages.subscribe, currentHelpVideoPage, () => null)
}

// ── Walk ─────────────────────────────────────────────────────────────────────
export type Walk = {
  videoId: string
  title: string
  steps: WalkStep[]
  index: number
  /** The sheet is open on this step ("Watch this step"); the overlay waits. */
  watching: boolean
  /** Bumps on every start, so a restarted walk is a new walk. */
  run: number
}

const walk = makeStore<Walk | null>(null)
let runs = 0

export function startHelpVideoWalk(w: {
  videoId: string
  title: string
  steps: WalkStep[]
  index?: number
}) {
  if (!w.steps.length) return
  runs += 1
  walk.set({
    videoId: w.videoId,
    title: w.title,
    steps: w.steps,
    index: Math.min(Math.max(0, w.index ?? 0), w.steps.length - 1),
    watching: false,
    run: runs
  })
}

/** Moves to step `index`; past the last step the walk ends. */
export function goToWalkStep(index: number) {
  const w = walk.get()
  if (!w) return
  if (index >= w.steps.length) walk.set(null)
  else walk.set({ ...w, index: Math.max(0, index), watching: false })
}

export function setWalkWatching(watching: boolean) {
  const w = walk.get()
  if (w && w.watching !== watching) walk.set({ ...w, watching })
}

export function endHelpVideoWalk() {
  walk.set(null)
}

export function currentWalk(): Walk | null {
  return walk.get()
}

export function useHelpVideoWalk(): Walk | null {
  return useSyncExternalStore(walk.subscribe, walk.get, () => null)
}

// ── One overlay ──────────────────────────────────────────────────────────────
// Every host (the recording provider, each sheet) mounts a walk host; only the
// earliest still mounted draws, so the overlay survives the sheet closing and
// is never drawn twice.
const hosts = makeStore<symbol[]>([])

export function claimWalkHost(id: symbol): () => void {
  hosts.set([...hosts.get(), id])
  return () => hosts.set(hosts.get().filter((h) => h !== id))
}

export function useIsWalkOwner(id: symbol): boolean {
  return useSyncExternalStore(
    hosts.subscribe,
    () => hosts.get()[0] === id,
    () => false
  )
}
