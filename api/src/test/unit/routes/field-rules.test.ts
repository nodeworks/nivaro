import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Same route-harness idiom as collection-layouts-active.test.ts.
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async (req: { user?: { id: string; role?: string }; isAdmin?: boolean }) => {
    req.user = { id: 'test-user', role: 'user' }
    req.isAdmin = false
  }),
  requireAdmin: vi.fn(async (req: { user?: { id: string }; isAdmin?: boolean }) => {
    req.user = { id: 'test-admin' }
    req.isAdmin = true
  })
}))

vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/permissions.js', () => ({ can: vi.fn(async () => true) }))
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { db } from '../../../db/index.js'
import { fieldRulesRoutes } from '../../../routes/field-rules.js'
import {
  evaluateRulesForTrigger,
  isEmptyValue,
  matchesTrigger,
  validateDynamicConfig
} from '../../../services/field-rules.js'
import { can } from '../../../services/permissions.js'

function buildApp() {
  const app = Fastify({ logger: false })
  app.register(fieldRulesRoutes, { prefix: '/field-rules' })
  return app
}

afterEach(() => vi.clearAllMocks())

// ─── Pure helpers ───────────────────────────────────────────────────────────

describe('isEmptyValue', () => {
  it('treats null, undefined, empty string and empty array as empty', () => {
    expect(isEmptyValue(null)).toBe(true)
    expect(isEmptyValue(undefined)).toBe(true)
    expect(isEmptyValue('')).toBe(true)
    expect(isEmptyValue([])).toBe(true)
  })

  it('does NOT treat 0 or false as empty', () => {
    expect(isEmptyValue(0)).toBe(false)
    expect(isEmptyValue(false)).toBe(false)
  })

  it('does not treat a non-empty array or string as empty', () => {
    expect(isEmptyValue(['a'])).toBe(false)
    expect(isEmptyValue('x')).toBe(false)
  })
})

describe('matchesTrigger', () => {
  it('nnull matches any non-null value, including an empty array', () => {
    expect(matchesTrigger('nnull', ['a'], null)).toBe(true)
    expect(matchesTrigger('nnull', null, null)).toBe(false)
  })

  it('eq/neq compare via String coercion', () => {
    expect(matchesTrigger('eq', 2, '2')).toBe(true)
    expect(matchesTrigger('neq', 2, '2')).toBe(false)
  })

  it('in matches against a JSON array trigger_value', () => {
    expect(matchesTrigger('in', 'b', JSON.stringify(['a', 'b']))).toBe(true)
    expect(matchesTrigger('in', 'c', JSON.stringify(['a', 'b']))).toBe(false)
  })
})

describe('validateDynamicConfig', () => {
  it('forbids dynamic_config for set/clear', () => {
    expect(validateDynamicConfig('set', { collection: 'regions' })).toMatch(/not allowed/)
    expect(validateDynamicConfig('clear', {})).toMatch(/not allowed/)
    expect(validateDynamicConfig('set', null)).toBeNull()
  })

  it('requires dynamic_config for set_lookup/set_from_trigger', () => {
    expect(validateDynamicConfig('set_lookup', null)).toMatch(/required/)
    expect(validateDynamicConfig('set_from_trigger', undefined)).toMatch(/required/)
  })

  it('set_lookup: names the offending key', () => {
    expect(
      validateDynamicConfig('set_lookup', {
        filter_field: 'division',
        filter_op: 'in',
        select: 'id'
      })
    ).toMatch(/dynamic_config\.collection/)
    expect(
      validateDynamicConfig('set_lookup', { collection: 'regions', filter_op: 'in', select: 'id' })
    ).toMatch(/dynamic_config\.filter_field/)
    expect(
      validateDynamicConfig('set_lookup', {
        collection: 'regions',
        filter_field: 'division',
        filter_op: 'bogus',
        select: 'id'
      })
    ).toMatch(/dynamic_config\.filter_op/)
    expect(
      validateDynamicConfig('set_lookup', {
        collection: 'regions',
        filter_field: 'division',
        filter_op: 'in'
      })
    ).toMatch(/dynamic_config\.select/)
  })

  it('set_lookup: accepts a valid config, JSON string or object', () => {
    const cfg = { collection: 'regions', filter_field: 'division', filter_op: 'in', select: 'id' }
    expect(validateDynamicConfig('set_lookup', cfg)).toBeNull()
    expect(validateDynamicConfig('set_lookup', JSON.stringify(cfg))).toBeNull()
  })

  it('set_from_trigger: names the offending key, map is optional', () => {
    expect(validateDynamicConfig('set_from_trigger', {})).toMatch(/dynamic_config\.field/)
    expect(validateDynamicConfig('set_from_trigger', { field: 'categories' })).toBeNull()
    expect(
      validateDynamicConfig('set_from_trigger', { field: 'categories', map: 'category' })
    ).toBeNull()
    expect(validateDynamicConfig('set_from_trigger', { field: 'categories', map: '1bad' })).toMatch(
      /dynamic_config\.map/
    )
  })

  it('rejects malformed JSON', () => {
    expect(validateDynamicConfig('set_lookup', '{not json')).toMatch(/valid JSON/)
  })
})

