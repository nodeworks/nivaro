import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { NivaroClient } from '@nivaro/sdk'
import { describe, expect, it, vi } from 'vitest'
import { createNivaroMcpServer } from './index.js'
import { parseRecordUri, recordUri, type SubscriptionHost } from './record-resource.js'
import { mockClient } from './test-utils.js'

async function connectWith(client: NivaroClient, subscriptions?: SubscriptionHost) {
  const { server } = createNivaroMcpServer({ url: 'http://nivaro.test', client, subscriptions })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const mcp = new Client({ name: 'test', version: '0.0.0' })
  await server.connect(serverTransport)
  await mcp.connect(clientTransport)
  return mcp
}

describe('record URIs', () => {
  it('round-trip a collection and id', () => {
    const uri = recordUri('work_orders', 'a b/7')
    expect(uri).toBe('nivaro://record/work_orders/a%20b%2F7')
    expect(parseRecordUri(uri)).toEqual({ collection: 'work_orders', id: 'a b/7' })
  })

  it('refuse anything that is not one record', () => {
    expect(parseRecordUri('nivaro://collection/articles')).toBeNull()
    expect(parseRecordUri('nivaro://record/articles')).toBeNull()
    expect(parseRecordUri('nivaro://record/articles/7/extra')).toBeNull()
    expect(parseRecordUri('nivaro://record/orders%3A5/7')).toBeNull()
    expect(parseRecordUri('https://record/articles/7')).toBeNull()
  })
})

describe('record resource', () => {
  it('reads one record as the key user', async () => {
    const { client, calls } = mockClient(() => ({ data: { id: 7, title: 'Hello' } }))
    const mcp = await connectWith(client)
    const res = await mcp.readResource({ uri: 'nivaro://record/articles/7' })
    expect(JSON.parse(String((res.contents[0] as { text: string }).text))).toEqual({
      id: 7,
      title: 'Hello'
    })
    expect(calls[0]).toMatchObject({ _method: 'GET', _path: '/items/articles/7' })
  })

  it('does not advertise subscriptions without a host (stdio, stateless)', async () => {
    const { client } = mockClient(() => ({ data: {} }))
    const mcp = await connectWith(client)
    expect(mcp.getServerCapabilities()?.resources?.subscribe).toBeFalsy()
    await expect(mcp.subscribeResource({ uri: 'nivaro://record/articles/7' })).rejects.toThrow()
  })

  it('subscribes and unsubscribes through the host', async () => {
    const { client } = mockClient(() => ({ data: {} }))
    const host: SubscriptionHost = {
      subscribe: vi.fn(async () => null),
      unsubscribe: vi.fn(async () => {})
    }
    const mcp = await connectWith(client, host)
    expect(mcp.getServerCapabilities()?.resources?.subscribe).toBe(true)
    await mcp.subscribeResource({ uri: 'nivaro://record/articles/7' })
    expect(host.subscribe).toHaveBeenCalledWith({
      uri: 'nivaro://record/articles/7',
      collection: 'articles',
      id: '7'
    })
    await mcp.unsubscribeResource({ uri: 'nivaro://record/articles/7' })
    expect(host.unsubscribe).toHaveBeenCalledWith('nivaro://record/articles/7')
  })

  it('passes the host refusal back and refuses non-record URIs', async () => {
    const { client } = mockClient(() => ({ data: {} }))
    const host: SubscriptionHost = {
      subscribe: vi.fn(async () => ({
        error: 'You cannot read this record',
        code: 'NOT_FOUND' as const
      })),
      unsubscribe: vi.fn(async () => {})
    }
    const mcp = await connectWith(client, host)
    await expect(mcp.subscribeResource({ uri: 'nivaro://record/articles/9' })).rejects.toThrow(
      /cannot read this record/
    )
    await expect(mcp.subscribeResource({ uri: 'nivaro://collections' })).rejects.toThrow(
      /Only records/
    )
    expect(host.subscribe).toHaveBeenCalledTimes(1)
  })
})
