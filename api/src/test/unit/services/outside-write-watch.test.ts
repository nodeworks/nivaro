import { describe, expect, it } from 'vitest'
import type { JournalEntry } from '../../../services/event-journal.js'
import {
  effectiveOutsideWrites,
  journalAnnounced,
  judgeWatchable,
  laterStamp,
  normalizeOutsideWriteSettings,
  noteJournal,
  OUTSIDE_WRITE_DEFAULTS,
  pickNewRows,
  recentWindowMs,
  stampMinus,
  type TableFacts,
  watchQuery
} from '../../../services/outside-write-watch.js'

const facts = (over: Partial<TableFacts> = {}): TableFacts => ({
  schema: 'dbo',
  table: 'workflows',
  dateColumns: new Map([
    ['date_updated', 'date_updated'],
    ['created', 'created']
  ]),
  leading: new Set(['id', 'date_updated']),
  pk: ['id'],
  ...over
})

describe('which collections can be watched', () => {
  it('watches the changed-at column when an index starts with it', () => {
    expect(judgeWatchable('workflows', facts(), [])).toMatchObject({
      watchable: true,
      ts: 'date_updated',
      pk: 'id'
    })
  })

  it('prefers the field marked date-updated over the name list', () => {
    const f = facts({
      dateColumns: new Map([
        ['date_updated', 'date_updated'],
        ['changed_on', 'Changed_On']
      ]),
      leading: new Set(['changed_on'])
    })
    expect(judgeWatchable('workflows', f, ['changed_on'])).toMatchObject({
      watchable: true,
      ts: 'Changed_On'
    })
  })

  it('refuses a table with no index on the timestamp (no scans every few seconds)', () => {
    const j = judgeWatchable('workflows', facts({ leading: new Set(['id']) }), [])
    expect(j).toMatchObject({ watchable: false, reason_code: 'no-index', ts: 'date_updated' })
    expect(j.reason).toMatch(/No index starts with date_updated/)
  })

  it('refuses no timestamp, no single-column key, no table', () => {
    expect(
      judgeWatchable('x', facts({ dateColumns: new Map([['created', 'created']]) }), []).reason_code
    ).toBe('no-timestamp')
    expect(judgeWatchable('x', facts({ pk: ['a', 'b'] }), []).reason_code).toBe('no-key')
    expect(judgeWatchable('x', facts({ pk: [] }), []).reason_code).toBe('no-key')
    expect(judgeWatchable('x', undefined, []).reason_code).toBe('not-table')
  })
})

describe('the watermark window', () => {
  it('steps back by the overlap and never below a floor', () => {
    expect(stampMinus('2026-11-14T10:00:00.000', 120)).toBe('2026-11-14T09:58:00.000')
    expect(stampMinus('2026-01-01T00:01:00.500', 61)).toBe('2025-12-31T23:59:59.500')
    expect(laterStamp('2026-11-14T09:58:00.000', '2026-11-14T09:59:00.000')).toBe(
      '2026-11-14T09:59:00.000'
    )
    expect(laterStamp('2026-11-14T09:58:00.000', undefined)).toBe('2026-11-14T09:58:00.000')
  })

  it('reads both clocks as two index ranges, READPAST, capped', () => {
    const sql = watchQuery(
      { schema: 'dbo', table: 'work]flows', ts: 'date_updated', pk: 'id' },
      {
        lowU: '2026-11-14T15:00:00.000',
        highU: '2026-11-14T15:00:10.000',
        lowL: '2026-11-14T10:00:00.000',
        highL: '2026-11-14T10:00:10.000'
      },
      500
    )
    expect(sql).toContain('SELECT TOP (501)')
    expect(sql).toContain('FROM [dbo].[work]]flows] WITH (READPAST)')
    expect(sql).toContain(
      "([date_updated] > '2026-11-14T15:00:00.000' AND [date_updated] <= '2026-11-14T15:00:10.000')"
    )
    expect(sql).toContain(
      "OR ([date_updated] > '2026-11-14T10:00:00.000' AND [date_updated] <= '2026-11-14T10:00:10.000')"
    )
  })

  it('refuses a stamp that is not the database clock form', () => {
    expect(() =>
      watchQuery(
        { schema: 'dbo', table: 't', ts: 'u', pk: 'id' },
        { lowU: "x' OR 1=1 --", highU: 'a', lowL: 'b', highL: 'c' }
      )
    ).toThrow()
  })
})

const entry = (room: string, payload: Record<string, unknown>, seq = 1): JournalEntry => ({
  seq,
  room,
  event: 'collection:update',
  payload
})