// ─── evaluateRulesForTrigger (shared engine) ───────────────────────────────

function makeLogger() {
  return { warn: vi.fn() }
}

function ruleRow(overrides: Record<string, unknown>) {
  return {
    id: 1,
    collection: 'workflows',
    trigger_field: 'divisions',
    trigger_op: 'nnull',
    trigger_value: null,
    target_field: 'regions',
    target_type: 'set_lookup',
    target_value: null,
    only_when_empty: false,
    dynamic_config: null,
    sort: 0,
    is_active: true,
    ...overrides
  }
}

describe('evaluateRulesForTrigger — static set/clear parity', () => {
  it('set writes the literal target_value when triggered', async () => {
    const database = vi.fn((table: string) => {
      if (table === 'nivaro_field_rules') {
        return {
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              select: vi.fn(() =>
                Promise.resolve([
                  ruleRow({
                    target_type: 'set',
                    target_value: 'west',
                    trigger_op: 'eq',
                    trigger_value: 'a'
                  })
                ])
              )
            }))
          }))
        }
      }
      throw new Error(`unexpected table ${table}`)
    })

    const updates = await evaluateRulesForTrigger(
      database as unknown as Parameters<typeof evaluateRulesForTrigger>[0],
      'workflows',
      'divisions',
      'a',
      {}
    )
    expect(updates).toEqual({ regions: 'west' })
  })

  it('clear nulls the target when triggered', async () => {
    const database = vi.fn((table: string) => {
      if (table === 'nivaro_field_rules') {
        return {
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              select: vi.fn(() =>
                Promise.resolve([ruleRow({ target_type: 'clear', trigger_op: 'null' })])
              )
            }))
          }))
        }
      }
      throw new Error(`unexpected table ${table}`)
    })

    const updates = await evaluateRulesForTrigger(
      database as unknown as Parameters<typeof evaluateRulesForTrigger>[0],
      'workflows',
      'divisions',
      null,
      {}
    )
    expect(updates).toEqual({ regions: null })
  })

  it('does not fire when the trigger condition is not met', async () => {
    const database = vi.fn((table: string) => {
      if (table === 'nivaro_field_rules') {
        return {
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              select: vi.fn(() =>
                Promise.resolve([
                  ruleRow({ target_type: 'set', target_value: 'west', trigger_op: 'nnull' })
                ])
              )
            }))
          }))
        }
      }
      throw new Error(`unexpected table ${table}`)
    })

    const updates = await evaluateRulesForTrigger(
      database as unknown as Parameters<typeof evaluateRulesForTrigger>[0],
      'workflows',
      'divisions',
      null,
      {}
    )
    expect(updates).toEqual({})
  })
})

