import {
  type MutableRefObject,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useMemo,
  useRef
} from 'react'
import type { VideoEdits } from '../../types'
import type { Selection } from './Lanes'

const SNAP_PX = 8
const EDGE_PX = 6
const MIN_ITEM_MS = 200

export type Change = { edits: VideoEdits; refused?: string }
/** Notes read as sentences: every one ends with a full stop. */
export const sentence = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`)

/**
 * Dragging, stretching, snapping and keyboard handling for timeline bars.
 * A change the server would refuse is not applied; its reason goes to
 * `setNote`. The returned callbacks never change identity: they read the
 * latest edits, zoom and playhead through refs, so the memoised lanes are
 * not re-rendered by the playhead moving.
 */
export function useBarDrag(opts: {
  edits: VideoEdits
  sourceMs: number
  pps: number
  playheadSrcMs: number
  dragging: MutableRefObject<boolean>
  onChange: (e: VideoEdits, key?: string) => void
  onSelect: (s: Selection) => void
  setNote: (n: string | null) => void
}) {
  const latest = useRef(opts)
  latest.current = opts
  const { edits, sourceMs } = opts
  // The playhead is read at snap time (latest.current), not memoised in.
  const snapTargets = useMemo(() => {
    const t = [0, sourceMs]
    for (const s of edits.segments) t.push(s.start_ms, s.end_ms)
    for (const k of ['annotations', 'zooms', 'blurs', 'captions'] as const)
      for (const x of edits[k]) t.push(x.start_ms, x.end_ms)
    for (const c of edits.chapters) t.push(c.at_ms)
    return t
  }, [edits, sourceMs])
  const targets = useRef(snapTargets)
  targets.current = snapTargets

  const snap = useCallback((ms: number, own: number[]) => {
    const { pps, playheadSrcMs } = latest.current
    const px = (v: number) => (v / 1000) * pps
    for (const t of [playheadSrcMs, ...targets.current])
      if (!own.includes(t) && Math.abs(px(t) - px(ms)) <= SNAP_PX) return t
    return Math.round(ms)
  }, [])

  /** Apply a change, or show why it was refused (edits stay as they were). */
  const commit = useCallback((r: Change, key?: string) => {
    const { setNote, onChange, edits: now } = latest.current
    if (r.refused) {
      setNote(sentence(r.refused))
      return
    }
    setNote(null)
    if (r.edits !== now) onChange(r.edits, key)
  }, [])

  // Generic drag for any timed bar: move it, or stretch it from either edge.
  const drag = useCallback(
    (
      e: ReactPointerEvent<HTMLElement>,
      start: number,
      end: number,
      apply: (s: number, en: number) => Change,
      key: string,
      resizable = true
    ) => {
      if (e.button !== 0) return
      e.stopPropagation()
      const { setNote, dragging, pps, sourceMs: total } = latest.current
      setNote(null)
      const target = e.currentTarget
      // Safari doesn't focus a button on click; arrow keys need the focus.
      target.focus({ preventScroll: true })
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
          s = snap(Math.max(0, Math.min(total - (end - start), start + d)), [start, end])
          en = s + (end - start)
        } else if (mode === 'start')
          s = snap(Math.min(end - MIN_ITEM_MS, Math.max(0, start + d)), [start])
        else en = snap(Math.max(start + MIN_ITEM_MS, Math.min(total, end + d)), [end])
        const r = apply(s, en)
        if (r.refused) latest.current.setNote(sentence(r.refused))
        else if (r.edits !== last) {
          latest.current.setNote(null)
          last = r.edits
          latest.current.onChange(r.edits, key)
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
    },
    [snap]
  )

  /**
   * Keyboard on a focused bar (one tab stop per lane):
   * - Left/Right, Home/End: move to the previous, next, first or last bar.
   * - Alt+Left/Right: nudge it by 0.1 s (Shift: 1 s), when `apply` is given.
   * - Delete/Backspace: remove it, when `remove` is given.
   */
  const nudge = useCallback(
    (
      e: ReactKeyboardEvent<HTMLElement>,
      apply: ((deltaMs: number) => Change) | null,
      key: string,
      remove?: () => VideoEdits
    ) => {
      const arrow = e.key === 'ArrowLeft' || e.key === 'ArrowRight'
      if (arrow && e.altKey) {
        if (!apply) return
        e.preventDefault()
        const step = e.shiftKey ? 1000 : 100
        commit(apply(e.key === 'ArrowLeft' ? -step : step), key)
      } else if (arrow || e.key === 'Home' || e.key === 'End') {
        const lane = e.currentTarget.parentElement
        const bars = lane
          ? Array.from(lane.querySelectorAll<HTMLElement>('[data-hv-order]')).sort(
              (a, b) => Number(a.dataset.hvOrder) - Number(b.dataset.hvOrder)
            )
          : []
        const i = bars.indexOf(e.currentTarget)
        const j =
          e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? bars.length - 1
              : i + (e.key === 'ArrowLeft' ? -1 : 1)
        const next = bars[j]
        if (!next || next === e.currentTarget) return
        e.preventDefault()
        next.focus()
        next.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
      } else if (remove && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault()
        e.stopPropagation()
        const { setNote, onChange, onSelect } = latest.current
        setNote(null)
        onChange(remove())
        onSelect(null)
      }
    },
    [commit]
  )

  return useMemo(() => ({ drag, nudge }), [drag, nudge])
}
