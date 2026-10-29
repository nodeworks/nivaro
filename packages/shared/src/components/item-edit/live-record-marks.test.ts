import { beforeEach, describe, expect, it } from 'vitest'
import { remoteChangedFields } from '../ItemEditForm'
import { clearLiveRecordMarks, liveRecordWrite, markLiveRecordWrite } from './live-record-marks'

describe('live record marks', () => {
  beforeEach(() => clearLiveRecordMarks())

  it('has no mark for a refetch nobody explained (Edit after Summary, focus)', () => {
    expect(liveRecordWrite('workflows', '370973')).toBeNull()
  })

  it('keeps the fields a live write named, and merges a quick second write', () => {
    markLiveRecordWrite('workflows', '1', ['region'])
    markLiveRecordWrite('workflows', '1', ['project'])
    expect(liveRecordWrite('workflows', '1')?.fields?.sort()).toEqual(['project', 'region'])
  })

  it('a write that named no fields may have moved any', () => {
    markLiveRecordWrite('workflows', '1', null)
    expect(liveRecordWrite('workflows', '1')?.fields).toBeNull()
  })

  it('expires', () => {
    markLiveRecordWrite('workflows', '1', ['region'])
    expect(liveRecordWrite('workflows', '1', Date.now() + 60_000)).toBeNull()
  })
})

describe('remoteChangedFields', () => {
  it('ignores fields the previous load did not carry (Summary loads fewer)', () => {
    expect(
      remoteChangedFields({ id: 1, name: 'a' }, { id: 1, name: 'a', project: 5, region: 2 })
    ).toEqual([])
  })
  it('reports a real change of a loaded field', () => {
    expect(remoteChangedFields({ id: 1, region: null }, { id: 1, region: 2 })).toEqual(['region'])
  })
})
