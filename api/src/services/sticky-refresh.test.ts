import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildBelow,
  type ConnectingClient,
  compareBuilds,
  forgetRemembered,
  getMinBuilds,
  listRemembered,
  MAX_PAGE_LOADS,
  type MinBuildRule,
  matchMinBuild,
  refreshOwedOnConnect,
  rememberRefresh,
  type StickyRedis,
  type StoredRefresh,
  setMinBuild
} from './sticky-refresh.js'

/** Just enough of Redis for the sticky store (lists + hashes). */
function memoryRedis(): StickyRedis & { keys: () => string[] } {
  const lists = new Map<string, string[]>()
  const hashes = new Map<string, Map<string, string>>()
  const hash = (k: string) => {
    let h = hashes.get(k)
    if (!h) {
      h = new Map()
      hashes.set(k, h)
    }
    return h
  }
  const range = (arr: string[], start: number, stop: number) =>
    arr.slice(start, stop < 0 ? arr.length + stop + 1 : stop + 1)
  return {
    keys: () => [...lists.keys(), ...hashes.keys()],
    async lpush(key, ...values) {
      lists.set(key, [...values.reverse(), ...(lists.get(key) ?? [])])
    },
    async ltrim(key, start, stop) {
      lists.set(key, range(lists.get(key) ?? [], start, stop))
    },
    async lrange(key, start, stop) {
      return range(lists.get(key) ?? [], start, stop)
    },
    async del(key) {
      lists.delete(key)
      hashes.delete(key)
    },
    async rpush(key, ...values) {
      lists.set(key, [...(lists.get(key) ?? []), ...values])
    },
    async expire() {},
    async hset(key, field, value) {
      hash(key).set(field, value)
    },
    async hget(key, field) {
      return hashes.get(key)?.get(field) ?? null
    },
    async hdel(key, field) {
      hashes.get(key)?.delete(field)
    },
    async hgetall(key) {
      return Object.fromEntries(hashes.get(key) ?? [])
    },
    async hsetnx(key, field, value) {
      const h = hash(key)
      if (h.has(field)) return 0
      h.set(field, value)
      return 1
    },
    async hlen(key) {
      return hashes.get(key)?.size ?? 0
    }
  }
}

const USER = '11111111-2222-3333-4444-555555555555'
const ISSUED = 1_800_000_000_000

function instr(over: Partial<StoredRefresh> = {}): StoredRefresh {
  return {
    id: 'i-1',
    issued_at: ISSUED,
    issuer: null,
    issuer_name: null,
    seconds: 30,
    message: 'New release',
    target: { app: null, user_ids: [], older: false },
    ...over
  }
}

function tab(over: Partial<ConnectingClient> & { loaded?: number; build?: string } = {}) {
  const { loaded = ISSUED - 60_000, build = '0.3.11', ...rest } = over
  return {
    user_id: USER,
    app: 'admin',
    version: { build, api: '0.3.11', tab: 'tab-a', loaded },
    obeyed: [],
    ...rest
  } satisfies ConnectingClient
}

