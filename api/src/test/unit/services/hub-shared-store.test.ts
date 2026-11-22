import type { Knex } from 'knex'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// Nivaro Hub phase 6, Task 1: the shared-deployment store. Real SQLite with the 542 + 546 + 551 +
// 552 + 553 tables. The deployment token is shown once and stored sealed with a SHA-256 lookup;
// after a rotation the previous token keeps working for 24 h only (preflight R7: it stays sealed
// in prev_token so the Hub can still call the deployment link during the grace). An app's
// ENCRYPTION_KEY is stored sealed with its fingerprint (columns encryption_key /
// encryption_key_fp, preflight M4). Also the shared lock and the phase-6 env lock holders (R10).

vi.mock('../../../db/index.js', async () => {
  const knex = (await import('knex')).default
  const { sqliteAfterCreate, sqliteCompat } = await import('../../../db/sqlite.js')
  sqliteCompat()
  const db = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1, afterCreate: sqliteAfterCreate }
  })
  return { db }
})

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const { up: up542 } = await import('../../../db/migrations/542_hub_tables.js')
const { up: up543 } = await import('../../../db/migrations/543_hub_promotions.js')
const { up: up546 } = await import('../../../db/migrations/546_hub_stack_settings.js')
const { up: up551 } = await import('../../../db/migrations/551_hub_signins.js')
const { up: up552 } = await import('../../../db/migrations/552_hub_shared_deployments.js')
const { up: up553 } = await import('../../../db/migrations/553_hub_moves.js')
const S = await import('../../../services/hub/shared/store.js')
const { HUB_MASK, openSecret, sealSecret } = await import('../../../services/hub/secrets.js')
const { keyFingerprint, APP_KEY_RE } = await import('../../../services/app-key-fingerprint.js')
const L = await import('../../../services/hub/promote-lock.js')

const HUB_KEY = 'c'.repeat(64)
const APP_KEY = 'ab'.repeat(32)
let prevKey: string | undefined

const base = {
  key: 'shared-one',
  name: 'Shared one',
  link_url: 'https://shared-one.internal.example.com'
}

async function driver(kind: 'gitlab' | 'docker'): Promise<number> {
  const [row] = await db('nivaro_hub_drivers')
    .insert({ kind, name: `${kind} driver`, config: '{}' })
    .returning('id')
  return Number(typeof row === 'object' ? (row as { id: number }).id : row)
}

let envSeq = 0
async function newEnv(): Promise<number> {
  const [row] = await db('nivaro_hub_environments')
    .insert({
      app_id: 1,
      key: `e${++envSeq}`,
      base_url: `https://e${envSeq}.example.com`,
      hostnames: '[]'
    })
    .returning('id')
  return Number(typeof row === 'object' ? (row as { id: number }).id : row)
}

function fields(over: Record<string, unknown> = {}) {
  const v = S.validateSharedInput({ ...base, ...over })
  if (!v.ok) throw new Error(`${v.code}: ${v.message}`)
  return v.row
}

