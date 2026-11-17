import { afterEach, describe, expect, it, vi } from 'vitest'

// Update guards (EFP prod 2026-11-17, workflow 372787): one PATCH from a Zone-scoped
// person took the Zone off, answered 200, and the record left their access. The
// caller's own update may not empty a required field (to-many links included) nor take
// a record they can see out of their User Scope — refused BEFORE anything is stored.

const store = vi.hoisted(() => ({
  junction: [] as Array<Record<string, unknown>>,
  firstHop: null as Record<string, unknown> | null
}))
vi.mock('../../../db/index.js', () => {
  const chain = (rows: () => unknown[]): unknown =>
    new Proxy(() => undefined, {
      get(_t, prop) {
        if (prop === 'then')
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve(rows()).then(res, rej)
        if (prop === 'first') return () => Promise.resolve(store.firstHop ?? undefined)
        return () => chain(rows)
      }
    })
  const db = Object.assign(
    (table: string) => chain(() => (table === 'divisions' ? [] : store.junction)),
    {
      raw: (sql: string) => ({ sql, toString: () => sql })
    }
  )
  return { db }
})

const rules = vi.hoisted(() => ({
  required: new Set<string>(),
  formRequired: new Set<string>(),
  formsCalled: 0
}))
vi.mock('../../../services/bulk-field-rules.js', () => ({
  bulkRuleTable: vi.fn(async () => {
    const labels: Record<string, string> = { divisions: 'Zone', regions: 'Region', name: 'Name' }
    return new Map(
      Object.keys(labels).map((f) => [
        f,
        { field: f, label: labels[f], required: rules.required.has(f) }
      ])
    )
  }),
  placementRequires: (_p: unknown, f: string) => rules.formRequired.has(f)
}))
vi.mock('../../../services/form-field-gate.js', () => ({
  resolveFormsForRecords: vi.fn(async (_c: string, ids: Array<string | number>) => {
    rules.formsCalled++
    return new Map(ids.map((id) => [String(id).toLowerCase(), { id: 86 }]))
  }),
  loadFormShape: vi.fn(async () => ({ placements: [] }))
}))

const gates = vi.hoisted(() => ({
  scopes: [] as Array<Record<string, unknown>>,
  visible: true,
  bypass: false
}))
vi.mock('../../../services/record-access.js', () => ({
  compileAccessGates: vi.fn(async () => ({
    bypass: gates.bypass,
    permitted: true,
    strict: null,
    scopes: gates.scopes
  })),
  visibleIds: vi.fn(async (_g: unknown, ids: string[]) => new Set(gates.visible ? ids : []))
}))
vi.mock('../../../services/user-scopes.js', () => ({ applyScopeHops: vi.fn() }))
vi.mock('../../../services/access-request-text.js', () => ({
  collectionNoun: vi.fn(async () => 'workflow')
}))

import {
  assertUpdateKeepsRecord,
  type GuardInput,
  linkIdsAfter,
  OutOfScopeUpdateError,
  RequiredFieldClearedError
} from '../../../services/update-guards.js'

const ERIC = { id: 'ERIC', role: 'MEMBER' } as never
const zoneWrite = (over: Partial<GuardInput['linkWrites'][number]> = {}) => ({
  field: 'divisions',
  junction: 'workflows_divisions',
  parentFk: 'workflows_id',
  relatedFk: 'divisions_id',
  links: [] as Array<{ id: string | number }>,
  removals: [] as Array<{ id: string | number }>,
  set: false,
  ...over
})
const input = (over: Partial<GuardInput> = {}): GuardInput => ({
  user: ERIC,
  isAdmin: false,
  collection: 'workflows',
  id: 372787,
  callerFields: new Set(['divisions']),
  columnPayload: {},
  previous: { id: 372787, name: 'CM27-81228' },
  linkWrites: [],
  ...over
})
const ZONE_GATE = {
  dimension: 'division',
  label: 'Zone',
  values: [3],
  hops: [
    {
      kind: 'junction',
      junction: 'workflows_divisions',
      parentFk: 'workflows_id',
      targetFk: 'divisions_id',
      to: 'divisions'
    }
  ],
  target: 'divisions',
  displayField: 'short_name'
}

