import { describe, expect, it } from 'vitest'
import {
  importCadence,
  isImportStale,
  isSnoozed,
  type SnoozeRow,
  splitSettingValues,
  stableRowHash,
  validateSettingPatch
} from '../../../services/integration-signal-settings.js'
import type { IntegrationSignal } from '../../../services/integration-signals.js'

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
})

describe('isImportStale', () => {
  const now = new Date('2026-09-23T12:00:00Z')
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000)
  it('is stale past the cadence, never when excluded or never run', () => {
    expect(isImportStale(hoursAgo(50), { hours: 48, source: 'default' }, now)).toBe(true)
    expect(isImportStale(hoursAgo(10), { hours: 48, source: 'default' }, now)).toBe(false)
    expect(isImportStale(hoursAgo(5000), { hours: 0, source: 'excluded' }, now)).toBe(false)
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
