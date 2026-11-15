import { useEffect, useRef, useState } from 'react'
import { getLiveMode } from './live-preference'

/**
 * "Lines 12 → 13" (realtime round 8, item 20). A folded line section keeps its row count in the
 * header; when the count moves while the section is folded (someone added or removed a line),
 * the header says where it came from for a few seconds, then settles on the new number.
 *
 * Only in Normal live mode: Calm shows the new number without the mark, Off never gets the
 * change in the first place. The first value a section shows is never a step.
 */

export const COUNT_STEP_MS = 6000

export interface CountStep {
  from: number
  to: number
}

/** The step between two shown values, or null (pure; exported for tests). */
export function countStepOf(
  before: number | null | undefined,
  after: number | null | undefined,
  mode: string
): CountStep | null {
  if (mode !== 'normal') return null
  if (before == null || after == null || before === after) return null
  return { from: before, to: after }
}

/** The capped read (≤ cap rows) shows "200+" at the cap. */
export function countLabel(n: number, cap = 200): string {
  return n >= cap ? `${cap}+` : String(n)
}

export function useCountStep(value: number | null | undefined, enabled = true): CountStep | null {
  const prev = useRef<number | null | undefined>(undefined)
  const [step, setStep] = useState<CountStep | null>(null)
  useEffect(() => {
    const before = prev.current
    prev.current = value
    if (!enabled || before === undefined) return
    const next = countStepOf(before, value, getLiveMode())
    if (!next) {
      setStep(null)
      return
    }
    setStep(next)
    const t = setTimeout(() => setStep(null), COUNT_STEP_MS)
    return () => clearTimeout(t)
  }, [value, enabled])
  return enabled ? step : null
}
