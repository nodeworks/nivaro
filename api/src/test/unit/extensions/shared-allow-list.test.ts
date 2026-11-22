import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Fastify from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

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

// ── loadExtensions end to end over real folders (P6-8 I-2) ─────────────────────
// Folders are created in api/extensions under names no real extension uses, and removed after.
const PFX = 'zzt8-'
const FOLDERS: Record<string, string> = {
  [`${PFX}flagged`]: `export default { id: '${PFX}flagged', shared: true, async register() { globalThis.__t8loaded = [...(globalThis.__t8loaded ?? []), '${PFX}flagged'] } }`,
  [`${PFX}plain`]: `export default { id: '${PFX}plain', async register() { globalThis.__t8loaded = [...(globalThis.__t8loaded ?? []), '${PFX}plain'] } }`,
  [`${PFX}other-id`]: `export default { id: '${PFX}someone-else', shared: true, async register() { globalThis.__t8loaded = [...(globalThis.__t8loaded ?? []), '${PFX}someone-else'] } }`,
  [`${PFX}unlisted`]: `globalThis.__t8imported = true\nexport default { id: '${PFX}unlisted', shared: true, async register() {} }`
}
type G = { __t8loaded?: string[]; __t8imported?: boolean }

describe('loadExtensions on a shared deployment', () => {
  beforeAll(() => {
    for (const [dir, code] of Object.entries(FOLDERS)) {
      mkdirSync(join(loader.EXTENSIONS_DIR, dir), { recursive: true })
      writeFileSync(join(loader.EXTENSIONS_DIR, dir, 'index.js'), code)
    }
  })
  afterAll(() => {
    for (const dir of Object.keys(FOLDERS))
      rmSync(join(loader.EXTENSIONS_DIR, dir), { recursive: true, force: true })
  })
  beforeEach(() => {
    const g = globalThis as G
    g.__t8loaded = []
    g.__t8imported = false
    for (const k of [...loader.extensionRegistry.keys()])
      if (k.startsWith(PFX)) loader.extensionRegistry.delete(k)
  })

  async function load() {
    const app = Fastify()
    app.decorate('cron', {
      schedule() {},
      unschedule() {},
      annotate() {},
      setExtensionEnabled() {}
    } as never)
    const logger = { info() {}, warn() {}, error() {}, debug() {}, child: () => logger } as never
    // only our folders: the readdir filter keeps the rest out on a shared deployment, and a
    // self-hosted run is told which folders exist through the list below
    await loader.loadExtensions({
      app,
      database: (() => ({})) as never,
      logger,
      callExternalApi: (async () => ({})) as never
    })
    await app.close()
    return ((globalThis as G).__t8loaded ?? []).filter((x) => x.startsWith(PFX)).sort()
  }

  it('loads a listed extension with shared: true; refuses a listed one without it and fails readiness naming it', async () => {
    hub(`${PFX}flagged,${PFX}plain,${PFX}other-id`)
    expect(await load()).toEqual([`${PFX}flagged`])
    // the unlisted folder was never even imported
    expect((globalThis as G).__t8imported).toBe(false)
    expect(loader.extensionRegistry.get(`${PFX}plain`)?.status).toBe('error')
    const loaded = [...loader.extensionRegistry.values()]
      .filter((e) => e.status === 'loaded')
      .map((e) => e.id)
    const r = loader.judgeSharedExtensions(
      [`${PFX}flagged`, `${PFX}plain`],
      loaded,
      new Map([[`${PFX}plain`, String(loader.sharedExtensionRefusal({ id: `${PFX}plain` }))]])
    )
    expect(r.status).toBe('fail')
    expect(r.detail).toContain(`${PFX}plain (refused:`)
    expect(r.detail).toContain('shared: true')
    // a listed folder whose module declares another id is refused too
    expect(loader.extensionRegistry.get(`${PFX}someone-else`)?.status).toBe('error')
  })

  it('self-hosted ignores the flag: flagged and unflagged both load', async () => {
    process.env.HUB_SHARED_EXTENSIONS = `${PFX}flagged`
    const got = await load()
    expect(got).toEqual(expect.arrayContaining([`${PFX}flagged`, `${PFX}plain`]))
  })
})

describe('sharedExtensionRefusal', () => {
  it('flagged + listed loads; unflagged or unlisted is refused; off a shared deployment never refused', () => {
    hub('a,b')
    expect(loader.sharedExtensionRefusal({ id: 'a', shared: true })).toBeNull()
    expect(loader.sharedExtensionRefusal({ id: 'b' })).toMatch(/shared: true/)
    expect(loader.sharedExtensionRefusal({ id: 'c', shared: true })).toMatch(/not listed/)
    process.env = { ...saved }
    delete process.env.HUB_SHARED_DEPLOYMENT
    expect(loader.sharedExtensionRefusal({ id: 'b' })).toBeNull()
  })
})
