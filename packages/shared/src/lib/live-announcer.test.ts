import { afterEach, describe, expect, it, vi } from 'vitest'
import { attentionPrefsOf } from './attention-prefs'
import {
  ANNOUNCE_MIN_GAP_MS,
  composeAnnouncement,
  createAnnouncer,
  humanField,
  worthAnnouncing
} from './live-announcer'
import { waitingCount } from './waiting-count'

describe('composeAnnouncement', () => {
  it('names the fields when one record changed', () => {
    expect(composeAnnouncement([{ action: 'update', item: 1, fields: ['status'] }])).toBe(
      'Status changed'
    )
    expect(
      composeAnnouncement([{ action: 'update', item: 1, fields: ['unit_price', 'qty'] }])
    ).toBe('Unit price and Qty changed')
    expect(composeAnnouncement([{ action: 'update', item: 1, fields: ['a', 'b', 'c'] }])).toBe(
      '3 fields changed'
    )
  })

  it('counts rows when several changed, and says what happened to them', () => {
    expect(
      composeAnnouncement([
        { action: 'update', item: 1, fields: ['x'] },
        { action: 'update', item: 2, fields: ['y'] }
      ])
    ).toBe('2 rows updated')
    expect(
      composeAnnouncement([
        { action: 'create', item: 7 },
        { action: 'update', item: 2, fields: ['y'] },
        { action: 'delete', item: 9 }
      ])
    ).toBe('1 row added, 1 row removed, 1 row updated')
  })

  it('counts one record once however many writes touched it, and a bulk write by its count', () => {
    expect(
      composeAnnouncement([
        { action: 'update', item: 1, fields: ['x'] },
        { action: 'update', item: 1, fields: ['x'] }
      ])
    ).toBe('X changed')
    expect(composeAnnouncement([{ action: 'update', item: '*', bulk: 40 }])).toBe('40 rows updated')
  })

  it('never says a value: only the names the event carried', () => {
    const text = composeAnnouncement([
      { action: 'update', item: 1, fields: ['status'], ...({ value: 'Approved' } as object) }
    ])
    expect(text).not.toContain('Approved')
  })

  it('stays silent for surfaces nobody reads aloud, and for off', () => {
    expect(worthAnnouncing({ action: 'update', item: 1, fields: ['$lock'] })).toBe(false)
    expect(composeAnnouncement([{ action: 'update', item: 1, fields: ['$lock'] }])).toBe('')
    expect(composeAnnouncement([{ action: 'update', item: 1, fields: ['status'] }], 'off')).toBe('')
    expect(composeAnnouncement([])).toBe('')
  })

  it('brief only says that something changed', () => {
    expect(composeAnnouncement([{ action: 'update', item: 1, fields: ['status'] }], 'brief')).toBe(
      'Updated'
    )
    expect(
      composeAnnouncement(
        [
          { action: 'update', item: 1 },
          { action: 'update', item: 2 },
          { action: 'update', item: 3 }
        ],
        'brief'
      )
    ).toBe('3 rows updated')
  })

  it('reads aspect names as words', () => {
    expect(composeAnnouncement([{ action: 'update', item: 1, fields: ['$comments'] }])).toBe(
      'Comments changed'
    )
    expect(humanField('statusCode')).toBe('Status code')
    expect(humanField('unit_price')).toBe('Unit price')
  })
})

describe('createAnnouncer coalescing', () => {
  afterEach(() => vi.useRealTimers())

  function setup() {
    vi.useFakeTimers()
    const said: string[] = []
    const a = createAnnouncer({
      say: (t) => said.push(t),
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
    })
    return { said, a }
  }

  it('folds a burst into one announcement', () => {
    const { said, a } = setup()
    for (let i = 1; i <= 12; i++) a.note({ action: 'update', item: i, fields: ['status'] })
    expect(said).toEqual([])
    vi.advanceTimersByTime(1000)
    expect(said).toEqual(['12 rows updated'])
  })

  it('never announces twice inside the gap; what arrives meanwhile waits for it', () => {
    const { said, a } = setup()
    a.note({ action: 'update', item: 1, fields: ['status'] })
    vi.advanceTimersByTime(1000)
    expect(said).toHaveLength(1)
    // Three more changes inside the next few seconds: nothing yet…
    vi.advanceTimersByTime(1000)
    a.note({ action: 'update', item: 2, fields: ['status'] })
    vi.advanceTimersByTime(500)
    a.note({ action: 'update', item: 3, fields: ['status'] })
    vi.advanceTimersByTime(1000)
    expect(said).toHaveLength(1)
    // …then ONE announcement once the gap since the first has passed.
    vi.advanceTimersByTime(ANNOUNCE_MIN_GAP_MS)
    expect(said).toHaveLength(2)
    expect(said[1]).toBe('2 rows updated')
  })

  it('says nothing after being set to off, and drops what was waiting', () => {
    const { said, a } = setup()
    a.note({ action: 'update', item: 1, fields: ['status'] })
    a.setVerbosity('off')
    vi.advanceTimersByTime(10_000)
    a.note({ action: 'update', item: 2, fields: ['status'] })
    vi.advanceTimersByTime(10_000)
    expect(said).toEqual([])
  })

  it('applies a new verbosity to what is waiting', () => {
    const { said, a } = setup()
    a.note({ action: 'update', item: 1, fields: ['status'] })
    a.setVerbosity('brief')
    vi.advanceTimersByTime(1000)
    expect(said).toEqual(['Updated'])
  })
})

describe('waiting count and attention prefs', () => {
  it('adds the four My Work figures and ignores junk', () => {
    expect(waitingCount({ owned: 3, approvals: 2, tasks: 1, questions: 0 })).toBe(5)
    // Open tasks never count toward the tab title.
    expect(waitingCount({ tasks: 7 })).toBe(0)
    expect(waitingCount({ owned: 2.9 })).toBe(2)
    expect(waitingCount({ owned: -4, tasks: Number.NaN })).toBe(0)
    expect(waitingCount(null)).toBe(0)
    expect(waitingCount(undefined)).toBe(0)
  })

  it('defaults to the count on and full announcements', () => {
    expect(attentionPrefsOf(null)).toEqual({ tabCount: true, announce: 'full' })
    expect(attentionPrefsOf({ tab_count: 'off', live_announce: 'brief' })).toEqual({
      tabCount: false,
      announce: 'brief'
    })
    expect(attentionPrefsOf({ live_announce: 'nonsense' }).announce).toBe('full')
  })
})