describe('sticky force refresh', () => {
  const env = { ...process.env }
  beforeEach(() => {
    process.env.FORCE_REFRESH_REMEMBER_HOURS = ''
    process.env.FORCE_REFRESH_REMEMBER_MAX = ''
  })
  afterEach(() => {
    process.env = { ...env }
  })

  // listRemembered drops anything older than the window, measured from now.
  const now = () => ISSUED + 1000

  async function store(redis: StickyRedis, tenant: string | null, i: StoredRefresh) {
    await rememberRefresh(redis, tenant, i)
    // The clock in tests sits next to ISSUED.
    const realNow = Date.now
    Date.now = now
    return () => {
      Date.now = realNow
    }
  }

  it('delivers a remembered instruction to a tab that connects later', async () => {
    const redis = memoryRedis()
    const restore = await store(redis, null, instr())
    try {
      const owed = await refreshOwedOnConnect(redis, null, tab())
      expect(owed).toMatchObject({ id: 'i-1', reason: 'sticky', seconds: 30, issued_at: ISSUED })
    } finally {
      restore()
    }
  })

  it('never re-sends to a tab that already obeyed', async () => {
    const redis = memoryRedis()
    const restore = await store(redis, null, instr())
    try {
      // Page loaded after the instruction: it already runs what is served.
      expect(await refreshOwedOnConnect(redis, null, tab({ loaded: ISSUED + 5 }))).toBeNull()
      // The tab says it reloaded for it (sessionStorage marker in client:hello).
      expect(await refreshOwedOnConnect(redis, null, tab({ obeyed: ['i-1'] }))).toBeNull()
      // A reconnect inside the same page load (the banner is already counting).
      expect(await refreshOwedOnConnect(redis, null, tab())).not.toBeNull()
      expect(await refreshOwedOnConnect(redis, null, tab())).toBeNull()
    } finally {
      restore()
    }
  })

  it('matches the target: people, app, older', async () => {
    const redis = memoryRedis()
    const restore = await store(
      redis,
      null,
      instr({ target: { app: 'efp-new', user_ids: [USER.toUpperCase()], older: false } })
    )
    try {
      expect(await refreshOwedOnConnect(redis, null, tab())).toBeNull()
      expect(
        await refreshOwedOnConnect(redis, null, tab({ app: 'efp-new', user_id: 'someone-else' }))
      ).toBeNull()
      expect(await refreshOwedOnConnect(redis, null, tab({ app: 'efp-new' }))).not.toBeNull()

      await forgetRemembered(redis, null, null)
      await rememberRefresh(
        redis,
        null,
        instr({
          id: 'old',
          target: { app: null, user_ids: [], older: true },
          builds: { admin: '0.3.12' },
          api: '0.3.12',
          settling: ['efp-new']
        })
      )
      // Already on the build that was current: no reload.
      expect(
        await refreshOwedOnConnect(redis, null, {
          ...tab({ build: '0.3.12' }),
          version: { build: '0.3.12', api: '0.3.12', tab: 'b', loaded: ISSUED - 1 }
        })
      ).toBeNull()
      expect(await refreshOwedOnConnect(redis, null, tab({ build: '0.3.10' }))).toMatchObject({
        id: 'old'
      })
      // An app that was still rolling out is never judged.
      expect(await refreshOwedOnConnect(redis, null, tab({ app: 'efp-new' }))).toBeNull()
    } finally {
      restore()
    }
  })

  it('keeps only the newest N and forgets on request', async () => {
    process.env.FORCE_REFRESH_REMEMBER_MAX = '3'
    const redis = memoryRedis()
    const realNow = Date.now
    Date.now = now
    try {
      for (let i = 0; i < 5; i++)
        await rememberRefresh(redis, null, instr({ id: `i-${i}`, issued_at: ISSUED + i }))
      const rows = await listRemembered(redis, null)
      expect(rows.map((r) => r.id)).toEqual(['i-4', 'i-3', 'i-2'])
      expect(await forgetRemembered(redis, null, 'i-3')).toBe(1)
      expect((await listRemembered(redis, null)).map((r) => r.id)).toEqual(['i-4', 'i-2'])
    } finally {
      Date.now = realNow
    }
  })

  it('remembers nothing when switched off', async () => {
    process.env.FORCE_REFRESH_REMEMBER_HOURS = '0'
    const redis = memoryRedis()
    expect(await rememberRefresh(redis, null, instr())).toBe(false)
    expect(redis.keys()).toEqual([])
  })

  it('keeps tenants apart', async () => {
    const redis = memoryRedis()
    const restore = await store(redis, 'tenant-a', instr())
    try {
      expect(await refreshOwedOnConnect(redis, 'tenant-b', tab())).toBeNull()
      expect(await refreshOwedOnConnect(redis, null, tab())).toBeNull()
      expect(await refreshOwedOnConnect(redis, 'tenant-a', tab())).not.toBeNull()
      await setMinBuild(redis, 'tenant-a', rule())
      expect(await getMinBuilds(redis, 'tenant-b')).toEqual([])
      expect(redis.keys().every((k) => k.startsWith('nvr:fr:tenant-a:'))).toBe(true)
    } finally {
      restore()
    }
  })
})

