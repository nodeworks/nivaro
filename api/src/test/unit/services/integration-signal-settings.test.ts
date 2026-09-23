import { describe, expect, it } from 'vitest'
import {
  isSnoozed,
  stableRowHash,
  type SnoozeRow,
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
})

describe('stableRowHash', () => {
  it('ignores since and numbers inside the detail', () => {
    const a = stableRowHash({ key: 'k', title: 'T', detail: '3 records failing', since: '2026-01-01', actions: [] })
    const b = stableRowHash({ key: 'k', title: 'T', detail: '9 records failing', since: '2026-02-02', actions: [] })
    expect(a).toBe(b)
    expect(stableRowHash({ key: 'k', title: 'Other', actions: [] })).not.toBe(a)
  })
})

describe('isSnoozed', () => {
  const row = { key: 'k1', group: 'g1', title: 'T', actions: [] }
  it('matches row, group and whole-signal scopes', () => {
    expect(isSnoozed(row, 'core:x', [sn({ row_key: 'k1', until: new Date('2026-09-24') })], now)).not.toBeNull()
    expect(isSnoozed(row, 'core:x', [sn({ group_key: 'g1', until: new Date('2026-09-24') })], now)).not.toBeNull()
    expect(isSnoozed(row, 'core:x', [sn({ until: new Date('2026-09-24') })], now)).not.toBeNull()
    expect(isSnoozed(row, 'core:y', [sn({ signal: 'core:y', until: new Date('2026-09-24') })], now)).not.toBeNull()
    expect(isSnoozed(row, 'core:x', [sn({ signal: 'core:y', until: new Date('2026-09-24') })], now)).toBeNull()
  })
  it('expires by time and by payload change', () => {
    expect(isSnoozed(row, 'core:x', [sn({ row_key: 'k1', until: new Date('2026-09-22') })], now)).toBeNull()
    const h = stableRowHash(row)
    expect(isSnoozed(row, 'core:x', [sn({ row_key: 'k1', until_change_hash: h })], now)).not.toBeNull()
    expect(
      isSnoozed({ ...row, title: 'changed' }, 'core:x', [sn({ row_key: 'k1', until_change_hash: h })], now)
    ).toBeNull()
  })
})
