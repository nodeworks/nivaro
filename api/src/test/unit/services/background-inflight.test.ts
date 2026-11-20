import { describe, expect, it } from 'vitest'
import {
  backgroundWorkCount,
  listBackgroundWork,
  noteBackgroundWork,
  withBackgroundWork
} from '../../../services/background-inflight.js'

describe('background work in flight (for the stall watchdog)', () => {
  it('lists running work longest-first and forgets it when it ends', async () => {
    const endA = noteBackgroundWork('cron', 'file-cleanup')
    let seenInside: string[] = []
    await withBackgroundWork('import', 'invoices #1', async () => {
      seenInside = listBackgroundWork().map((w) => `${w.kind} ${w.label}`)
    })
    expect(seenInside).toEqual(['cron file-cleanup', 'import invoices #1'])
    expect(listBackgroundWork().map((w) => w.label)).toEqual(['file-cleanup'])
    endA()
    endA()
    expect(backgroundWorkCount()).toBe(0)
  })

  it('a failing piece of work is still forgotten', async () => {
    await expect(
      withBackgroundWork('cron', 'boom', async () => {
        throw new Error('x')
      })
    ).rejects.toThrow('x')
    expect(backgroundWorkCount()).toBe(0)
  })
})