function rule(over: Partial<MinBuildRule> = {}): MinBuildRule {
  return {
    app: 'admin',
    build: '0.3.12',
    seconds: 15,
    message: 'Please reload',
    set_at: ISSUED,
    set_by: null,
    set_by_name: null,
    ...over
  }
}

describe('minimum client build', () => {
  it('compares versions as versions', () => {
    expect(compareBuilds('0.3.9', '0.3.12')).toBe(-1)
    expect(compareBuilds('v1.0', '1.0.0')).toBe(0)
    expect(compareBuilds('0.4.0', '0.3.99')).toBe(1)
    expect(compareBuilds('staging-0ec33c1e', '0.3.12')).toBeNull()
  })

  it('judges below the minimum', () => {
    expect(buildBelow('0.3.11', '0.3.12', ISSUED + 10, ISSUED)).toBe(true)
    expect(buildBelow('0.3.12', '0.3.12', 0, ISSUED)).toBe(false)
    expect(buildBelow('0.3.13', '0.3.12', 0, ISSUED)).toBe(false)
    // dev / unknown builds are never judged.
    expect(buildBelow('dev', '0.3.12', 0, ISSUED)).toBe(false)
    expect(buildBelow(null, '0.3.12', 0, ISSUED)).toBe(false)
    // Hashes: a different build that loaded before the rule was set.
    expect(buildBelow('abc123', 'def456', ISSUED - 1, ISSUED)).toBe(true)
    expect(buildBelow('abc123', 'def456', ISSUED + 1, ISSUED)).toBe(false)
    expect(buildBelow('def456', 'def456', ISSUED - 1, ISSUED)).toBe(false)
  })

  it('gates a tab on an older build when it connects', async () => {
    const redis = memoryRedis()
    expect(await refreshOwedOnConnect(redis, null, tab())).toBeNull() // off by default
    await setMinBuild(redis, null, rule())
    expect(await refreshOwedOnConnect(redis, null, tab({ build: '0.3.12' }))).toBeNull()
    expect(await refreshOwedOnConnect(redis, null, tab({ app: 'efp-new' }))).toBeNull()
    expect(await refreshOwedOnConnect(redis, null, tab())).toMatchObject({
      reason: 'min-build',
      min_build: '0.3.12',
      seconds: 15,
      message: 'Please reload',
      id: `min-admin-${ISSUED}`
    })
    expect(matchMinBuild(tab(), [rule()])).not.toBeNull()
  })

  it(`stops after ${MAX_PAGE_LOADS} page loads of a tab still below it (cached bundle)`, async () => {
    const redis = memoryRedis()
    await setMinBuild(redis, null, rule())
    const sends: unknown[] = []
    for (let load = 1; load <= 4; load++) {
      // Each page load reconnects twice; only the first connect of a load is told.
      for (let i = 0; i < 2; i++)
        sends.push(await refreshOwedOnConnect(redis, null, tab({ loaded: ISSUED + load })))
    }
    expect(sends.filter(Boolean)).toHaveLength(MAX_PAGE_LOADS)
    // Another tab is counted on its own.
    expect(
      await refreshOwedOnConnect(redis, null, {
        ...tab(),
        version: { build: '0.3.11', api: null, tab: 'tab-b', loaded: ISSUED + 1 }
      })
    ).not.toBeNull()
  })

  it('needs a tab id to send a minimum-build reload (bounded)', async () => {
    const redis = memoryRedis()
    await setMinBuild(redis, null, rule())
    expect(
      await refreshOwedOnConnect(redis, null, {
        ...tab(),
        version: { build: '0.3.11', api: null, tab: null, loaded: ISSUED }
      })
    ).toBeNull()
  })
})
