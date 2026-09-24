import { describe, expect, it } from 'vitest'
import { isRealChange, isRestartWorthy } from '../../../services/dev-extension-watch.js'

describe('isRestartWorthy', () => {
  it('restarts on extension source', () => {
    expect(isRestartWorthy('index.ts')).toBe(true)
    expect(isRestartWorthy('obligations/kinds-mwf.ts')).toBe(true)
    expect(isRestartWorthy('templates/mail/base.liquid')).toBe(true)
  })
  it('ignores scripts, tests, data and non-source files', () => {
    expect(isRestartWorthy('scripts/promote-config.ts')).toBe(false)
    expect(isRestartWorthy('tests/e2e/fold.spec.ts')).toBe(false)
    expect(isRestartWorthy('mdsi-signals.test.ts')).toBe(false)
    expect(isRestartWorthy('data/bom-category-scopes.json')).toBe(false)
    expect(isRestartWorthy('procedures/reforecast.sql')).toBe(false)
    expect(isRestartWorthy(null)).toBe(false)
  })
})

describe('isRealChange', () => {
  const boot = 1_000_000
  it('ignores anything inside the boot quiet window', () => {
    expect(isRealChange(boot + 100, boot, boot + 2_000)).toBe(false)
  })
  it('ignores a file not written since the process started', () => {
    expect(isRealChange(boot - 60_000, boot, boot + 30_000)).toBe(false)
  })
  it('restarts on a file written after boot, and on a deleted file', () => {
    expect(isRealChange(boot + 20_000, boot, boot + 30_000)).toBe(true)
    expect(isRealChange(null, boot, boot + 30_000)).toBe(true)
  })
})
