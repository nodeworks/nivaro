import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../services/collections.js', () => ({ getCollection: vi.fn(async () => undefined) }))
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { evaluateTransitionRequirements } from '../../../services/transition-requirements.js'

afterEach(() => vi.restoreAllMocks())

function makeLogger() {
  return { warn: vi.fn() }
}

describe('evaluateTransitionRequirements — read-time identifier re-validation', () => {
  it('skips a hand-edited malicious child_fields entry without ever touching the database', async () => {
    const dbMock = vi.fn(() => {
      throw new Error('database should never be queried for a malformed entry')
    })
    const logger = makeLogger()

    const requirements = JSON.stringify([
      {
        type: 'child_fields',
        // Hand-edited past the create/PATCH validator — not a valid identifier.
        collection: 'users; DROP TABLE nivaro_users;--',
        fk_field: 'workflow',
        fields: ['req_id']
      }
    ])

    const result = await evaluateTransitionRequirements(
      dbMock as unknown as Parameters<typeof evaluateTransitionRequirements>[0],
      requirements,
      'item-1',
      logger
    )

    expect(result).toBeNull()
    expect(dbMock).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ entry: expect.any(Object) }),
      expect.stringContaining('malformed child_fields entry')
    )
  })

  it('skips an entry with an invalid fk_field identifier without touching the database', async () => {
    const dbMock = vi.fn(() => {
      throw new Error('database should never be queried for a malformed entry')
    })
    const logger = makeLogger()

    const requirements = JSON.stringify([
      {
        type: 'child_fields',
        collection: 'workflow_line_items',
        fk_field: '1); DROP TABLE workflow_line_items;--',
        fields: ['req_id']
      }
    ])

    const result = await evaluateTransitionRequirements(
      dbMock as unknown as Parameters<typeof evaluateTransitionRequirements>[0],
      requirements,
      'item-1',
      logger
    )

    expect(result).toBeNull()
    expect(dbMock).not.toHaveBeenCalled()
  })
})

describe('evaluateTransitionRequirements — child-query failure fails open loudly', () => {
  it('logs a warning and treats the requirement as passed when the child-row query throws', async () => {
    const logger = makeLogger()
    const dbMock = vi.fn((table: string) => {
      if (table === 'nivaro_fields') {
        return { where: vi.fn(() => ({ select: vi.fn(() => Promise.resolve([])) })) }
      }
      // Child collection query: where(...).limit(2000).select([...]) — throws to
      // simulate a misconfigured fk_field (column doesn't exist, bad grants, etc).
      return {
        where: vi.fn(() => ({
          limit: vi.fn(() => ({
            select: vi.fn(() => Promise.reject(new Error('column "workflow" does not exist')))
          }))
        }))
      }
    })

    const requirements = JSON.stringify([
      {
        type: 'child_fields',
        collection: 'workflow_line_items',
        fk_field: 'workflow',
        fields: ['req_id']
      }
    ])

    const result = await evaluateTransitionRequirements(
      dbMock as unknown as Parameters<typeof evaluateTransitionRequirements>[0],
      requirements,
      'item-1',
      logger
    )

    expect(result).toBeNull()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'workflow_line_items',
        fkField: 'workflow'
      }),
      expect.stringContaining('child row query failed')
    )
  })

  it('falls back to console.warn (its own logger) when no logger is passed', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dbMock = vi.fn((table: string) => {
      if (table === 'nivaro_fields') {
        return { where: vi.fn(() => ({ select: vi.fn(() => Promise.resolve([])) })) }
      }
      return {
        where: vi.fn(() => ({
          limit: vi.fn(() => ({
            select: vi.fn(() => Promise.reject(new Error('boom')))
          }))
        }))
      }
    })

    const requirements = JSON.stringify([
      {
        type: 'child_fields',
        collection: 'workflow_line_items',
        fk_field: 'workflow',
        fields: ['req_id']
      }
    ])

    const result = await evaluateTransitionRequirements(
      dbMock as unknown as Parameters<typeof evaluateTransitionRequirements>[0],
      requirements,
      'item-1'
    )

    expect(result).toBeNull()
    expect(warnSpy).toHaveBeenCalled()
  })
})
