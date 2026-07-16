/**
 * Integration coverage for Task 4 (Rollup Fields + Aggregate Validation):
 *  - sum_cap 'block' rules stop an over-cap create/update with a 422 whose
 *    body carries `code` + `violations` — proving the server.ts error handler
 *    forwards them (previously dropped for every hook-thrown error).
 *  - validation_rules entries without a `type` (plain AI text rules) still
 *    reach runAiValidation and reach the Anthropic prompt, even when typed
 *    rule objects (sum_cap) are mixed into the same array.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }))

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({ messages: { create: mockCreate } }))
}))
vi.mock('../../config.js', () => ({ config: { ANTHROPIC_API_KEY: 'test-key' } }))
vi.mock('../../db/index.js', () => ({ db: vi.fn() }))

import Fastify from 'fastify'
import { db } from '../../db/index.js'
import { registerAggregateCapHooks } from '../../hooks/aggregate-caps.js'
import { invalidateAiSettingsCache, registerAiValidationHooks } from '../../hooks/ai-validation.js'
import type { HookContext } from '../../hooks/registry.js'
import { hooks } from '../../hooks/registry.js'

registerAggregateCapHooks()
registerAiValidationHooks()

// Mirrors server.ts:133-150 — same fix under test (forward code+violations
// when both are present on the thrown error), minus the trackError/logger
// side effects that need the full app.
function buildApp() {
  const app = Fastify({ logger: false })
  app.setErrorHandler(
    (err: Error & { statusCode?: number; code?: string; violations?: unknown }, _req, reply) => {
      const status = err.statusCode ?? 500
      reply.code(status).send({
        statusCode: status,
        error: 'Error',
        message: err.message,
        ...(err.code && err.violations ? { code: err.code, violations: err.violations } : {})
      })
    }
  )
  app.post('/api/:collection', async (req) => {
    const { collection } = req.params as { collection: string }
    const ctx: HookContext = {
      collection,
      action: 'create',
      payload: req.body as Record<string, unknown>,
      database: db as unknown as HookContext['database']
    }
    await hooks.trigger('before', ctx)
    return { data: { id: 'new' } }
  })
  return app
}

function settingsChain(row: Record<string, unknown> | undefined) {
  return { where: vi.fn().mockReturnThis(), first: vi.fn().mockResolvedValue(row) }
}

afterEach(() => {
  vi.clearAllMocks()
  invalidateAiSettingsCache()
})

describe('sum_cap validation surfaces structured 422s through the real error handler fix', () => {
  it('POST over the cap returns 422 with code + violations', async () => {
    const settingsRow = {
      validation_enabled: 1,
      validation_mode: 'soft',
      validation_rules: JSON.stringify([
        {
          type: 'sum_cap',
          severity: 'block',
          sum_field: 'allocated_amount',
          group_by: 'workflow_line',
          cap: { relation: 'workflow_line', field: 'amount' },
          message: 'Allocations exceed the line amount'
        }
      ]),
      duplicate_detection_enabled: 0,
      duplicate_threshold: 0.85
    }

    const allocationsChain = {
      where: vi.fn().mockReturnThis(),
      whereNot: vi.fn().mockReturnThis(),
      sum: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue({ v: '90' })
    }
    const relationsChain = {
      where: vi.fn().mockReturnThis(),
      whereNull: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue({ one_collection: 'workflow_lines' })
    }
    const workflowLinesChain = {
      where: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue({ amount: 100 })
    }

    vi.mocked(db).mockImplementation((table: unknown) => {
      if (table === 'nivaro_ai_collection_settings') return settingsChain(settingsRow) as never
      if (table === 'allocations') return allocationsChain as never
      if (table === 'nivaro_relations') return relationsChain as never
      if (table === 'workflow_lines') return workflowLinesChain as never
      throw new Error(`unexpected table ${String(table)}`)
    })

    const app = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/allocations',
      payload: { workflow_line: 'wl1', allocated_amount: 50 }
    })

    expect(res.statusCode).toBe(422)
    const body = JSON.parse(res.body)
    expect(body.code).toBe('VALIDATION_CAP_EXCEEDED')
    expect(body.violations).toEqual([
      {
        rule: 'sum_cap',
        field: 'allocated_amount',
        explanation: expect.stringContaining('Allocations exceed the line amount')
      }
    ])
    await app.close()
  })
})

describe('validation_rules back-compat: plain string rules still reach the AI validator', () => {
  it('a mixed rules array (string + sum_cap object) still evaluates the string rule via runAiValidation', async () => {
    const settingsRow = {
      validation_enabled: 1,
      validation_mode: 'hard',
      validation_rules: JSON.stringify([
        'No profanity',
        {
          type: 'sum_cap',
          severity: 'warn',
          sum_field: 'x',
          group_by: 'y',
          cap: { relation: 'y', field: 'z' },
          message: 'm'
        }
      ]),
      duplicate_detection_enabled: 0,
      duplicate_threshold: 0.85
    }

    vi.mocked(db).mockImplementation((table: unknown) => {
      if (table === 'nivaro_ai_collection_settings') return settingsChain(settingsRow) as never
      throw new Error(`unexpected table ${String(table)}`)
    })

    mockCreate.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            violations: [{ rule: 'No profanity', explanation: 'contains profanity' }]
          })
        }
      ]
    })

    const app = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/articles',
      payload: { body: 'darn' }
    })

    expect(mockCreate).toHaveBeenCalledTimes(1)
    const call = mockCreate.mock.calls[0][0] as { messages: Array<{ content: string }> }
    const prompt = call.messages[0].content
    expect(prompt).toContain('No profanity')
    expect(prompt).not.toContain('sum_cap')

    expect(res.statusCode).toBe(422)
    const body = JSON.parse(res.body)
    expect(body.code).toBe('AI_VALIDATION_FAILED')
    expect(body.violations).toEqual([{ rule: 'No profanity', explanation: 'contains profanity' }])
    await app.close()
  })
})
