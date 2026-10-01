import { describe, expect, it } from 'vitest'
import { config } from '../../../config.js'
import { partitionSelf } from '../../../services/environment-self.js'

const envs = [
  { id: 1, name: 'Local dev' },
  { id: 2, name: 'Staging' },
  { id: 3, name: 'Production' }
]

describe('partitionSelf', () => {
  it('names This instance after the component that points back at this API', () => {
    const comps = [
      { name: 'API', environment: 1, base_url: `http://localhost:${config.PORT}` },
      { name: 'API', environment: 2, base_url: 'https://staging.example.com' },
      { name: 'API', environment: 3, base_url: 'https://prod.example.com' }
    ]
    const r = partitionSelf(comps, envs, `localhost:${config.PORT}`)
    expect(r.selfEnvironment).toBe('Local dev')
    expect(r.probe.map((c) => c.environment)).toEqual([2, 3])
    expect(r.skipped).toHaveLength(1)
  })

  it('prefers a named-host match over loopback, and skips loopback on other ports', () => {
    const comps = [
      { name: 'API', environment: 1, base_url: 'http://localhost:3999' },
      { name: 'API', environment: 2, base_url: 'https://staging.example.com' }
    ]
    const r = partitionSelf(comps, envs, 'staging.example.com')
    expect(r.selfEnvironment).toBe('Staging')
    expect(r.probe).toHaveLength(0)
    expect(r.skipped.map((s) => s.environment)).toEqual(['Local dev', 'Staging'])
  })
})