describe('evaluateRulesForTrigger — only_when_empty', () => {
  it('skips the target when it already has a non-empty value in the draft', async () => {
    const database = vi.fn((table: string) => {
      if (table === 'nivaro_field_rules') {
        return {
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              select: vi.fn(() =>
                Promise.resolve([
                  ruleRow({ target_type: 'set', target_value: 'west', only_when_empty: true })
                ])
              )
            }))
          }))
        }
      }
      throw new Error(`unexpected table ${table}`)
    })

    const updates = await evaluateRulesForTrigger(
      database as unknown as Parameters<typeof evaluateRulesForTrigger>[0],
      'workflows',
      'divisions',
      ['a'],
      { regions: ['already-set'] }
    )
    expect(updates).toEqual({})
  })

  it('fires when the target is empty (null, empty string, empty array)', async () => {
    for (const existing of [null, '', [], undefined]) {
      const database = vi.fn((table: string) => {
        if (table === 'nivaro_field_rules') {
          return {
            where: vi.fn(() => ({
              orderBy: vi.fn(() => ({
                select: vi.fn(() =>
                  Promise.resolve([
                    ruleRow({ target_type: 'set', target_value: 'west', only_when_empty: true })
                  ])
                )
              }))
            }))
          }
        }
        throw new Error(`unexpected table ${table}`)
      })

      const updates = await evaluateRulesForTrigger(
        database as unknown as Parameters<typeof evaluateRulesForTrigger>[0],
        'workflows',
        'divisions',
        ['a'],
        { regions: existing }
      )
      expect(updates).toEqual({ regions: 'west' })
    }
  })

  it('0 and false on the target count as non-empty — rule does not fire', async () => {
    for (const existing of [0, false]) {
      const database = vi.fn((table: string) => {
        if (table === 'nivaro_field_rules') {
          return {
            where: vi.fn(() => ({
              orderBy: vi.fn(() => ({
                select: vi.fn(() =>
                  Promise.resolve([
                    ruleRow({ target_type: 'set', target_value: 'west', only_when_empty: true })
                  ])
                )
              }))
            }))
          }
        }
        throw new Error(`unexpected table ${table}`)
      })

      const updates = await evaluateRulesForTrigger(
        database as unknown as Parameters<typeof evaluateRulesForTrigger>[0],
        'workflows',
        'divisions',
        ['a'],
        { regions: existing }
      )
      expect(updates).toEqual({})
    }
  })
})

