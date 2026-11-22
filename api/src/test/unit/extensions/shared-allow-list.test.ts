import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub phase 6 Task 8: a Hub shared deployment loads only the extensions in HUB_SHARED_EXTENSIONS
// (and never imports another folder's code); a listed id that did not load fails the readiness
// check `shared-extensions`. Self-hosted and Nivaro Cloud load every extension, as before.

vi.mock('../../../services/readiness.js', () => ({
  registerReadinessCheck: vi.fn(),
  retireReadinessCheck: vi.fn()
}))

const loader = await import('../../../extensions/loader.js')

const saved = { ...process.env }
function hub(list?: string) {
  delete process.env.CLOUD_META_DB_URL
  process.env.HUB_SHARED_DEPLOYMENT = 'shared-a'
  process.env.HUB_URL = 'https://hub.example'
  process.env.HUB_DEPLOYMENT_TOKEN = 't'.repeat(40)
  if (list === undefined) delete process.env.HUB_SHARED_EXTENSIONS
  else process.env.HUB_SHARED_EXTENSIONS = list
}
beforeEach(() => {
  delete process.env.HUB_SHARED_DEPLOYMENT
  delete process.env.CLOUD_META_DB_URL
  delete process.env.HUB_SHARED_EXTENSIONS
})
afterEach(() => {
  process.env = { ...saved }
})

describe('shared extension allow-list', () => {
  it('HUB_SHARED_EXTENSIONS=a on a shared deployment loads only a (folders and ids)', () => {
    hub('a')
    expect(loader.sharedExtensionAllowList()).toEqual(['a'])
    expect(loader.allowedExtensionDirs(['a', 'b', 'c'])).toEqual(['a'])
    expect(loader.extensionIdAllowed('a')).toBe(true)
    expect(loader.extensionIdAllowed('b')).toBe(false)
  })

  it('reads a comma list with spaces and duplicates; nothing listed loads nothing', () => {
    hub(' a , b,a,, ')
    expect(loader.sharedExtensionAllowList()).toEqual(['a', 'b'])
    hub()
    expect(loader.sharedExtensionAllowList()).toEqual([])
    expect(loader.allowedExtensionDirs(['a', 'b'])).toEqual([])
  })

  it('self-hosted loads every extension, as before', () => {
    process.env.HUB_SHARED_EXTENSIONS = 'a' // ignored off a shared deployment
    expect(loader.sharedExtensionAllowList()).toBeNull()
    expect(loader.allowedExtensionDirs(['a', 'b', 'c'])).toEqual(['a', 'b', 'c'])
    expect(loader.extensionIdAllowed('b')).toBe(true)
  })

  it('Nivaro Cloud loads every extension, as before', () => {
    process.env.CLOUD_META_DB_URL = 'postgres://meta'
    process.env.HUB_SHARED_EXTENSIONS = 'a'
    expect(loader.sharedExtensionAllowList()).toBeNull()
    expect(loader.allowedExtensionDirs(['a', 'b'])).toEqual(['a', 'b'])
  })
})

describe('readiness shared-extensions', () => {
  it('fails when a listed extension did not load, naming it', () => {
    const r = loader.judgeSharedExtensions(['a', 'b'], ['a'])
    expect(r.status).toBe('fail')
    expect(r.detail).toContain('b')
    expect(r.detail).not.toMatch(/\ba\b.*\bnot\b/)
  })

  it('passes when every listed extension loaded', () => {
    expect(loader.judgeSharedExtensions(['a'], ['a']).status).toBe('pass')
    expect(loader.judgeSharedExtensions([], []).status).toBe('pass')
  })

  it('is registered as shared-extensions and skips off a shared deployment', async () => {
    const { registerReadinessCheck } = await import('../../../services/readiness.js')
    loader.registerSharedExtensionsReadiness()
    const call = vi
      .mocked(registerReadinessCheck)
      .mock.calls.find((c) => (c[0] as { id: string }).id === 'shared-extensions')
    expect(call).toBeTruthy()
    const check = call?.[0] as { run: () => Promise<{ status: string; detail: string }> }
    expect((await check.run()).status).toBe('skip')
    hub('a,b')
    const r = await check.run()
    expect(r.status).toBe('fail') // nothing loaded in this test process
    expect(r.detail).toContain('a')
    expect(r.detail).toContain('b')
  })
})
