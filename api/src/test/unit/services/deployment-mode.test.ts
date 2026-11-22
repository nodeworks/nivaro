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

  // Hub variables WITHOUT a shared key change nothing: a Hub (HUB=on), an app the Hub watches
  // (HUB_TOKEN) and a stray HUB_URL + HUB_DEPLOYMENT_TOKEN stay self-hosted, and stay cloud when
  // CLOUD_META_DB_URL is set — with exactly the cloud values.
  const hubOnly: Array<[string, NodeJS.ProcessEnv]> = [
    ['HUB=on', { HUB: 'on' }],
    ['HUB_TOKEN', { HUB_TOKEN: 'x'.repeat(32) }],
    [
      'HUB_URL + HUB_DEPLOYMENT_TOKEN',
      { HUB_URL: 'https://hub.example', HUB_DEPLOYMENT_TOKEN: TOKEN }
    ]
  ]
  it.each(hubOnly)('parity with %s: self-hosted stays self-hosted', (_n, env) => {
    expect(isNivaroCloud(env)).toBe(false)
    expect(isMultiTenant(env)).toBe(false)
    expect(perAppJobs(env)).toBe(false)
    expect(tenantSource(env)).toBeNull()
    expect(hubSharedConfig(env)).toBeNull()
    expect(deploymentModeProblem(env)).toBeNull()
  })
  it.each(hubOnly)('parity with %s: cloud stays exactly cloud', (_n, env) => {
    const cloud = { CLOUD_META_DB_URL: 'postgres://x' }
    const withHub = { ...env, ...cloud }
    expect(isNivaroCloud(withHub)).toBe(isNivaroCloud(cloud))
    expect(isMultiTenant(withHub)).toBe(isMultiTenant(cloud))
    expect(perAppJobs(withHub)).toBe(perAppJobs(cloud))
    expect(tenantSource(withHub)).toBe(tenantSource(cloud))
    expect(hubSharedConfig(withHub)).toBeNull()
    expect(deploymentModeProblem(withHub)).toBeNull()
  })

  it('hubSharedConfig is null when cloud and a shared key are both set', () => {
    expect(hubSharedConfig({ ...shared, CLOUD_META_DB_URL: 'postgres://x' })).toBeNull()
  })

  const bad: Array<[string, NodeJS.ProcessEnv, RegExp]> = [
    ['with cloud', { ...shared, CLOUD_META_DB_URL: 'postgres://x' }, /CLOUD_META_DB_URL/],
    ['with HUB=on', { ...shared, HUB: 'on' }, /HUB=on/],
    ['no url', { ...shared, HUB_URL: undefined }, /needs HUB_URL/],
    ['blank url', { ...shared, HUB_URL: '  ' }, /needs HUB_URL/],
    ['http remote', { ...shared, HUB_URL: 'http://hub.example' }, /https/],
    ['short token', { ...shared, HUB_DEPLOYMENT_TOKEN: 'y'.repeat(31) }, /32/],
    ['bad key', { ...shared, HUB_SHARED_DEPLOYMENT: 'Bad_Key' }, /lowercase/]
  ]
  it.each(bad)('problem: %s', (_n, env, keyword) => {
    const p = deploymentModeProblem(env)
    expect(p).toMatch(keyword)
    expect(p).not.toContain(TOKEN)
    expect(p).not.toContain('y'.repeat(31))
  })

  it('loopback http is fine', () => {
    expect(deploymentModeProblem({ ...shared, HUB_URL: 'http://127.0.0.1:3095' })).toBeNull()
  })
})
