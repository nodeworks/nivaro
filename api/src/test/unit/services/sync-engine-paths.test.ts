import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

const { getPath, setPath } = await import('../../../services/sync-engine.js')

describe('sync-engine field paths — no prototype pollution', () => {
  it('writes nested paths as before', () => {
    const o: Record<string, unknown> = {}
    setPath(o, 'a.b.c', 1)
    setPath(o, 'x', 2)
    expect(o).toEqual({ a: { b: { c: 1 } }, x: 2 })
    expect(getPath(o, 'a.b.c')).toBe(1)
  })

  it.each([
    '__proto__.polluted',
    'constructor.prototype.polluted',
    'a.__proto__.polluted'
  ])('ignores %s', (path) => {
    const o: Record<string, unknown> = { a: {} }
    setPath(o, path, true)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.prototype).not.toHaveProperty('polluted')
  })

  it('reads only own properties', () => {
    expect(getPath({ a: 1 }, 'constructor')).toBeUndefined()
    expect(getPath({ a: 1 }, '__proto__')).toBeUndefined()
    expect(getPath({ a: { toString: 'x' } }, 'a.toString')).toBe('x')
    expect(getPath({ a: {} }, 'a.toString')).toBeUndefined()
  })
})
