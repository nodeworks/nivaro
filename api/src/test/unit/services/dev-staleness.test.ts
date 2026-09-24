import { describe, expect, it } from 'vitest'
import { staleFrom } from '../../../services/dev-staleness.js'

describe('staleFrom', () => {
  const start = Date.parse('2026-09-24T14:26:00Z')
  it('is null when nothing changed after the process started', () => {
    expect(staleFrom({ path: '/r/api/src/a.ts', mtime: start - 60_000 }, start, '/r')).toBeNull()
  })
  it('ignores a save inside the restart grace window', () => {
    expect(staleFrom({ path: '/r/api/src/a.ts', mtime: start + 5_000 }, start, '/r')).toBeNull()
  })
  it('names the file changed after the process started', () => {
    const r = staleFrom({ path: '/r/api/src/services/x.ts', mtime: start + 60_000 }, start, '/r')
    expect(r).toEqual({
      file: 'api/src/services/x.ts',
      changed_at: new Date(start + 60_000).toISOString()
    })
  })
  it('is null with no files', () => {
    expect(staleFrom(null, start, '/r')).toBeNull()
  })
})
