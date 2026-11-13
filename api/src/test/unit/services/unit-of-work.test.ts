import { AsyncLocalStorage } from 'node:async_hooks'
import { describe, expect, it, vi } from 'vitest'
import { inBackgroundPool } from '../../../db/pool-context.js'
import {
  DETACHED_BACKLOG,
  DETACHED_SLOT_MS,
  DETACHED_SLOTS,
  deferEffect,
  detachedEffectsPending,
  drainDetachedEffects,
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

    describe('across units (security review 2026-11-12)', () => {
      // One at a time held only inside ONE unit. A loop of creates (an import, an inbound
      // feed) opens a unit per row, so every row's after-create flow started at once: N
      // partner calls together, all on the small background pool.
      it('at most two run at once, the rest wait their turn', async () => {
        let running = 0
        let most = 0
        const gates: Array<() => void> = []
        const held = () => async () => {
          running++
          most = Math.max(most, running)
          await new Promise<void>((r) => gates.push(r))
          running--
        }
        for (let i = 0; i < 6; i++) {
          await runUnit(`u${i}`, async () => {
            await deferEffect(`e${i}`, held(), { detached: true })
          })
        }
        await settle()
        expect(DETACHED_SLOTS).toBe(2)
        expect(running).toBe(2)
        expect(detachedEffectsPending()).toBe(6)
        while (gates.length > 0) {
          gates.shift()?.()
          await settle()
        }
        expect(most).toBe(2)
        expect(detachedEffectsPending()).toBe(0)
      })

      it('with a deep backlog a writer runs its own effect itself, as before detaching', async () => {
        const gates: Array<() => void> = []
        const held = () => new Promise<void>((r) => gates.push(r))
        for (let i = 0; i < DETACHED_SLOTS + DETACHED_BACKLOG; i++) {
          await runUnit('fill', async () => {
            await deferEffect('fill', held, { detached: true })
          })
        }
        await settle()
        // The lane is full of runs that are not finishing. A new write must not queue behind
        // them (one hung partner would then stall every writer): it runs its effect inline
        // and waits for THAT, which is what every create did before effects could detach.
        const ran: string[] = []
        let release: () => void = () => {}
        let returned = false
        const late = runUnit('late', async () => {
          await deferEffect(
            'late',
            async () => {
              ran.push('late:start')
              await new Promise<void>((r) => {
                release = r
              })
              ran.push('late:end')
            },
            { detached: true }
          )
        }).then(() => {
          returned = true
        })
        await settle()
        expect(ran).toEqual(['late:start'])
        expect(returned).toBe(false)
        release()
        await late
        expect(ran).toEqual(['late:start', 'late:end'])
        // The backlog is exactly as it was: the late write neither waited for it nor joined it.
        expect(detachedEffectsPending()).toBe(DETACHED_SLOTS + DETACHED_BACKLOG)
        while (gates.length > 0) {
          gates.shift()?.()
          await settle()
        }
        expect(detachedEffectsPending()).toBe(0)
      })

      it('a run that does not end gives its slot to the next one after a time limit', async () => {
        vi.useFakeTimers()
        try {
          const started: string[] = []
          const releases: Array<() => void> = []
          const stuck = (name: string) => () => {
            started.push(name)
            return new Promise<void>((r) => releases.push(r))
          }
          for (const name of ['a', 'b', 'c', 'd']) {
            await runUnit(name, async () => {
              await deferEffect(name, stuck(name), { detached: true })
            })
          }
          await vi.advanceTimersByTimeAsync(1)
          expect(started).toEqual(['a', 'b'])
          await vi.advanceTimersByTimeAsync(DETACHED_SLOT_MS)
          // Both stuck runs lost their slots; the two that waited have started. The stuck
          // ones are still counted: they have not finished.
          expect(started).toEqual(['a', 'b', 'c', 'd'])
          expect(detachedEffectsPending()).toBe(4)
          for (const r of releases) r()
          await vi.advanceTimersByTimeAsync(1)
          expect(detachedEffectsPending()).toBe(0)
        } finally {
          vi.useRealTimers()
        }
      })

      it('an effect that waited runs in the context of the unit that queued it', async () => {
        const who = new AsyncLocalStorage<string>()
        const gates: Array<() => void> = []
        const seen: Array<string | undefined> = []
        const held = () => new Promise<void>((r) => gates.push(r))
        await who.run('filler', async () => {
          for (let i = 0; i < DETACHED_SLOTS; i++) {
            await runUnit('fill', async () => {
              await deferEffect('fill', held, { detached: true })
            })
          }
        })
        await who.run('tenant-a', () =>
          runUnit('a', async () => {
            await deferEffect('a', () => void seen.push(who.getStore()), { detached: true })
          })
        )
        await settle()
        expect(seen).toEqual([])
        while (gates.length > 0) {
          gates.shift()?.()
          await settle()
        }
        // Started later, from another unit's completion: still its own tenant and person.
        expect(seen).toEqual(['tenant-a'])
      })

      it('shutdown waits for what is in flight and says what it had to leave', async () => {
        let release: () => void = () => {}
        await runUnit('u', async () => {
          await deferEffect(
            'slow',
            () =>
              new Promise<void>((r) => {
                release = r
              }),
            { detached: true }
          )
        })
        await settle()
        expect(await drainDetachedEffects(10)).toEqual({ left: 1 })
        release()
        expect(await drainDetachedEffects(500)).toEqual({ left: 0 })
      })
    })

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