describe('evaluateRulesForTrigger — set_lookup', () => {
  function lookupRule(overrides: Record<string, unknown> = {}) {
    return ruleRow({
      target_type: 'set_lookup',
      dynamic_config: JSON.stringify({
        collection: 'regions',
        filter_field: 'division',
        filter_op: 'in',
        select: 'id'
      }),
      ...overrides
    })
  }

  // Knex's query builder is itself a thenable — `q.whereIn(...)` mutates and
  // returns the SAME builder, awaited afterward. Mock that shape: `.limit()`
  // returns an awaitable object carrying `.whereIn`/`.where` as no-op-return
  // methods, resolving to `rows` when the caller does `await q`.
  function thenableRows(rows: Record<string, unknown>[]) {
    return Object.assign(Promise.resolve(rows), { whereIn: vi.fn(), where: vi.fn() })
  }

  it('array trigger value uses whereIn and returns the matching ids', async () => {
    const q = thenableRows([{ id: 'r1' }, { id: 'r2' }])
    const database = vi.fn((table: string) => {
      if (table === 'nivaro_field_rules') {
        return {
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({ select: vi.fn(() => Promise.resolve([lookupRule()])) }))
          }))
        }
      }
      if (table === 'regions') {
        return { select: vi.fn(() => ({ limit: vi.fn(() => q) })) }
      }
      throw new Error(`unexpected table ${table}`)
    })

    const updates = await evaluateRulesForTrigger(
      database as unknown as Parameters<typeof evaluateRulesForTrigger>[0],
      'workflows',
      'divisions',
      ['north', 'south'],
      {}
    )
    expect(updates).toEqual({ regions: ['r1', 'r2'] })
    expect(q.whereIn).toHaveBeenCalledWith('division', ['north', 'south'])
  })

  it('scalar trigger value uses where', async () => {
    const q = thenableRows([{ id: 'r1' }])
    const database = vi.fn((table: string) => {
      if (table === 'nivaro_field_rules') {
        return {
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({ select: vi.fn(() => Promise.resolve([lookupRule()])) }))
          }))
        }
      }
      if (table === 'regions') {
        return { select: vi.fn(() => ({ limit: vi.fn(() => q) })) }
      }
      throw new Error(`unexpected table ${table}`)
    })

    const updates = await evaluateRulesForTrigger(
      database as unknown as Parameters<typeof evaluateRulesForTrigger>[0],
      'workflows',
      'divisions',
      'north',
      {}
    )
    expect(updates).toEqual({ regions: ['r1'] })
    expect(q.where).toHaveBeenCalledWith('division', 'north')
  })

  it('dead collection/column: query throws → rule skipped + logger.warn, never throws', async () => {
    const logger = makeLogger()
    const q = Object.assign(Promise.reject(new Error('column "division" does not exist')), {
      whereIn: vi.fn(),
      where: vi.fn()
    })
    q.catch(() => {}) // pre-empt Node's unhandled-rejection warning for the intentionally-rejected mock
    const database = vi.fn((table: string) => {
      if (table === 'nivaro_field_rules') {
        return {
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({ select: vi.fn(() => Promise.resolve([lookupRule()])) }))
          }))
        }
      }
      if (table === 'regions') {
        return { select: vi.fn(() => ({ limit: vi.fn(() => q) })) }
      }
      throw new Error(`unexpected table ${table}`)
    })

    const updates = await evaluateRulesForTrigger(
      database as unknown as Parameters<typeof evaluateRulesForTrigger>[0],
      'workflows',
      'divisions',
      ['north'],
      {},
      logger
    )
    expect(updates).toEqual({})
    expect(logger.warn).toHaveBeenCalled()
  })

  it('invalid dynamic_config: skipped + logger.warn without querying the db', async () => {
    const logger = makeLogger()
    const regionsTable = vi.fn(() => {
      throw new Error('should never query the lookup collection for an invalid rule')
    })
    const database = vi.fn((table: string) => {
      if (table === 'nivaro_field_rules') {
        return {
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              select: vi.fn(() => Promise.resolve([lookupRule({ dynamic_config: '{not json' })]))
            }))
          }))
        }
      }
      if (table === 'regions') return regionsTable()
      throw new Error(`unexpected table ${table}`)
    })

    const updates = await evaluateRulesForTrigger(
      database as unknown as Parameters<typeof evaluateRulesForTrigger>[0],
      'workflows',
      'divisions',
      ['north'],
      {},
      logger
    )
    expect(updates).toEqual({})
    expect(logger.warn).toHaveBeenCalled()
  })
})

