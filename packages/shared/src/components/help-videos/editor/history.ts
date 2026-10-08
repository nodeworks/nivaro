import type { VideoEdits } from '../types'

export type History = {
  past: VideoEdits[]
  present: VideoEdits
  future: VideoEdits[]
  lastKey: string | null
  lastAt: number
}
export type HistoryAction =
  | { type: 'set'; edits: VideoEdits; key?: string; now: number }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'reset'; edits: VideoEdits }
  /** Swap in the copy the server stored for `from`, in place: no undo step.
   *  Ignored once `present` is no longer `from` (the author moved on). */
  | { type: 'adopt'; from: VideoEdits; edits: VideoEdits }

const MERGE_MS = 800
const MAX = 100

export function initHistory(e: VideoEdits): History {
  return { past: [], present: e, future: [], lastKey: null, lastAt: 0 }
}

export function historyReducer(h: History, a: HistoryAction): History {
  switch (a.type) {
    case 'set': {
      if (a.edits === h.present) return h
      // Consecutive changes under one key (a drag) within 800 ms are one step.
      const merge = !!a.key && a.key === h.lastKey && a.now - h.lastAt < MERGE_MS
      const past = merge ? h.past : [...h.past, h.present].slice(-MAX)
      return { past, present: a.edits, future: [], lastKey: a.key ?? null, lastAt: a.now }
    }
    case 'undo': {
      if (!h.past.length) return h
      return {
        past: h.past.slice(0, -1),
        present: h.past[h.past.length - 1],
        future: [h.present, ...h.future],
        lastKey: null,
        lastAt: 0
      }
    }
    case 'redo': {
      if (!h.future.length) return h
      return {
        past: [...h.past, h.present],
        present: h.future[0],
        future: h.future.slice(1),
        lastKey: null,
        lastAt: 0
      }
    }
    case 'reset':
      return initHistory(a.edits)
    case 'adopt':
      return h.present === a.from && a.edits !== h.present ? { ...h, present: a.edits } : h
  }
}
