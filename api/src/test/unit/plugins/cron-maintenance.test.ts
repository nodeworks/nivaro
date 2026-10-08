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

type Holder = { heldByMaintenance(id: string): Promise<boolean> }

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
})
