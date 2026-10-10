import { describe, expect, it } from 'vitest'
import type { HelpVideoQuestion } from '../types'
import {
  feedbackDue,
  fmtMoment,
  myQuestions,
  QUESTION_MAX,
  questionMoment,
  questionProblem
} from './feedback'

describe('feedbackDue', () => {
  it('is due at the end, at the completion threshold, or when already finished', () => {
    expect(feedbackDue({ editedMs: 1000, totalMs: 60_000, ended: false, completed: false })).toBe(
      false
    )
    expect(feedbackDue({ editedMs: 54_000, totalMs: 60_000, ended: false, completed: false })).toBe(
      true
    )
    expect(feedbackDue({ editedMs: 53_999, totalMs: 60_000, ended: false, completed: false })).toBe(
      false
    )
    expect(feedbackDue({ editedMs: 0, totalMs: 60_000, ended: true, completed: false })).toBe(true)
    expect(feedbackDue({ editedMs: 0, totalMs: 60_000, ended: false, completed: true })).toBe(true)
  })
  it('an unknown length never reaches the threshold by itself', () => {
    expect(feedbackDue({ editedMs: 5000, totalMs: 0, ended: false, completed: false })).toBe(false)
  })
})

describe('questionMoment', () => {
  it('is the clock when the form opened, whole ms, inside the video', () => {
    expect(questionMoment(42_500.6, 90_000)).toBe(42_501)
    expect(questionMoment(-3, 90_000)).toBe(0)
    expect(questionMoment(95_000, 90_000)).toBe(90_000)
    expect(questionMoment(95_000, 0)).toBe(95_000)
  })
})

describe('questionProblem', () => {
  it('needs some text under the limit', () => {
    expect(questionProblem('   ')).toBe('Write your question first')
    expect(questionProblem('x'.repeat(QUESTION_MAX + 1))).toBe('Keep it under 1000 characters')
    expect(questionProblem(' Where is Save? ')).toBeNull()
  })
})

describe('myQuestions', () => {
  const q = (id: string, mine: boolean, created_at: string): HelpVideoQuestion => ({
    id,
    video_id: 'v',
    version_id: null,
    at_ms: 0,
    text: id,
    mine,
    answer: null,
    answered_at: null,
    answered_by_name: null,
    created_at
  })
  it('keeps only this person’s questions, newest first', () => {
    const out = myQuestions([
      q('a', true, '2026-10-01T00:00:00Z'),
      q('b', false, '2026-10-03T00:00:00Z'),
      q('c', true, '2026-10-02T00:00:00Z')
    ])
    expect(out.map((x) => x.id)).toEqual(['c', 'a'])
  })
})

describe('fmtMoment', () => {
  it('formats m:ss', () => {
    expect(fmtMoment(0)).toBe('0:00')
    expect(fmtMoment(42_900)).toBe('0:42')
    expect(fmtMoment(600_000)).toBe('10:00')
  })
})
