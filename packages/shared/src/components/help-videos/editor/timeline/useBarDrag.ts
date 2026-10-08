import {
  type MutableRefObject,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useMemo
} from 'react'
import type { VideoEdits } from '../../types'
import type { Selection } from './Lanes'

const SNAP_PX = 8
const EDGE_PX = 6
const MIN_ITEM_MS = 200

export type Change = { edits: VideoEdits; refused?: string }
export const sentence = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`)

/** Dragging, stretching, snapping and keyboard nudges for timeline bars. A
 *  change the server would refuse is not applied; its reason goes to setNote. */
export function useBarDrag({
  edits,
  sourceMs,
  pps,
  playheadSrcMs,
  dragging,
  onChange,
  onSelect,
  setNote
}: {
  edits: VideoEdits
  sourceMs: number
  pps: number
  playheadSrcMs: number
  dragging: MutableRefObject<boolean>
  onChange: (e: VideoEdits, key?: string) => void
  onSelect: (s: Selection) => void
  setNote: (n: string | null) => void
}) {
  const toPx = (ms: number) => (ms / 1000) * pps
  const snapTargets = useMemo(() => {
    const t = [playheadSrcMs, 0, sourceMs]
    for (const s of edits.segments) t.push(s.start_ms, s.end_ms)
    for (const k of ['annotations', 'zooms', 'blurs', 'captions'] as const)
      for (const x of edits[k]) t.push(x.start_ms, x.end_ms)
    for (const c of edits.chapters) t.push(c.at_ms)
    return t
  }, [edits, playheadSrcMs, sourceMs])
  const snap = (ms: number, own: number[]) => {
    for (const t of snapTargets)
      if (!own.includes(t) && Math.abs(toPx(t) - toPx(ms)) <= SNAP_PX) return t
    return Math.round(ms)
  }

  /** Apply a change, or show why it was refused (edits stay as they were). */
  const commit = (r: Change, key?: string) => {
    if (r.refused) {
      setNote(sentence(r.refused))
      return
    }
    setNote(null)
    if (r.edits !== edits) onChange(r.edits, key)
  }

  // Generic drag for any timed bar: move it, or stretch it from either edge.
  const drag = (
    e: ReactPointerEvent<HTMLElement>,
    start: number,
    end: number,
    apply: (s: number, en: number) => Change,
    key: string,
    resizable = true
  ) => {
    if (e.button !== 0) return
    e.stopPropagation()
    setNote(null)
    const target = e.currentTarget
    const rect = target.getBoundingClientRect()
    const mode = !resizable
      ? 'move'
      : e.clientX - rect.left < EDGE_PX
        ? 'start'
        : rect.right - e.clientX < EDGE_PX
          ? 'end'
          : 'move'
    const x0 = e.clientX
    target.setPointerCapture(e.pointerId)
    dragging.current = true
    let last: VideoEdits | null = null
    const move = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - x0) < 2 && !last) return
      const d = ((ev.clientX - x0) / pps) * 1000
      let s = start
      let en = end
      if (mode === 'move') {
        s = snap(Math.max(0, Math.min(sourceMs - (end - start), start + d)), [start, end])
        en = s + (end - start)
      } else if (mode === 'start')
        s = snap(Math.min(end - MIN_ITEM_MS, Math.max(0, start + d)), [start])
      else en = snap(Math.max(start + MIN_ITEM_MS, Math.min(sourceMs, end + d)), [end])
      const r = apply(s, en)
      if (r.refused) setNote(sentence(r.refused))
      else if (r.edits !== last) {
        setNote(null)
        last = r.edits
        onChange(r.edits, key)
      }
    }
    const up = () => {
      dragging.current = false
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', up)
      target.removeEventListener('pointercancel', up)
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up)
    target.addEventListener('pointercancel', up)
  }

  // Keyboard: arrows nudge a selected bar (Shift = 1 s), Delete removes it.
  const nudge = (
    e: ReactKeyboardEvent,
    apply: (deltaMs: number) => Change,
    key: string,
    remove?: () => VideoEdits
  ) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      const step = e.shiftKey ? 1000 : 100
      commit(apply(e.key === 'ArrowLeft' ? -step : step), key)
    } else if (remove && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault()
      e.stopPropagation()
      setNote(null)
      onChange(remove())
      onSelect(null)
    }
  }

  return { drag, nudge }
}
