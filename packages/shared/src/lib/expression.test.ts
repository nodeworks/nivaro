import { describe, expect, it } from 'vitest'
import {
  evaluateBoolean,
  evaluateExpression,
  evaluateNumeric,
  extractExpressionTokens,
  parseExpression,
  readPath,
  validateExpression
} from './expression.js'

describe('parseExpression', () => {
  it('parses arithmetic with correct precedence', () => {
    expect(evaluateNumeric('2 + 3 * 4', {})).toBe(14)
    expect(evaluateNumeric('(2 + 3) * 4', {})).toBe(20)
    expect(evaluateNumeric('-3 + 10', {})).toBe(7)
  })

  it('accepts both token syntaxes the old dialects used', () => {
    const row = { amount: 100, qty: 3 }
    expect(evaluateNumeric('{{amount}} / {{qty}}', row)).toBeCloseTo(33.333, 2)
    expect(evaluateNumeric('item.amount - 40', row)).toBe(60)
  })

  it('reads dotted and indexed paths', () => {
    const row = { line: { amount: 250 }, years: [{ id: 2026 }] }
    expect(evaluateNumeric('{{line.amount}}', row)).toBe(250)
    expect(evaluateNumeric('{{years[0].id}}', row)).toBe(2026)
  })

  it('reports where a malformed expression breaks', () => {
    const r = parseExpression('{{a}} + ')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatch(/ended unexpectedly/)
      expect(r.position).toBe(8)
    }
  })

  it('names the = for == mistake specifically', () => {
    const r = parseExpression('{{a}} = 5')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/Use == /)
  })

  it('rejects an unclosed token instead of silently reading past it', () => {
    const r = parseExpression('{{amount')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/Unclosed/)
  })

  it('rejects trailing junk rather than evaluating the prefix', () => {
    // The old sanitizer-regex dialects accepted whatever matched and dropped
    // the rest, so a typo could silently change the sum.
    expect(parseExpression('1 + 2 )').ok).toBe(false)
  })
})

describe('token values cannot change expression shape', () => {
  it('a negative value does not become a subtraction', () => {
    // The substitute-then-parse dialects turned `{{a}} - {{b}}` with b = -5
    // into `10 - -5`, which happened to work, but `{{a}}{{b}}`-adjacent cases
    // and string values corrupted outright. Values are now data, never syntax.
    expect(evaluateNumeric('{{a}} - {{b}}', { a: 10, b: -5 })).toBe(15)
  })

  it('a string value that looks like an operator is not executed', () => {
    expect(evaluateNumeric('{{a}} + 1', { a: '2 * 100' })).toBe(1)
  })

  it('a numeric string still behaves as a number', () => {
    expect(evaluateNumeric('{{a}} + 1', { a: '41' })).toBe(42)
  })
})

describe('missing-value semantics', () => {
  const row = { amount: 100, allocated_total: null }

  it("defaults to zero, preserving every existing formula's behaviour", () => {
    expect(evaluateNumeric('{{amount}} - {{allocated_total}}', row)).toBe(100)
    expect(evaluateNumeric('{{amount}} - {{never_existed}}', row)).toBe(100)
  })

  it('propagates null when asked to', () => {
    expect(evaluateNumeric('{{amount}} - {{allocated_total}}', row, { missing: 'null' })).toBeNull()
  })

  it('never invents arithmetic from a relation object or array', () => {
    // Number([]) is 0, which is how the old dialects silently summed relations.
    expect(evaluateNumeric('{{rel}} + 5', { rel: [] }, { missing: 'null' })).toBeNull()
    expect(evaluateNumeric('{{rel}} + 5', { rel: { id: 1 } }, { missing: 'null' })).toBeNull()
  })

  it('returns null for division by zero rather than Infinity', () => {
    expect(evaluateNumeric('{{a}} / {{b}}', { a: 5, b: 0 })).toBeNull()
  })
})

describe('comparisons and guards', () => {
  it('evaluates comparisons directly — no operator string-splitting needed', () => {
    // The allocate-drawer guard used to be split on a regex and each half
    // evaluated separately because the evaluator could not do comparisons.
    expect(evaluateBoolean('{{amount}} >= {{agg}}', { amount: 100, agg: 40 })).toBe(true)
    expect(evaluateBoolean('{{amount}} >= {{agg}}', { amount: 10, agg: 40 })).toBe(false)
  })

  it('supports and/or with short-circuit', () => {
    expect(evaluateBoolean('{{a}} > 0 && {{b}} > 0', { a: 1, b: 1 })).toBe(true)
    expect(evaluateBoolean('{{a}} > 0 && {{b}} > 0', { a: 0, b: 1 })).toBe(false)
    expect(evaluateBoolean('{{a}} > 0 || {{b}} > 0', { a: 0, b: 1 })).toBe(true)
  })

  it('compares against null and strings', () => {
    expect(evaluateBoolean('{{state}} == "approved"', { state: 'approved' })).toBe(true)
    expect(evaluateBoolean('{{state}} != null', { state: null })).toBe(false)
    expect(evaluateBoolean('{{state}} == null', { state: '' })).toBe(true)
  })

  it('is false — never a coerced zero — when ordering a non-number', () => {
    expect(evaluateBoolean('{{name}} > 5', { name: 'abc' })).toBe(false)
    expect(evaluateBoolean('{{name}} < 5', { name: 'abc' })).toBe(false)
  })

  it('negates with !', () => {
    expect(evaluateBoolean('!({{a}} > 5)', { a: 1 })).toBe(true)
  })
})

