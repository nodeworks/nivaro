import { describe, expect, it } from 'vitest'
import {
  callerKindOf,
  callerTitle,
  downTitle,
  entityTitle,
  loadStats,
  p95,
  pageTitle,
  parseLoadList,
  parseRecordingFor,
  partnerIdOf,
  recordRef
} from './logic'

const UUID = '7A0411F3-C687-40E5-ADF5-614157CF88EC'

describe('caller keys', () => {
  it('classifies the keys the map uses', () => {
    expect(callerKindOf('k12')).toBe('key')
    expect(callerKindOf(`u${UUID}`)).toBe('person')
    expect(callerKindOf('cron')).toBe('cron')
    expect(callerKindOf('anon')).toBe('anon')
    expect(callerKindOf('cron:ext:efp-ops:auto-create-mwf')).toBe('source')
    expect(callerKindOf('k')).toBeNull()
    expect(callerKindOf('u123')).toBeNull()
    expect(callerKindOf('cron: x')).toBeNull()
  })
  it('titles a caller ref without a label', () => {
    expect(callerTitle({ kind: 'caller', id: 'k12' })).toBe('API key 12')
    expect(callerTitle({ kind: 'caller', id: `u${UUID}` })).toBe('Person 7A0411F3')
    expect(callerTitle({ kind: 'caller', id: 'cron:outbox-worker' })).toBe('Job outbox-worker')
    expect(callerTitle({ kind: 'caller', id: 'flow:abc' })).toBe('Flow abc')
    expect(callerTitle({ kind: 'caller', id: 'cron' })).toBe('Crons & flows')
    expect(callerTitle({ kind: 'caller', id: 'k1', label: 'Fusion' })).toBe('Fusion')
  })
})

describe('titles', () => {
  it('reads entity, page and down ids', () => {
    expect(entityTitle({ kind: 'entity', id: 'items/workflows' })).toBe('workflows · items')
    expect(entityTitle({ kind: 'entity', id: 'items/__background__' })).toBe(
      'Background jobs · items'
    )
    expect(pageTitle({ kind: 'page', id: 'admin /traffic-map' })).toBe('Page /traffic-map (admin)')
    expect(pageTitle({ kind: 'page', id: '/collections/:id' })).toBe('Page /collections/:id')
    expect(downTitle({ kind: 'down', id: 'db' })).toBe('SQL Server')
    expect(downTitle({ kind: 'down', id: 'ext:3' })).toBe('Partner 3')
    expect(downTitle({ kind: 'down', id: 'x:efp-ops.mdsi' })).toBe('x:efp-ops.mdsi')
    expect(partnerIdOf('ext:3')).toBe(3)
    expect(partnerIdOf('mail')).toBeNull()
    expect(recordRef('workflows', 5).id).toBe('workflows:5')
  })
})

describe('recording-for answers', () => {
  it('accepts the shapes the helper route may send', () => {
    expect(parseRecordingFor({ id: 'r1' })).toEqual({
      kind: 'found',
      id: 'r1',
      at: null,
      clip: false
    })
    expect(parseRecordingFor({ recording_id: 'r2', app: 'error-clip' })).toMatchObject({
      id: 'r2',
      clip: true
    })
    expect(
      parseRecordingFor({
        recording: { id: 'r3', started_at: '2026-10-01T10:00:00.000Z' },
        offset_ms: 5000
      })
    ).toMatchObject({ id: 'r3', at: Date.parse('2026-10-01T10:00:05.000Z') })
    expect(parseRecordingFor({ none: true, reason: 'No recording then' })).toEqual({
      kind: 'none',
      reason: 'No recording then'
    })
    expect(parseRecordingFor(null)).toBeNull()
    expect(parseRecordingFor({})).toBeNull()
  })
})

describe('page loads', () => {
  it('cleans the load list and computes stats', () => {
    const rows = parseLoadList([
      { load: 'aaaaaa', at: 1, calls: 10, ms: 400, user: 'Beth', caller: `u${UUID}` },
      { load: 'bbbbbb', at: 2, calls: 30, ms: 900, caller: 'not a key' },
      { nope: true },
      'x'
    ])
    expect(rows).toHaveLength(2)
    // `user` is a display name, kept as text; `caller` is the key, kept only when it is one
    expect(rows[0]).toMatchObject({ user: 'Beth', caller: `u${UUID}` })
    expect(rows[1].user).toBeNull()
    expect(rows[1].caller).toBeNull()
    expect(loadStats(rows)).toEqual({ n: 2, calls_avg: 20, calls_p95: 30, ms_p95: 900 })
    expect(loadStats([])).toEqual({ n: 0, calls_avg: 0, calls_p95: 0, ms_p95: 0 })
    expect(parseLoadList({ data: [] })).toEqual([])
    expect(p95([])).toBe(0)
  })
})
