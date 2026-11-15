import { describe, expect, it } from 'vitest'
import { muted } from './PipelinePanel'

// The Progress card's step chip: a step with no colour, or only a grey one, uses the
// theme's muted pair so it stays readable on a dark card (design review 2026-11-15).
describe('state badge tone', () => {
  it('no colour or a grey colour is muted', () => {
    expect(muted(null)).toBe(true)
    expect(muted('')).toBe(true)
    expect(muted('#94a3b8')).toBe(true)
    expect(muted('#64748b')).toBe(true)
  })

  it('a real hue keeps its colour', () => {
    expect(muted('#f59e0b')).toBe(false)
    expect(muted('#10b981')).toBe(false)
    expect(muted('#ef4444')).toBe(false)
  })
})
