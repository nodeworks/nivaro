import { describe, expect, it } from 'vitest'
import {
  importCadence,
  isImportStale,
  isSnoozed,
  planChangedSnoozePrune,
  planStaleDismissalPrune,
  rowOccurrence,
  type SnoozeRow,
  splitSettingValues,
  stableRowHash,
  validateSettingPatch
} from '../../../services/integration-signal-settings.js'
import type { IntegrationSignal, SignalRow } from '../../../services/integration-signals.js'

const sig: IntegrationSignal = {
  id: 'core:x',
  label: 'x',
  description: '',
  tab: 'pushes',
  severity: 'warn',
  thresholds: [{ key: 'days', label: 'Days', default: 5, unit: 'days', min: 1, max: 60 }],
  evaluate: async () => ({ count: 0, rows: [] })
}
const now = new Date('2026-09-23T12:00:00Z')
const sn = (p: Partial<SnoozeRow>): SnoozeRow => ({
  id: 1,
  signal: 'core:x',
  row_key: null,
  group_key: null,
  until: null,
  until_change_hash: null,
  until_occurrence: null,
  ...p
})

describe('validateSettingPatch', () => {
  it('accepts in-range thresholds, severity and enabled', () => {
    expect(validateSettingPatch(sig, { days: 7, severity: 'critical', enabled: false })).toEqual({
      ok: true,
      values: { days: '7', severity: 'critical', enabled: 'false' }
    })
  })
  it('rejects out-of-range, unknown keys and bad severity', () => {
    expect(validateSettingPatch(sig, { days: 0 }).ok).toBe(false)
    expect(validateSettingPatch(sig, { nope: 1 }).ok).toBe(false)
    expect(validateSettingPatch(sig, { severity: 'loud' }).ok).toBe(false)
  })
  it('rejects a non-boolean enabled value instead of coercing it', () => {
    expect(validateSettingPatch(sig, { enabled: 'false' })).toEqual({
      ok: false,
      error: 'enabled must be true or false'
    })
    expect(validateSettingPatch(sig, { enabled: 1 }).ok).toBe(false)
    expect(validateSettingPatch(sig, { enabled: true })).toEqual({
      ok: true,
      values: { enabled: 'true' }
    })
  })
})

// The per-import staleness store: `default_hours` is a declared threshold,
// `cadence_hours:<import key>` a dynamic override (0 = excluded, null = back
// to the default).
const stale: IntegrationSignal = {
  id: 'core:import-stale',
  label: 'Import stale',
  description: '',
  tab: 'inbound',
  severity: 'warn',
  thresholds: [
    {
      key: 'default_hours',
      label: 'Default cadence',
      default: 48,
      unit: 'hours',
      min: 1,
      max: 2160
    }
  ],
  evaluate: async () => ({ count: 0, rows: [] })
}

describe('validateSettingPatch — import cadence', () => {
  it('accepts null on a dynamic key (remove the override)', () => {
    expect(validateSettingPatch(stale, { 'cadence_hours:orders': null })).toEqual({
      ok: true,
      values: { 'cadence_hours:orders': null }
    })
  })
  it('accepts 0 on a cadence_hours key (excluded)', () => {
    expect(validateSettingPatch(stale, { 'cadence_hours:orders': 0 })).toEqual({
      ok: true,
      values: { 'cadence_hours:orders': '0' }
    })
  })
  it('rejects a negative, a non-number and an over-range cadence', () => {
    expect(validateSettingPatch(stale, { 'cadence_hours:orders': -1 }).ok).toBe(false)
    expect(validateSettingPatch(stale, { 'cadence_hours:orders': 'soon' }).ok).toBe(false)
    expect(validateSettingPatch(stale, { 'cadence_hours:orders': 2161 }).ok).toBe(false)
  })
  it('keeps default_hours at a minimum of 1', () => {
    expect(validateSettingPatch(stale, { default_hours: 0 })).toEqual({
      ok: false,
      error: '"Default cadence" must be at least 1'
    })
    expect(validateSettingPatch(stale, { default_hours: 6 }).ok).toBe(true)
  })
  it('still rejects 0 on a dynamic key that is not a cadence', () => {
    expect(validateSettingPatch(stale, { 'weight:orders': 0 }).ok).toBe(false)
  })
  it('does not allow null on enabled or severity', () => {
    expect(validateSettingPatch(stale, { enabled: null }).ok).toBe(false)
    expect(validateSettingPatch(stale, { severity: null }).ok).toBe(false)
  })
})

