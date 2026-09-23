import { describe, expect, it, vi } from 'vitest'

// Same mock set as ai-chat-filter.test.ts — ai-chat.ts imports these five
// modules at the top level, so importing it at all requires them to be
// inert. integration-obligations.js is deliberately left UNMOCKED: the
// dispatcher case dynamically imports the real module, and the first
// describe block below exercises summariseObligationsForAi directly against
// it too.
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

const { db } = await import('../../../db/index.js')
const { can } = await import('../../../services/permissions.js')
const { executeChatTool } = await import('../../../services/ai-chat.js')
const { summariseObligationsForAi, clearObligationKinds, registerObligationKind } = await import(
  '../../../services/integration-obligations.js'
)

// ─── the pure shaper (brief step 1, verbatim) ──────────────────────────────

describe('summariseObligationsForAi', () => {
  it('answers the question the user actually asked — why was X not sent', () => {
    const out = summariseObligationsForAi([
      {
        api: 'Partner',
        kind: 'wf.state',
        outcome: 'skipped',
        reason: 'guard unmet: is_on_hold = true',
        due_at: new Date('2026-09-22T14:02:00Z'),
        trigger: 'transition'
      }
    ])
    expect(out).toEqual([
      {
        api: 'Partner',
        kind: 'wf.state',
        outcome: 'skipped',
        reason: 'guard unmet: is_on_hold = true',
        due_at: '2026-09-22T14:02:00.000Z',
        trigger: 'transition'
      }
    ])
  })

  it('never invents a reason for a send that landed', () => {
    const out = summariseObligationsForAi([
      {
        api: 'Partner',
        kind: 'wf.state',
        outcome: 'sent',
        reason: null,
        due_at: new Date('2026-09-22T14:02:00Z'),
        trigger: 'transition'
      }
    ])
    expect(out[0].reason).toBeNull()
  })

  it('returns an empty list rather than a shape the model must special-case', () => {
    expect(summariseObligationsForAi([])).toEqual([])
  })
})

// ─── the integration_status tool ───────────────────────────────────────────

const user = { id: 'user-1', role: 'role-1' } as never

function mockObligationSelect(rows: unknown[]) {
  const chain = {
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    select: vi.fn().mockResolvedValue(rows)
  }
  chain.where.mockReturnValue(chain)
  chain.orderBy.mockReturnValue(chain)
  chain.limit.mockReturnValue(chain)
  vi.mocked(db).mockReturnValue(chain as unknown as ReturnType<typeof db>)
  return chain
}

describe('integration_status tool', () => {
  it('refuses a nivaro_/directus_ collection before ever checking permission — same guard as every other tool', async () => {
    vi.mocked(can).mockClear()
    await expect(
      executeChatTool(user, 'integration_status', { collection: 'nivaro_users', id: '1' })
    ).rejects.toThrow(/system collections/i)
    expect(can).not.toHaveBeenCalled()
  })

  it('refuses when the caller cannot read the record\'s own collection', async () => {
    vi.mocked(can).mockResolvedValue(false)
    vi.mocked(db).mockClear()
    await expect(
      executeChatTool(user, 'integration_status', { collection: 'workflows', id: '1' })
    ).rejects.toThrow(/read access/i)
    // the permission check happens BEFORE any ledger read
    expect(db).not.toHaveBeenCalled()
  })

  it('requires an id', async () => {
    vi.mocked(can).mockResolvedValue(true)
    await expect(
      executeChatTool(user, 'integration_status', { collection: 'workflows', id: '' })
    ).rejects.toThrow(/id is required/i)
  })

  it('returns the ledger shaped for the model, with the kind label filled in when the kind is registered', async () => {
    clearObligationKinds()
    registerObligationKind({
      api: 'Partner',
      kind: 'wf.state',
      collection: 'workflows',
      label: 'State push',
      expect: async () => []
    })
    vi.mocked(can).mockResolvedValue(true)
    mockObligationSelect([
      {
        api: 'Partner',
        kind: 'wf.state',
        outcome: 'skipped',
        reason: 'guard unmet: is_on_hold = true',
        due_at: new Date('2026-09-22T14:02:00Z'),
        trigger: 'transition'
      }
    ])

    const { result, summary } = await executeChatTool(user, 'integration_status', {
      collection: 'workflows',
      id: '55'
    })

    expect(result).toEqual({
      record: 'workflows/55',
      obligations: [
        {
          api: 'Partner',
          kind: 'wf.state',
          kind_label: 'State push',
          outcome: 'skipped',
          reason: 'guard unmet: is_on_hold = true',
          due_at: '2026-09-22T14:02:00.000Z',
          trigger: 'transition'
        }
      ]
    })
    expect(summary).toBe('1 obligation(s) for workflows/55')
    clearObligationKinds()
  })

  it('falls back to the raw kind when nothing is registered for it — an unregistered or retired kind still reads', async () => {
    clearObligationKinds()
    vi.mocked(can).mockResolvedValue(true)
    mockObligationSelect([
      {
        api: 'Partner',
        kind: 'wf.orphaned',
        outcome: 'sent',
        reason: null,
        due_at: new Date('2026-09-22T14:02:00Z'),
        trigger: 'transition'
      }
    ])

    const { result } = await executeChatTool(user, 'integration_status', {
      collection: 'workflows',
      id: '9'
    })

    expect((result as { obligations: Array<{ kind_label: string }> }).obligations[0].kind_label).toBe(
      'wf.orphaned'
    )
  })

  it('returns an empty obligations list rather than throwing when nothing is on the ledger', async () => {
    vi.mocked(can).mockResolvedValue(true)
    mockObligationSelect([])

    const { result, summary } = await executeChatTool(user, 'integration_status', {
      collection: 'workflows',
      id: '1'
    })

    expect(result).toEqual({ record: 'workflows/1', obligations: [] })
    expect(summary).toBe('No obligations recorded for workflows/1')
  })
})
