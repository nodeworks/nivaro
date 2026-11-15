import { describe, expect, it, vi } from 'vitest'

vi.mock('../../db/index.js', () => ({ db: Object.assign(() => ({}), { raw: async () => [] }) }))

import { changeIndicator, fieldListText, stepTiming } from './change.js'
import { mediansFromStays } from './step-medians.js'

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

  it('takes medians only for steps with enough finished stays', () => {
    const stays = [
      ...[10, 20, 30, 40, 50].map((secs) => ({ state: 'S1', secs })),
      { state: 'S2', secs: 5 },
      { state: 'S1', secs: null }
    ]
    const m = mediansFromStays(stays)
    expect(m.get('s1')).toBe(30)
    expect(m.has('s2')).toBe(false)
  })
})
