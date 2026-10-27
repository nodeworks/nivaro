import { Parser } from 'expr-eval'
import { describe, expect, it } from 'vitest'

// C3 (security audit 2026-10-27): formulas (write-computed fields, addendum
// and import templates, header summaries) run through expr-eval. 2.0.2 lets a
// formula reach prototypes and call any function value it can name (code
// execution). `expr-eval` now resolves to expr-eval-fork (the upstream fix,
// never published as expr-eval): prototype access and unregistered functions
// throw, while arithmetic, item fields and registered helpers keep working.

// The same options services/items.ts, addendum-render.ts and routes/items.ts use.
function parser() {
  const p = new Parser({
    operators: { logical: true, comparison: true, in: true, concatenate: true }
  })
  p.functions.upper = (s: unknown) => String(s ?? '').toUpperCase()
  return p
}

describe('expr-eval formulas', () => {
  it('still evaluates arithmetic, item fields, comparisons and registered helpers', () => {
    const p = parser()
    const item = { amount: 120, allocated_total: 20, name: 'pump', status: 'open' }
    expect(p.evaluate('item.amount - item.allocated_total', { item } as never)).toBe(100)
    expect(p.evaluate('item.amount > 100 and item.status == "open"', { item } as never)).toBe(true)
    expect(p.evaluate('upper(item.name) || "-1"', { item } as never)).toBe('PUMP-1')
    expect(p.evaluate('round(item.amount / 7)', { item } as never)).toBe(17)
    expect(p.evaluate('item.status in ["open", "held"]', { item } as never)).toBe(true)
  })

  it('refuses prototype access', () => {
    const p = parser()
    const item = { amount: 1 }
    expect(() => p.evaluate('item.__proto__', { item } as never)).toThrow()
    expect(() => p.evaluate('item.constructor', { item } as never)).toThrow()
    expect(() => p.evaluate('item.constructor.constructor', { item } as never)).toThrow()
    expect(() => p.evaluate('__proto__', { item } as never)).toThrow()
  })

  it('refuses to call a function value that is not a registered helper', () => {
    const p = parser()
    let called = false
    const item = {
      run: () => {
        called = true
        return 1
      }
    }
    expect(() => p.evaluate('item.run()', { item } as never)).toThrow()
    expect(called).toBe(false)
  })

  it('cannot build a Function from a formula', () => {
    const p = parser()
    const formula = 'f(x) = x; item.constructor.constructor("return process")()'
    expect(() => p.evaluate(formula, { item: { a: 1 } } as never)).toThrow()
  })
})
