import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/embeddings.js', async () => {
  const actual = await vi.importActual<typeof import('../../../services/embeddings.js')>(
    '../../../services/embeddings.js'
  )
  return { ...actual, embedText: vi.fn() }
})

const { formatPlaybooksForPrompt, normalizeQuestion, planFromTrace, rankPlaybooks } = await import(
  '../../../services/ai-playbooks.js'
)

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

describe('formatPlaybooksForPrompt', () => {
  it('is empty with no playbooks and lists question, plan and answer otherwise', () => {
    expect(formatPlaybooksForPrompt([])).toBe('')
    const text = formatPlaybooksForPrompt([pb(7, [1])])
    expect(text).toContain('Q: q7')
    expect(text).toContain('aggregate({"collection":"workflows"})')
    expect(text).toContain('Answer given: a7')
  })
})

describe('normalizeQuestion', () => {
  it('collapses whitespace and case', () => {
    expect(normalizeQuestion('  How MANY   workflows? ')).toBe('how many workflows?')
  })
})