describe('dedupe against what was already announced', () => {
  it('reads ids, coalesced lists and bulk events from the journal', () => {
    const m = journalAnnounced([
      entry('collection:workflows', { item: 7 }),
      entry('collection:Workflows', { items: [8, 9], coalesced: true }),
      entry('collection:forecasts', { item: '*', bulk: 900 }),
      entry('record:workflows:7', { item: 7 }),
      { seq: 5, room: 'collection:x', event: 'other', payload: { item: 1 } }
    ])
    expect([...(m.get('workflows')?.ids ?? [])]).toEqual(['7', '8', '9'])
    expect(m.get('forecasts')?.whole).toBe(true)
    expect(m.has('x')).toBe(false)
  })

  it('skips rows the app announced a moment ago and rows already looked at', () => {
    const now = 100_000
    const recent = new Map()
    noteJournal([entry('collection:workflows', { item: 7 })], now, 15_000, new Map(), recent)
    const seen = new Map<string, number>()
    const rows = [
      { id: 7, ts: '2026-11-14T10:00:01.000' },
      { id: 8, ts: '2026-11-14T10:00:02.000' },
      { id: 8, ts: '2026-11-14T10:00:02.000' }
    ]
    const first = pickNewRows(rows, seen, recent.get('workflows'), now, 60_000, 15_000)
    expect(first).toEqual({ announce: ['8'], deduped: 1 })
    // the next look reads the same rows again (overlap): nothing twice
    expect(pickNewRows(rows, seen, recent.get('workflows'), now + 10_000, 60_000, 15_000)).toEqual({
      announce: [],
      deduped: 0
    })
    // a NEW change to row 8 (new stamp) is announced again
    expect(
      pickNewRows([{ id: 8, ts: '2026-11-14T10:00:12.000' }], seen, undefined, now, 60_000, 15_000)
        .announce
    ).toEqual(['8'])
  })

  it('forgets an app announcement after the window', () => {
    const recent = new Map()
    noteJournal([entry('collection:workflows', { item: 7 })], 0, 15_000, new Map(), recent)
    const r = pickNewRows(
      [{ id: 7, ts: 'a' }],
      new Map(),
      recent.get('workflows'),
      20_000,
      1,
      15_000
    )
    expect(r.announce).toEqual(['7'])
  })

  it('never counts its own announcements of the previous look as "already told"', () => {
    const recent = new Map()
    const mine = new Map([['workflows', { ids: new Set(['7']), whole: false }]])
    noteJournal(
      [entry('collection:workflows', { item: 7 }), entry('collection:workflows', { item: 9 })],
      1000,
      15_000,
      mine,
      recent
    )
    expect([...recent.get('workflows').ids.keys()]).toEqual(['9'])
    // its own bulk event does not swallow the collection either
    const bulkMine = new Map([['forecasts', { ids: new Set<string>(), whole: true }]])
    noteJournal([entry('collection:forecasts', { item: '*' })], 1000, 15_000, bulkMine, recent)
    expect(recent.get('forecasts')?.wholeAt ?? -Infinity).toBe(-Infinity)
  })

  it('an app bulk event counts every row of that collection as told for the window', () => {
    const recent = new Map()
    noteJournal([entry('collection:forecasts', { many: true })], 0, 15_000, new Map(), recent)
    expect(
      pickNewRows([{ id: 1, ts: 'a' }], new Map(), recent.get('forecasts'), 5000, 1, 15_000)
    ).toEqual({ announce: [], deduped: 1 })
  })

  it('sizes the window from the interval', () => {
    expect(recentWindowMs(10)).toBe(15_000)
  })
})

describe('settings', () => {
  it('normalizes and clamps', () => {
    expect(normalizeOutsideWriteSettings(null)).toEqual(OUTSIDE_WRITE_DEFAULTS)
    expect(
      normalizeOutsideWriteSettings({
        enabled: false,
        interval_seconds: 1,
        mode: 'chosen',
        collections: ['workflows', 'bad name;', 'workflows']
      })
    ).toEqual({ enabled: false, interval_seconds: 5, mode: 'chosen', collections: ['workflows'] })
    expect(normalizeOutsideWriteSettings({ interval_seconds: 9999 }).interval_seconds).toBe(300)
  })

  it('env wins, and cloud mode is always off', () => {
    const prevEnv = process.env.OUTSIDE_WRITE_WATCH
    const prevCloud = process.env.CLOUD_META_DB_URL
    try {
      process.env.OUTSIDE_WRITE_WATCH = 'off'
      expect(effectiveOutsideWrites(OUTSIDE_WRITE_DEFAULTS).enabled).toBe(false)
      process.env.OUTSIDE_WRITE_WATCH = 'on'
      process.env.CLOUD_META_DB_URL = 'x'
      expect(effectiveOutsideWrites(OUTSIDE_WRITE_DEFAULTS)).toMatchObject({
        enabled: false,
        cloud: true
      })
    } finally {
      if (prevEnv == null) delete process.env.OUTSIDE_WRITE_WATCH
      else process.env.OUTSIDE_WRITE_WATCH = prevEnv
      if (prevCloud == null) delete process.env.CLOUD_META_DB_URL
      else process.env.CLOUD_META_DB_URL = prevCloud
    }
  })
})
