import { afterEach, describe, expect, it, vi } from 'vitest'

const emitted: string[] = []
vi.mock('../../../services/io-holder.js', () => ({
  getIo: () => ({
    sockets: { adapter: { rooms: new Map([['t:a:watch:ai-calls', new Set(['s'])]]) } },
    to: (room: string) => ({ emit: () => emitted.push(room) })
  })
}))
const tenant = { id: '' as string | null }
vi.mock('../../../db/tenant-context.js', () => ({ getTenantId: () => tenant.id }))

import { emitAiCallLive } from '../../../services/ai-quality.js'

const call = {
  at: '',
  request_id: null,
  feature: 'chat',
  model: 'm',
  provider: 'p',
  user: null,
  status: 'ok' as const,
  latency_ms: 1,
  cost_usd: 0,
  input_tokens: 1,
  output_tokens: 1
}
afterEach(() => {
  emitted.length = 0
  delete process.env.CLOUD_META_DB_URL
})

describe('emitAiCallLive', () => {
  it('emits to the tenant-scoped room in cloud mode', async () => {
    process.env.CLOUD_META_DB_URL = 'x'
    tenant.id = 'a'
    emitAiCallLive(call)
    await new Promise((r) => setTimeout(r, 20))
    expect(emitted).toEqual(['t:a:watch:ai-calls'])
  })
  it('emits nothing in cloud mode without a tenant', async () => {
    process.env.CLOUD_META_DB_URL = 'x'
    tenant.id = null
    emitAiCallLive(call)
    await new Promise((r) => setTimeout(r, 20))
    expect(emitted).toEqual([])
  })
})
