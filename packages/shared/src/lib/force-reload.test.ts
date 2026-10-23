import { describe, expect, it } from 'vitest'
import { buildBelow, compareBuilds, MIN_BUILD_RELOADS, shouldObeyForceReload } from './force-reload'

const never = () => 0

describe('force reload — what this tab obeys', () => {
  it('obeys every push from an older server (no id)', () => {
    expect(shouldObeyForceReload({ seconds: 5 }, { build: null, loaded: 0 }, never)).toBe(true)
  })

  it('a minimum build: only when this tab is below it, at most twice', () => {
    const d = { id: 'min-admin-1', reason: 'min-build' as const, min_build: '0.3.12', set_at: 1 }
    expect(shouldObeyForceReload(d, { build: '0.3.11', loaded: 5 }, never)).toBe(true)
    // A shared worker reported another tab's build: this one is current.
    expect(shouldObeyForceReload(d, { build: '0.3.12', loaded: 5 }, never)).toBe(false)
    expect(shouldObeyForceReload(d, { build: 'dev', loaded: 5 }, never)).toBe(false)
    expect(shouldObeyForceReload(d, { build: '0.3.11', loaded: 5 }, () => MIN_BUILD_RELOADS)).toBe(
      false
    )
  })

  it('a remembered instruction: never twice, never for a tab loaded after it', () => {
    const d = { id: 'i-1', reason: 'sticky' as const, issued_at: 1000 }
    expect(shouldObeyForceReload(d, { build: 'x', loaded: 999 }, never)).toBe(true)
    expect(shouldObeyForceReload(d, { build: 'x', loaded: 1001 }, never)).toBe(false)
    expect(shouldObeyForceReload(d, { build: 'x', loaded: 999 }, () => 1)).toBe(false)
  })

  it('compares builds the way the server does (twin)', () => {
    expect(compareBuilds('0.3.9', '0.3.12')).toBe(-1)
    expect(compareBuilds('abc', '0.3.12')).toBeNull()
    expect(buildBelow('abc', 'def', 1, 2)).toBe(true)
    expect(buildBelow('abc', 'def', 3, 2)).toBe(false)
  })
})