beforeAll(async () => {
  prevKey = process.env.ENCRYPTION_KEY
  process.env.ENCRYPTION_KEY = HUB_KEY
  await up542(db)
  await up543(db)
  await up546(db)
  await up551(db)
  await up552(db)
  await up553(db)
})
afterAll(async () => {
  if (prevKey === undefined) delete process.env.ENCRYPTION_KEY
  else process.env.ENCRYPTION_KEY = prevKey
  await db.destroy()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('shared deployment token', () => {
  it('is shown once and never stored plain', async () => {
    const { row, token } = await S.createShared(fields(), null)
    expect(token.length).toBeGreaterThanOrEqual(43)
    expect(row.token).toBe(HUB_MASK)
    const raw = await db('nivaro_hub_shared_deployments').where({ id: row.id }).first()
    expect(raw.token).not.toBe(token)
    expect(String(raw.token)).not.toContain(token)
    expect(raw.token_lookup).toMatch(/^[0-9a-f]{64}$/)
    expect(raw.token_lookup).not.toBe(token)
    expect(openSecret(raw.token)).toBe(token)
    expect(await S.openSharedToken(row.id)).toBe(token)
    // A list or read never carries the token either.
    expect((await S.getShared(row.id))?.token).toBe(HUB_MASK)
    expect(JSON.stringify(await S.listShared())).not.toContain(token)
  })

  it('finds the deployment for its token; a wrong key or token finds nothing', async () => {
    const { row, token } = await S.createShared(fields({ key: 'shared-two' }), null)
    expect((await S.sharedForToken('shared-two', token))?.id).toBe(row.id)
    expect(await S.sharedForToken('shared-one', token)).toBeNull()
    expect(await S.sharedForToken('shared-two', `${token}x`)).toBeNull()
    expect(await S.sharedForToken('shared-two', '')).toBeNull()
    expect(await S.sharedForToken('no-such', token)).toBeNull()
  })

  it('keeps the previous token valid for 24 h after a rotation, then refuses it', async () => {
    const { row, token: old } = await S.createShared(fields({ key: 'shared-rot' }), null)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-22T10:00:00Z'))
    const { token: next } = await S.rotateSharedToken(row.id)
    expect(next).not.toBe(old)
    expect(next.length).toBeGreaterThanOrEqual(43)
    expect((await S.sharedForToken('shared-rot', next))?.id).toBe(row.id)
    expect((await S.sharedForToken('shared-rot', old))?.id).toBe(row.id)
    expect(await S.openSharedToken(row.id)).toBe(next)
    expect(await S.openSharedPrevToken(row.id)).toBe(old)
    const raw = await db('nivaro_hub_shared_deployments').where({ id: row.id }).first()
    expect(String(raw.prev_token)).not.toContain(old)

    vi.setSystemTime(new Date('2026-11-23T09:59:00Z'))
    expect((await S.sharedForToken('shared-rot', old))?.id).toBe(row.id)
    vi.setSystemTime(new Date('2026-11-23T10:01:00Z'))
    expect(await S.sharedForToken('shared-rot', old)).toBeNull()
    expect(await S.openSharedPrevToken(row.id)).toBeNull()
    expect((await S.sharedForToken('shared-rot', next))?.id).toBe(row.id)
  })

  it('derives the link bearer from the token (preflight R7), never the token itself', () => {
    const b = S.deploymentLinkBearer('t'.repeat(43))
    expect(b).toMatch(/^[0-9a-f]{64}$/)
    expect(b).toBe(S.deploymentLinkBearer('t'.repeat(43)))
    expect(b).not.toBe(S.deploymentLinkBearer('u'.repeat(43)))
  })
})

describe('tenant id and app key', () => {
  it('tenantIdFor is the app key (48) and the environment id', () => {
    const id = S.tenantIdFor({ key: 'a'.repeat(64) }, { id: 7 })
    expect(id).toBe(`${'a'.repeat(48)}-e7`)
    expect(id).toMatch(/^[a-z0-9-]{1,64}$/)
    expect(S.tenantIdFor({ key: 'crm' }, { id: 12 })).toBe('crm-e12')
  })

  it('keyFingerprint is stable, 32 hex long and differs per key', () => {
    expect(APP_KEY_RE.test(APP_KEY)).toBe(true)
    const fp = keyFingerprint(APP_KEY)
    expect(fp).toMatch(/^[0-9a-f]{32}$/)
    expect(keyFingerprint(APP_KEY)).toBe(fp)
    expect(keyFingerprint('cd'.repeat(32))).not.toBe(fp)
  })

  it('setAppKey refuses anything but 64 hex, and stores the key sealed with its fingerprint', async () => {
    const envId = await newEnv()
    for (const bad of ['', 'xyz', 'a'.repeat(63), 'g'.repeat(64), 'a'.repeat(65), 42])
      await expect(S.setAppKey(envId, bad as string)).rejects.toMatchObject({ code: 'BAD_KEY' })
    const { fp } = await S.setAppKey(envId, APP_KEY.toUpperCase())
    expect(fp).toBe(keyFingerprint(APP_KEY))
    const raw = await db('nivaro_hub_environments').where({ id: envId }).first()
    expect(raw.encryption_key_fp).toBe(fp)
    expect(String(raw.encryption_key).toLowerCase()).not.toContain(APP_KEY)
    expect(await S.openAppKey(envId)).toBe(APP_KEY)
  })

  it('setAppKey on a missing environment is NOT_FOUND', async () => {
    await expect(S.setAppKey(99999, APP_KEY)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('openAppKey falls back to the stack settings ENCRYPTION_KEY, else null', async () => {
    const envId = await newEnv()
    expect(await S.openAppKey(envId)).toBeNull()
    const other = 'ef'.repeat(32)
    await db('nivaro_hub_stack_settings').insert({
      environment_id: envId,
      secrets: sealSecret(JSON.stringify({ ENCRYPTION_KEY: sealSecret(other) }))
    })
    expect(await S.openAppKey(envId)).toBe(other)
    // The admin entry (the environment's own column) wins.
    await S.setAppKey(envId, APP_KEY)
    expect(await S.openAppKey(envId)).toBe(APP_KEY)
  })
})

describe('delete and update', () => {
  it('refuses to delete or retire a deployment a placement names', async () => {
    const { row } = await S.createShared(fields({ key: 'shared-del' }), null)
    const [p] = await db('nivaro_hub_placements')
      .insert({ kind: 'shared', driver_id: 0, target: '{}', shared_deployment_id: row.id })
      .returning('id')
    await expect(S.deleteShared(row.id)).rejects.toMatchObject({ code: 'SHARED_IN_USE' })
    expect((await S.getShared(row.id))?.status).toBe('new')
    await db('nivaro_hub_placements')
      .where({ id: typeof p === 'object' ? (p as { id: number }).id : p })
      .del()
    // Never deployed, nothing placed: really deleted.
    expect(await S.deleteShared(row.id)).toEqual({ outcome: 'deleted' })
    expect(await S.getShared(row.id)).toBeNull()
  })

  it('retires a deployment that has history and keeps every history row (ruling P6-2)', async () => {
    const { row, token } = await S.createShared(fields({ key: 'shared-hist' }), null)
    for (const version of ['0.3.1', '0.3.2'])
      await db('nivaro_hub_shared_deploys').insert({
        shared_deployment_id: row.id,
        kind: 'upgrade',
        version,
        status: 'success'
      })
    expect(await S.deleteShared(row.id)).toEqual({ outcome: 'retired' })
    expect((await S.getShared(row.id))?.status).toBe('retired')
    expect(
      await db('nivaro_hub_shared_deploys').where({ shared_deployment_id: row.id })
    ).toHaveLength(2)
    // M1: a retired deployment never authenticates.
    expect(await S.sharedForToken('shared-hist', token)).toBeNull()
    // Again: still retired, nothing lost.
    expect(await S.deleteShared(row.id)).toEqual({ outcome: 'retired' })
    expect(
      await db('nivaro_hub_shared_deploys').where({ shared_deployment_id: row.id })
    ).toHaveLength(2)
  })

  it('retires a deployment that ran (status past new) even without history rows', async () => {
    const { row } = await S.createShared(fields({ key: 'shared-ran' }), null)
    await S.setSharedStatus(row.id, 'active')
    expect(await S.deleteShared(row.id)).toEqual({ outcome: 'retired' })
    expect((await S.getShared(row.id))?.status).toBe('retired')
  })

  it('deletes or retires only under the shared lock', async () => {
    const { row } = await S.createShared(fields({ key: 'shared-lck' }), null)
    const lock = L.sharedLock(null)
    const held = (await lock.take(row.id, 'place')) as string
    await expect(S.deleteShared(row.id, { lock })).rejects.toMatchObject({
      code: 'SHARED_BUSY',
      statusCode: 409
    })
    expect(await S.getShared(row.id)).not.toBeNull()
    await lock.release(row.id, held)
    expect(await S.deleteShared(row.id, { lock })).toEqual({ outcome: 'deleted' })
    // The lock is let go afterwards.
    expect(await lock.holder(row.id)).toBeNull()
  })

  it('a missing deployment is NOT_FOUND', async () => {
    await expect(S.deleteShared(99999)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('a rotation that lost the race fails instead of showing a dead token (M2)', async () => {
    const { row } = await S.createShared(fields({ key: 'shared-race' }), null)
    const out = await Promise.allSettled([S.rotateSharedToken(row.id), S.rotateSharedToken(row.id)])
    const won = out.filter((o) => o.status === 'fulfilled') as PromiseFulfilledResult<{
      token: string
    }>[]
    const lost = out.filter((o) => o.status === 'rejected') as PromiseRejectedResult[]
    expect(won).toHaveLength(1)
    expect(lost).toHaveLength(1)
    expect(lost[0].reason).toMatchObject({ code: 'TOKEN_CHANGED', statusCode: 409 })
    expect((await S.sharedForToken('shared-race', won[0].value.token))?.id).toBe(row.id)
  })

  it('refuses a second deployment with the same key', async () => {
    await S.createShared(fields({ key: 'shared-dup' }), null)
    await expect(S.createShared(fields({ key: 'shared-dup' }), null)).rejects.toMatchObject({
      code: 'KEY_TAKEN'
    })
  })

  it('reads and updates the stored fields', async () => {
    const { row } = await S.createShared(
      fields({
        key: 'shared-upd',
        extensions: ['efp-ops', 'efp-ops'],
        extension_pins: { 'efp-ops': `registry.example.com/acme/efp-ops@sha256:${'1'.repeat(64)}` },
        host_pattern: '*.apps.example.com',
        pool_budget: 80,
        settings: { size: 'medium' }
      }),
      'AAAAAAAA-0000-4000-8000-000000000001'
    )
    expect(row).toMatchObject({
      key: 'shared-upd',
      mode: 'registered',
      status: 'new',
      extensions: ['efp-ops'],
      extension_pins: { 'efp-ops': `registry.example.com/acme/efp-ops@sha256:${'1'.repeat(64)}` },
      host_pattern: '*.apps.example.com',
      pool_budget: 80,
      settings: { size: 'medium' },
      driver_id: null,
      stack: null
    })
    expect((await S.getSharedByKey('shared-upd'))?.id).toBe(row.id)
    const up = await S.updateShared(row.id, { name: 'Renamed', pool_budget: 90 })
    expect(up).toMatchObject({ name: 'Renamed', pool_budget: 90, extensions: ['efp-ops'] })
    expect(await S.updateShared(99999, { name: 'x' })).toBeNull()
  })

  it('docker mode needs a docker driver', async () => {
    const gitlab = await driver('gitlab')
    const docker = await driver('docker')
    await expect(
      S.createShared(fields({ key: 'shared-dg', mode: 'docker', driver_id: gitlab }), null)
    ).rejects.toMatchObject({ code: 'DRIVER_NOT_DOCKER' })
    const { row } = await S.createShared(
      fields({ key: 'shared-dd', mode: 'docker', driver_id: docker }),
      null
    )
    expect(row).toMatchObject({ mode: 'docker', driver_id: docker, stack: 'shared-dd' })
  })
})

describe('validateSharedInput', () => {
  const code = (over: Record<string, unknown>, existing?: unknown) => {
    const v = S.validateSharedInput({ ...base, ...over }, existing as never)
    return v.ok ? 'ok' : v.code
  }

  it('accepts a plain registered deployment and normalises the link', () => {
    const v = S.validateSharedInput({ ...base, link_url: 'https://Shared-One.example.com/' })
    expect(v.ok && v.row).toMatchObject({
      key: 'shared-one',
      mode: 'registered',
      link_url: 'https://shared-one.example.com',
      pool_budget: 60,
      extensions: [],
      extension_pins: {},
      host_pattern: null,
      settings: {}
    })
  })

  it('fires each code on its bad input', () => {
    expect(code({ mode: 'docker', driver_id: 3, stack: 'Bad Stack' })).toBe('BAD_STACK')
    expect(code({ mode: 'docker', driver_id: 3, stack: 'x'.repeat(42) })).toBe('BAD_STACK')
    expect(code({ version_pin: 'a b' })).toBe('BAD_VERSION')
    expect(code({ version_pin: 'v'.repeat(65) })).toBe('BAD_VERSION')
    expect(code({ settings: ['x'] })).toBe('BAD_SETTINGS')
    expect(code({ settings: 'size=small' })).toBe('BAD_SETTINGS')
    expect(code({ settings: { big: 'x'.repeat(20_001) } })).toBe('BAD_SETTINGS')
    expect(code({ host_pattern: `*.${'a'.repeat(64)}.example.com` })).toBe('BAD_PATTERN')
    expect(code({ host_pattern: `*.${'a'.repeat(63)}.example.com` })).toBe('ok')
    expect(code({ key: 'Bad Key' })).toBe('BAD_KEY')
    expect(code({ key: '-x' })).toBe('BAD_KEY')
    expect(code({ name: '' })).toBe('BAD_NAME')
    expect(code({ name: 'x'.repeat(201) })).toBe('BAD_NAME')
    expect(code({ link_url: 'http://shared.example.com' })).toBe('BAD_LINK_URL')
    expect(code({ link_url: 'https://user:pw@shared.example.com' })).toBe('BAD_LINK_URL')
    expect(code({ link_url: 'https://shared.example.com/api' })).toBe('BAD_LINK_URL')
    expect(code({ link_url: 'ftp://shared.example.com' })).toBe('BAD_LINK_URL')
    expect(code({ link_url: undefined })).toBe('BAD_LINK_URL')
    expect(code({ host_pattern: 'apps.example.com' })).toBe('BAD_PATTERN')
    expect(code({ host_pattern: '*.com' })).toBe('BAD_PATTERN')
    expect(code({ host_pattern: '*.Apps.example.com' })).toBe('BAD_PATTERN')
    expect(code({ pool_budget: 0 })).toBe('BAD_BUDGET')
    expect(code({ pool_budget: 501 })).toBe('BAD_BUDGET')
    expect(code({ pool_budget: 1.5 })).toBe('BAD_BUDGET')
    expect(code({ extensions: ['Bad_Id'] })).toBe('BAD_EXTENSIONS')
    expect(code({ extensions: 'efp-ops' })).toBe('BAD_EXTENSIONS')
    expect(code({ extensions: Array.from({ length: 51 }, (_, i) => `x${i}`) })).toBe(
      'BAD_EXTENSIONS'
    )
    expect(code({ extension_pins: { 'other-ext': '1.0.0' } })).toBe('BAD_EXTENSIONS')
    // Ruling P6-16 (Task 5 review I-1): a pin is the agent's image pin, as phase-4 stack settings.
    const PIN = `registry.example.com/acme/efp-ops@sha256:${'2'.repeat(64)}`
    const withExt = (pin: unknown) =>
      code({ extensions: ['efp-ops'], extension_pins: { 'efp-ops': pin } })
    expect(withExt(PIN)).toBe('ok')
    expect(withExt(`nodeworks/efp-ops@sha256:${'a'.repeat(64)}`)).toBe('ok')
    expect(withExt('1.2.3')).toBe('BAD_EXTENSIONS')
    expect(withExt('nodeworks/efp-ops:1.2.3')).toBe('BAD_EXTENSIONS')
    expect(withExt(`nodeworks/efp-ops@sha256:${'a'.repeat(63)}`)).toBe('BAD_EXTENSIONS')
    expect(withExt(`Nodeworks/efp-ops@sha256:${'a'.repeat(64)}`)).toBe('BAD_EXTENSIONS')
    expect(code({ mode: 'docker' })).toBe('DRIVER_NOT_DOCKER')
    expect(code({ mode: 'gitlab' })).toBe('BAD_MODE')
  })

  it('allows plain http only for loopback and RFC 1918 hosts, outside production (M3)', () => {
    expect(code({ link_url: 'http://127.0.0.1:3140' })).toBe('ok')
    expect(code({ link_url: 'http://localhost:3140' })).toBe('ok')
    expect(code({ link_url: 'http://[::1]:3140' })).toBe('ok')
    expect(code({ link_url: 'http://10.1.2.3:3000' })).toBe('ok')
    expect(code({ link_url: 'http://172.16.0.4' })).toBe('ok')
    expect(code({ link_url: 'http://192.168.1.10' })).toBe('ok')
    expect(code({ link_url: 'http://172.32.0.4' })).toBe('BAD_LINK_URL')
    expect(code({ link_url: 'http://8.8.8.8' })).toBe('BAD_LINK_URL')
    expect(code({ link_url: 'http://nivaro-shared' })).toBe('BAD_LINK_URL')
    expect(code({ link_url: 'http://tasks.nivaro' })).toBe('BAD_LINK_URL')
    const prev = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      expect(code({ link_url: 'http://127.0.0.1:3140' })).toBe('BAD_LINK_URL')
      expect(code({ link_url: 'http://10.1.2.3:3000' })).toBe('BAD_LINK_URL')
      expect(code({ link_url: 'https://10.1.2.3:3000' })).toBe('ok')
    } finally {
      process.env.NODE_ENV = prev
    }
  })

  it('a docker deployment names a docker driver (when its kind is known)', () => {
    const v = S.validateSharedInput({ ...base, mode: 'docker', driver_id: 3 }, undefined, {
      driverKind: 'gitlab'
    })
    expect(v.ok ? 'ok' : v.code).toBe('DRIVER_NOT_DOCKER')
    const ok = S.validateSharedInput({ ...base, mode: 'docker', driver_id: 3 }, undefined, {
      driverKind: 'docker'
    })
    expect(ok.ok).toBe(true)
  })

  it('keeps key and mode on an existing deployment', () => {
    const existing = {
      id: 1,
      key: 'shared-one',
      name: 'Shared one',
      mode: 'registered',
      driver_id: null,
      stack: null,
      version_pin: null,
      extensions: [],
      extension_pins: {},
      host_pattern: null,
      link_url: 'https://shared-one.example.com',
      pool_budget: 60,
      status: 'active',
      settings: {},
      token: HUB_MASK,
      last_seen_at: null
    }
    const v = S.validateSharedInput({ name: 'New name' }, existing as never)
    expect(v.ok && v.row).toMatchObject({ key: 'shared-one', name: 'New name', pool_budget: 60 })
    expect(code({ key: 'other-key' }, existing)).toBe('IMMUTABLE')
    expect(code({ mode: 'docker' }, existing)).toBe('IMMUTABLE')
  })
})

describe('locks (preflight R10)', () => {
  it('names the phase-6 environment lock holders', () => {
    expect(L.holderOf('move:abc')).toBe('move')
    expect(L.holderOf('shared:abc')).toBe('shared')
    const fb = { code: 'X', message: 'x' }
    expect(L.lockHolderRefusal('move', fb).code).toBe('MOVE_RUNNING')
    expect(L.lockHolderRefusal('shared', fb).code).toBe('SHARED_UPGRADE_RUNNING')
    expect(L.lockHolderRefusal('move', fb, 'move')).toBe(fb)
  })

  it('the shared lock: one holder at a time, renew and release by token only', async () => {
    expect(L.hubSharedLockKey(4)).toBe('nvr:hub:shared:4')
    const lock = L.sharedLock(null)
    const t = await lock.take(4, 'shared')
    expect(t).toMatch(/^shared:/)
    expect(await lock.take(4, 'move')).toBeNull()
    expect(await lock.holder(4)).toBe('shared')
    expect(await lock.renew(4, 'move:nope')).toBe(false)
    expect(await lock.renew(4, t as string)).toBe(true)
    await lock.release(4, 'move:nope')
    expect(await lock.holder(4)).toBe('shared')
    await lock.release(4, t as string)
    expect(await lock.holder(4)).toBeNull()
    const p = await lock.take(4, 'place')
    expect(p).toMatch(/^place:/)
    await lock.release(4, p as string)
  })

  it('the shared lock on Redis uses SET NX and the compare-and-* scripts', async () => {
    const store = new Map<string, string>()
    const redis = {
      set: vi.fn(async (k: string, v: string, ..._a: Array<string | number>) => {
        if (store.has(k)) return null
        store.set(k, v)
        return 'OK'
      }),
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      del: vi.fn(async (...k: string[]) => {
        for (const x of k) store.delete(x)
      }),
      exists: vi.fn(async (k: string) => (store.has(k) ? 1 : 0)),
      eval: vi.fn(async (script: string, _n: number, k: string, tok: string) => {
        if (store.get(k) !== tok) return 0
        if (/'del'/.test(script)) store.delete(k)
        return 1
      })
    }
    const lock = L.sharedLock(redis)
    const t = (await lock.take(9, 'move')) as string
    expect(redis.set).toHaveBeenCalledWith('nvr:hub:shared:9', t, 'PX', L.LOCK_TTL_MS, 'NX')
    expect(await lock.take(9, 'shared')).toBeNull()
    expect(await lock.holder(9)).toBe('move')
    expect(await lock.renew(9, t)).toBe(true)
    await lock.release(9, t)
    expect(store.has('nvr:hub:shared:9')).toBe(false)
    const refusal = L.sharedLockRefusal('shared')
    expect(refusal.code).toBe('SHARED_BUSY')
    expect(L.sharedLockRefusal('move').code).toBe('SHARED_BUSY')
  })
})