afterEach(() => {
  delete process.env.UPDATE_SCOPE_GUARD
  delete process.env.UPDATE_REQUIRED_GUARD
  store.junction = []
  store.firstHop = null
  rules.required = new Set()
  rules.formRequired = new Set()
  rules.formsCalled = 0
  gates.scopes = []
  gates.visible = true
  gates.bypass = false
})

describe('linkIdsAfter', () => {
  it('removals then adds; a set replaces; ids compare case-blind', () => {
    expect(linkIdsAfter(zoneWrite({ removals: [{ id: 3 }] }), [3])).toEqual([])
    expect(linkIdsAfter(zoneWrite({ removals: [{ id: 3 }], links: [{ id: 4 }] }), [3])).toEqual([
      '4'
    ])
    expect(linkIdsAfter(zoneWrite({ set: true, links: [] }), [3])).toEqual([])
    expect(linkIdsAfter(zoneWrite({ links: [{ id: 'ab' }] }), ['AB'])).toEqual(['ab'])
  })
})

describe('required guard', () => {
  it('taking the last Zone off a required Zone is refused, naming the field', async () => {
    rules.required = new Set(['divisions'])
    store.junction = [{ divisions_id: 3 }]
    const err = await assertUpdateKeepsRecord(
      input({ linkWrites: [zoneWrite({ removals: [{ id: 3 }] })] })
    ).catch((e) => e)
    expect(err).toBeInstanceOf(RequiredFieldClearedError)
    expect(err).toMatchObject({
      statusCode: 422,
      code: 'REQUIRED_VALUE_MISSING',
      field: 'divisions'
    })
    expect(err.violations).toEqual([
      { field: 'divisions', rule: 'required', message: 'Pick a Zone' }
    ])
    expect(err.message).toMatch(/^Zone is required/)
  })

  it('a field the record’s form requires counts too', async () => {
    rules.formRequired = new Set(['divisions'])
    store.junction = [{ divisions_id: 3 }]
    await expect(
      assertUpdateKeepsRecord(input({ linkWrites: [zoneWrite({ set: true })] }))
    ).rejects.toBeInstanceOf(RequiredFieldClearedError)
  })

  it('a caller-sent empty required column is refused; one already empty is not', async () => {
    rules.required = new Set(['name'])
    const write = { callerFields: new Set(['name']), columnPayload: { name: null } }
    await expect(assertUpdateKeepsRecord(input(write))).rejects.toMatchObject({ field: 'name' })
    await expect(
      assertUpdateKeepsRecord(input({ ...write, previous: { id: 1, name: null } }))
    ).resolves.toBeUndefined()
  })

  it('a replace, a write that leaves a link, or a field it does not touch never refuses', async () => {
    rules.required = new Set(['divisions'])
    store.junction = [{ divisions_id: 3 }]
    for (const w of [
      zoneWrite({ removals: [{ id: 3 }], links: [{ id: 4 }] }),
      zoneWrite({ links: [{ id: 3 }] }),
      zoneWrite({ set: true, links: [{ id: 3 }] })
    ])
      await expect(assertUpdateKeepsRecord(input({ linkWrites: [w] }))).resolves.toBeUndefined()
    await expect(
      assertUpdateKeepsRecord(
        input({ callerFields: new Set(['notes']), columnPayload: { notes: 'x' } })
      )
    ).resolves.toBeUndefined()
    expect(rules.formsCalled).toBe(0)
  })

  it('UPDATE_REQUIRED_GUARD=off turns it off', async () => {
    process.env.UPDATE_REQUIRED_GUARD = 'off'
    rules.required = new Set(['divisions'])
    store.junction = [{ divisions_id: 3 }]
    await expect(
      assertUpdateKeepsRecord(input({ linkWrites: [zoneWrite({ removals: [{ id: 3 }] })] }))
    ).resolves.toBeUndefined()
  })
})

