import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/items.js', () => ({
  ForbiddenError: class extends Error {},
  applyConditions: vi.fn(),
  planConditionPath: vi.fn(),
  readItems: vi.fn()
}))
vi.mock('../../../services/permissions.js', () => ({ can: vi.fn(), getRowFilter: vi.fn() }))
vi.mock('../../../services/embeddings.js', () => ({
  embedText: vi.fn(),
  searchEmbeddings: vi.fn()
}))

const { compileChatFilter } = await import('../../../services/ai-chat.js')

const valid = new Set(['id', 'name', 'workflow_state', 'project', 'amount'])
const planOk = async () => ({ hops: [] })
const planNull = async () => null

describe('compileChatFilter', () => {
  it('compiles flat operator filters into path conditions', async () => {
    const out = await compileChatFilter(
      'workflows',
      { name: { _contains: 'x' }, amount: { _gt: 5 } },
      valid,
      planOk
    )
    expect(out).toEqual([
      { path: ['name'], op: '_contains', value: 'x' },
      { path: ['amount'], op: '_gt', value: 5 }
    ])
  })

  it('reads nested objects and dotted keys as relation paths', async () => {
    const out = await compileChatFilter(
      'workflows',
      {
        workflow_state: { name: { _eq: 'started' } },
        'project.project_type.name': { _eq: 'CMTS' }
      },
      valid,
      planOk
    )
    expect(out).toEqual([
      { path: ['workflow_state', 'name'], op: '_eq', value: 'started' },
      { path: ['project', 'project_type', 'name'], op: '_eq', value: 'CMTS' }
    ])
  })

  it('maps $state to the pipeline-state virtual path', async () => {
    expect(
      await compileChatFilter(
        'workflows',
        { $state: { _in: ['started', 'completed'] } },
        valid,
        planOk
      )
    ).toEqual([{ path: ['$state'], op: '_in', value: ['started', 'completed'] }])
    expect(
      await compileChatFilter('workflows', { $state: { _eq: 'started' } }, valid, planOk)
    ).toEqual([{ path: ['$state'], op: '_in', value: ['started'] }])
  })

  it('treats a bare value as equality', async () => {
    expect(await compileChatFilter('workflows', { name: 'abc' }, valid, planOk)).toEqual([
      { path: ['name'], op: '_eq', value: 'abc' }
    ])
  })

  it('THROWS on an unknown field instead of dropping it', async () => {
    await expect(
      compileChatFilter('workflows', { state: { _eq: 'started' } }, valid, planOk)
    ).rejects.toThrow(/Unknown field "state" on workflows/)
  })

  it('throws on an unknown operator and on an unplannable path', async () => {
    await expect(
      compileChatFilter('workflows', { name: { _like: 'x' } }, valid, planOk)
    ).rejects.toThrow(/Unknown filter operator "_like"/)
    await expect(
      compileChatFilter('workflows', { project: { nope: { _eq: 1 } } }, valid, planNull)
    ).rejects.toThrow(/Cannot filter workflows on path "project.nope"/)
  })

  it('rejects a non-object filter and returns nothing for null', async () => {
    expect(await compileChatFilter('workflows', null, valid, planOk)).toEqual([])
    await expect(compileChatFilter('workflows', 'x', valid, planOk)).rejects.toThrow(
      /filter must be an object/
    )
  })
})
