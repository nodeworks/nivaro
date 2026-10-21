import { useEffect, useRef } from 'react'

/**
 * The record page's side of Follow me (#2855). A record page (ItemEditForm)
 * publishes which record and tab it shows; the huddle's follow store reads it
 * to tell the presenter's position, and asks a follower's page to switch tab.
 * Sections are found in the DOM by `data-section-key` (GroupSection).
 *
 * Nothing here knows about sockets or routes: it is a tiny in-memory bus
 * between whatever record page is mounted and the huddle store, so it works
 * the same in every host.
 */

export interface RecordView {
  collection: string
  itemId: string
  step: string | null
}

interface Surface {
  token: number
  view: RecordView
  setStep: (step: string) => void
  /** When the page mounted: its first tab corrections (a stale remembered tab) are not clicks. */
  since: number
}

/** Tab changes this soon after a page mounts are the page settling, not the reader. */
const SETTLE_MS = 1500

let surfaces: Surface[] = []
let nextToken = 1
/** The step the follow store just asked for — a change to it is not the reader's own click. */
let expected: { token: number; step: string } | null = null
const listeners = new Set<() => void>()
const manualListeners = new Set<() => void>()

function notify() {
  for (const l of listeners) l()
}

/** The record page on screen (the one mounted last wins: a page under a drawer yields). */
export function currentRecordView(): RecordView | null {
  return surfaces.at(-1)?.view ?? null
}

export function subscribeRecordView(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** The reader changed tab themselves (a follower doing that stops following). */
export function onManualRecordChange(cb: () => void): () => void {
  manualListeners.add(cb)
  return () => {
    manualListeners.delete(cb)
  }
}

export function sameRecord(
  a: { collection: string; itemId?: string; id?: string } | null,
  b: { collection: string; itemId?: string; id?: string } | null
): boolean {
  if (!a || !b) return false
  const ai = String(a.itemId ?? a.id ?? '')
  const bi = String(b.itemId ?? b.id ?? '')
  return a.collection === b.collection && !!ai && ai.toUpperCase() === bi.toUpperCase()
}

/** Ask the page showing this record to open a tab; false when no such page is mounted. */
export function applyFollowStep(collection: string, itemId: string, step: string): boolean {
  const s = surfaces.at(-1)
  if (!s || !sameRecord(s.view, { collection, itemId })) return false
  if (s.view.step === step) return true
  expected = { token: s.token, step }
  s.setStep(step)
  return true
}

/** The first record section whose bottom is still below the page's top band. */
export function currentSection(root: ParentNode = document): string | null {
  const els = root.querySelectorAll<HTMLElement>('[data-section-key]')
  for (const el of els) {
    const r = el.getBoundingClientRect()
    if (r.height === 0) continue
    if (r.bottom > 140) return el.dataset.sectionKey ?? null
  }
  return null
}

export function scrollToSection(key: string, root: ParentNode = document): boolean {
  const el = root.querySelector<HTMLElement>(`[data-section-key="${CSS.escape(key)}"]`)
  if (!el) return false
  if (typeof el.scrollIntoView === 'function') {
    el.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }
  return true
}

/** Test seam: forget every mounted page. */
export function resetFollowBusForTests() {
  surfaces = []
  expected = null
  listeners.clear()
  manualListeners.clear()
}

/** Low-level registration (the hook below wraps it). */
export function registerRecordSurface(view: RecordView, setStep: (step: string) => void) {
  const token = nextToken++
  surfaces = [...surfaces, { token, view, setStep, since: Date.now() }]
  notify()
  return {
    update(next: RecordView) {
      const s = surfaces.find((x) => x.token === token)
      if (!s) return
      const prev = s.view
      s.view = next
      if (next.step !== prev.step) {
        const asked = expected?.token === token && expected.step === next.step
        if (asked) expected = null
        else if (
          prev.step !== null &&
          sameRecord(prev, next) &&
          Date.now() - s.since > SETTLE_MS &&
          s === surfaces.at(-1)
        ) {
          for (const l of manualListeners) l()
        }
      }
      notify()
    },
    remove() {
      surfaces = surfaces.filter((x) => x.token !== token)
      if (expected?.token === token) expected = null
      notify()
    }
  }
}

/**
 * ItemEditForm calls this once: `itemId` null = not a record page (new record,
 * layout design canvas, embedded form) and nothing is published.
 */
export function useHuddleFollowSurface({
  collection,
  itemId,
  step,
  setStep
}: {
  collection: string
  itemId: string | null
  step: string | null
  setStep: (step: string) => void
}) {
  const setRef = useRef(setStep)
  setRef.current = setStep
  const handle = useRef<ReturnType<typeof registerRecordSurface> | null>(null)
  const stepRef = useRef(step)
  stepRef.current = step

  useEffect(() => {
    if (!itemId) return
    const h = registerRecordSurface({ collection, itemId, step: stepRef.current }, (s) =>
      setRef.current(s)
    )
    handle.current = h
    return () => {
      h.remove()
      if (handle.current === h) handle.current = null
    }
  }, [collection, itemId])

  useEffect(() => {
    if (itemId) handle.current?.update({ collection, itemId, step })
  }, [collection, itemId, step])
}
