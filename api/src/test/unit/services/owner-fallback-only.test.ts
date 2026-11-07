import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

const { ownersOrFallback } = await import('../../../services/pipeline-engine.js')

// Rob 2026-11-07 (FDX24INV-37438): the IR creator was listed beside the
// Engineering Review owners. The fallback user owns a step only when nobody
// else does.
describe('ownersOrFallback', () => {
  const creator = { id: 'creator' }
  it('keeps the assigned owners and leaves the creator out', () => {
    expect(ownersOrFallback([{ id: 'nick' }, { id: 'joe' }], () => [creator])).toEqual([
      { id: 'nick' },
      { id: 'joe' }
    ])
  })
  it('falls back to the creator only when no one is assigned', () => {
    expect(ownersOrFallback([], () => [creator])).toEqual([creator])
  })
  it('does not even look up the fallback when owners exist', () => {
    const fallback = vi.fn(() => [creator])
    ownersOrFallback([{ id: 'nick' }], fallback)
    expect(fallback).not.toHaveBeenCalled()
  })
})
