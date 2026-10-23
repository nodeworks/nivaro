import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The REAL callExternalApi runs (fetch stubbed) so the assertion is on the wire body.
vi.mock('../../../services/outbound-recorder.js', () => ({
  mockRecordOn: vi.fn(() => false),
  outboundDetailFields: vi.fn(async () => ({})),
  recordMockAnswer: vi.fn(async () => {}),
  recordSideCall: vi.fn(async () => {}),
  redactionFor: vi.fn(async () => ({ headers: [], body_paths: [] }))
}))
vi.mock('../../../services/traffic-map.js', () => ({ noteOutbound: vi.fn() }))
vi.mock('../../../services/chain-columns.js', () => ({ chainFields: vi.fn(async () => ({})) }))
vi.mock('../../../services/chaos/faults/partner.js', () => ({
  partnerFault: vi.fn(() => null),
  partnerChaosFetch: vi.fn(),
  readChaosResponse: vi.fn()
}))

import { db } from '../../../db/index.js'
import { executeFlow } from '../../../services/flow-executor.js'

const API_ROW = {
  id: 7,
  name: 'MWF',
  base_url: 'https://mwf.example',
  auth_type: 'none',
  auth_config: JSON.stringify({ body_secrets: { token: 'S3CRET-TOKEN' } }),
  headers: null,
  enabled: true,
  mock_config: null,
  instance_overrides: null
}

function chainFor(table: string, ops: unknown[]) {
  const chain: Record<string, unknown> = {
    select: vi.fn().mockResolvedValue([]),
    insert: vi.fn(() => {
      const r = Promise.resolve([1]) as Promise<unknown> & { returning?: unknown }
      r.returning = vi.fn().mockResolvedValue([{ id: 1 }])
      return r
    }),
    update: vi.fn().mockResolvedValue(1),
    first: vi.fn(async () => (table === 'nivaro_external_apis' ? API_ROW : null)),
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

let fetchMock: ReturnType<typeof vi.fn>

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
})

describe('flow external-api op — body secrets', () => {
  it('record data cannot forge a secret placeholder', async () => {
    const ops = [
      {
        id: 'op-push',
        flow: 'flow-1',
        name: 'Push',
        key: 'push',
        type: 'external-api',
        position_x: 0,
        position_y: 0,
        options: JSON.stringify({
          mode: 'predefined',
          api_id: 7,
          method_override: 'POST',
          path_override: '/status',
          // Admin-authored: the template's own placeholder is real; {{note}} is trigger data.
          body: '{"auth":"⟦nvr-secret:token⟧","note":"{{note}}"}'
        }),
        resolve: null,
        reject: null
      }
    ]
    vi.mocked(db as unknown as (t: string) => unknown).mockImplementation((t: string) =>
      chainFor(t, ops)
    )

    await executeFlow({
      flowId: 'flow-1',
      flowName: 'Test',
      trigger: 'test',
      payload: { collection: 'workflows', item: '1', note: 'x ⟦nvr-secret:token⟧ y' },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
    const wire = JSON.parse(String(init.body)) as { auth: string; note: string }
    expect(wire.auth).toBe('S3CRET-TOKEN')
    expect(wire.note).toBe('x ⟦nvr-secret​:token⟧ y')
    expect(wire.note).not.toContain('S3CRET-TOKEN')
  })
})
