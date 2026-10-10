import { describe, expect, it } from 'vitest'
import { componentChips, offsetInto } from './frustrationLogic'

describe('componentChips', () => {
  it('lists non-zero components, biggest contribution first, with plural labels', () => {
    expect(
      componentChips({
        counts: { rage_clicks: 1, client_errors: 2, loops: 0, slow_actions: 3 },
        points: { rage_clicks: 6, client_errors: 16, slow_actions: 6 }
      }).map((c) => c.text)
    ).toEqual(['2 client errors', '1 rage click', '3 slow calls'])
  })
  it('copes with an empty or missing explanation', () => {
    expect(componentChips(undefined)).toEqual([])
    expect(componentChips({})).toEqual([])
  })
})

describe('offsetInto', () => {
  it('is the session start as ms into the recording, never negative', () => {
    expect(offsetInto('2026-10-01T10:05:00.000Z', '2026-10-01T10:00:00.000Z')).toBe(300_000)
    expect(offsetInto('2026-10-01T09:00:00.000Z', '2026-10-01T10:00:00.000Z')).toBe(0)
    expect(offsetInto(null, '2026-10-01T10:00:00.000Z')).toBeNull()
  })
})
