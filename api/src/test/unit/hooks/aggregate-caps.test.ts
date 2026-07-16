import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../hooks/ai-validation.js', () => ({ getAiCollectionSettings: vi.fn() }))

import { db } from '../../../db/index.js'
import {
  CapValidationError,
  evaluateSumCapRule,
  isSumCapRule,
  registerAggregateCapHooks,
  type SumCapRule
} from '../../../hooks/aggregate-caps.js'
import { getAiCollectionSettings } from '../../../hooks/ai-validation.js'
import type { HookContext } from '../../../hooks/registry.js'
import { hooks } from '../../../hooks/registry.js'

function rule(overrides: Partial<SumCapRule> = {}): SumCapRule {
  return {
    type: 'sum_cap',
    severity: 'block',
    sum_field: 'allocated_amount',
    group_by: 'workflow_line',
    cap: { relation: 'workflow_line', field: 'amount' },
    message: 'Allocations exceed the line amount',
    ...overrides
  }
}

function ctx(overrides: Partial<HookContext> = {}): HookContext {
  return {
    collection: 'allocations',
    action: 'create',
    payload: {},
    user: { id: 'u1' } as HookContext['user'],
    database: db as unknown as HookContext['database'],
    ...overrides
  }
}

// Chain for the child collection: covers both the current-row fetch
// (`.where({id}).first()`) and the sum aggregate (`.where(f, v).whereNot({id}).sum(...).first()`).
// `firstResults` is consumed in call order — first() call #1, #2, ... — so tests
// must supply exactly as many entries as `.first()` calls happen for that scenario.
function collectionChain(firstResults: unknown[]) {
  const whereArgs: unknown[][] = []
  const whereNotIds: unknown[] = []
  const first = vi.fn()
  for (const r of firstResults) first.mockReturnValueOnce(Promise.resolve(r))
  const chain = {
    where: vi.fn((...args: unknown[]) => {
      whereArgs.push(args)
      return chain
    }),
    whereNot: vi.fn((cond: Record<string, unknown>) => {
      whereNotIds.push(cond.id)
      return chain
    }),
    sum: vi.fn(() => chain),
    select: vi.fn(() => chain),
    first
  }
  return { chain, whereArgs, whereNotIds }
}

// Chain for a lookup table hit exactly once: nivaro_relations or the parent collection.
function onceChain(result: unknown) {
  const chain = {
    where: vi.fn(() => chain),
    whereNull: vi.fn(() => chain),
    select: vi.fn(() => chain),
    first: vi.fn().mockResolvedValue(result)
  }
  return chain
}

afterEach(() => {
  vi.clearAllMocks()
})

// Registered once for the whole file — the registry has no reset hook, so
// registering per-test would accumulate duplicate before-hook entries.
registerAggregateCapHooks()

describe('isSumCapRule', () => {
  it('accepts a well-formed sum_cap rule', () => {
    expect(isSumCapRule(rule())).toBe(true)
  })

  it('rejects entries without type sum_cap, plain strings, and malformed shapes', () => {
    expect(isSumCapRule('Content must be professional')).toBe(false)
    expect(isSumCapRule({ type: 'other' })).toBe(false)
    expect(isSumCapRule({ ...rule(), severity: 'nope' })).toBe(false)
    expect(isSumCapRule({ ...rule(), cap: { relation: '' } })).toBe(false)
    expect(isSumCapRule(null)).toBe(false)
  })
})