describe('splitSettingValues', () => {
  it('turns null into a delete and everything else into an upsert', () => {
    expect(
      splitSettingValues({ 'cadence_hours:a': null, 'cadence_hours:b': '0', default_hours: '6' })
    ).toEqual({
      upserts: [
        ['cadence_hours:b', '0'],
        ['default_hours', '6']
      ],
      deletes: ['cadence_hours:a']
    })
  })
})

describe('importCadence', () => {
  it('reads the default, an override and an exclusion', () => {
    expect(importCadence('a', { default_hours: 48 })).toEqual({ hours: 48, source: 'default' })
    expect(importCadence('a', { default_hours: 48, 'cadence_hours:a': 6 })).toEqual({
      hours: 6,
      source: 'override'
    })
    expect(importCadence('a', { default_hours: 48, 'cadence_hours:a': 0 })).toEqual({
      hours: 0,
      source: 'excluded'
    })
  })
  it('has no dormancy opinion with no last-attempt time', () => {
    expect(importCadence('a', { default_hours: 48 })).toEqual({ hours: 48, source: 'default' })
  })
})

describe('importCadence — dormant imports', () => {
  const now = new Date('2026-09-23T12:00:00Z')
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000)
  it('an import untouched for the default 90 days is dormant, not stale', () => {
    expect(importCadence('a', { default_hours: 48 }, daysAgo(120), now)).toEqual({
      hours: 0,
      source: 'dormant'
    })
    expect(importCadence('a', { default_hours: 48 }, daysAgo(89), now)).toEqual({
      hours: 48,
      source: 'default'
    })
  })
  it('an explicit override always wins over dormancy', () => {
    expect(
      importCadence('a', { default_hours: 48, 'cadence_hours:a': 6 }, daysAgo(400), now)
    ).toEqual({ hours: 6, source: 'override' })
  })
  it('an exclusion is unaffected by dormancy', () => {
    expect(
      importCadence('a', { default_hours: 48, 'cadence_hours:a': 0 }, daysAgo(400), now)
    ).toEqual({ hours: 0, source: 'excluded' })
  })
  it('honours a custom dormant_days threshold', () => {
    expect(importCadence('a', { default_hours: 48, dormant_days: 10 }, daysAgo(15), now)).toEqual({
      hours: 0,
      source: 'dormant'
    })
    expect(importCadence('a', { default_hours: 48, dormant_days: 10 }, daysAgo(5), now)).toEqual({
      hours: 48,
      source: 'default'
    })
  })
})

describe('isImportStale', () => {
  const now = new Date('2026-09-23T12:00:00Z')
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000)
  it('is stale past the cadence, never when excluded, dormant or never run', () => {
    expect(isImportStale(hoursAgo(50), { hours: 48, source: 'default' }, now)).toBe(true)
    expect(isImportStale(hoursAgo(10), { hours: 48, source: 'default' }, now)).toBe(false)
    expect(isImportStale(hoursAgo(5000), { hours: 0, source: 'excluded' }, now)).toBe(false)
    expect(isImportStale(hoursAgo(5000), { hours: 0, source: 'dormant' }, now)).toBe(false)
    expect(isImportStale(null, { hours: 48, source: 'default' }, now)).toBe(false)
  })
})

describe('stableRowHash', () => {
  it('ignores since and numbers inside the detail', () => {
    const a = stableRowHash({
      key: 'k',
      title: 'T',
      detail: '3 records failing',
      since: '2026-01-01',
      actions: []
    })
    const b = stableRowHash({
      key: 'k',
      title: 'T',
      detail: '9 records failing',
      since: '2026-02-02',
      actions: []
    })
    expect(a).toBe(b)
    expect(stableRowHash({ key: 'k', title: 'Other', actions: [] })).not.toBe(a)
  })
})

describe('isSnoozed', () => {
  const row = { key: 'k1', group: 'g1', title: 'T', actions: [] }
  it('matches row, group and whole-signal scopes', () => {
    expect(
      isSnoozed(row, 'core:x', [sn({ row_key: 'k1', until: new Date('2026-09-24') })], now)
    ).not.toBeNull()
    expect(
      isSnoozed(row, 'core:x', [sn({ group_key: 'g1', until: new Date('2026-09-24') })], now)
    ).not.toBeNull()
    expect(isSnoozed(row, 'core:x', [sn({ until: new Date('2026-09-24') })], now)).not.toBeNull()
    expect(
      isSnoozed(row, 'core:y', [sn({ signal: 'core:y', until: new Date('2026-09-24') })], now)
    ).not.toBeNull()
    expect(
      isSnoozed(row, 'core:x', [sn({ signal: 'core:y', until: new Date('2026-09-24') })], now)
    ).toBeNull()
  })
  it('expires by time and by payload change', () => {
    expect(
      isSnoozed(row, 'core:x', [sn({ row_key: 'k1', until: new Date('2026-09-22') })], now)
    ).toBeNull()
    const h = stableRowHash(row)
    expect(
      isSnoozed(row, 'core:x', [sn({ row_key: 'k1', until_change_hash: h })], now)
    ).not.toBeNull()
    expect(
      isSnoozed(
        { ...row, title: 'changed' },
        'core:x',
        [sn({ row_key: 'k1', until_change_hash: h })],
        now
      )
    ).toBeNull()
  })
})

