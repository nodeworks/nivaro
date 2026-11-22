import { describe, expect, it } from 'vitest'
import {
  cloudMetaDbUrl,
  deploymentModeProblem,
  hubSharedConfig,
  isMultiTenant,
  isNivaroCloud,
  perAppJobs,
  tenantSource
} from '../../../services/deployment-mode.js'

const TOKEN = 'x'.repeat(32)
const shared = {
  HUB_SHARED_DEPLOYMENT: 'shared-a',
  HUB_URL: 'https://hub.example',
  HUB_DEPLOYMENT_TOKEN: TOKEN
}

describe('deployment-mode predicates', () => {
  const table: Array<[string, NodeJS.ProcessEnv, boolean, boolean, boolean, string | null]> = [
    ['empty', {}, false, false, false, null],
    ['cloud', { CLOUD_META_DB_URL: 'postgres://x' }, true, true, false, 'cloud-meta'],
    ['cloud blank-ish', { CLOUD_META_DB_URL: ' ' }, true, true, false, 'cloud-meta'],
    ['cloud empty string', { CLOUD_META_DB_URL: '' }, false, false, false, null],
    ['shared', shared, false, true, true, 'hub'],
    ['shared key blank', { HUB_SHARED_DEPLOYMENT: '  ' }, false, false, false, null]
  ]
  it.each(table)('%s', (_n, env, cloud, multi, perApp, source) => {
    expect(isNivaroCloud(env)).toBe(cloud)
    expect(isMultiTenant(env)).toBe(multi)
    expect(perAppJobs(env)).toBe(perApp)
    expect(tenantSource(env)).toBe(source)
  })

  it('shared is valid with no problem', () => {
    expect(deploymentModeProblem(shared)).toBeNull()
    expect(hubSharedConfig(shared)).toEqual({
      deployment: 'shared-a',
      hubUrl: 'https://hub.example',
      token: TOKEN
    })
    expect(hubSharedConfig({})).toBeNull()
    expect(cloudMetaDbUrl({ CLOUD_META_DB_URL: 'postgres://x' })).toBe('postgres://x')
    expect(cloudMetaDbUrl({})).toBeNull()
  })

  it('parity: without HUB_SHARED_DEPLOYMENT both predicates equal the old truthiness', () => {
    const forms = [undefined, '', ' ', '  ', 'postgres://x', '0', 'false', 'off', 'no', 'a']
    for (const v of forms) {
      const env: NodeJS.ProcessEnv = v === undefined ? {} : { CLOUD_META_DB_URL: v }
      const old = !!env.CLOUD_META_DB_URL
      expect(isNivaroCloud(env)).toBe(old)
      expect(isMultiTenant(env)).toBe(old)
      expect(perAppJobs(env)).toBe(false)
      expect(deploymentModeProblem(env)).toBeNull()
    }
  })

  const bad: Array<[string, NodeJS.ProcessEnv]> = [
    ['with cloud', { ...shared, CLOUD_META_DB_URL: 'postgres://x' }],
    ['with HUB=on', { ...shared, HUB: 'on' }],
    ['no url', { ...shared, HUB_URL: undefined }],
    ['http remote', { ...shared, HUB_URL: 'http://hub.example' }],
    ['short token', { ...shared, HUB_DEPLOYMENT_TOKEN: 'y'.repeat(31) }],
    ['bad key', { ...shared, HUB_SHARED_DEPLOYMENT: 'Bad_Key' }]
  ]
  it.each(bad)('problem: %s', (_n, env) => {
    const p = deploymentModeProblem(env)
    expect(p).toBeTruthy()
    expect(p).not.toContain(TOKEN)
    expect(p).not.toContain('y'.repeat(31))
  })

  it('loopback http is fine', () => {
    expect(deploymentModeProblem({ ...shared, HUB_URL: 'http://127.0.0.1:3095' })).toBeNull()
  })
})
