import { describe, expect, it } from 'vitest'
import { evaluateImportLineRules, RULE_SET_KEY } from './evaluateLineRules'

describe('evaluateImportLineRules', () => {
  const client = (updates: Record<string, unknown>[]) => {
    let i = 0
    return {
      request: async <T>(cmd: unknown) => {
        const body = (cmd as { _body?: Record<string, unknown> })._body ?? {}
        expect(Object.keys(body.data as object).some((k) => k.startsWith('__'))).toBe(false)
        return { updates: updates[i++] ?? {} } as T
      }
    }
  }

  it('marks only the keys a rule changed versus the file', async () => {
    const rows = [
      { category: 66, price: '10', __o2m_units: [] },
      { category: 67, price: '1' }
    ]
    const res = await evaluateImportLineRules(
      client([{ price: 1 }, { price: '1' }]),
      'lines',
      [{}],
      {},
      rows
    )
    expect(res.rows[0][RULE_SET_KEY]).toEqual(['price'])
    expect(res.rows[0].price).toBe(1)
    expect(res.rows[0].__o2m_units).toEqual([])
    expect(RULE_SET_KEY in res.rows[1]).toBe(false)
    expect(res.ruleFields).toEqual({ price: 1 })
    expect(res.failed).toBe(false)
  })

  it('degrades a failed evaluate to the file row and reports it', async () => {
    const failing = {
      request: async () => {
        throw new Error('boom')
      }
    }
    const res = await evaluateImportLineRules(failing, 'lines', [{}], {}, [{ a: 1 }])
    expect(res.rows).toEqual([{ a: 1 }])
    expect(res.failed).toBe(true)
  })

  it('is a no-op without rules', async () => {
    const res = await evaluateImportLineRules(client([]), 'lines', [], {}, [{ a: 1 }])
    expect(res.rows).toEqual([{ a: 1 }])
  })
})
