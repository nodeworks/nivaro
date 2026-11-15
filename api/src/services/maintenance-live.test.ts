import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// rt4 #13 — the maintenance page returns to the app by itself: a change in what people see of
// maintenance (on/off, page or strip, expected end, wording) announces `announcements:changed`
// once; a failed read never counts; while maintenance was last seen ON the process looks again
// every few seconds (an override a rebuild job deletes outside the app).

vi.mock('./tenant-rooms.js', () => ({ currentTenantKey: () => '' }))

import {
  _maintenanceWatching,
  _resetMaintenanceLive,
  maintenanceSignature,
  observeMaintenance,
  recheckMaintenanceSoon,
  stopMaintenanceWatch
} from './maintenance-live.js'

const announce = vi.fn()
let state: { on: boolean; display?: string; until?: string | null; message?: string | null }
const read = vi.fn(async () => {
  observeMaintenance(state)
  return state
})

beforeEach(() => {
  vi.useFakeTimers()
  announce.mockReset()
  read.mockClear()
  state = { on: false }
  delete process.env.CLOUD_META_DB_URL
  _resetMaintenanceLive({ announce, read })
})
afterEach(() => {
  stopMaintenanceWatch()
  vi.useRealTimers()
})

describe('maintenanceSignature', () => {
  it('is "off" whatever the other fields say, and names what people see when on', () => {
    expect(maintenanceSignature({ on: false, display: 'page', message: 'x' })).toBe('off')
    expect(
      maintenanceSignature({ on: true, display: 'page', until: null, message: ' Back ' })
    ).toBe('on|page||Back')
    expect(maintenanceSignature({ on: true })).toBe('on|banner||')
  })
})

describe('observeMaintenance', () => {
  it('sets a baseline on the first read and announces only real changes', () => {
    expect(observeMaintenance({ on: true, display: 'page' })).toBe(false)
    expect(observeMaintenance({ on: true, display: 'page' })).toBe(false)
    expect(announce).not.toHaveBeenCalled()
    // Maintenance ends: one notice.
    expect(observeMaintenance({ on: false })).toBe(true)
    expect(announce).toHaveBeenCalledTimes(1)
    // A new expected end while on is a change too (the page shows it).
    observeMaintenance({ on: true, display: 'page' })
    observeMaintenance({ on: true, display: 'page', until: '2026-11-15T03:00:00.000Z' })
    expect(announce).toHaveBeenCalledTimes(3)
  })
})

describe('the watch while maintenance is on', () => {
  it('runs only while the last read said ON, and hears an override deleted outside the app', async () => {
    state = { on: true, display: 'page' }
    observeMaintenance(state)
    expect(_maintenanceWatching()).toBe(true)
    // The rebuild job deletes the override: the next look sees it and announces.
    state = { on: false }
    await vi.advanceTimersByTimeAsync(5_000)
    expect(read).toHaveBeenCalled()
    expect(announce).toHaveBeenCalledTimes(1)
    expect(_maintenanceWatching()).toBe(false)
  })

  it('never runs in cloud mode (module timers would be shared by every tenant)', () => {
    process.env.CLOUD_META_DB_URL = 'x'
    observeMaintenance({ on: true })
    expect(_maintenanceWatching()).toBe(false)
  })
})

describe('recheckMaintenanceSoon (a write in this process)', () => {
  it('reads again at once and tells again after other replicas’ caches expired', async () => {
    observeMaintenance({ on: true, display: 'page' })
    stopMaintenanceWatch()
    state = { on: false }
    recheckMaintenanceSoon()
    await vi.advanceTimersByTimeAsync(300)
    expect(announce).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(16_000)
    expect(announce).toHaveBeenCalledTimes(2)
  })

  it('says nothing when the write did not change maintenance (any other setting)', async () => {
    observeMaintenance({ on: false })
    recheckMaintenanceSoon()
    recheckMaintenanceSoon()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(read).toHaveBeenCalledTimes(1)
    expect(announce).not.toHaveBeenCalled()
  })
})
