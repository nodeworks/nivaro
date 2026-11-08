import { beforeEach, describe, expect, it, vi } from 'vitest'

const rows: Array<Record<string, unknown>> = []
vi.mock('../../../db/index.js', () => {
  const chain: any = {
    where: vi.fn(() => chain),
    select: vi.fn(() => chain),
    catch: vi.fn(() => Promise.resolve(rows)),
    then: (res: (v: unknown) => unknown) => Promise.resolve(rows).then(res)
  }
  return { db: vi.fn(() => chain) }
})
vi.mock('../../../services/external-apis.js', () => ({
  mockConfigFor: (r: { mock_config?: string | null }) => !!r.mock_config,
  resolveAuth: vi.fn(),
  resolveInstanceRow: (r: unknown) => r
}))

const { healthProbeTargets } = await import('../../../services/external-api-health.js')

describe('healthProbeTargets — which partners the 5-minute probe watches', () => {
  beforeEach(() => {
    rows.length = 0
  })

  it('watches an oauth2_cc partner with no health path through its token endpoint', async () => {
    rows.push(
      { id: 1, name: 'MWF', health_path: null, auth_type: 'oauth2_cc', mock_config: null },
      { id: 2, name: 'Plain', health_path: '/ping', auth_type: 'api_key', mock_config: null },
      { id: 3, name: 'NoCheck', health_path: null, auth_type: 'api_key', mock_config: null },
      { id: 4, name: 'Mocked', health_path: null, auth_type: 'oauth2_cc', mock_config: '{}' }
    )
    const t = await healthProbeTargets()
    expect(t.map((x) => x.name)).toEqual(['MWF', 'Plain'])
    expect(t[0].path).toBe('(token endpoint)')
    expect(t[1].path).toBe('/ping')
  })
})
