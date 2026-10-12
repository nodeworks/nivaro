import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/permissions.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/permissions.js')>()),
  can: vi.fn(async () => true)
}))
vi.mock('../../../services/instance-guard.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/instance-guard.js')>()),
  assertInstanceAccess: vi.fn(async () => {})
}))
vi.mock('../../../services/pipeline-engine.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/pipeline-engine.js')>()),
  buildInstancePayload: vi.fn(async (instance: { id: number }, role: string) => ({
    id: instance.id,
    built_for_role: role
  }))
}))

import { db } from '../../../db/index.js'
import { pubsub, topics } from '../../../graphql/pubsub.js'
import { domainSubscriptionFields } from '../../../graphql/resolvers.js'
import { assertInstanceAccess } from '../../../services/instance-guard.js'
import { can } from '../../../services/permissions.js'

const user = { id: 'U1', role: 'R' }
type Sub = (src: unknown, args: Record<string, unknown>, ctx: unknown) => unknown

async function firstWithin(it: AsyncIterableIterator<unknown>, ms = 10): Promise<unknown> {
  const r = await Promise.race([
    it.next(),
    new Promise<null>((res) => setTimeout(() => res(null), ms))
  ])
  await it.return?.()
  return r && !r.done ? r.value : null
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.mocked(can).mockClear()
})

describe('GraphQL subscriptions listen under the connection tenant', () => {
  const subscribe = domainSubscriptionFields.itemMutated.subscribe as Sub

  it('a tenant-A connection hears tenant A and not tenant B', async () => {
    const itA = (await subscribe(
      null,
      { collection: 'orders' },
      {
        user,
        isAdmin: true,
        tenantKey: 'A'
      }
    )) as AsyncIterableIterator<unknown>
    pubsub.publish(topics.itemMutated('orders', '*', 'B'), { itemMutated: { item: 'b' } })
    expect(await firstWithin(itA)).toBeNull()

    const itA2 = (await subscribe(
      null,
      { collection: 'orders' },
      {
        user,
        isAdmin: true,
        tenantKey: 'A'
      }
    )) as AsyncIterableIterator<unknown>
    pubsub.publish(topics.itemMutated('orders', '*', 'A'), { itemMutated: { item: 'a' } })
    expect(await firstWithin(itA2)).toEqual({ itemMutated: { item: 'a' } })
  })

  it('runs the read check inside the connection tenant', async () => {
    const withTenant = vi.fn(<T>(fn: () => Promise<T>) => fn())
    const it = (await subscribe(
      null,
      { collection: 'orders' },
      {
        user,
        isAdmin: false,
        tenantKey: 'A',
        withTenant
      }
    )) as AsyncIterableIterator<unknown>
    await it.return?.()
    expect(withTenant).toHaveBeenCalledTimes(1)
    expect(can).toHaveBeenCalledWith(user, 'read', 'orders')
  })

  it('in cloud mode a connection without a tenant hears nobody', async () => {
    vi.stubEnv('CLOUD_META_DB_URL', 'postgres://meta')
    const it = (await subscribe(
      null,
      { collection: 'orders' },
      {
        user,
        isAdmin: true
      }
    )) as AsyncIterableIterator<unknown>
    pubsub.publish(topics.itemMutated('orders', '*', ''), { itemMutated: { item: 'x' } })
    expect(await firstWithin(it)).toBeNull()
  })

  it('workflow state subscriptions need collection read and are per tenant', async () => {
    const wf = domainSubscriptionFields.workflowStateChanged.subscribe as Sub
    vi.mocked(can).mockResolvedValueOnce(false)
    await expect(
      wf(null, { collection: 'orders', item: '1' }, { user, isAdmin: false, tenantKey: 'A' })
    ).rejects.toThrow(/permission/)
    const it = (await wf(
      null,
      { collection: 'orders', item: '1' },
      {
        user,
        isAdmin: false,
        tenantKey: 'A'
      }
    )) as AsyncIterableIterator<unknown>
    pubsub.publish(topics.workflowStateChanged('orders', '1', 'B'), { workflowStateChanged: 1 })
    expect(await firstWithin(it)).toBeNull()
  })
})

describe('workflow / pipeline state events are built per subscriber', () => {
  const wf = domainSubscriptionFields.workflowStateChanged.subscribe as Sub
  const pl = domainSubscriptionFields.pipelineStateChanged.subscribe as Sub
  const ana = { id: 'ANA', role: 'R-APPROVER' }
  const bob = { id: 'BOB', role: 'R-VIEWER' }

  function instances() {
    vi.mocked(db).mockImplementation((() => {
      const b: Record<string, unknown> = {}
      b.where = vi.fn(() => b)
      b.first = vi.fn(async () => ({ id: 5 }))
      return b
    }) as never)
  }

  it('each subscriber gets the instance built with THEIR role, from an ids-only event', async () => {
    instances()
    const itAna = (await wf(
      null,
      { collection: 'orders', item: '1' },
      {
        user: ana,
        isAdmin: false,
        tenantKey: ''
      }
    )) as AsyncIterableIterator<unknown>
    const itBob = (await wf(
      null,
      { collection: 'orders', item: '1' },
      {
        user: bob,
        isAdmin: false,
        tenantKey: ''
      }
    )) as AsyncIterableIterator<unknown>
    pubsub.publish(topics.workflowStateChanged('orders', '1', ''), {
      workflowStateChanged: { collection: 'orders', item: '1', instance_id: 5 }
    })
    const [a, b] = await Promise.all([firstWithin(itAna, 30), firstWithin(itBob, 30)])
    expect(a).toEqual({
      workflowStateChanged: {
        collection: 'orders',
        item: '1',
        instance: { id: 5, built_for_role: 'R-APPROVER' }
      }
    })
    expect(
      (b as { workflowStateChanged: { instance: unknown } }).workflowStateChanged.instance
    ).toEqual({ id: 5, built_for_role: 'R-VIEWER' })
  })

  it('skips an event for a record the subscriber can no longer read', async () => {
    instances()
    const it = (await pl(
      null,
      { collection: 'orders', item: '1' },
      {
        user: bob,
        isAdmin: false,
        tenantKey: ''
      }
    )) as AsyncIterableIterator<unknown>
    vi.mocked(assertInstanceAccess).mockRejectedValueOnce(new Error('404'))
    pubsub.publish(topics.pipelineStateChanged('orders', '1', ''), {
      pipelineStateChanged: { collection: 'orders', item: '1', instance_id: 5 }
    })
    expect(await firstWithin(it, 30)).toBeNull()
  })

  it('refuses the subscription when the subscriber cannot read the record', async () => {
    vi.mocked(assertInstanceAccess).mockRejectedValueOnce(new Error('404'))
    await expect(
      wf(null, { collection: 'orders', item: '1' }, { user: bob, isAdmin: false, tenantKey: '' })
    ).rejects.toThrow(/permission/)
  })
})
