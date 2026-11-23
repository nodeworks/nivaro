import { describe, expect, it } from 'vitest'
import { scanStateFile } from './module-state-scan.js'

// Hub phase 6 Task 22 fix round 1 (review I-3): what the module-state scanner finds, on small
// made-up modules.

const kinds = (src: string) =>
  Object.fromEntries(scanStateFile('services/x.ts', src).map((f) => [f.name, f.kind]))
const keyed = (src: string) =>
  Object.fromEntries(scanStateFile('services/x.ts', src).map((f) => [f.name, f.keyed]))

describe('module-level literals written later', () => {
  it.each([
    ['perUser[id] += n', 'const perUser = {}\nexport function f(id, n) { perUser[id] += n }'],
    ['stats.hits++', 'const stats = { hits: 0 }\nexport function f() { stats.hits++ }'],
    ['++stats.hits', 'const stats = { hits: 0 }\nexport function f() { ++stats.hits }'],
    ['x.a.b -= 1', 'const x = { a: { b: 2 } }\nexport function f() { x.a.b -= 1 }'],
    ['memo[k] ??= v', 'const memo = {}\nexport function f(k, v) { memo[k] ??= v }'],
    ['list.push', 'const list = []\nexport function f(v) { list.push(v) }'],
    ['Object.create(null)', 'const d = Object.create(null)\nexport function f(k) { d[k] = 1 }']
  ])('%s is found', (_n, src) => {
    expect(Object.values(kinds(src))).toEqual(['literal'])
  })

  it('a literal only read is not state', () => {
    expect(kinds('const T = { a: 1 }\nexport function f() { return T.a === 1 }')).toEqual({})
  })
})

describe('keyed detection', () => {
  it('every write names the app: detected', () => {
    expect(keyed('const m = new Map()\nexport function f(k) { m.set(appKey(k), 1) }').m).toBe(true)
  })

  it('a Map also handed to a helper is never detected (the helper may write any key)', () => {
    const src =
      'const m = new Map()\nexport function f(k) { m.set(appKey(k), 1); setCapped(m, k, 2) }'
    expect(keyed(src).m).toBe(false)
  })

  it('a Map aliased to another name is never detected', () => {
    const src =
      'const m = new Map()\nexport function f(k) { m.set(appKey(k), 1); const a = m\n a.set(k, 2) }'
    expect(keyed(src).m).toBe(false)
  })

  // Hub phase 6 parked wave (T22 R2-M1): a Map that leaves the module by object shorthand, as an
  // array element or as a return value may be written there with any key.
  it.each([
    ['object shorthand', 'const h = { m }'],
    ['object shorthand, later member', 'const h = { a: 1, m }'],
    ['array element', 'const all = [m]'],
    ['array element, later', 'const all = [n, m]'],
    ['returned', 'return m'],
    ['returned with a semicolon', 'return m;'],
    ['returned with a fallback', 'return m ?? null']
  ])('a Map handed on by %s is never detected', (_why, leak) => {
    const src = `const m = new Map()\nconst n = 1\nexport function f(k) { m.set(appKey(k), 1) }\nexport function g() { ${leak} }`
    expect(keyed(src).m).toBe(false)
  })

  it.each([
    ['a read returned', 'return m.get(appKey(k))'],
    ['an index read returned', 'return m[0]'],
    ['an optional read returned', 'return m?.size'],
    ['a spread of its keys', 'return [...m.keys()]']
  ])('%s is not handing it on: still detected', (_why, read) => {
    const src = `const m = new Map()\nexport function f(k) { m.set(appKey(k), 1) }\nexport function g(k) { ${read} }`
    expect(keyed(src).m).toBe(true)
  })

  it('dropAppEntries(m) only removes: still detected', () => {
    const src =
      'const m = new Map()\nexport function f(k) { m.set(appKey(k), 1) }\nexport function g() { dropAppEntries(m) }'
    expect(keyed(src).m).toBe(true)
  })
})

// Final review (rest) I-1: a keyed Map registered with registerAppKeyed (app-forget.ts) is still a
// finding, still checked for its keys, and marked as forgotten when its app leaves.
describe('registered for forgetAppState', () => {
  const forgets = (src: string) =>
    Object.fromEntries(scanStateFile('services/x.ts', src).map((f) => [f.name, f.forgets]))

  it('registerAppKeyed(new Map()) is a Map, detected keyed, and forgets', () => {
    const src =
      'const m = registerAppKeyed(new Map<string, number>())\nexport function f(k) { m.set(appKey(k), 1) }'
    expect(kinds(src)).toEqual({ m: 'Map' })
    expect(keyed(src).m).toBe(true)
    expect(forgets(src).m).toBe(true)
  })

  it('a registered Map whose writes do not name the app is still not keyed', () => {
    const src = 'const m = registerAppKeyed(new Map())\nexport function f(k) { m.set(k, 1) }'
    expect(keyed(src).m).toBe(false)
  })

  it('an unregistered keyed Map does not forget (a separate forgetApp store is not that Map)', () => {
    const plain = 'const m = new Map()\nexport function f(k) { m.set(appKey(k), 1) }'
    expect(forgets(plain).m).toBe(false)
    expect(forgets(`${plain}\nregisterAppKeyed({ forgetApp: (a) => dropFor(m, a) })`).m).toBe(false)
  })

  it('a class instance registered (RelationCache shape) forgets', () => {
    const src =
      'const c = registerAppKeyed(new RelationCache())\nexport function f() { c.set("a", 1) }'
    expect(forgets(src).c).toBe(true)
  })
})