describe('scope guard', () => {
  it('Zone taken off a Zone-scoped person’s record: 422 OUT_OF_SCOPE, nothing stored', async () => {
    gates.scopes = [ZONE_GATE]
    store.junction = [{ divisions_id: 3 }]
    const err = await assertUpdateKeepsRecord(
      input({ linkWrites: [zoneWrite({ removals: [{ id: 3 }] })] })
    ).catch((e) => e)
    expect(err).toBeInstanceOf(OutOfScopeUpdateError)
    expect(err).toMatchObject({ statusCode: 422, code: 'OUT_OF_SCOPE', field: 'divisions' })
    expect(err.message).toMatch(/^Pick a Zone — without it this workflow would leave your access/)
    expect(err.violations[0]).toMatchObject({ field: 'divisions', message: 'Pick a Zone' })
  })

  it('a Zone outside theirs is refused; one of theirs passes', async () => {
    gates.scopes = [ZONE_GATE]
    store.junction = [{ divisions_id: 3 }]
    await expect(
      assertUpdateKeepsRecord(
        input({ linkWrites: [zoneWrite({ removals: [{ id: 3 }], links: [{ id: 9 }] })] })
      )
    ).rejects.toMatchObject({ code: 'OUT_OF_SCOPE' })
    gates.scopes = [{ ...ZONE_GATE, values: [3, 9] }]
    await expect(
      assertUpdateKeepsRecord(
        input({ linkWrites: [zoneWrite({ removals: [{ id: 3 }], links: [{ id: 9 }] })] })
      )
    ).resolves.toBeUndefined()
  })

  it('a many-to-one first hop: the new value is walked down the rest of the route', async () => {
    const regionGate = {
      ...ZONE_GATE,
      hops: [
        { kind: 'm2o', from: 'workflows', to: 'regions', fk: 'region' },
        { kind: 'm2o', from: 'regions', to: 'divisions', fk: 'division' }
      ]
    }
    gates.scopes = [regionGate]
    const write = {
      callerFields: new Set(['region']),
      columnPayload: { region: 12 },
      previous: { id: 1, region: 8 }
    }
    store.firstHop = null
    await expect(assertUpdateKeepsRecord(input(write))).rejects.toMatchObject({
      code: 'OUT_OF_SCOPE',
      field: 'region'
    })
    store.firstHop = { id: 12 }
    await expect(assertUpdateKeepsRecord(input(write))).resolves.toBeUndefined()
  })

  it('never judged: no scopes, a record already out of view, an untouched route, the switch off', async () => {
    const removeZone = input({ linkWrites: [zoneWrite({ removals: [{ id: 3 }] })] })
    store.junction = [{ divisions_id: 3 }]
    await expect(assertUpdateKeepsRecord(removeZone)).resolves.toBeUndefined()
    gates.scopes = [ZONE_GATE]
    gates.visible = false
    await expect(assertUpdateKeepsRecord(removeZone)).resolves.toBeUndefined()
    gates.visible = true
    await expect(
      assertUpdateKeepsRecord(input({ columnPayload: { notes: 'x' } }))
    ).resolves.toBeUndefined()
    process.env.UPDATE_SCOPE_GUARD = 'off'
    await expect(assertUpdateKeepsRecord(removeZone)).resolves.toBeUndefined()
  })

  it('an administrator’s own restrict scope binds them too (gates compiled as acting admin)', async () => {
    const { compileAccessGates } = await import('../../../services/record-access.js')
    gates.scopes = [ZONE_GATE]
    store.junction = [{ divisions_id: 3 }]
    await expect(
      assertUpdateKeepsRecord(
        input({ isAdmin: true, linkWrites: [zoneWrite({ removals: [{ id: 3 }] })] })
      )
    ).rejects.toMatchObject({ code: 'OUT_OF_SCOPE' })
    expect(compileAccessGates).toHaveBeenLastCalledWith(ERIC, 'workflows', { actingAdmin: true })
  })
})
