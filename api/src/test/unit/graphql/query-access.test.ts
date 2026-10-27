import { afterEach, describe, expect, it, vi } from 'vitest'

// A chainable knex stand-in: every builder call returns the builder; awaiting it gives `rows`.
const rows: { value: unknown[] } = { value: [] }
function builder() {
  const b: Record<string, unknown> = {}
  for (const m of ['leftJoin', 'join', 'orderBy', 'limit', 'offset', 'select', 'where', 'whereIn'])
    b[m] = () => b
  b.first = async () => rows.value[0]
  // biome-ignore lint/suspicious/noThenProperty: knex builders are thenables
  b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(rows.value).then(res, rej)
  return b
}

vi.mock('../../../db/index.js', () => ({ db: vi.fn(() => builder()) }))
vi.mock('../../../services/instance-guard.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/instance-guard.js')>()),
  assertInstanceAccess: vi.fn(async () => {})
}))
vi.mock('../../../services/branch-instances.js', () => ({
  findRecordInstance: vi.fn(async () => ({ id: 'I1', template: 'T', current_state: null }))
}))
vi.mock('../../../services/pipeline-engine.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/pipeline-engine.js')>()),
  buildInstancePayload: vi.fn(async (instance: { id: string }) => ({ id: instance.id }))
}))
vi.mock('../../../services/file-access.js', () => ({
  readableFileIds: vi.fn(async () => new Set(['f1']))
}))
vi.mock('../../../services/record-access.js', () => ({
  compileAccessGates: vi.fn(async () => ({})),
  visibleIds: vi.fn(async () => new Set(['A']))
}))

import { domainQueryFields } from '../../../graphql/resolvers.js'
import { readableFileIds } from '../../../services/file-access.js'
import { assertInstanceAccess, InstanceAccessError } from '../../../services/instance-guard.js'

type Resolve = (src: unknown, args: Record<string, unknown>, ctx: unknown) => Promise<unknown>
const resolve = (name: string) => domainQueryFields[name].resolve as unknown as Resolve
const user = { id: 'U1', role: 'R' }
const member = { user, isAdmin: false }
const admin = { user, isAdmin: true }

afterEach(() => {
  rows.value = []
  vi.mocked(assertInstanceAccess).mockReset()
  vi.mocked(assertInstanceAccess).mockImplementation(async () => {})
})

describe('GraphQL audit trail and template queries are admin-only (H10, H12)', () => {
  for (const name of [
    'activity',
    'activity_by_id',
    'workflow_templates',
    'workflow_template_by_id',
    'pipeline_templates',
    'pipeline_template_by_id',
    'pipeline_matrix'
  ]) {
    it(`${name} refuses a non-admin`, async () => {
      await expect(resolve(name)(null, { id: '1', template_id: '1' }, member)).rejects.toThrow(
        /Admin access required/
      )
    })
  }

  it('activity still answers an administrator', async () => {
    rows.value = [{ id: 1, action: 'update', user_id: null }]
    const out = (await resolve('activity')(null, { limit: 50, offset: 0 }, admin)) as unknown[]
    expect(out).toHaveLength(1)
  })
})

describe('GraphQL record-instance queries judge the record as the caller (H12)', () => {
  it('workflow_instance answers null for a record the caller cannot see', async () => {
    vi.mocked(assertInstanceAccess).mockRejectedValue(new InstanceAccessError(404, 'nope'))
    const out = await resolve('workflow_instance')(
      null,
      { collection: 'orders', item: '7' },
      member
    )
    expect(out).toBeNull()
    expect(assertInstanceAccess).toHaveBeenCalledWith(user, false, 'orders', '7', undefined, 'read')
  })

  it('a collection the caller cannot read is FORBIDDEN', async () => {
    vi.mocked(assertInstanceAccess).mockRejectedValue(new InstanceAccessError(403, 'no'))
    await expect(
      resolve('pipeline_owners')(null, { collection: 'orders', item: '7' }, member)
    ).rejects.toThrow(/Forbidden/)
  })

  it('a visible record still answers', async () => {
    const out = await resolve('workflow_instance')(
      null,
      { collection: 'orders', item: '7' },
      member
    )
    expect(out).toEqual({ id: 'I1' })
  })

  it('pipeline_owners_all and pipeline_owners_for_state gate too', async () => {
    vi.mocked(assertInstanceAccess).mockRejectedValue(new InstanceAccessError(404, 'nope'))
    expect(
      await resolve('pipeline_owners_all')(null, { collection: 'orders', item: '7' }, member)
    ).toEqual({ byState: [] })
    expect(
      await resolve('pipeline_owners_for_state')(
        null,
        { collection: 'orders', item: '7', state_id: 'S' },
        member
      )
    ).toBeNull()
  })

  it('workflow_instances keeps only records the caller can see', async () => {
    rows.value = [
      { id: 'i1', item: 'A' },
      { id: 'i2', item: 'B' }
    ]
    const out = (await resolve('workflow_instances')(
      null,
      { collection: 'orders' },
      member
    )) as Array<{ id: string }>
    expect(out.map((o) => o.id)).toEqual(['i1'])
  })

  it('workflow_instances on a system collection gives a non-admin nothing', async () => {
    rows.value = [{ id: 'i1', item: 'A' }]
    expect(
      await resolve('workflow_instances')(null, { collection: 'nivaro_addendums' }, member)
    ).toEqual([])
  })
})

describe('GraphQL files follow the file-access rule (H11)', () => {
  it('lists only files the caller may read', async () => {
    rows.value = [
      { id: 'f1', filename_download: 'mine.pdf' },
      { id: 'f2', filename_download: 'dm.pdf' }
    ]
    const out = (await resolve('files')(null, { limit: 50, offset: 0 }, member)) as Array<{
      id: string
    }>
    expect(out.map((f) => f.id)).toEqual(['f1'])
    expect(readableFileIds).toHaveBeenCalled()
  })
})
