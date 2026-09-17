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
const noLinks = async () => ({ m2o: [], aliases: [] })
const workflowLinks = async (c: string) =>
  c === 'workflows'
    ? { m2o: [{ field: 'vendor', collection: 'vendors' }], aliases: [] }
    : { m2o: [], aliases: [] }

describe('compileChatFilter', () => {
  it('compiles flat operator filters into path conditions', async () => {
    const out = await compileChatFilter(
      'workflows',
      { name: { _contains: 'x' }, amount: { _gt: 5 } },
      valid,
      planOk,
      noLinks
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

  it('THROWS on a text operator against a link column (an id never contains a name)', async () => {
    const v = new Set([...valid, 'vendor'])
    await expect(
      compileChatFilter('workflows', { vendor: { _contains: 'insight' } }, v, planOk, workflowLinks)
    ).rejects.toThrow(/"vendor" is a link to vendors/)
    // Through the link is fine — that is the fix the error points at.
    expect(
      await compileChatFilter(
        'workflows',
        { 'vendor.name': { _contains: 'insight' } },
        v,
        planOk,
        workflowLinks
      )
    ).toEqual([{ path: ['vendor', 'name'], op: '_contains', value: 'insight' }])
  })

  it('rejects a non-object filter and returns nothing for null', async () => {
    expect(await compileChatFilter('workflows', null, valid, planOk)).toEqual([])
    await expect(compileChatFilter('workflows', 'x', valid, planOk)).rejects.toThrow(
      /filter must be an object/
    )
  })
})

describe('buildWrapUpMessages', () => {
  it('folds the tool history into one plain user turn with no tool blocks', async () => {
    const { buildWrapUpMessages } = await import('../../../services/ai-chat.js')
    const convo = [
      { role: 'user' as const, content: 'How many apples?' },
      {
        role: 'assistant' as const,
        content: [{ type: 'tool_use', id: 't1', name: 'count', input: { what: 'apples' } }]
      },
      {
        role: 'user' as const,
        content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"count":7}' }]
      }
    ] as never
    const out = buildWrapUpMessages(convo)
    expect(out).toHaveLength(1)
    expect(out[0].role).toBe('user')
    const text = out[0].content as string
    expect(text.startsWith('How many apples?')).toBe(true)
    expect(text).toContain('Tool call count({"what":"apples"})')
    expect(text).toContain('Result: {"count":7}')
    expect(text).toContain('Answer now')
    expect(JSON.stringify(out)).not.toContain('tool_use')
  })

  it('truncates long results and the whole transcript', async () => {
    const { buildWrapUpMessages } = await import('../../../services/ai-chat.js')
    const big = 'x'.repeat(10_000)
    const convo = [
      { role: 'user' as const, content: 'q' },
      {
        role: 'assistant' as const,
        content: [{ type: 'tool_use', id: 't', name: 'a', input: {} }]
      },
      { role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 't', content: big }] }
    ] as never
    const text = buildWrapUpMessages(convo, { perResult: 100, total: 500 })[0].content as string
    expect(text).toContain('… (truncated)')
    expect(text.length).toBeLessThan(900)
  })
})
