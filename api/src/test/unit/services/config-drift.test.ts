import { describe, expect, it } from 'vitest'
import {
  computeDrift,
  type DriftActivity,
  type DriftMark,
  driftTables,
  MARK_ACTION,
  meaningfulFields,
  overwrittenBy,
  REOPEN_ACTION,
  rowScope
} from '../../../services/config-drift/core.js'
import { driftSectionRows } from '../../../services/config-drift/report-section.js'
import type { DriftReport } from '../../../services/config-drift/store.js'
import { normalizeDriftSettings } from '../../../services/config-drift/store.js'
import { hashRow, type SnapshotRow } from '../../../services/config-inventory.js'

/**
 * Config changed here, not from promotion: the 2026-11-13 production hand fixes (a shared
 * default saved view, the shared collection pins order) are found against the promotion
 * baseline, attributed from the activity log, kept quiet once marked as intended, and named by
 * any write that would overwrite them.
 */

function row(data: Record<string, unknown>): SnapshotRow {
  return { hash: hashRow(data), data }
}

function table(...rows: Array<Record<string, unknown>>): Record<string, SnapshotRow> {
  return Object.fromEntries(rows.map((r) => [String(r.id), row(r)]))
}

const SINCE = '2026-11-06T02:00:00.000Z'

const baselinePins = {
  id: 7,
  extension_id: 'nivaro-core',
  key: 'collection_pins',
  value: '["workflows","projects"]'
}
const livePins = { ...baselinePins, value: '["projects","workflows"]' }
const sharedView = {
  id: 48,
  collection: 'deployment_part_types',
  name: 'Active types',
  is_shared: true,
  is_default: true,
  user: 'u-rob',
  filters: '{"active":{"_eq":true}}'
}
const personalView = {
  id: 49,
  collection: 'workflows',
  name: 'Mine',
  is_shared: false,
  is_default: false,
  user: 'u-ann'
}

function activity(over: Partial<DriftActivity>): DriftActivity {
  return {
    id: 1,
    action: 'update',
    collection: null,
    item: null,
    user: 'u-rob',
    origin: 'person',
    timestamp: '2026-11-13T15:00:00.000Z',
    comment: null,
    ...over
  }
}

const names = new Map([
  ['u-rob', 'Rob Lee'],
  ['u-ann', 'Ann Smith']
])

function baseInput() {
  return {
    tables: ['nivaro_extension_settings', 'nivaro_saved_views', 'nivaro_queues'],
    baseline: {
      nivaro_extension_settings: table(baselinePins),
      nivaro_saved_views: table(),
      nivaro_queues: table({ id: 3, name: 'Approvals', last_materialized_at: '2026-11-06' })
    },
    live: {
      nivaro_extension_settings: table(livePins),
      nivaro_saved_views: table(sharedView, personalView),
      // a run stamp moved — not a change anyone made
      nivaro_queues: table({ id: 3, name: 'Approvals', last_materialized_at: '2026-11-13' })
    },
    since: SINCE,
    activity: [
      activity({
        id: 10,
        action: 'create',
        collection: 'nivaro_saved_views',
        item: '48',
        timestamp: '2026-11-13T14:00:00.000Z'
      }),
      // the pins route logs `<extension>:<key>`, not the row id
      activity({
        id: 11,
        collection: 'nivaro_extension_settings',
        item: 'nivaro-core:collection_pins',
        timestamp: '2026-11-13T14:30:00.000Z'
      }),
      // before the promotion: not a change since it
      activity({
        id: 2,
        collection: 'nivaro_saved_views',
        item: '48',
        user: 'u-ann',
        timestamp: '2026-11-01T00:00:00.000Z'
      })
    ],
    stamps: [] as DriftActivity[],
    marks: [] as DriftMark[],
    names
  }
}