describe('evaluateSumCapRule', () => {
  it('create: sums existing rows plus the incoming payload value, no self-exclusion', async () => {
    const { chain, whereArgs, whereNotIds } = collectionChain([{ v: '40' }])
    const relChain = onceChain({ one_collection: 'workflow_lines' })
    const parentChain = onceChain({ amount: 100 })

    vi.mocked(db).mockImplementation((table: unknown) => {
      if (table === 'allocations') return chain as never
      if (table === 'nivaro_relations') return relChain as never
      if (table === 'workflow_lines') return parentChain as never
      throw new Error(`unexpected table ${String(table)}`)
    })

    await evaluateSumCapRule(
      rule(),
      ctx({ action: 'create', payload: { workflow_line: 'wl1', allocated_amount: 50 } })
    )

    // 40 (existing) + 50 (incoming) = 90 <= 100 cap: no violation, no throw
    expect(whereArgs[0]).toEqual(['workflow_line', 'wl1'])
    expect(whereNotIds).toEqual([])
  })

  it("update: excludes the row's own stored contribution via whereNot, adds the incoming value", async () => {
    // first() call #1 = current row fetch, #2 = sum aggregate
    const { chain, whereNotIds } = collectionChain([
      { workflow_line: 'wl1', allocated_amount: 20 },
      { v: '40' }
    ])
    const relChain = onceChain({ one_collection: 'workflow_lines' })
    const parentChain = onceChain({ amount: 100 })

    vi.mocked(db).mockImplementation((table: unknown) => {
      if (table === 'allocations') return chain as never
      if (table === 'nivaro_relations') return relChain as never
      if (table === 'workflow_lines') return parentChain as never
      throw new Error(`unexpected table ${String(table)}`)
    })

    await expect(
      evaluateSumCapRule(
        rule(),
        ctx({ action: 'update', keys: ['row1'], payload: { allocated_amount: 90 } })
      )
    ).rejects.toBeInstanceOf(CapValidationError)

    // 40 (other rows) + 90 (incoming) = 130 > 100 cap
    expect(whereNotIds).toEqual(['row1'])
  })

  it("update: payload omitting sum_field falls back to the current row's stored value", async () => {
    const { chain } = collectionChain([{ workflow_line: 'wl1', allocated_amount: 20 }, { v: '40' }])
    const relChain = onceChain({ one_collection: 'workflow_lines' })
    const parentChain = onceChain({ amount: 65 })

    vi.mocked(db).mockImplementation((table: unknown) => {
      if (table === 'allocations') return chain as never
      if (table === 'nivaro_relations') return relChain as never
      if (table === 'workflow_lines') return parentChain as never
      throw new Error(`unexpected table ${String(table)}`)
    })

    // payload omits allocated_amount entirely -> incoming falls back to stored 20
    // 40 + 20 = 60 <= 65: should not throw
    await expect(
      evaluateSumCapRule(rule(), ctx({ action: 'update', keys: ['row1'], payload: {} }))
    ).resolves.toBeUndefined()
  })

  it("update: payload omitting group_by falls back to the current row's group value", async () => {
    const { chain } = collectionChain([
      { workflow_line: 'wl1', allocated_amount: 20 },
      { v: '999' }
    ])
    const relChain = onceChain({ one_collection: 'workflow_lines' })
    const parentChain = onceChain({ amount: 100 })

    vi.mocked(db).mockImplementation((table: unknown) => {
      if (table === 'allocations') return chain as never
      if (table === 'nivaro_relations') return relChain as never
      if (table === 'workflow_lines') return parentChain as never
      throw new Error(`unexpected table ${String(table)}`)
    })

    await expect(
      evaluateSumCapRule(
        rule(),
        ctx({ action: 'update', keys: ['row1'], payload: { allocated_amount: 5 } })
      )
    ).rejects.toBeInstanceOf(CapValidationError)
  })

  it('skips when the resolved group value is null (create, payload omits group_by)', async () => {
    const dbFn = vi.fn()
    vi.mocked(db).mockImplementation(dbFn as never)

    await evaluateSumCapRule(rule(), ctx({ action: 'create', payload: { allocated_amount: 5 } }))

    expect(dbFn).not.toHaveBeenCalled()
  })

  it('treats a null/missing incoming value as 0', async () => {
    const { chain, whereArgs } = collectionChain([{ v: null }])
    const relChain = onceChain({ one_collection: 'workflow_lines' })
    const parentChain = onceChain({ amount: 10 })

    vi.mocked(db).mockImplementation((table: unknown) => {
      if (table === 'allocations') return chain as never
      if (table === 'nivaro_relations') return relChain as never
      if (table === 'workflow_lines') return parentChain as never
      throw new Error(`unexpected table ${String(table)}`)
    })

    // no existing sum (null), no incoming amount in payload -> total 0, cap 10: passes
    await expect(
      evaluateSumCapRule(rule(), ctx({ action: 'create', payload: { workflow_line: 'wl1' } }))
    ).resolves.toBeUndefined()
    expect(whereArgs[0]).toEqual(['workflow_line', 'wl1'])
  })

  it('skips when the M2O relation cannot be resolved (no matching nivaro_relations row)', async () => {
    const { chain } = collectionChain([{ v: '1000' }])
    const relChain = onceChain(undefined)

    vi.mocked(db).mockImplementation((table: unknown) => {
      if (table === 'allocations') return chain as never
      if (table === 'nivaro_relations') return relChain as never
      throw new Error(`unexpected table ${String(table)}`)
    })

    await expect(
      evaluateSumCapRule(
        rule(),
        ctx({ action: 'create', payload: { workflow_line: 'wl1', allocated_amount: 999 } })
      )
    ).resolves.toBeUndefined()
  })

  it('skips when the parent cap value is null', async () => {
    const { chain } = collectionChain([{ v: '1000' }])
    const relChain = onceChain({ one_collection: 'workflow_lines' })
    const parentChain = onceChain({ amount: null })

    vi.mocked(db).mockImplementation((table: unknown) => {
      if (table === 'allocations') return chain as never
      if (table === 'nivaro_relations') return relChain as never
      if (table === 'workflow_lines') return parentChain as never
      throw new Error(`unexpected table ${String(table)}`)
    })

    await expect(
      evaluateSumCapRule(
        rule(),
        ctx({ action: 'create', payload: { workflow_line: 'wl1', allocated_amount: 999 } })
      )
    ).resolves.toBeUndefined()
  })

  it('block severity throws CapValidationError with the violations shape', async () => {
    const { chain } = collectionChain([{ v: '90' }])
    const relChain = onceChain({ one_collection: 'workflow_lines' })
    const parentChain = onceChain({ amount: 100 })

    vi.mocked(db).mockImplementation((table: unknown) => {
      if (table === 'allocations') return chain as never
      if (table === 'nivaro_relations') return relChain as never
      if (table === 'workflow_lines') return parentChain as never
      throw new Error(`unexpected table ${String(table)}`)
    })

    let caught: CapValidationError | undefined
    try {
      await evaluateSumCapRule(
        rule(),
        ctx({ action: 'create', payload: { workflow_line: 'wl1', allocated_amount: 50 } })
      )
    } catch (err) {
      caught = err as CapValidationError
    }

    expect(caught).toBeInstanceOf(CapValidationError)
    expect(caught?.statusCode).toBe(422)
    expect(caught?.code).toBe('VALIDATION_CAP_EXCEEDED')
    expect(caught?.violations).toEqual([
      {
        rule: 'sum_cap',
        field: 'allocated_amount',
        explanation: expect.stringContaining('Allocations exceed the line amount')
      }
    ])
  })

  it('warn severity does not throw', async () => {
    const { chain } = collectionChain([{ v: '90' }])
    const relChain = onceChain({ one_collection: 'workflow_lines' })
    const parentChain = onceChain({ amount: 100 })
    const notifChain = {
      insert: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([{ id: 1 }])
    }

    vi.mocked(db).mockImplementation((table: unknown) => {
      if (table === 'allocations') return chain as never
      if (table === 'nivaro_relations') return relChain as never
      if (table === 'workflow_lines') return parentChain as never
      if (table === 'nivaro_notifications') return notifChain as never
      throw new Error(`unexpected table ${String(table)}`)
    })

    await expect(
      evaluateSumCapRule(
        rule({ severity: 'warn' }),
        ctx({ action: 'create', payload: { workflow_line: 'wl1', allocated_amount: 50 } })
      )
    ).resolves.toBeUndefined()

    expect(notifChain.insert).toHaveBeenCalled()
  })

  it("applies the caller's workspace scope to both the current-row fetch and the SUM query", async () => {
    const collection = 'scoped_allocations_ws'
    const columnInfo = vi.fn().mockResolvedValue({ workspace_id: {} })
    const { chain, whereArgs, whereNotIds } = collectionChain([
      { workflow_line: 'wl1', allocated_amount: 20 },
      { v: '40' }
    ])
    ;(chain as unknown as Record<string, unknown>).columnInfo = columnInfo
    const relChain = onceChain({ one_collection: 'workflow_lines' })
    const parentChain = onceChain({ amount: 100 })

    vi.mocked(db).mockImplementation((table: unknown) => {
      if (table === collection) return chain as never
      if (table === 'nivaro_relations') return relChain as never
      if (table === 'workflow_lines') return parentChain as never
      throw new Error(`unexpected table ${String(table)}`)
    })

    await expect(
      evaluateSumCapRule(
        rule(),
        ctx({
          collection,
          action: 'update',
          keys: ['row1'],
          payload: { allocated_amount: 90 },
          req: { workspaceId: 'ws-other' } as HookContext['req']
        })
      )
    ).rejects.toBeInstanceOf(CapValidationError)

    expect(columnInfo).toHaveBeenCalled()
    // Both the current-row fetch and the sum query got the workspace filter —
    // matching items.ts's updateOne, which scopes both its previousData fetch
    // and its update query the same way.
    expect(whereArgs.filter((args) => args[0] === `${collection}.workspace_id`)).toHaveLength(2)
    expect(whereNotIds).toEqual(['row1'])
  })

  it("skips the rule without throwing when the scoped current-row fetch finds nothing (row invisible under this workspace) — the write path's own 404 check handles it", async () => {
    const collection = 'scoped_allocations_missing'
    const columnInfo = vi.fn().mockResolvedValue({ workspace_id: {} })
    const first = vi.fn().mockResolvedValue(undefined)
    const chain: Record<string, unknown> = {
      where: vi.fn(() => chain),
      whereNot: vi.fn(() => chain),
      sum: vi.fn(() => chain),
      select: vi.fn(() => chain),
      columnInfo,
      first
    }

    vi.mocked(db).mockImplementation((table: unknown) => {
      if (table === collection) return chain as never
      throw new Error(`unexpected table ${String(table)}`)
    })

    await expect(
      evaluateSumCapRule(
        rule(),
        ctx({
          collection,
          action: 'update',
          keys: ['other-workspace-row'],
          payload: { allocated_amount: 999999 },
          req: { workspaceId: 'ws-other' } as HookContext['req']
        })
      )
    ).resolves.toBeUndefined()

    // Only the scoped current-row fetch happened — never reached the sum
    // query, the relation lookup, or the parent cap fetch.
    expect(first).toHaveBeenCalledTimes(1)
  })

  it("skips the rule (NULL-cap path, no throw) when the parent cap row is invisible under the caller's workspace scope", async () => {
    const collection = 'scoped_parent_test_child'
    const parentCollection = 'scoped_parent_test_parent'

    const childChain: Record<string, unknown> = {
      where: vi.fn(() => childChain),
      whereNot: vi.fn(() => childChain),
      sum: vi.fn(() => childChain),
      columnInfo: vi.fn().mockResolvedValue({}), // no workspace_id column on the child here
      first: vi.fn().mockResolvedValue({ v: '10' })
    }
    const relChain = onceChain({ one_collection: parentCollection })
    const parentFirst = vi.fn().mockResolvedValue(undefined) // invisible under this scope
    const parentChain: Record<string, unknown> = {
      where: vi.fn(() => parentChain),
      select: vi.fn(() => parentChain),
      columnInfo: vi.fn().mockResolvedValue({ workspace_id: {} }),
      first: parentFirst
    }

    vi.mocked(db).mockImplementation((table: unknown) => {
      if (table === collection) return childChain as never
      if (table === 'nivaro_relations') return relChain as never
      if (table === parentCollection) return parentChain as never
      throw new Error(`unexpected table ${String(table)}`)
    })

    await expect(
      evaluateSumCapRule(
        rule(),
        ctx({
          collection,
          action: 'create',
          payload: { workflow_line: 'wl-other-workspace', allocated_amount: 5 },
          req: { workspaceId: 'ws-other' } as HookContext['req']
        })
      )
    ).resolves.toBeUndefined()

    expect(parentFirst).toHaveBeenCalledTimes(1)
  })
})

