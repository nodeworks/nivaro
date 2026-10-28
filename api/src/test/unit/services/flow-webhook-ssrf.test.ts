import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Review A3 (2026-10-27): the flow webhook / custom external-api ops are SSRF-guarded in cloud
// mode only — self-hosted flows reach internal services on purpose, like external API configs.

vi.mock('../../../services/chain-columns.js', () => ({ chainFields: vi.fn(async () => ({})) }))

import { db } from '../../../db/index.js'
import { executeFlow } from '../../../services/flow-executor.js'

function chainFor(table: string, ops: unknown[]) {
  const chain: Record<string, unknown> = {
    select: vi.fn().mockResolvedValue([]),
    insert: vi.fn(() => {
      const r = Promise.resolve([1]) as Promise<unknown> & { returning?: unknown }
      r.returning = vi.fn().mockResolvedValue([{ id: 1 }])
      return r
    }),
    update: vi.fn().mockResolvedValue(1),
    first: vi.fn(async () => null),
    count: vi.fn().mockResolvedValue([{ total: 0 }])
  }
  for (const m of ['where', 'orderBy', 'limit', 'offset', 'whereIn', 'whereNull']) {
    chain[m] = vi.fn(() => chain)
  }
  if (table === 'nivaro_flow_operations') {
    // biome-ignore lint/suspicious/noThenProperty: a knex builder is a thenable
    chain.then = (resolve: (v: unknown[]) => void) => resolve(ops)
  }
  return chain
}

const op = (type: string, options: Record<string, unknown>) => ({
  id: 'op-1',
  flow: 'flow-1',
  name: 'Call',
  key: 'call',
  type,
  position_x: 0,
  position_y: 0,
  options: JSON.stringify(options),
  resolve: null,
  reject: null
})

let fetchMock: ReturnType<typeof vi.fn>
const savedCloud = process.env.CLOUD_META_DB_URL

beforeEach(() => {
  fetchMock = vi.fn(
    async () =>
      new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
  )
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.mocked(db as unknown as (t: string) => unknown).mockReset()
  if (savedCloud === undefined) delete process.env.CLOUD_META_DB_URL
  else process.env.CLOUD_META_DB_URL = savedCloud
})

async function run(ops: unknown[]) {
  vi.mocked(db as unknown as (t: string) => unknown).mockImplementation((t: string) =>
    chainFor(t, ops)
  )
  return executeFlow({
    flowId: 'flow-1',
    flowName: 'Test',
    trigger: 'test',
    payload: { collection: 'workflows', item: '1' },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never
  })
}

describe('flow outbound calls to an internal host', () => {
  it('self-hosted: the webhook op reaches it', async () => {
    delete process.env.CLOUD_META_DB_URL
    await run([op('webhook', { url: 'http://10.0.0.5:8080/hook' })])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe('http://10.0.0.5:8080/hook')
  })

  it('self-hosted: the custom external-api op reaches it', async () => {
    delete process.env.CLOUD_META_DB_URL
    await run([op('external-api', { mode: 'custom', url: 'http://127.0.0.1:9000/x' })])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('cloud: the webhook op is refused before any request', async () => {
    process.env.CLOUD_META_DB_URL = 'mssql://meta'
    const out = await run([op('webhook', { url: 'http://10.0.0.5:8080/hook' })])
    expect(fetchMock).not.toHaveBeenCalled()
    expect(JSON.stringify(out)).toContain('URL not allowed')
  })
})
