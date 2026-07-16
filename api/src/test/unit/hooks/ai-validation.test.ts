import { afterEach, describe, expect, it, vi } from 'vitest'

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }))

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({ messages: { create: mockCreate } }))
}))
vi.mock('../../../config.js', () => ({ config: { ANTHROPIC_API_KEY: 'test-key' } }))
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { runAiValidation } from '../../../hooks/ai-validation.js'

function textResponse(json: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(json) }] }
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('runAiValidation — typed rule back-compat', () => {
  it('returns [] without calling the model when every rule is a typed object (no string rules)', async () => {
    const rules = [
      {
        type: 'sum_cap',
        severity: 'block',
        sum_field: 'allocated_amount',
        group_by: 'workflow_line',
        cap: { relation: 'workflow_line', field: 'amount' },
        message: 'over cap'
      }
    ]

    const violations = await runAiValidation('allocations', { id: 1 }, rules)

    expect(violations).toEqual([])
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('sends only the free-text string rules to the model, filtering out typed rule objects', async () => {
    mockCreate.mockResolvedValue(textResponse({ violations: [] }))

    const rules: unknown[] = [
      'Content must be professional',
      {
        type: 'sum_cap',
        severity: 'block',
        sum_field: 'allocated_amount',
        group_by: 'workflow_line',
        cap: { relation: 'workflow_line', field: 'amount' },
        message: 'over cap'
      },
      'No profanity'
    ]

    await runAiValidation('articles', { body: 'hello' }, rules)

    expect(mockCreate).toHaveBeenCalledTimes(1)
    const call = mockCreate.mock.calls[0][0] as { messages: Array<{ content: string }> }
    const prompt = call.messages[0].content

    expect(prompt).toContain('Content must be professional')
    expect(prompt).toContain('No profanity')
    expect(prompt).not.toContain('sum_cap')
  })

  it('still reports violations for the string rules the model flags', async () => {
    mockCreate.mockResolvedValue(
      textResponse({ violations: [{ rule: 'No profanity', explanation: 'contains profanity' }] })
    )

    const rules: unknown[] = [
      'No profanity',
      {
        type: 'sum_cap',
        severity: 'warn',
        sum_field: 'x',
        group_by: 'y',
        cap: { relation: 'y', field: 'z' },
        message: 'm'
      }
    ]

    const violations = await runAiValidation('articles', { body: 'darn' }, rules)

    expect(violations).toEqual([{ rule: 'No profanity', explanation: 'contains profanity' }])
  })
})
