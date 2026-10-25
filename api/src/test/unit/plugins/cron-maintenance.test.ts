import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Scheduled ticks hold while maintenance mode is on; the window sweep that
// ends a maintenance window opts out; a failed lookup never holds a job.
const state = { on: false, fail: false }
vi.mock('../../../services/security.js', () => ({
  maintenanceState: async () => {
    if (state.fail) throw new Error('redis down')
    return { on: state.on, message: null, display: 'page', until: null, source: 'override' }
  }
}))

const { CronManager } = await import('../../../plugins/cron.js')

type Holder = {
  heldByMaintenance(id: string): Promise<boolean>
  noteHeldSlot(id: string, slot: Date): Promise<void>
}

describe('cron ticks during maintenance (2026-10-07)', () => {
  let m: InstanceType<typeof CronManager>
  beforeEach(() => {
    state.on = false
    state.fail = false
    m = new CronManager()
    m.schedule('nightly', '0 3 * * *', async () => {})
    m.schedule('maintenance-windows', '* * * * *', async () => {}, { duringMaintenance: true })
  })
  afterEach(() => {
    m.unschedule('nightly')
    m.unschedule('maintenance-windows')
  })

  it('does not hold any job while maintenance is off', async () => {
    const h = m as unknown as Holder
    expect(await h.heldByMaintenance('nightly')).toBe(false)
    expect(await h.heldByMaintenance('maintenance-windows')).toBe(false)
  })

  it('holds an ordinary job and lets the window sweep tick while maintenance is on', async () => {
    state.on = true
    const h = m as unknown as Holder
    expect(await h.heldByMaintenance('nightly')).toBe(true)
    expect(await h.heldByMaintenance('maintenance-windows')).toBe(false)
  })

  it('never holds a job when the maintenance lookup itself fails', async () => {
    state.on = true
    state.fail = true
    const h = m as unknown as Holder
    expect(await h.heldByMaintenance('nightly')).toBe(false)
  })

  it('releases the hold once maintenance ends', async () => {
    state.on = true
    const h = m as unknown as Holder
    expect(await h.heldByMaintenance('nightly')).toBe(true)
    state.on = false
    expect(await h.heldByMaintenance('nightly')).toBe(false)
  })

  it('remembers a held slot so the miss detector skips it (2026-10-25)', async () => {
    const h = m as unknown as Holder
    const slot = new Date('2026-10-25T04:35:00Z')
    expect(await m.heldByMaintenanceAt('nightly', slot)).toBe(false)
    await h.noteHeldSlot('nightly', slot)
    expect(await m.heldByMaintenanceAt('nightly', slot)).toBe(true)
    // An earlier expected slot is covered too; a later one (after maintenance) is not.
    expect(await m.heldByMaintenanceAt('nightly', new Date('2026-10-25T04:00:00Z'))).toBe(true)
    expect(await m.heldByMaintenanceAt('nightly', new Date('2026-10-26T04:35:00Z'))).toBe(false)
    expect(await m.heldByMaintenanceAt('maintenance-windows', slot)).toBe(false)
  })
})