describe('readPath', () => {
  it('prefers a literal dotted key over traversal', () => {
    // resolve-paths stores results flat under the dotted path itself.
    expect(readPath({ 'a.b': 7, a: { b: 9 } }, 'a.b')).toBe(7)
  })

  it('traverses when there is no literal key', () => {
    expect(readPath({ a: { b: 9 } }, 'a.b')).toBe(9)
  })

  it('returns undefined rather than throwing on a broken path', () => {
    expect(readPath({ a: null }, 'a.b.c')).toBeUndefined()
    expect(readPath({}, 'x[2].y')).toBeUndefined()
  })
})

describe('validateExpression', () => {
  it('accepts a good expression and lists its fields', () => {
    const r = validateExpression('{{amount}} - {{line.total}}')
    expect(r.ok).toBe(true)
    expect(r.tokens).toEqual(['amount', 'line.total'])
  })

  it('flags fields that do not exist on the collection', () => {
    const r = validateExpression('{{amount}} - {{typo_field}}', ['amount', 'quantity'])
    expect(r.ok).toBe(true)
    expect(r.unknownTokens).toEqual(['typo_field'])
  })

  it('accepts a dotted path whose first segment is known', () => {
    const r = validateExpression('{{line.total}}', ['line'])
    expect(r.unknownTokens).toEqual([])
  })

  it('reports an empty expression', () => {
    expect(validateExpression('   ').ok).toBe(false)
  })

  it('surfaces the parse error and position for the editor caret', () => {
    const r = validateExpression('{{a}} ** 2')
    expect(r.ok).toBe(false)
    expect(typeof r.position).toBe('number')
  })
})

describe('extractExpressionTokens', () => {
  it('lists fields without evaluating', () => {
    expect(extractExpressionTokens('{{a}} + {{b.c}} * {{a}}')).toEqual(['a', 'b.c'])
  })

  it('returns nothing for an unparseable expression', () => {
    expect(extractExpressionTokens('{{a}} +')).toEqual([])
  })
})

describe('reserved call-site tokens', () => {
  it('treats __agg__ / __input__ / __saved__ as ordinary fields', () => {
    expect(evaluateNumeric('{{quantity}} - {{__agg__}}', { quantity: 10, __agg__: 4 })).toBe(6)
    expect(
      evaluateNumeric('{{allocated_total}} - {{__saved__}} + {{__input__}}', {
        allocated_total: 100,
        __saved__: 20,
        __input__: 35
      })
    ).toBe(115)
  })
})

describe('expression results are values, not exceptions', () => {
  it('returns null for a parse failure instead of throwing', () => {
    expect(evaluateExpression('((', {})).toBeNull()
    expect(evaluateNumeric('((', {})).toBeNull()
    expect(evaluateBoolean('((', {})).toBe(false)
  })
})

describe('function-call syntax (server-side expr-eval formulas)', () => {
  it('accepts a call as valid syntax rather than reporting a false error', () => {
    // write-computed fields are evaluated server-side by expr-eval, which has
    // functions this engine does not. Flagging them as syntax errors in the
    // editor would be worse than declining to preview them.
    const r = validateExpression('concat(item.first_name, " ", item.last_name)')
    expect(r.ok).toBe(true)
    expect(r.tokens).toEqual(['first_name', 'last_name'])
  })

  it('declines to evaluate a call rather than throwing', () => {
    expect(evaluateExpression('concat(item.a, item.b)', { a: 'x', b: 'y' })).toBeNull()
  })

  it('still reports a genuinely broken call', () => {
    expect(validateExpression('concat(item.a,').ok).toBe(false)
  })

  it('handles a call nested in arithmetic', () => {
    const r = validateExpression('round({{amount}}) + 1')
    expect(r.ok).toBe(true)
    expect(r.tokens).toEqual(['amount'])
  })

  it('accepts a zero-argument call', () => {
    expect(validateExpression('now()').ok).toBe(true)
  })
})
