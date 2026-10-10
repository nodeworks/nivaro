import type { HelpVideoQuestion } from '../types'

// "Was this helpful?" and questions at a moment (#1505): the rules the panel
// under the player follows, kept free of React.

/** The server's question limit (the route answers 400 past it). */
export const QUESTION_MAX = 1000
/** The completion threshold: 18 of the video's 20 sections. */
export const FEEDBACK_THRESHOLD = 0.9

/** The thumbs show when the video has ended, when playback has reached the
 *  completion threshold, or when this person already finished it before. */
export function feedbackDue(s: {
  editedMs: number
  totalMs: number
  ended: boolean
  completed: boolean
}): boolean {
  if (s.ended || s.completed) return true
  return s.totalMs > 0 && s.editedMs / s.totalMs >= FEEDBACK_THRESHOLD
}

/** The moment a question is about: the clock at the time the form opened
 *  (not when it is sent — people type for a while), rounded to whole ms and
 *  never past the end. */
export function questionMoment(openedAtMs: number, totalMs: number): number {
  const at = Math.max(0, Math.round(openedAtMs))
  return totalMs > 0 ? Math.min(at, Math.round(totalMs)) : at
}

/** Why a draft cannot be sent, or null when it can. */
export function questionProblem(text: string): string | null {
  const t = text.trim()
  if (!t) return 'Write your question first'
  if (t.length > QUESTION_MAX) return `Keep it under ${QUESTION_MAX} characters`
  return null
}

export function fmtMoment(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** This person's own questions, newest first; the quiet list under the player. */
export function myQuestions(all: HelpVideoQuestion[]): HelpVideoQuestion[] {
  return all
    .filter((q) => q.mine)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
}