describe('computeDrift', () => {
  it('finds the production hand fixes and who made them', () => {
    const { items, skipped } = computeDrift(baseInput())
    expect(items.map((i) => [i.id, i.kind])).toEqual([
      ['nivaro_extension_settings:7', 'changed'],
      ['nivaro_saved_views:48', 'added']
    ])
    const pins = items[0]
    expect(pins.who).toEqual({ user_id: 'u-rob', name: 'Rob Lee' })
    expect(pins.evidence).toBe('activity')
    expect(pins.fields).toEqual([
      { field: 'value', promoted: '["workflows","projects"]', here: '["projects","workflows"]' }
    ])
    expect(items[1].label).toBe('Active types (deployment_part_types)')
    expect(items[1].at).toBe('2026-11-13T14:00:00.000Z')
    // the personal view and the queue's run stamp are not drift
    expect(skipped.personal).toBe(1)
    expect(skipped.volatile_only).toBe(1)
  })

  it('still lists a change nobody can be named for (a direct SQL fix)', () => {
    const input = baseInput()
    input.activity = []
    const { items } = computeDrift(input)
    expect(items).toHaveLength(2)
    expect(items.every((i) => i.evidence === 'none' && i.who === null)).toBe(true)
  })

  it('falls back to a config-epoch stamp naming the table', () => {
    const input = baseInput()
    input.activity = []
    input.stamps = [
      activity({
        id: 30,
        action: 'config-epoch',
        collection: 'nivaro_cache_epochs',
        comment:
          'Configuration changed: settings (nivaro_extension_settings) by Rob Lee on production'
      })
    ]
    const pins = computeDrift(input).items.find((i) => i.table === 'nivaro_extension_settings')
    expect(pins?.evidence).toBe('stamp')
    expect(pins?.who?.name).toBe('Rob Lee')
  })

  it('reports a row removed here', () => {
    const input = baseInput()
    input.live.nivaro_extension_settings = table()
    const pins = computeDrift(input).items.find((i) => i.table === 'nivaro_extension_settings')
    expect(pins?.kind).toBe('removed')
    expect(pins?.live_hash).toBeNull()
  })

  it('a mark holds while the row is unchanged, and lapses once it changes again', () => {
    const input = baseInput()
    const liveHash = input.live.nivaro_saved_views['48'].hash
    input.marks = [
      {
        id: 50,
        table: 'nivaro_saved_views',
        key: '48',
        action: MARK_ACTION,
        hash: liveHash,
        note: 'Agreed with ops',
        user: 'u-rob',
        at: '2026-11-13T16:00:00.000Z'
      }
    ]
    const view = computeDrift(input).items.find((i) => i.key === '48')
    expect(view?.intended).toEqual({
      note: 'Agreed with ops',
      by: 'u-rob',
      by_name: 'Rob Lee',
      at: '2026-11-13T16:00:00.000Z'
    })

    input.live.nivaro_saved_views = table({ ...sharedView, name: 'Active only' }, personalView)
    expect(computeDrift(input).items.find((i) => i.key === '48')?.intended).toBeNull()
  })

  it('a reopen after the mark cancels it', () => {
    const input = baseInput()
    const liveHash = input.live.nivaro_saved_views['48'].hash
    const mark = {
      table: 'nivaro_saved_views',
      key: '48',
      hash: liveHash,
      note: null,
      user: 'u-rob',
      at: SINCE
    }
    input.marks = [
      { ...mark, id: 50, action: MARK_ACTION },
      { ...mark, id: 51, action: REOPEN_ACTION }
    ]
    expect(computeDrift(input).items.find((i) => i.key === '48')?.intended).toBeNull()
  })

  it('skips tables the baseline does not carry', () => {
    const input = baseInput()
    input.tables.push('nivaro_search_synonyms')
    ;(input.live as Record<string, Record<string, SnapshotRow>>).nivaro_search_synonyms = table({
      id: 1,
      terms: 'po,purchase order'
    })
    const { items, skipped } = computeDrift(input)
    expect(items.some((i) => i.table === 'nivaro_search_synonyms')).toBe(false)
    expect(skipped.tables_not_in_baseline).toEqual(['nivaro_search_synonyms'])
  })
})