describe('registerAggregateCapHooks', () => {
  it('registers before hooks on create and update that evaluate sum_cap rules and block over-cap writes', async () => {
    vi.mocked(getAiCollectionSettings).mockResolvedValue({
      collection: 'allocations',
      validation_enabled: false,
      validation_mode: 'soft',
      validation_rules: [rule(), 'a plain AI rule, ignored here'],
      duplicate_detection_enabled: false,
      duplicate_threshold: 0.85
    } as never)

    const { chain } = collectionChain([{ v: '90' }])
    const relChain = onceChain({ one_collection: 'workflow_lines' })
    const parentChain = onceChain({ amount: 100 })

    vi.mocked(db).mockImplementation((table: unknown) => {
      if (table === 'allocations') return chain as never
      if (table === 'nivaro_relations') return relChain as never
      if (table === 'workflow_lines') return parentChain as never
      throw new Error(`unexpected table ${String(table)}`)
    })

    await expect(
      hooks.trigger(
        'before',
        ctx({ action: 'create', payload: { workflow_line: 'wl1', allocated_amount: 50 } })
      )
    ).rejects.toThrow(CapValidationError)
  })

  it('is a no-op when the collection has no sum_cap rules', async () => {
    vi.mocked(getAiCollectionSettings).mockResolvedValue({
      collection: 'allocations',
      validation_enabled: false,
      validation_mode: 'soft',
      validation_rules: ['just a plain AI rule'],
      duplicate_detection_enabled: false,
      duplicate_threshold: 0.85
    } as never)

    const dbFn = vi.fn()
    vi.mocked(db).mockImplementation(dbFn as never)

    await expect(
      hooks.trigger('before', ctx({ action: 'create', payload: { title: 'hi' } }))
    ).resolves.toBeUndefined()

    expect(dbFn).not.toHaveBeenCalled()
  })
})
