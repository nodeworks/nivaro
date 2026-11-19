import { describe, expect, it } from 'vitest'
import { pulseMatchesLog, tableFollowsPulse } from './activity-live'

describe('Activity log follows the pulse (rt4 #15)', () => {
  const e = { action: 'update', collection: 'workflows', item: '12', user: 'U-1', group_key: 'g1' }

  it('writes re-read soon, routine reads on the slow beat', () => {
    expect(pulseMatchesLog(e, {})).toBe('write')
    expect(pulseMatchesLog({ ...e, action: 'read' }, {})).toBe('read')
    expect(pulseMatchesLog({ ...e, action: '' }, {})).toBeNull()
  })

  it('judges the filters the pulse can answer', () => {
    expect(pulseMatchesLog(e, { collections: ['invoices'] })).toBeNull()
    expect(pulseMatchesLog(e, { collections: ['workflows'] })).toBe('write')
    expect(pulseMatchesLog(e, { actions: ['create'] })).toBeNull()
    expect(
      pulseMatchesLog({ ...e, action: 'report-view' }, { exclude_actions: ['read'] })
    ).toBeNull()
    expect(pulseMatchesLog(e, { item: '13' })).toBeNull()
    expect(pulseMatchesLog(e, { user: 'u-1' })).toBe('write')
    expect(pulseMatchesLog(e, { user: 'u-2' })).toBeNull()
    expect(pulseMatchesLog(e, {}, 'g2')).toBeNull()
    expect(pulseMatchesLog(e, {}, 'g1')).toBe('write')
  })

  it('a window that already ended never gains entries', () => {
    expect(pulseMatchesLog(e, { range: 'yesterday' })).toBeNull()
    expect(pulseMatchesLog(e, { to: '2020-01-01' })).toBeNull()
    expect(pulseMatchesLog(e, { range: 'today' })).toBe('write')
  })
})

describe('tableFollowsPulse (rt-fix C, admin #12)', () => {
  it('follows only page 1, newest first', () => {
    expect(tableFollowsPulse({ page: 1, sort: '-timestamp' }, '-timestamp')).toBe(true)
    expect(tableFollowsPulse({ page: 1 }, '-timestamp')).toBe(true)
    expect(tableFollowsPulse({ page: 2, sort: '-timestamp' }, '-timestamp')).toBe(false)
    expect(tableFollowsPulse({ page: 1, sort: 'collection' }, '-timestamp')).toBe(false)
  })
})