describe('overwrittenBy — the warning a promotion / apply / restore carries', () => {
  const input = baseInput()
  const { items } = computeDrift(input)

  it('a promotion from dev (which never had the fixes) overwrites both', () => {
    const dev = {
      nivaro_extension_settings: table(baselinePins),
      nivaro_saved_views: table()
    }
    const hit = overwrittenBy(items, dev, input.live, {
      tables: ['nivaro_extension_settings', 'nivaro_saved_views'],
      deletes: true
    })
    expect(hit.map((i) => i.id)).toEqual(['nivaro_extension_settings:7', 'nivaro_saved_views:48'])
  })

  it('an upsert-only apply never removes the row added here', () => {
    const dev = { nivaro_saved_views: table() }
    expect(
      overwrittenBy(items, dev, input.live, { tables: ['nivaro_saved_views'], deletes: false })
    ).toEqual([])
  })

  it('a source that already carries the same change overwrites nothing', () => {
    const dev = {
      nivaro_extension_settings: table(livePins),
      nivaro_saved_views: table(sharedView)
    }
    expect(
      overwrittenBy(items, dev, input.live, {
        tables: ['nivaro_extension_settings', 'nivaro_saved_views'],
        deletes: true
      })
    ).toEqual([])
  })

  it('marked changes and other tables are not warned about', () => {
    const marked = items.map((i) =>
      i.key === '48' ? { ...i, intended: { note: 'ok', by: null, by_name: null, at: SINCE } } : i
    )
    const dev = { nivaro_saved_views: table(), nivaro_extension_settings: table(baselinePins) }
    expect(
      overwrittenBy(marked, dev, input.live, { tables: ['nivaro_saved_views'], deletes: true })
    ).toEqual([])
  })

  it('scoped by keys', () => {
    const dev = { nivaro_extension_settings: table(baselinePins) }
    expect(
      overwrittenBy(items, dev, input.live, {
        tables: ['nivaro_extension_settings'],
        deletes: false,
        keys: new Set(['99'])
      })
    ).toEqual([])
  })
})

describe('scope', () => {
  it('leaves out people, personal subscriptions and per-instance settings', () => {
    const t = driftTables([
      'nivaro_users',
      'nivaro_saved_views',
      'nivaro_settings_overrides',
      'nivaro_notification_subscriptions',
      'nivaro_collection_layouts'
    ])
    expect(t).toEqual(['nivaro_saved_views', 'nivaro_collection_layouts'])
  })

  it('personal saved views and instance-local settings rows', () => {
    expect(rowScope('nivaro_saved_views', personalView)).toBe('personal')
    expect(rowScope('nivaro_saved_views', sharedView)).toBe('config')
    expect(
      rowScope('nivaro_extension_settings', {
        extension_id: 'nivaro-core',
        key: 'form_change:12'
      })
    ).toBe('local')
    expect(rowScope('nivaro_extension_settings', baselinePins)).toBe('config')
  })

  it('volatile columns are not a change, but last_name is', () => {
    expect(
      meaningfulFields({ last_run_at: 1, updated_at: 2 }, { last_run_at: 3, updated_at: 4 })
    ).toEqual([])
    expect(meaningfulFields({ last_name: 'A' }, { last_name: 'B' })).toHaveLength(1)
  })

  it('settings normalize', () => {
    expect(normalizeDriftSettings({ refuse_overwrite: true, baseline_snapshot_id: '12' })).toEqual({
      refuse_overwrite: true,
      baseline_snapshot_id: 12,
      track_here: false
    })
    expect(normalizeDriftSettings('nope')).toEqual({
      refuse_overwrite: false,
      baseline_snapshot_id: null,
      track_here: false
    })
  })
})

describe('daily report section', () => {
  const win = {
    day: '2026-11-13',
    start: new Date('2026-11-13T11:00:00Z'),
    end: new Date('2026-11-14T04:00:00Z'),
    tz: 'America/New_York'
  }
  const { items } = computeDrift(baseInput())
  const report: DriftReport = {
    environment: 'production',
    active: true,
    settings: normalizeDriftSettings({}),
    baseline: {
      snapshot_id: 9,
      taken_at: SINCE,
      trigger: 'promote',
      version: '0.3.157',
      environment: 'production',
      pinned: false
    },
    items,
    totals: { open: 2, intended: 0, tables: 2 },
    skipped: { personal: 0, local: 0, volatile_only: 0, tables_not_in_baseline: [] },
    errors: {},
    generated_at: SINCE
  }

  it('count + link, new in the window', () => {
    const rows = driftSectionRows(report, win)
    expect(rows[0]).toMatchObject({
      key: 'open',
      value: 2,
      href: '/environments/changed-here'
    })
    expect(rows[1]).toMatchObject({ key: 'new', value: 2 })
  })

  it('nothing on an instance that does not track', () => {
    expect(driftSectionRows({ ...report, active: false }, win)).toEqual([])
  })

  it('says when no baseline is stored yet', () => {
    expect(driftSectionRows({ ...report, baseline: null }, win)[0].note).toMatch(/baseline/)
  })
})
