import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CACHE_SETTINGS,
  cacheSetting,
  coerceSetting,
  effectiveCacheConfig,
  envSetting,
  mergeCacheConfigPatch,
  onCacheConfigChange,
  setStoredCacheConfigForTests
} from '../../../services/cache-config.js'
import {
  cachedAccess,
  permissionCacheEnabled,
  permissionCacheStats,
  providePermissionCacheWiring,
  resetPermissionCacheForTests
} from '../../../services/permission-cache.js'
import { listTotalTtlMs } from '../../../services/read-caches.js'

// Cache switches as configuration (2026-10-27): env wins when set, else this instance's
// stored `cache` key, else the default; switches move at run time.

const ENV_KEYS = CACHE_SETTINGS.map((d) => d.env)
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  delete process.env.CLOUD_META_DB_URL
  setStoredCacheConfigForTests(null)
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  setStoredCacheConfigForTests(null)
})

const def = (key: string) => {
  const d = CACHE_SETTINGS.find((x) => x.key === key)
  if (!d) throw new Error(key)
  return d
}

describe('precedence', () => {
  it('default when nothing is set', () => {
    expect(cacheSetting('permission.enabled')).toBe(false)
    expect(cacheSetting('list_total.ttl_ms')).toBe(30_000)
    expect(cacheSetting('warm.mode')).toBe('auto')
    const row = effectiveCacheConfig().find((e) => e.key === 'identity.ttl_ms')
    expect(row?.source).toBe('default')
  })

  it('stored config beats the default', () => {
    setStoredCacheConfigForTests({ permission: { enabled: true }, list_total: { ttl_ms: 0 } })
    expect(cacheSetting('permission.enabled')).toBe(true)
    expect(cacheSetting('list_total.ttl_ms')).toBe(0)
    expect(listTotalTtlMs()).toBe(0)
    const row = effectiveCacheConfig().find((e) => e.key === 'permission.enabled')
    expect(row).toMatchObject({ source: 'config', stored: true, value: true })
  })

  it('env beats stored config, and is read live', () => {
    setStoredCacheConfigForTests({ permission: { enabled: true }, warm: { mode: 'on' } })
    process.env.PERMISSION_CACHE = 'off'
    process.env.CACHE_WARM = 'off'
    expect(cacheSetting('permission.enabled')).toBe(false)
    expect(cacheSetting('warm.mode')).toBe('off')
    const row = effectiveCacheConfig().find((e) => e.key === 'warm.mode')
    expect(row).toMatchObject({ source: 'env', env_value: 'off', stored: 'on' })
    delete process.env.CACHE_WARM
    expect(cacheSetting('warm.mode')).toBe('on')
  })

  it('an env value that means nothing falls through (no silent default pin)', () => {
    setStoredCacheConfigForTests({ list_total: { ttl_ms: 5000 }, warm: { mode: 'off' } })
    process.env.LIST_TOTAL_CACHE_MS = 'abc'
    process.env.CACHE_WARM = 'sometimes'
    expect(cacheSetting('list_total.ttl_ms')).toBe(5000)
    expect(cacheSetting('warm.mode')).toBe('off')
  })

  it('cloud mode never reads the stored layer and keeps the permission cache off', () => {
    process.env.CLOUD_META_DB_URL = 'x'
    setStoredCacheConfigForTests({ permission: { enabled: true }, label: { ttl_ms: 1000 } })
    process.env.PERMISSION_CACHE = 'on'
    expect(cacheSetting('permission.enabled')).toBe(false)
    expect(cacheSetting('label.ttl_ms')).toBe(30_000)
    delete process.env.CLOUD_META_DB_URL
  })
})

describe('env meanings kept', () => {
  it('PERMISSION_CACHE is on only for "on"; METADATA_L2 off only for "off"', () => {
    expect(envSetting(def('permission.enabled'), { PERMISSION_CACHE: 'on' })).toBe(true)
    expect(envSetting(def('permission.enabled'), { PERMISSION_CACHE: 'true' })).toBe(false)
    expect(envSetting(def('metadata_l2.enabled'), { METADATA_L2: 'off' })).toBe(false)
    expect(envSetting(def('metadata_l2.enabled'), { METADATA_L2: 'yes' })).toBe(true)
  })

  it('ints clamp to their range; non-positive means unset where the minimum is positive', () => {
    expect(envSetting(def('permission.ttl_ms'), { PERMISSION_CACHE_TTL_MS: '999999' })).toBe(60_000)
    expect(envSetting(def('permission.ttl_ms'), { PERMISSION_CACHE_TTL_MS: '0' })).toBeUndefined()
    expect(envSetting(def('list_total.ttl_ms'), { LIST_TOTAL_CACHE_MS: '0' })).toBe(0)
    expect(envSetting(def('list_total.ttl_ms'), { LIST_TOTAL_CACHE_MS: '-5' })).toBeUndefined()
    expect(coerceSetting(def('identity.ttl_ms'), 60_000)).toBe(5_000)
  })
})

describe('mergeCacheConfigPatch', () => {
  it('sets, coerces and clears (null) values; unknown keys and bad values refuse', () => {
    const next = mergeCacheConfigPatch(
      { permission: { enabled: false, ttl_ms: 20000 } },
      { 'permission.enabled': 'on', 'permission.ttl_ms': null, 'warm.mode': 'off' }
    )
    expect(next).toEqual({ permission: { enabled: true }, warm: { mode: 'off' } })
    expect(() => mergeCacheConfigPatch({}, { 'nope.x': 1 })).toThrow(/Unknown/)
    expect(() => mergeCacheConfigPatch({}, { 'warm.mode': 'sometimes' })).toThrow(/Invalid/)
    expect(mergeCacheConfigPatch({ label: { ttl_ms: 5 } }, { 'label.ttl_ms': null })).toEqual({})
  })
})

describe('run-time switch', () => {
  beforeEach(() => resetPermissionCacheForTests())

  it('a stored change fires the listeners with what moved', () => {
    setStoredCacheConfigForTests({})
    const seen: string[][] = []
    const off = onCacheConfigChange((changed) => seen.push([...changed]))
    setStoredCacheConfigForTests({ identity: { ttl_ms: 1000 } })
    off()
    expect(seen).toEqual([['identity.ttl_ms']])
  })

  it('the permission cache follows the config, attaches its seams and drops entries on a move', async () => {
    setStoredCacheConfigForTests({})
    const on = vi.fn()
    const client = { on }
    providePermissionCacheWiring({ redis: null, clients: [client] })
    expect(permissionCacheEnabled()).toBe(false)
    expect(on).not.toHaveBeenCalled()

    setStoredCacheConfigForTests({ permission: { enabled: true } })
    expect(permissionCacheEnabled()).toBe(true)
    // query / query-response / query-error seams on the provided client
    expect(on.mock.calls.map((c) => c[0])).toEqual(['query', 'query-response', 'query-error'])
    const resets = Number(permissionCacheStats().resets)

    setStoredCacheConfigForTests({ permission: { enabled: false } })
    expect(permissionCacheEnabled()).toBe(false)
    expect(Number(permissionCacheStats().resets)).toBeGreaterThan(resets)
    // Off: straight to the compute, nothing kept.
    const compute = vi.fn(async () => 1)
    await cachedAccess({ id: 'u' } as never, 'op', 'q', compute, (v) => v)
    await cachedAccess({ id: 'u' } as never, 'op', 'q', compute, (v) => v)
    expect(compute).toHaveBeenCalledTimes(2)
    expect(permissionCacheStats().entries).toBe(0)
  })
})