describe('evaluateRulesForTrigger — set_from_trigger', () => {
  function fromTriggerRule(config: Record<string, unknown>) {
    return ruleRow({
      trigger_field: 'car_project_type',
      target_field: 'categories',
      target_type: 'set_from_trigger',
      dynamic_config: JSON.stringify(config)
    })
  }

  // set_from_trigger's plain-column path uses getActualColumns (services/items.ts),
  // which reads db.raw() off the module-level `db` singleton — NOT the `database`
  // argument threaded through evaluateRulesForTrigger. So these tests mock/pass
  // the same imported `db` for both, with `.raw` stubbed to answer the
  // information_schema.columns probe.
  function mockDbWithRaw(
    impl: (table: string) => unknown,
    rawImpl: (...args: unknown[]) => Promise<unknown>
  ) {
    vi.mocked(db).mockImplementation(impl as unknown as typeof db)
    ;(db as unknown as { raw: (...args: unknown[]) => Promise<unknown> }).raw = vi.fn(rawImpl)
  }

  it('plain column on the related record is read directly', async () => {
    mockDbWithRaw(
      (table: string) => {
        if (table === 'nivaro_field_rules') {
          return {
            where: vi.fn(() => ({
              orderBy: vi.fn(() => ({
                select: vi.fn(() => Promise.resolve([fromTriggerRule({ field: 'notes' })]))
              }))
            }))
          }
        }
        if (table === 'nivaro_relations') {
          return {
            where: vi.fn((cond: Record<string, unknown>) => {
              if ('many_collection' in cond) {
                return {
                  whereNull: vi.fn(() => ({
                    first: vi.fn(() => Promise.resolve({ one_collection: 'project_types_plain' }))
                  }))
                }
              }
              // alias lookup by one_collection/one_field — no alias, it's a plain column
              return { first: vi.fn(() => Promise.resolve(undefined)) }
            })
          }
        }
        if (table === 'project_types_plain') {
          return {
            where: vi.fn(() => ({
              select: vi.fn((cols: string[]) => {
                expect(cols).toEqual(['id', 'notes'])
                return { first: vi.fn(() => Promise.resolve({ id: 'pt1', notes: 'hello' })) }
              })
            }))
          }
        }
        throw new Error(`unexpected table ${table}`)
      },
      () => Promise.resolve([{ COLUMN_NAME: 'id' }, { COLUMN_NAME: 'notes' }])
    )

    const updates = await evaluateRulesForTrigger(
      db as unknown as Parameters<typeof evaluateRulesForTrigger>[0],
      'workflows',
      'car_project_type',
      'pt1',
      {}
    )
    expect(updates).toEqual({ categories: 'hello' })
  })

  it('M2M alias with map reads the junction column values (categories via car_project_type)', async () => {
    mockDbWithRaw(
      (table: string) => {
        if (table === 'nivaro_field_rules') {
          return {
            where: vi.fn(() => ({
              orderBy: vi.fn(() => ({
                select: vi.fn(() =>
                  Promise.resolve([fromTriggerRule({ field: 'categories', map: 'category' })])
                )
              }))
            }))
          }
        }
        if (table === 'nivaro_relations') {
          return {
            where: vi.fn((cond: Record<string, unknown>) => {
              if ('many_collection' in cond) {
                return {
                  whereNull: vi.fn(() => ({
                    first: vi.fn(() => Promise.resolve({ one_collection: 'project_types_m2m' }))
                  }))
                }
              }
              // alias lookup: one_collection=project_types_m2m, one_field=categories
              return {
                first: vi.fn(() =>
                  Promise.resolve({
                    many_collection: 'project_type_categories',
                    many_field: 'project_type_id',
                    junction_field: 'category_id'
                  })
                )
              }
            })
          }
        }
        if (table === 'project_types_m2m') {
          return {
            where: vi.fn(() => ({
              select: vi.fn((cols: string[]) => {
                expect(cols).toEqual(['id']) // categories isn't a real column — id-only projection
                return { first: vi.fn(() => Promise.resolve({ id: 'pt1' })) }
              })
            }))
          }
        }
        if (table === 'project_type_categories') {
          return {
            where: vi.fn(() => ({
              select: vi.fn(() => ({
                limit: vi.fn(() => Promise.resolve([{ category: 'cat-a' }, { category: 'cat-b' }]))
              }))
            }))
          }
        }
        throw new Error(`unexpected table ${table}`)
      },
      (...args: unknown[]) => {
        const query = String(args[0])
        if (query.includes('project_types_m2m')) return Promise.resolve([{ COLUMN_NAME: 'id' }])
        return Promise.resolve([
          { COLUMN_NAME: 'id' },
          { COLUMN_NAME: 'project_type_id' },
          { COLUMN_NAME: 'category_id' },
          { COLUMN_NAME: 'category' }
        ])
      }
    )

    const updates = await evaluateRulesForTrigger(
      db as unknown as Parameters<typeof evaluateRulesForTrigger>[0],
      'workflows',
      'car_project_type',
      'pt1',
      {}
    )
    expect(updates).toEqual({ categories: ['cat-a', 'cat-b'] })
  })

  it('M2M alias without map is skipped + logger.warn', async () => {
    const logger = makeLogger()
    mockDbWithRaw(
      (table: string) => {
        if (table === 'nivaro_field_rules') {
          return {
            where: vi.fn(() => ({
              orderBy: vi.fn(() => ({
                select: vi.fn(() => Promise.resolve([fromTriggerRule({ field: 'categories' })]))
              }))
            }))
          }
        }
        if (table === 'nivaro_relations') {
          return {
            where: vi.fn((cond: Record<string, unknown>) => {
              if ('many_collection' in cond) {
                return {
                  whereNull: vi.fn(() => ({
                    first: vi.fn(() => Promise.resolve({ one_collection: 'project_types_nomap' }))
                  }))
                }
              }
              return {
                first: vi.fn(() =>
                  Promise.resolve({
                    many_collection: 'project_type_categories_nomap',
                    many_field: 'project_type_id',
                    junction_field: 'category_id'
                  })
                )
              }
            })
          }
        }
        if (table === 'project_types_nomap') {
          return {
            where: vi.fn(() => ({
              select: vi.fn(() => ({ first: vi.fn(() => Promise.resolve({ id: 'pt1' })) }))
            }))
          }
        }
        throw new Error(`unexpected table ${table}`)
      },
      () => Promise.resolve([{ COLUMN_NAME: 'id' }])
    )

    const updates = await evaluateRulesForTrigger(
      db as unknown as Parameters<typeof evaluateRulesForTrigger>[0],
      'workflows',
      'car_project_type',
      'pt1',
      {},
      logger
    )
    expect(updates).toEqual({})
    expect(logger.warn).toHaveBeenCalled()
  })

  it('dead relation (trigger field has no M2O relation) is skipped + logger.warn', async () => {
    const logger = makeLogger()
    const database = vi.fn((table: string) => {
      if (table === 'nivaro_field_rules') {
        return {
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              select: vi.fn(() => Promise.resolve([fromTriggerRule({ field: 'categories' })]))
            }))
          }))
        }
      }
      if (table === 'nivaro_relations') {
        return {
          where: vi.fn(() => ({
            whereNull: vi.fn(() => ({ first: vi.fn(() => Promise.resolve(undefined)) }))
          }))
        }
      }
      throw new Error(`unexpected table ${table}`)
    })

    const updates = await evaluateRulesForTrigger(
      database as unknown as Parameters<typeof evaluateRulesForTrigger>[0],
      'workflows',
      'car_project_type',
      'pt1',
      {},
      logger
    )
    expect(updates).toEqual({})
    expect(logger.warn).toHaveBeenCalled()
  })

  it('empty trigger value short-circuits without querying', async () => {
    const database = vi.fn((table: string) => {
      if (table === 'nivaro_field_rules') {
        return {
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              select: vi.fn(() =>
                Promise.resolve([fromTriggerRule({ field: 'categories', map: 'category' })])
              )
            }))
          }))
        }
      }
      throw new Error(
        `unexpected table ${table} — should not be queried for an empty trigger value`
      )
    })

    const updates = await evaluateRulesForTrigger(
      database as unknown as Parameters<typeof evaluateRulesForTrigger>[0],
      'workflows',
      'car_project_type',
      null,
      {}
    )
    expect(updates).toEqual({})
  })
})

