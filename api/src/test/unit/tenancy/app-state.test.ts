import type { Knex } from 'knex'
import { describe, expect, it } from 'vitest'
import { runWithTenantDb } from '../../../db/tenant-context.js'
import { appBox, appMap, appSet } from '../../../services/app-state.js'

// Hub phase 6 Task 22: the per-app module state helpers. Two apps of one process (copies: same
// keys) must never read or overwrite each other's entries; outside any app (self-hosted) the
// helpers behave like the plain Map / Set / variable they replace.

const fakeKnex = {} as Knex
function inApp<T>(app: string, fn: () => T): T {
  let out!: T
  runWithTenantDb(
    fakeKnex,
    app,
    () => {
      out = fn()
    },
    app
  )
  return out
}

describe('appMap', () => {
  it('keeps each app its own entries under the same key', () => {
    const m = appMap<string, string>()
    inApp('A', () => m.set('workflows', 'A config'))
    expect(inApp('B', () => m.get('workflows'))).toBeUndefined()
    inApp('B', () => m.set('workflows', 'B config'))
    expect(inApp('A', () => m.get('workflows'))).toBe('A config')
    expect(inApp('B', () => m.get('workflows'))).toBe('B config')
    expect(inApp('A', () => m.size)).toBe(1)
    expect(inApp('A', () => [...m.keys()])).toEqual(['workflows'])
  })

  it('a clear inside an app clears only that app; outside any app it clears every app', () => {
    const m = appMap<string, number>()
    inApp('A', () => m.set('k', 1))
    inApp('B', () => m.set('k', 2))
    inApp('A', () => m.clear())
    expect(inApp('B', () => m.get('k'))).toBe(2)
    inApp('A', () => m.set('k', 1))
    m.clear()
    expect(inApp('A', () => m.has('k'))).toBe(false)
    expect(inApp('B', () => m.has('k'))).toBe(false)
  })

  it('a delete outside any app reaches every app', () => {
    const m = appMap<string, number>()
    inApp('A', () => m.set('k', 1))
    inApp('B', () => m.set('k', 2))
    inApp('B', () => m.delete('k'))
    expect(inApp('A', () => m.get('k'))).toBe(1)
    expect(m.delete('k')).toBe(true)
    expect(inApp('A', () => m.get('k'))).toBeUndefined()
  })

  it('self-hosted (no app) behaves like a plain Map', () => {
    const m = appMap<string, number>()
    m.set('a', 1)
    expect(m.get('a')).toBe(1)
    expect(m.size).toBe(1)
    expect([...m]).toEqual([['a', 1]])
    expect(m instanceof Map).toBe(true)
  })
})

describe('appSet', () => {
  it('keeps each app its own members', () => {
    const s = appSet<number>()
    inApp('A', () => s.add(7))
    expect(inApp('B', () => s.has(7))).toBe(false)
    inApp('B', () => s.add(7))
    inApp('B', () => s.delete(7))
    expect(inApp('A', () => s.has(7))).toBe(true)
    s.clear()
    expect(inApp('A', () => s.has(7))).toBe(false)
  })
})

describe('appBox', () => {
  it('keeps each app its own value', () => {
    const b = appBox<{ rows: string[] } | null>(() => null)
    inApp('A', () => {
      b.value = { rows: ['A flag'] }
    })
    expect(inApp('B', () => b.value)).toBeNull()
    inApp('B', () => {
      b.value = { rows: ['B flag'] }
    })
    expect(inApp('A', () => b.value?.rows)).toEqual(['A flag'])
  })

  it('a running flag in one app never blocks another', () => {
    const running = appBox(() => false)
    inApp('A', () => {
      running.value = true
    })
    expect(inApp('B', () => running.value)).toBe(false)
  })

  it('putting the initial value back outside any app resets every app', () => {
    const b = appBox<number | null>(() => null)
    inApp('A', () => {
      b.value = 1
    })
    inApp('B', () => {
      b.value = 2
    })
    b.value = null
    expect(inApp('A', () => b.value)).toBeNull()
    expect(inApp('B', () => b.value)).toBeNull()
  })

  it('self-hosted (no app) behaves like a plain variable', () => {
    const b = appBox(() => 0)
    b.value = 5
    expect(b.value).toBe(5)
    b.value = 0
    expect(b.value).toBe(0)
  })

  it('reset(): this app’s slot inside an app, every app’s outside one (object initial value)', () => {
    const b = appBox<{ at: number }>(() => ({ at: 0 }))
    inApp('A', () => {
      b.value = { at: 1 }
    })
    inApp('B', () => {
      b.value = { at: 2 }
    })
    inApp('A', () => b.reset())
    expect(inApp('A', () => b.value.at)).toBe(0)
    expect(inApp('B', () => b.value.at)).toBe(2)
    b.reset()
    expect(inApp('B', () => b.value.at)).toBe(0)
  })
})
