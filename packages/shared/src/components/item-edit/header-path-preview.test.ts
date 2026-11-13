import { describe, expect, it } from 'vitest'
import { keepResolvedPaths } from './header-path-preview'

// Staging, 2026-11-12: after a refused Submit to Warehouse the record was read again
// (invalidateRecordData) and the header's Unit and Schedule Date tiles went to "—" until a
// reload. Those tiles are relation paths (unit.name, unit.schedule_date): their values are
// resolved once (/resolve-paths) and merged into the form's copy of the record. The refetched
// record carries no such keys, and adopting it as is dropped them.
describe('the record read again keeps the relation-path values it was showing', () => {
  const shown = { id: 7, unit: 12, 'unit.name': 'U-1204', 'unit.schedule_date': '2026-12-01' }

  it('carries them over while the record still points at the same related record', () => {
    expect(keepResolvedPaths(shown, { id: 7, unit: 12, mdsi_status: 'error' })).toEqual({
      id: 7,
      unit: 12,
      mdsi_status: 'error',
      'unit.name': 'U-1204',
      'unit.schedule_date': '2026-12-01'
    })
  })

  it('reads the first hop the same whether it is an id or an expanded record', () => {
    expect(keepResolvedPaths(shown, { id: 7, unit: { id: '12' } })['unit.name']).toBe('U-1204')
  })

  it('drops them once the record points somewhere else: the old values would be wrong', () => {
    const next = keepResolvedPaths(shown, { id: 7, unit: 13 })
    expect('unit.name' in next).toBe(false)
    expect('unit.schedule_date' in next).toBe(false)
  })

  it('never overrides a value the new read carries itself', () => {
    expect(keepResolvedPaths(shown, { id: 7, unit: 12, 'unit.name': 'U-1204B' })['unit.name']).toBe(
      'U-1204B'
    )
  })

  it('returns the read itself when there is nothing to keep', () => {
    const next = { id: 7, unit: 12 }
    expect(keepResolvedPaths({}, next)).toBe(next)
    expect(keepResolvedPaths({ id: 7, unit: 12 }, next)).toBe(next)
  })
})
