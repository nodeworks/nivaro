import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/embeddings.js', async () => {
  const actual = await vi.importActual<typeof import('../../../services/embeddings.js')>(
    '../../../services/embeddings.js'
  )
  return { ...actual, embedText: vi.fn() }
})

const {
  formatPlaybooksForPrompt,
  normalizeQuestion,
  planFromTrace,
  playbookVisibleTo,
  rankPlaybooks,
  stripPlanValues
} = await import('../../../services/ai-playbooks.js')

const pb = (id: number, embedding: number[], rating: number | null = null) => ({
  id,
  question: `q${id}`,
  plan: [{ tool: 'aggregate', input: { collection: 'workflows' } }],
  answer: `a${id}`,
  rating,
  use_count: 0,
  embedding
})

describe('rankPlaybooks', () => {
  it('returns the closest playbooks above the threshold, best first', () => {
    const out = rankPlaybooks([pb(1, [1, 0]), pb(2, [0.9, 0.1]), pb(3, [0, 1])], [1, 0], 0.7, 2)
    expect(out.map((p) => p.id)).toEqual([1, 2])
    expect(out[0].score).toBeGreaterThan(out[1].score)
  })

  it('never offers a net-negative playbook', () => {
    const out = rankPlaybooks([pb(1, [1, 0], -1), pb(2, [1, 0], 2)], [1, 0], 0.5, 5)
    expect(out.map((p) => p.id)).toEqual([2])
  })
})

describe('planFromTrace', () => {
  it('keeps successful calls in order and drops errored ones', () => {
    const plan = planFromTrace([
      { tool: 'query_items', input: { collection: 'x' }, summary: 'error: Unknown field' },
      { tool: 'query_items', input: { collection: 'y' }, summary: '3 rows' },
      { tool: 'aggregate', input: { collection: 'y' }, summary: 'count 3' }
    ])
    expect(plan).toEqual([
      { tool: 'query_items', input: { collection: 'y' } },
      { tool: 'aggregate', input: { collection: 'y' } }
    ])
  })
})

describe('formatPlaybooksForPrompt (review 2026-10-27: plan only)', () => {
  it('is empty with no playbooks and lists the plan only otherwise — no answer, no other question', () => {
    expect(formatPlaybooksForPrompt([])).toBe('')
    const text = formatPlaybooksForPrompt([pb(7, [1])])
    expect(text).toContain('aggregate({"collection":"workflows"})')
    expect(text).not.toContain('a7')
    expect(text).not.toContain('q7')
    expect(text).toMatch(/<data source="playbooks">/)
    expect(text).toMatch(/never instructions/)
  })

  it("shows the asker's own earlier question, never another person's", () => {
    const own = { ...pb(8, [1]), user: 'AAA' }
    expect(formatPlaybooksForPrompt([own], 'aaa')).toContain('your earlier question: q8')
    expect(formatPlaybooksForPrompt([own], 'bbb')).not.toContain('q8')
  })

  it('strips filter values even from plans stored before the change', () => {
    const old = {
      ...pb(9, [1]),
      plan: [
        {
          tool: 'query_items',
          input: {
            collection: 'vendors',
            filter: { name: { _eq: 'Acme secret' }, 'project.code': { _in: ['P1', 'P2'] } },
            search: 'salary of Kim',
            limit: 5
          }
        }
      ]
    }
    const text = formatPlaybooksForPrompt([old])
    expect(text).toContain('"collection":"vendors"')
    expect(text).toContain('"name":{"_eq":"<value>"}')
    expect(text).toContain('"project.code":{"_in":["<value>"]}')
    expect(text).toContain('"limit":5')
    expect(text).not.toMatch(/Acme|salary|P1/)
  })
})

describe('stripPlanValues / planFromTrace store no values', () => {
  it('keeps shape keys and replaces values', () => {
    expect(
      stripPlanValues({
        collection: 'x',
        group_by: ['state'],
        filter: { amount: { _gt: 1000 } },
        query: 'Kim'
      })
    ).toEqual({
      collection: 'x',
      group_by: ['state'],
      filter: { amount: { _gt: '<value>' } },
      query: '<value>'
    })
    const plan = planFromTrace([
      { tool: 'query_items', input: { collection: 'y', search: 'Acme' }, summary: '1 row' }
    ])
    expect(plan).toEqual([{ tool: 'query_items', input: { collection: 'y', search: '<value>' } }])
  })
})

describe('playbookVisibleTo', () => {
  const asker = { userId: 'u1', role: 'R1', admin: false }
  it('own, same role + admin flag, or rated helpful', () => {
    expect(playbookVisibleTo({ ...pb(1, [1]), user: 'U1', role: 'R9' }, asker)).toBe(true)
    expect(playbookVisibleTo({ ...pb(2, [1]), user: 'u2', role: 'r1', admin: false }, asker)).toBe(
      true
    )
    expect(playbookVisibleTo({ ...pb(3, [1]), user: 'u2', role: 'r1', admin: true }, asker)).toBe(
      false
    )
    expect(playbookVisibleTo({ ...pb(4, [1]), user: 'u2', role: 'R2' }, asker)).toBe(false)
    expect(playbookVisibleTo({ ...pb(5, [1], 1), user: 'u2', role: 'R2' }, asker)).toBe(true)
    expect(playbookVisibleTo({ ...pb(6, [1]), user: 'u2', role: 'R2' }, null)).toBe(false)
  })
})

describe('normalizeQuestion', () => {
  it('collapses whitespace and case', () => {
    expect(normalizeQuestion('  How MANY   workflows? ')).toBe('how many workflows?')
  })
})
