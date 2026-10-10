import type { RecordedMark } from '../types'

/**
 * Script mode (#1491): the author writes the steps before recording (one per
 * line), the recording bar shows them as a teleprompter and "Next" marks
 * where each step starts. The marks go up with the upload's finalize meta
 * (`script`, the steps; `marks`, `[{ t_ms, step }]` in source time like
 * clicks) and the server turns them into the draft's chapters. The server
 * mirror: api/src/services/help-video-script.ts.
 */

export const SCRIPT_LIMITS = {
  /** Steps per script. */
  steps: 60,
  /** Characters per step. */
  stepChars: 200
} as const

export type { RecordedMark }

/** The textarea's text as steps: one per non-empty line, trimmed, whitespace
 *  collapsed. `problem` names the first limit the text breaks, if any. */
export function parseScript(text: string): { steps: string[]; problem: string | null } {
  const steps = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  let problem: string | null = null
  if (steps.length > SCRIPT_LIMITS.steps) {
    problem = `A script can have up to ${SCRIPT_LIMITS.steps} steps (this one has ${steps.length}).`
  } else {
    const long = steps.findIndex((s) => s.length > SCRIPT_LIMITS.stepChars)
    if (long >= 0) {
      problem = `Step ${long + 1} is longer than ${SCRIPT_LIMITS.stepChars} characters.`
    }
  }
  return { steps, problem }
}

/** The steps as the textarea shows them (a re-record pre-fills from the draft). */
export function scriptText(steps: string[] | null | undefined): string {
  return (steps ?? []).join('\n')
}

/**
 * The teleprompter's shortcut for Next: Alt+Shift+N (⌥⇧N). Not ⌘⇧N / Ctrl+Shift+N,
 * which the browser keeps for itself (a private window) and never hands to a
 * page. Matched on the physical key so it works on any keyboard layout; the
 * recorder stops the event there so nothing is typed into a field.
 */
export const NEXT_STEP_KEY_LABEL =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '')
    ? '⌥⇧N'
    : 'Alt+Shift+N'

export function isNextStepKey(e: {
  key?: string
  code?: string
  altKey: boolean
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  repeat?: boolean
}): boolean {
  if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey || e.repeat) return false
  return e.code === 'KeyN' || (e.key ?? '').toLowerCase() === 'n'
}

/** What the teleprompter shows for step `index` of `steps`. */
export function teleprompterView(
  steps: string[],
  index: number
): { current: string; next: string | null; label: string; last: boolean } | null {
  if (!steps.length) return null
  const i = Math.min(steps.length - 1, Math.max(0, index))
  return {
    current: steps[i],
    next: i + 1 < steps.length ? steps[i + 1] : null,
    label: `Step ${i + 1} of ${steps.length}`,
    last: i + 1 >= steps.length
  }
}