// Task 15c — Dismiss ("I've seen this one, tell me when it happens again").
// `occurrence` identifies the SPECIFIC instance behind a row, distinct from
// `key` (the problem itself, which never changes across failures).
describe('rowOccurrence', () => {
  const base: SignalRow = { key: 'k', title: 'T', actions: [] }

  it('prefers an explicit occurrence over since or the hash', () => {
    expect(rowOccurrence({ ...base, occurrence: 'run:1', since: '2026-01-01' })).toBe('run:1')
  })

  it('falls back to since when occurrence is unset', () => {
    expect(rowOccurrence({ ...base, since: '2026-01-01' })).toBe('2026-01-01')
  })

  it('falls back to the stable hash when neither occurrence nor since is set', () => {
    expect(rowOccurrence(base)).toBe(stableRowHash(base))
  })
})

describe('isSnoozed — Dismiss (until_occurrence)', () => {
  const row = (occurrence?: string, since?: string): SignalRow => ({
    key: 'k1',
    title: 'Forecasts: last run failed — import_forecasts -',
    actions: [],
    ...(occurrence !== undefined && { occurrence }),
    ...(since !== undefined && { since })
  })

  it('hides the row while its occurrence is unchanged from the dismissal', () => {
    const dismissed = sn({ row_key: 'k1', until_occurrence: 'run:100' })
    expect(isSnoozed(row('run:100'), 'core:x', [dismissed], now)).not.toBeNull()
  })

  it('a NEW occurrence — same wording, new run id — shows the row again', () => {
    const dismissed = sn({ row_key: 'k1', until_occurrence: 'run:100' })
    expect(isSnoozed(row('run:105'), 'core:x', [dismissed], now)).toBeNull()
  })

  it('never matches a row with a different key, or a dismissal on another signal', () => {
    const dismissed = sn({ row_key: 'k1', until_occurrence: 'run:100' })
    expect(isSnoozed({ ...row('run:100'), key: 'k2' }, 'core:x', [dismissed], now)).toBeNull()
    expect(isSnoozed(row('run:100'), 'core:y', [dismissed], now)).toBeNull()
  })

  it('a row with no explicit occurrence falls back to since — dismissal keys on THAT', () => {
    const target = row(undefined, '2026-09-20T00:00:00Z')
    const dismissed = sn({ row_key: 'k1', until_occurrence: rowOccurrence(target) })
    expect(isSnoozed(target, 'core:x', [dismissed], now)).not.toBeNull()
    // `since` moving (a fresh instance the signal only distinguishes by
    // timestamp) is exactly "it happened again" for a signal with no
    // dedicated occurrence.
    expect(isSnoozed(row(undefined, '2026-09-21T00:00:00Z'), 'core:x', [dismissed], now)).toBeNull()
  })

  it('a row with neither occurrence nor since falls back to the stable hash', () => {
    const target: SignalRow = { ...row(), detail: '3 records failing' }
    const dismissed = sn({ row_key: 'k1', until_occurrence: rowOccurrence(target) })
    expect(isSnoozed(target, 'core:x', [dismissed], now)).not.toBeNull()
    // The hash masks digits, so the SAME kind of detail with different
    // numbers still hashes the same and stays dismissed — same guarantee as
    // "Until it changes" (stableRowHash is shared).
    expect(
      isSnoozed({ ...target, detail: '9 records failing' }, 'core:x', [dismissed], now)
    ).not.toBeNull()
    // A real change to the title (a different problem) is a different hash.
    expect(isSnoozed({ ...target, title: 'Other problem' }, 'core:x', [dismissed], now)).toBeNull()
  })

  it('a Dismiss and an older timed snooze on the same row do not interfere with each other', () => {
    const timed = sn({ id: 1, row_key: 'k1', until: new Date('2026-09-25') }) // still valid
    const dismissed = sn({ id: 2, row_key: 'k1', until_occurrence: 'run:100' })
    // Both valid — matches (order in the array must not matter).
    expect(isSnoozed(row('run:100'), 'core:x', [timed, dismissed], now)).not.toBeNull()
    expect(isSnoozed(row('run:100'), 'core:x', [dismissed, timed], now)).not.toBeNull()
    // The dismissal goes stale (new occurrence) — the still-valid timed
    // snooze keeps the row hidden regardless; the stale dismissal does not
    // poison it.
    expect(isSnoozed(row('run:105'), 'core:x', [timed, dismissed], now)).not.toBeNull()
    // The timed snooze expires — the dismissal, still matching its
    // occurrence, keeps the row hidden on its own.
    const expiredTimed = sn({ id: 1, row_key: 'k1', until: new Date('2026-09-22') })
    expect(isSnoozed(row('run:100'), 'core:x', [expiredTimed, dismissed], now)).not.toBeNull()
    // Both stale/expired — the row shows again.
    expect(isSnoozed(row('run:105'), 'core:x', [expiredTimed, dismissed], now)).toBeNull()
  })
})

