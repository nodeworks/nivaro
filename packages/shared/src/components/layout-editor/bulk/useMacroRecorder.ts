import { useCallback, useMemo, useRef, useState } from 'react'
import { applyLayoutOps, type LayoutBundle, type LayoutOp } from '../../../lib/layout-ops'
import type { ApplyOptions, LayoutDraft } from '../useLayoutDraft'
import { appendStep, type MacroStep, toMacroSteps } from './macro-record'

/**
 * Record / Stop (#2663). Wraps the draft so every apply made while recording
 * is also written down as macro steps; Undo takes the last recorded change
 * back off the list and Redo puts it back, so the macro matches what the form
 * shows. The draft itself is untouched: the editor saves exactly as before.
 */
export interface MacroRecorder {
  recording: boolean
  steps: MacroStep[]
  /** The layout recording started on (the macro's source). */
  sourceLayoutId: number | null
  start(layoutId: number): void
  /** Stop recording; the steps stay until `clear` (to name and save them). */
  stop(): void
  clear(): void
}

interface Batch {
  steps: MacroStep[]
  text: boolean
  undoable: boolean
}

const flatten = (batches: Batch[]) =>
  batches.reduce<MacroStep[]>((acc, b) => b.steps.reduce(appendStep, acc), [])

export function useMacroRecorder(draft: LayoutDraft): {
  draft: LayoutDraft
  recorder: MacroRecorder
} {
  const [recording, setRecording] = useState(false)
  const [batches, setBatches] = useState<Batch[]>([])
  const [sourceLayoutId, setSource] = useState<number | null>(null)
  const recordingRef = useRef(false)
  const batchesRef = useRef<Batch[]>([])
  const redoRef = useRef<Batch[]>([])
  // The bundle the next apply lands on: the draft as rendered, moved on by
  // applies made since (several can run before the next render).
  const liveRef = useRef<LayoutBundle | null>(draft.bundle)
  const seenBundle = useRef<LayoutBundle | null>(draft.bundle)
  if (seenBundle.current !== draft.bundle) {
    seenBundle.current = draft.bundle
    liveRef.current = draft.bundle
  }
  const rawRef = useRef(draft)
  rawRef.current = draft

  const setAll = useCallback((next: Batch[]) => {
    batchesRef.current = next
    setBatches(next)
  }, [])

  const apply = useCallback(
    (ops: LayoutOp[], opts?: ApplyOptions) => {
      const before = liveRef.current
      if (recordingRef.current && before && ops.length) {
        const steps = toMacroSteps(before, ops)
        if (steps.length) {
          const text = !!opts?.text
          const cur = batchesRef.current
          const last = cur[cur.length - 1]
          // Typing the same setting again replaces the last value instead of adding a step.
          const merged =
            text && last?.text && last.steps.length === 1 && steps.length === 1
              ? appendStep(last.steps, steps[0])
              : null
          setAll(
            merged && merged.length === 1
              ? [...cur.slice(0, -1), { ...last, steps: merged }]
              : [...cur, { steps, text, undoable: opts?.undoable !== false }]
          )
          redoRef.current = []
        }
        try {
          liveRef.current = applyLayoutOps(before, ops)
        } catch {
          // The engine refuses it too; nothing changed.
        }
      }
      rawRef.current.apply(ops, opts)
    },
    [setAll]
  )

  const undo = useCallback(() => {
    if (recordingRef.current && rawRef.current.canUndo) {
      const cur = batchesRef.current
      let i = cur.length - 1
      while (i >= 0 && !cur[i].undoable) i--
      if (i >= 0) {
        redoRef.current = [...redoRef.current, cur[i]]
        setAll([...cur.slice(0, i), ...cur.slice(i + 1)])
      }
    }
    rawRef.current.undo()
  }, [setAll])

  const redo = useCallback(() => {
    if (recordingRef.current && rawRef.current.canRedo && redoRef.current.length) {
      const back = redoRef.current[redoRef.current.length - 1]
      redoRef.current = redoRef.current.slice(0, -1)
      setAll([...batchesRef.current, back])
    }
    rawRef.current.redo()
  }, [setAll])

  const start = useCallback(
    (layoutId: number) => {
      recordingRef.current = true
      redoRef.current = []
      setAll([])
      setSource(layoutId)
      setRecording(true)
    },
    [setAll]
  )
  const stop = useCallback(() => {
    recordingRef.current = false
    setRecording(false)
  }, [])
  const clear = useCallback(() => {
    recordingRef.current = false
    redoRef.current = []
    setAll([])
    setSource(null)
    setRecording(false)
  }, [setAll])

  const steps = useMemo(() => flatten(batches), [batches])
  const recorder = useMemo<MacroRecorder>(
    () => ({ recording, steps, sourceLayoutId, start, stop, clear }),
    [recording, steps, sourceLayoutId, start, stop, clear]
  )
  const wrapped = useMemo<LayoutDraft>(
    () => ({ ...draft, apply, undo, redo }),
    [draft, apply, undo, redo]
  )
  return { draft: wrapped, recorder }
}
