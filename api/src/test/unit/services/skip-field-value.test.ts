import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { skipFieldValue } from '../../../services/workflow-transitions.js'

const throwingDb = (() => {
  throw new Error('db must not be touched')
}) as never

describe('skipFieldValue', () => {
  it('reads a plain column straight off the row without a query', async () => {
    const v = await skipFieldValue(
      'workflows',
      { workflow_type: 2 },
      'workflow_type',
      '1',
      throwingDb
    )
    expect(v).toBe(2)
  })

  it('answers undefined (never throws) when a relation path cannot be resolved', async () => {
    const v = await skipFieldValue('workflows', { id: 1 }, 'workflow_type.type', '1', throwingDb)
    expect(v).toBeUndefined()
  })
})