describe('planStaleDismissalPrune', () => {
  const dsn = (
    p: Partial<{
      id: number
      signal: string
      row_key: string | null
      until_occurrence: string | null
    }>
  ) => ({
    id: 1,
    signal: 'core:x',
    row_key: 'k1',
    until_occurrence: 'run:1',
    ...p
  })

  it('prunes a dismissal whose row has not been seen at all in 30 days', () => {
    const staleRows = [{ signal: 'core:x', row_key: 'k1', last_seen: daysAgoOf(now, 40) }]
    expect(planStaleDismissalPrune([dsn({ id: 9 })], staleRows, now)).toEqual([9])
  })

  it('keeps a dismissal whose row is still being seen', () => {
    const freshRows = [{ signal: 'core:x', row_key: 'k1', last_seen: daysAgoOf(now, 2) }]
    expect(planStaleDismissalPrune([dsn({ id: 9 })], freshRows, now)).toEqual([])
  })

  it('prunes a dismissal whose row has no matching entry at all', () => {
    expect(planStaleDismissalPrune([dsn({ id: 9 })], [], now)).toEqual([9])
  })

  it('ignores a plain (non-dismiss) snooze — until_occurrence null', () => {
    expect(planStaleDismissalPrune([dsn({ id: 9, until_occurrence: null })], [], now)).toEqual([])
  })

  it('respects a custom staleness window', () => {
    const rows = [{ signal: 'core:x', row_key: 'k1', last_seen: daysAgoOf(now, 10) }]
    expect(planStaleDismissalPrune([dsn({ id: 9 })], rows, now, 5 * 86_400_000)).toEqual([9])
    expect(planStaleDismissalPrune([dsn({ id: 9 })], rows, now, 20 * 86_400_000)).toEqual([])
  })
})

function daysAgoOf(from: Date, days: number): Date {
  return new Date(from.getTime() - days * 86_400_000)
}

describe('isSnoozed — keys longer than the stored 300 characters', () => {
  it('matches a row whose key the snooze table could only hold truncated', () => {
    const long = `k:${'x'.repeat(398)}`
    const group = `g:${'y'.repeat(398)}`
    const row = { key: long, group, title: 'T', actions: [] }
    const until = new Date('2026-09-24')
    expect(
      isSnoozed(row, 'core:x', [sn({ row_key: long.slice(0, 300), until })], now)
    ).not.toBeNull()
    expect(
      isSnoozed(row, 'core:x', [sn({ group_key: group.slice(0, 300), until })], now)
    ).not.toBeNull()
  })
})

describe('planChangedSnoozePrune', () => {
  const row = { key: 'k1', title: 'T', actions: [] }
  const h = stableRowHash(row)
  it('drops an "until it changes" snooze once its open row no longer matches the hash', () => {
    const snoozes = [
      sn({ id: 1, row_key: 'k1', until_change_hash: h }),
      sn({ id: 2, row_key: 'k2', until_change_hash: h }),
      sn({ id: 3, row_key: 'k3', until_change_hash: 'old' }),
      sn({ id: 4, row_key: 'k1', until: new Date('2026-09-24') })
    ]
    const open = [
      { signal: 'core:x', row: row },
      { signal: 'core:x', row: { ...row, key: 'k2', title: 'reworded' } }
    ]
    // k1 still matches; k2 changed; k3 is not open (left alone — it may
    // come back unchanged); 4 is a timed snooze.
    expect(planChangedSnoozePrune(snoozes, open)).toEqual([2])
  })
  it('matches long keys by their stored 300-character prefix', () => {
    const long = `k:${'x'.repeat(398)}`
    const changed = { key: long, title: 'new wording', actions: [] }
    expect(
      planChangedSnoozePrune(
        [sn({ id: 9, row_key: long.slice(0, 300), until_change_hash: h })],
        [{ signal: 'core:x', row: changed }]
      )
    ).toEqual([9])
  })
})
