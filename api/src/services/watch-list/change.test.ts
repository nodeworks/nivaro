import { describe, expect, it, vi } from 'vitest'

vi.mock('../../db/index.js', () => ({ db: Object.assign(() => ({}), { raw: async () => [] }) }))

import { changeIndicator, fieldListText, stepTiming } from './change.js'
import { isRealStay, mediansFromStays } from './step-medians.js'

const ME = 'AAAA-1'
const BETH = 'bbbb-2'
const names = { 'bbbb-2': 'Beth Lee' }

describe('change indicator', () => {
  it('names the newest event and marks it changed when someone else made it after seen', () => {
    const ind = changeIndicator(
      [
        { kind: 'edited', at: '2026-11-14T10:00:00Z', by: ME, fields: ['Amount'] },
        { kind: 'moved', at: '2026-11-14T11:00:00Z', by: BETH, to: 'Approved' },
        null
      ],
      'aaaa-1',
      '2026-11-14T10:30:00Z',
      names
    )
    expect(ind).toMatchObject({
      kind: 'moved',
      text: 'Moved to Approved',
      by: { name: 'Beth Lee', self: false },
      changed: true,
      unseen: 1
    })
  })

  it('never lights a row for the person’s own writes', () => {
    const ind = changeIndicator(
      [{ kind: 'edited', at: '2026-11-14T11:00:00Z', by: 'aaaa-1', fields: ['Amount'] }],
      ME,
      '2026-11-14T10:00:00Z',
      names
    )
    expect(ind?.changed).toBe(false)
    expect(ind?.by).toMatchObject({ name: 'You', self: true })
  })

  it('is quiet when the change is older than the last look', () => {
    const ind = changeIndicator(
      [{ kind: 'commented', at: '2026-11-14T09:00:00Z', by: BETH }],
      ME,
      '2026-11-14T10:00:00Z',
      names
    )
    expect(ind?.changed).toBe(false)
    expect(ind?.text).toBe('Commented')
  })

  it('answers null with nothing to say', () => {
    expect(changeIndicator([null, undefined], ME, '2026-11-14T10:00:00Z', {})).toBeNull()
  })

  it('words field lists plainly', () => {
    expect(fieldListText([])).toBe('Edited')
    expect(fieldListText(['Amount'])).toBe('Changed Amount')
    expect(fieldListText(['Amount', 'Vendor'])).toBe('Changed Amount and Vendor')
    expect(fieldListText(['A', 'B', 'C', 'D'])).toBe('Changed A, B and 2 more')
  })
})

describe('step timing', () => {
  it('compares time in step with the usual stay', () => {
    const now = new Date('2026-11-14T12:00:00Z').getTime()
    expect(stepTiming('2026-11-14T10:00:00Z', 3600, now)).toEqual({
      in_step_s: 7200,
      usual_s: 3600,
      ratio: 2
    })
    expect(stepTiming('2026-11-14T10:00:00Z', null, now)?.ratio).toBeNull()
    expect(stepTiming(null, 10, now)).toBeNull()
  })

  it('takes medians only for steps with enough real stays', () => {
    const by = 'person-1'
    const stays = [
      ...[600, 1200, 1800, 2400, 3000].map((secs) => ({ state: 'S1', secs, left_by: by })),
      // Not waits: an automatic skip seconds after arriving, a move nobody made,
      // an automation's move — none of these may drag the usual time down.
      ...[2, 3, 5, 8].map((secs) => ({ state: 'S1', secs, left_by: by })),
      { state: 'S1', secs: 30, left_by: null },
      { state: 'S1', secs: 90, left_by: null },
      { state: 'S1', secs: 120, left_by: by, left_origin: 'machine' },
      { state: 'S2', secs: 600, left_by: by },
      { state: 'S1', secs: null, left_by: by }
    ]
    const m = mediansFromStays(stays)
    expect(m.get('s1')).toBe(1800)
    expect(m.has('s2')).toBe(false)
  })

  it('counts a stay only when a person ended it after at least a minute', () => {
    expect(isRealStay({ state: 'S', secs: 60, left_by: 'p' })).toBe(true)
    expect(isRealStay({ state: 'S', secs: 59, left_by: 'p' })).toBe(false)
    expect(isRealStay({ state: 'S', secs: 600, left_by: null })).toBe(false)
    expect(isRealStay({ state: 'S', secs: 600, left_by: 'p', left_origin: 'MACHINE' })).toBe(false)
    expect(isRealStay({ state: 'S', secs: 600, left_by: 'p', left_origin: 'import' })).toBe(true)
  })
})
