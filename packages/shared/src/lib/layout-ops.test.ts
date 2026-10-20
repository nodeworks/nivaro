import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { applyLayoutOps, type LayoutBundle, type LayoutOp, LayoutOpError } from './layout-ops'

// The golden cases are shared with the API twin (api/src/services/layout-ops-apply.ts),
// read by file so both suites prove the same behaviour.
const { cases } = JSON.parse(
  readFileSync(new URL('./layout-ops.fixtures.json', import.meta.url), 'utf8')
) as {
  cases: Array<{
    name: string
    before: LayoutBundle
    ops: LayoutOp[]
    after?: Omit<LayoutBundle, 'rev'>
    error?: { op_index: number }
  }>
}

describe('applyLayoutOps (golden fixtures)', () => {
  it('has at least 12 cases', () => {
    expect(cases.length).toBeGreaterThanOrEqual(12)
  })

  for (const c of cases) {
    it(c.name, () => {
      const frozen = JSON.stringify(c.before)
      if (c.error) {
        let caught: unknown
        try {
          applyLayoutOps(c.before, c.ops)
        } catch (e) {
          caught = e
        }
        expect(caught).toBeInstanceOf(LayoutOpError)
        expect((caught as LayoutOpError).op_index).toBe(c.error.op_index)
      } else {
        const { rev: _rev, ...result } = applyLayoutOps(c.before, c.ops)
        expect(result).toEqual(c.after)
      }
      // Pure: the input bundle is never mutated.
      expect(JSON.stringify(c.before)).toBe(frozen)
    })
  }
})