// ─── Route: POST /field-rules — validation matrix ──────────────────────────

function makeCreateDbMock(created: Record<string, unknown>) {
  return vi.fn((table: string) => {
    if (table !== 'nivaro_field_rules') throw new Error(`unexpected table: ${table}`)
    return {
      insert: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: 1 }])) })),
      where: vi.fn(() => ({ first: vi.fn(() => Promise.resolve(created)) }))
    }
  })
}

async function postRule(payload: Record<string, unknown>) {
  const app = buildApp()
  await app.ready()
  return app.inject({ method: 'POST', url: '/field-rules', payload })
}

describe('POST /field-rules — dynamic_config validation', () => {
  it('rejects set_lookup with no dynamic_config', async () => {
    vi.mocked(db).mockImplementation(makeCreateDbMock({}) as unknown as typeof db)
    const res = await postRule({
      collection: 'workflows',
      trigger_field: 'divisions',
      target_field: 'regions',
      target_type: 'set_lookup'
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toMatch(/dynamic_config/)
  })

  it('rejects set_from_trigger with a malformed field key', async () => {
    vi.mocked(db).mockImplementation(makeCreateDbMock({}) as unknown as typeof db)
    const res = await postRule({
      collection: 'workflows',
      trigger_field: 'car_project_type',
      target_field: 'categories',
      target_type: 'set_from_trigger',
      dynamic_config: { field: '1bad' }
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toMatch(/dynamic_config\.field/)
  })

  it('rejects set with a dynamic_config present', async () => {
    vi.mocked(db).mockImplementation(makeCreateDbMock({}) as unknown as typeof db)
    const res = await postRule({
      collection: 'workflows',
      trigger_field: 'divisions',
      target_field: 'regions',
      target_type: 'set',
      target_value: 'x',
      dynamic_config: { collection: 'regions' }
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toMatch(/not allowed/)
  })

  it('accepts a valid set_lookup rule and stores dynamic_config + only_when_empty', async () => {
    const created = {
      id: 1,
      collection: 'workflows',
      target_type: 'set_lookup',
      only_when_empty: 1,
      dynamic_config: JSON.stringify({
        collection: 'regions',
        filter_field: 'division',
        filter_op: 'in',
        select: 'id'
      })
    }
    vi.mocked(db).mockImplementation(makeCreateDbMock(created) as unknown as typeof db)
    const res = await postRule({
      collection: 'workflows',
      trigger_field: 'divisions',
      trigger_op: 'nnull',
      target_field: 'regions',
      target_type: 'set_lookup',
      only_when_empty: true,
      dynamic_config: {
        collection: 'regions',
        filter_field: 'division',
        filter_op: 'in',
        select: 'id'
      }
    })
    expect(res.statusCode).toBe(201)
  })
})

// ─── Route: POST /field-rules/evaluate — security gates + dispatch ────────

function makeEvaluateDbMock(opts: { registered?: boolean; rules?: Record<string, unknown>[] }) {
  return vi.fn((table: string) => {
    if (table === 'nivaro_collections') {
      return {
        where: vi.fn(() => ({
          first: vi.fn(() =>
            Promise.resolve(opts.registered === false ? undefined : { collection: 'workflows' })
          )
        }))
      }
    }
    if (table === 'nivaro_field_rules') {
      return {
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({ select: vi.fn(() => Promise.resolve(opts.rules ?? [])) }))
        }))
      }
    }
    throw new Error(`unexpected table: ${table}`)
  })
}

async function evaluate(payload: Record<string, unknown>) {
  const app = buildApp()
  await app.ready()
  return app.inject({ method: 'POST', url: '/field-rules/evaluate', payload })
}

describe('POST /field-rules/evaluate — new trigger_field/draft contract', () => {
  it('400s for an unregistered collection without ever touching nivaro_field_rules', async () => {
    const dbMock = makeEvaluateDbMock({ registered: false })
    vi.mocked(db).mockImplementation(dbMock as unknown as typeof db)

    const res = await evaluate({
      collection: 'not_a_real_table',
      trigger_field: 'divisions',
      trigger_value: ['a'],
      draft: {}
    })
    expect(res.statusCode).toBe(400)
    expect(dbMock.mock.calls.some((c) => c[0] === 'nivaro_field_rules')).toBe(false)
  })

  it('403s when the caller lacks read permission on the collection', async () => {
    vi.mocked(can).mockResolvedValueOnce(false)
    vi.mocked(db).mockImplementation(makeEvaluateDbMock({ rules: [] }) as unknown as typeof db)

    const res = await evaluate({
      collection: 'workflows',
      trigger_field: 'divisions',
      trigger_value: ['a'],
      draft: {}
    })
    expect(res.statusCode).toBe(403)
  })

  it('returns { data } with the fired target updates for a registered, readable collection', async () => {
    vi.mocked(db).mockImplementation(
      makeEvaluateDbMock({
        rules: [
          ruleRow({
            target_type: 'set',
            target_value: 'west',
            trigger_op: 'nnull',
            trigger_value: null
          })
        ]
      }) as unknown as typeof db
    )

    const res = await evaluate({
      collection: 'workflows',
      trigger_field: 'divisions',
      trigger_value: ['north'],
      draft: {}
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ data: { regions: 'west' } })
  })

  it('400s when trigger_field is missing', async () => {
    const res = await evaluate({ collection: 'workflows', draft: {} })
    expect(res.statusCode).toBe(400)
  })
})

// legacy row_rules/data contract still dispatches through applyFieldRules and
// is unaffected — smoke-tested to confirm the two shapes stay disambiguated.
describe('POST /field-rules/evaluate — legacy row_rules/data contract still works', () => {
  it('400s when data is missing (legacy contract)', async () => {
    const res = await evaluate({ collection: 'workflows' })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toMatch(/collection and data/)
  })
})
