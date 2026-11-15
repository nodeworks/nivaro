import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: {} }))

import { fieldWords } from '../../../services/linked-change.js'
import { MIN_SAMPLES, median, usualAnswerMs } from '../../../services/send-status.js'

describe('send status (rt4 #10)', () => {
  it('median', () => {
    expect(median([])).toBeNull()
    expect(median([5, 1, 3])).toBe(3)
    expect(median([4, 1, 3, 2])).toBe(3)
    expect(median([Number.NaN, -1, 7])).toBe(7)
  })

  it('"usually answers within" needs real history', () => {
    const pairs = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ started: 0, answered: (i + 1) * 60_000 }))
    expect(usualAnswerMs(pairs(MIN_SAMPLES - 1))).toBeNull()
    expect(usualAnswerMs(pairs(MIN_SAMPLES))).toBe(3 * 60_000)
  })
})

describe('linked change (rt4 #6)', () => {
  it('field words', () => {
    expect(fieldWords('is_active')).toBe('Active')
    expect(fieldWords('project_status')).toBe('Project status')
    expect(fieldWords('vendor_id')).toBe('Vendor')
  })
})
