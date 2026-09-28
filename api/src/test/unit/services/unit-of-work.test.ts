import { describe, expect, it } from 'vitest'
import { deferEffect, runUnit, unitOfWorkOpen, withUnitOfWork } from '../../../services/unit-of-work.js'

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
})
