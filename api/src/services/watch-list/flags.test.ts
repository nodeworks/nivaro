import { beforeEach, describe, expect, it, vi } from 'vitest'

const { log } = vi.hoisted(() => ({ log: [] as Array<{ table: string; calls: unknown[][] }> }))
vi.mock('../../db/index.js', async () => {
  const { fakeDb } = await import('./fake-db.test-helper.js')
  return {
    db: fakeDb(
      {
        nivaro_users: [
          {
            id: 'u-1',
            preferences: JSON.stringify({
              watch_list: {
                wl_alerts: true,
                pins: [{ c: 'orders', id: '5' }],
                alerts: [{ id: 'abcd1234', c: 'orders', rid: '5', kind: 'overdue' }]
              }
            })
          },
          // The LIKE matched text elsewhere in the preferences, not the watch list's own flag.
          { id: 'u-2', preferences: JSON.stringify({ note: '"wl_alerts":true', watch_list: {} }) }
        ]
      },
      log
    )
  }
})
vi.mock('../user-sync.js', () => ({ announcePrefsChanged: () => {} }))

import { forgetWatchFlags, peopleWith } from './flags.js'

beforeEach(() => {
  log.length = 0
  forgetWatchFlags()
})

describe('who turned a watch-list feature on', () => {
  it('finds people by the saved flag with one read, then serves the cache', async () => {
    const people = await peopleWith('wl_alerts', 1000)
    expect([...people.keys()]).toEqual(['u-1'])
    expect(people.get('u-1')?.alerts).toHaveLength(1)
    const where = log[0].calls.find((c) => c[0] === 'where')
    expect(where).toEqual(['where', 'preferences', 'like', '%"wl_alerts":true%'])
    await peopleWith('wl_alerts', 2000)
    expect(log).toHaveLength(1)
  })
})
