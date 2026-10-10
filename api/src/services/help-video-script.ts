import { type Chapter, EDIT_LIMITS, type VideoEdits } from './help-video-edits.js'

/**
 * Script mode (#1491): the author writes the steps before recording, the
 * recorder shows them as a teleprompter and "Next" marks where each step
 * starts. The script travels with the upload's finalize meta (`script`, the
 * steps; `marks`, `[{ t_ms, step }]` in source time like clicks), is kept on
 * the version (the `script` column, a JSON array) so a re-record can reuse
 * it, and becomes the draft's first chapters. The client mirror:
 * packages/shared/src/components/help-videos/recorder/script.ts.
 */

export const SCRIPT_LIMITS = {
  /** Steps per script. */
  steps: 60,
  /** Characters per step. */
  stepChars: 200,
  /** Marks kept per recording (one per step is all that is used). */
  marks: 200,
  /** Source time a mark can sit at (the 30:00 limit, with slack). */
  maxMs: 31 * 60_000
} as const

/** One "Next" press while recording: step `step` (0-based) starts at `t_ms`. */
export interface RecordedMark {
  t_ms: number
  step: number
}

/** The script as stored: trimmed non-empty lines, cut to length and count.
 *  Null when there is no script (not an array, or nothing left). */
export function normalizeScript(raw: unknown): string[] | null {
  if (raw == null || !Array.isArray(raw)) return null
  const out: string[] = []
  for (const line of raw) {
    if (out.length >= SCRIPT_LIMITS.steps) break
    if (typeof line !== 'string') continue
    const text = line.replace(/\s+/g, ' ').trim().slice(0, SCRIPT_LIMITS.stepChars).trim()
    if (text) out.push(text)
  }
  return out.length ? out : null
}

/** The marks as stored: finite, in range, whole numbers, sorted by time and
 *  capped. Null stays null (no script); [] when a script had no Next pressed. */
export function normalizeMarks(raw: unknown): RecordedMark[] | null {
  if (raw == null || !Array.isArray(raw)) return null
  const out: RecordedMark[] = []
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue
    const o = m as Record<string, unknown>
    const t = Number(o.t_ms)
    const step = Number(o.step)
    if (!Number.isFinite(t) || !Number.isFinite(step)) continue
    if (t < 0 || t > SCRIPT_LIMITS.maxMs) continue
    if (step < 0 || step >= SCRIPT_LIMITS.steps || !Number.isInteger(step)) continue
    out.push({ t_ms: Math.round(t), step })
  }
  out.sort((a, b) => a.t_ms - b.t_ms || a.step - b.step)
  return out.slice(0, SCRIPT_LIMITS.marks)
}

/**
 * The chapters a script makes: the first step starts at 0, every other step
 * where it was first marked (a step never marked makes no chapter), titles
 * cut to the chapter-title limit, in time order. [] without a script.
 */
export function chaptersFromScript(
  script: string[] | null | undefined,
  marks: RecordedMark[] | null | undefined,
  sourceMs: number
): Chapter[] {
  if (!script?.length) return []
  const max = Math.max(0, Math.round(sourceMs))
  const at = new Map<number, number>([[0, 0]])
  for (const m of marks ?? []) {
    if (m.step <= 0 || m.step >= script.length || at.has(m.step)) continue
    const t = Math.max(0, Math.round(m.t_ms))
    at.set(m.step, max ? Math.min(max, t) : t)
  }
  return [...at.entries()]
    .sort((a, b) => a[1] - b[1] || a[0] - b[0])
    .slice(0, EDIT_LIMITS.chapters)
    .map(([step, t]) => ({
      id: `script-${step + 1}`,
      at_ms: t,
      title: script[step].slice(0, EDIT_LIMITS.chapterTitle).trim() || `Step ${step + 1}`
    }))
}

/** `edits` with the script's chapters in place of its (empty) ones. The same
 *  object back when there is no script, so edits stay byte-identical. */
export function withScriptChapters(
  edits: VideoEdits,
  script: string[] | null | undefined,
  marks: RecordedMark[] | null | undefined,
  sourceMs: number
): VideoEdits {
  const chapters = chaptersFromScript(script, marks, sourceMs)
  return chapters.length ? { ...edits, chapters } : edits
}
