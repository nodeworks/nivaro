import { describe, expect, it, vi } from 'vitest'
import { inBackgroundPool } from '../../../db/pool-context.js'
import {
  deferEffect,
  runUnit,
  unitOfWorkOpen,
  withUnitOfWork
} from '../../../services/unit-of-work.js'

describe('unit of work (#793)', () => {
  it('runs an effect at once outside a unit', async () => {
    const ran: string[] = []
    await deferEffect('a', () => {
      ran.push('a')
    })
    expect(ran).toEqual(['a'])
    expect(unitOfWorkOpen()).toBe(false)
  })

  it('holds effects until the unit returns, in order', async () => {
    const ran: string[] = []
    await runUnit('u', async () => {
      await deferEffect('a', () => ran.push('a'))
      await deferEffect('b', () => ran.push('b'))
      expect(ran).toEqual([])
      expect(unitOfWorkOpen()).toBe(true)
    })
    expect(ran).toEqual(['a', 'b'])
  })

  it('drops effects when the unit throws', async () => {
    const ran: string[] = []
    await expect(
      withUnitOfWork('u', async () => {
        await deferEffect('a', () => ran.push('a'))
        throw new Error('refused')
      })
    ).rejects.toThrow('refused')
    expect(ran).toEqual([])
  })

  it('drops effects when the caller discards after compensating', async () => {
    const ran: string[] = []
    const out = await runUnit('u', async (unit) => {
      await deferEffect('a', () => ran.push('a'))
      unit.discard()
      await deferEffect('late', () => ran.push('late'))
      return 'compensated'
    })
    expect(out).toBe('compensated')
    expect(ran).toEqual([])
  })

  it('a nested unit joins the outer one and its discard discards the whole', async () => {
    const ran: string[] = []
    await runUnit('outer', async () => {
      await deferEffect('outer-a', () => ran.push('outer-a'))
      await runUnit('inner', async () => {
        await deferEffect('inner-a', () => ran.push('inner-a'))
      })
      expect(ran).toEqual([])
    })
    expect(ran).toEqual(['outer-a', 'inner-a'])

    ran.length = 0
    await runUnit('outer', async () => {
      await deferEffect('outer-a', () => ran.push('outer-a'))
      await runUnit('inner', async (inner) => {
        await deferEffect('inner-a', () => ran.push('inner-a'))
        inner.discard()
      })
    })
    expect(ran).toEqual([])
  })

  it('a failing effect never fails the unit or stops the others', async () => {
    const ran: string[] = []
    const result = await runUnit('u', async () => {
      await deferEffect('boom', () => Promise.reject(new Error('boom')))
      await deferEffect('after', () => ran.push('after'))
      return 42
    })
    expect(result).toBe(42)
    expect(ran).toEqual(['after'])
  })

  // Production review 2026-11-12: creating an inventory request waited ~1.5 s on an
  // "after" event flow's partner call (an effect nothing in the answer depends on),
  // because the unit ran every queued effect to the end before it returned.
  describe('detached effects', () => {
    const settle = async () => {
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
    }

    it('start in their turn when the unit commits, and the unit does not wait for them', async () => {
      const ran: string[] = []
      let release: () => void = () => {}
      const gate = new Promise<void>((r) => {
        release = r
      })
      await runUnit('u', async () => {
        await deferEffect('before', () => ran.push('before'))
        await deferEffect(
          'slow',
          async () => {
            ran.push('slow:start')
            await gate
            ran.push('slow:end')
          },
          { detached: true }
        )
        await deferEffect('after', () => ran.push('after'))
        expect(ran).toEqual([])
      })
      // The unit is back while the slow effect is still out.
      expect(ran).toEqual(['before', 'slow:start', 'after'])
      release()
      await settle()
      expect(ran).toEqual(['before', 'slow:start', 'after', 'slow:end'])
    })

    it('run one at a time, in order — a batch never fans them out', async () => {
      const ran: string[] = []
      let running = 0
      let most = 0
      const slow = (name: string) => async () => {
        running++
        most = Math.max(most, running)
        await new Promise((r) => setTimeout(r, 2))
        ran.push(name)
        running--
      }
      await runUnit('batch', async () => {
        for (const name of ['a', 'b', 'c', 'd'])
          await deferEffect(name, slow(name), { detached: true })
      })
      await new Promise((r) => setTimeout(r, 40))
      expect(ran).toEqual(['a', 'b', 'c', 'd'])
      expect(most).toBe(1)
    })

    it('are dropped with the unit when it throws or is discarded', async () => {
      const ran: string[] = []
      await expect(
        withUnitOfWork('u', async () => {
          await deferEffect('a', () => ran.push('a'), { detached: true })
          throw new Error('refused')
        })
      ).rejects.toThrow('refused')
      await runUnit('u', async (unit) => {
        await deferEffect('b', () => ran.push('b'), { detached: true })
        unit.discard()
      })
      await settle()
      expect(ran).toEqual([])
    })

    it('a failing one is logged, never thrown, and the next still runs', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const ran: string[] = []
      await runUnit('u', async () => {
        await deferEffect('boom', () => Promise.reject(new Error('boom')), { detached: true })
        await deferEffect('next', () => ran.push('next'), { detached: true })
      })
      await settle()
      expect(ran).toEqual(['next'])
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('effect boom failed'), 'boom')
      warn.mockRestore()
    })

    it('run on the background pool; the effects the unit waits for do not', async () => {
      const pools: Record<string, boolean> = {}
      await runUnit('u', async () => {
        await deferEffect('waited', () => {
          pools.waited = inBackgroundPool()
        })
        await deferEffect(
          'detached',
          () => {
            pools.detached = inBackgroundPool()
          },
          { detached: true }
        )
      })
      await settle()
      expect(pools).toEqual({ waited: false, detached: true })
    })

    it('outside a unit run at once, as before', async () => {
      const ran: string[] = []
      await deferEffect('a', () => ran.push('a'), { detached: true })
      expect(ran).toEqual(['a'])
    })
  })
})
