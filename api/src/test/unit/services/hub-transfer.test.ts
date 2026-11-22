import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub phase 6 Task 10 — file transfer between an app's old and new home: transfer tickets
// (services/hub-transfer/tickets.ts) and the pull (services/hub-transfer/pull.ts) against a fake
// source on a loopback port. The target's rows, storage and Redis are in-memory seams.

vi.mock('../../../db/index.js', () => ({
  db: () => {
    throw new Error('no database in this test')
  }
}))

import { withTenant } from '../../../db/tenant-context.js'
import {
  type FileRow,
  PullError,
  pullDeps,
  pullStatus,
  readPullStatus,
  resetPullsForTests,
  startPull
} from '../../../services/hub-transfer/pull.js'
import {
  mintTransferTicket,
  TRANSFER_TICKET_RE,
  ticketDeps,
  ticketKey,
  ticketTenant
} from '../../../services/hub-transfer/tickets.js'

// ─── an in-memory Redis with the commands the transfer uses ─────────────────────────────────

class FakeRedis {
  kv = new Map<string, { v: string; exp: number | null }>()
  sets = new Map<string, Set<string>>()
  private live(k: string) {
    const e = this.kv.get(k)
    if (e && e.exp !== null && e.exp <= Date.now()) {
      this.kv.delete(k)
      return undefined
    }
    return e
  }
  async get(k: string) {
    return this.live(k)?.v ?? null
  }
  async set(k: string, v: string, ...args: unknown[]) {
    const nx = args.includes('NX')
    const xx = args.includes('XX')
    const px = args.indexOf('PX')
    if (nx && this.live(k)) return null
    if (xx && !this.live(k)) return null
    this.kv.set(k, { v, exp: px >= 0 ? Date.now() + Number(args[px + 1]) : null })
    return 'OK'
  }
  async del(...keys: string[]) {
    let n = 0
    for (const k of keys) {
      if (this.kv.delete(k)) n++
      if (this.sets.delete(k)) n++
    }
    return n
  }
  async pexpire(_k: string, _ms: number) {
    return 1
  }
  async sadd(k: string, ...members: string[]) {
    const s = this.sets.get(k) ?? new Set<string>()
    for (const m of members) s.add(m)
    this.sets.set(k, s)
    return members.length
  }
  async smembers(k: string) {
    return [...(this.sets.get(k) ?? [])]
  }
}

// ─── the fake source ──────────────────────────────────────────────────────────────────────

const TICKET = `nvt_${'S'.repeat(43)}`
const objects = new Map<string, Buffer>()
const redirects = new Set<string>()
const sourceSeen: string[] = []
let server: Server
let SOURCE = ''

beforeAll(async () => {
  server = createServer((req, res) => {
    const id = decodeURIComponent((req.url ?? '').split('/').pop() ?? '')
    sourceSeen.push(id)
    if (req.headers.authorization !== `Transfer ${TICKET}`) {
      res.writeHead(401, { 'content-type': 'application/json' })
      return res.end('{"code":"TRANSFER_REFUSED"}')
    }
    if (redirects.has(id)) {
      // to a place that WOULD answer the bytes: only redirect: 'error' keeps them out
      res.writeHead(302, { location: `${SOURCE}/redirect-target` })
      return res.end()
    }
    if (id === 'redirect-target') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': '4' })
      return res.end('evil')
    }
    const body = objects.get(id)
    if (!body) {
      res.writeHead(404, { 'content-type': 'application/json' })
      return res.end('{"code":"NOT_FOUND"}')
    }
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(body.length),
      'x-nivaro-filename-disk': `${id}.bin`
    })
    res.end(body)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const a = server.address()
  SOURCE = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}/api/hub-transfer/files`
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})

// ─── the target: rows, storage, Redis, log ─────────────────────────────────────────────────

let root = ''
let rows: FileRow[] = []
let redis: FakeRedis
const logs: string[] = []
const saved = { ...process.env }

function fakeStorage() {
  const path = (k: string) => join(root, k)
  return {
    async exists(k: string) {
      try {
        statSync(path(k))
        return true
      } catch {
        return false
      }
    },
    async size(k: string) {
      try {
        return statSync(path(k)).size
      } catch {
        return null
      }
    },
    async putFile(k: string, from: string) {
      await mkdir(dirname(path(k)), { recursive: true })
      writeFileSync(path(k), readFileSync(from))
      return statSync(path(k)).size
    }
  }
}

const row = (id: string, size: number | null, over: Partial<FileRow> = {}): FileRow => ({
  id,
  filename_disk: `${id}.bin`,
  filesize: size,
  type: 'application/octet-stream',
  uploaded_on: new Date('2026-11-01T00:00:00Z'),
  modified_on: null,
  ...over
})

beforeEach(() => {
  process.env = { ...saved }
  delete process.env.CLOUD_META_DB_URL
  delete process.env.HUB_SHARED_DEPLOYMENT
  process.env.HUB_TOKEN = 'h'.repeat(40)
  root = mkdtempSync(join(tmpdir(), 'nvr-hub-transfer-'))
  redis = new FakeRedis()
  rows = []
  objects.clear()
  redirects.clear()
  sourceSeen.length = 0
  logs.length = 0
  resetPullsForTests()
  ticketDeps.redis = () => redis
  ticketDeps.now = () => Date.now()
  pullDeps.redis = () => redis as never
  pullDeps.storage = () => fakeStorage() as never
  pullDeps.listRows = async (after, limit) =>
    rows
      .filter((r) => after === null || r.id > after)
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .slice(0, limit)
  pullDeps.log = (msg, meta) => void logs.push(`${msg} ${JSON.stringify(meta ?? {})}`)
  pullDeps.limits = { ...pullDeps.defaultLimits }
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true })
  process.env = { ...saved }
})

async function finished(runId: string) {
  for (let i = 0; i < 400; i++) {
    const s = pullStatus(runId)
    if (s && s.state !== 'running') return s
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('the pull did not finish')
}

// ─── tickets ───────────────────────────────────────────────────────────────────────────────

describe('transfer tickets', () => {
  it('mints nvt_ + 32 random bytes, stored by hash only, valid 6 h', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-22T10:00:00Z'))
    const { ticket, expires_at } = await mintTransferTicket(null)
    expect(ticket).toMatch(TRANSFER_TICKET_RE)
    expect(expires_at).toBe('2026-11-22T16:00:00.000Z')
    expect([...redis.kv.keys()]).toEqual([ticketKey(ticket)])
    expect(ticketKey(ticket)).toMatch(/^nvr:hub-transfer:[0-9a-f]{64}$/)
    expect(JSON.stringify([...redis.kv.entries()])).not.toContain(ticket)
    expect(await ticketTenant(ticket)).toEqual({ ok: true, tenant: null })

    vi.setSystemTime(new Date('2026-11-22T15:59:59Z'))
    expect((await ticketTenant(ticket)).ok).toBe(true)
    vi.setSystemTime(new Date('2026-11-22T16:00:00Z'))
    expect((await ticketTenant(ticket)).ok).toBe(false)
  })

  it('refuses malformed and unknown tickets, and another app’s ticket on one Redis', async () => {
    expect((await ticketTenant('nope')).ok).toBe(false)
    expect((await ticketTenant(`nvt_${'x'.repeat(43)}`)).ok).toBe(false)
    const { ticket } = await mintTransferTicket(null)
    // another dedicated app (another HUB_TOKEN) reading the same Redis database
    process.env.HUB_TOKEN = 'o'.repeat(40)
    expect((await ticketTenant(ticket)).ok).toBe(false)
  })

  it('carries the tenant it was minted for on a shared deployment', async () => {
    process.env.HUB_SHARED_DEPLOYMENT = 'shared-a'
    process.env.HUB_URL = 'https://hub.example'
    process.env.HUB_DEPLOYMENT_TOKEN = 'd'.repeat(40)
    delete process.env.HUB_TOKEN
    const { ticket } = await mintTransferTicket('app-a-e1')
    expect(await ticketTenant(ticket)).toEqual({ ok: true, tenant: 'app-a-e1' })
    // another shared deployment on the same Redis never accepts it
    process.env.HUB_SHARED_DEPLOYMENT = 'shared-b'
    expect((await ticketTenant(ticket)).ok).toBe(false)
  })

  it('no Redis: minting fails with REDIS_UNAVAILABLE, a check fails closed', async () => {
    ticketDeps.redis = () => null
    await expect(mintTransferTicket(null)).rejects.toMatchObject({ code: 'REDIS_UNAVAILABLE' })
    expect((await ticketTenant(TICKET)).ok).toBe(false)
  })
})

// ─── the pull ──────────────────────────────────────────────────────────────────────────────

describe('pull', () => {
  it('copies 3 objects, skips the one already present at the same size, streams to storage', async () => {
    for (const id of ['a1', 'a2', 'a3', 'a4']) {
      objects.set(id, Buffer.from(`bytes of ${id}`))
      rows.push(row(id, `bytes of ${id}`.length))
    }
    // a4 is already here at the same size
    writeFileSync(join(root, 'a4.bin'), 'bytes of a4')
    const { run_id } = await startPull({ source: SOURCE, ticket: TICKET, mode: 'full' })
    const s = await finished(run_id)
    expect(s).toMatchObject({ state: 'done', total: 4, copied: 3, skipped: 1, failed: 0 })
    expect(s.missing).toEqual([])
    expect(s.bytes).toBe(3 * 'bytes of a1'.length)
    expect(readFileSync(join(root, 'a2.bin'), 'utf8')).toBe('bytes of a2')
    expect(sourceSeen.sort()).toEqual(['a1', 'a2', 'a3'])
  })

  it('a present object of another size is copied again', async () => {
    objects.set('b1', Buffer.from('the full object'))
    rows.push(row('b1', 15))
    writeFileSync(join(root, 'b1.bin'), 'half')
    const s = await finished(
      (await startPull({ source: SOURCE, ticket: TICKET, mode: 'full' })).run_id
    )
    expect(s).toMatchObject({ state: 'done', copied: 1, skipped: 0 })
    expect(readFileSync(join(root, 'b1.bin'), 'utf8')).toBe('the full object')
  })

  it('a 404 lands in missing (neither copied nor failed)', async () => {
    objects.set('c1', Buffer.from('here'))
    rows.push(row('c1', 4), row('c2', 4))
    const s = await finished(
      (await startPull({ source: SOURCE, ticket: TICKET, mode: 'full' })).run_id
    )
    expect(s).toMatchObject({ state: 'done', total: 2, copied: 1, failed: 0, missing: ['c2'] })
  })

  it('a second delta run copies only a new row', async () => {
    for (const id of ['d1', 'd2']) {
      objects.set(id, Buffer.from(`x-${id}`))
      rows.push(row(id, 4))
    }
    const first = await finished(
      (await startPull({ source: SOURCE, ticket: TICKET, mode: 'full' })).run_id
    )
    expect(first).toMatchObject({ state: 'done', copied: 2 })
    objects.set('d3', Buffer.from('x-d3'))
    rows.push(row('d3', 4))
    sourceSeen.length = 0
    const delta = await finished(
      (await startPull({ source: SOURCE, ticket: TICKET, mode: 'delta' })).run_id
    )
    expect(delta).toMatchObject({ state: 'done', total: 1, copied: 1, skipped: 0 })
    expect(sourceSeen).toEqual(['d3'])
  })

  it('delta also takes a row changed since the previous run started', async () => {
    objects.set('e1', Buffer.from('v1'))
    rows.push(row('e1', 2))
    await finished((await startPull({ source: SOURCE, ticket: TICKET, mode: 'full' })).run_id)
    // e1 changed after that run started: same key, new bytes of another size
    objects.set('e1', Buffer.from('version 2'))
    rows[0] = row('e1', 9, { modified_on: new Date(Date.now() + 60_000) })
    const delta = await finished(
      (await startPull({ source: SOURCE, ticket: TICKET, mode: 'delta' })).run_id
    )
    expect(delta).toMatchObject({ total: 1, copied: 1 })
    expect(readFileSync(join(root, 'e1.bin'), 'utf8')).toBe('version 2')
  })

  it('a redirect answer fails that row (redirect: error)', async () => {
    objects.set('f1', Buffer.from('fine'))
    rows.push(row('f1', 4), row('f2', 4))
    redirects.add('f2')
    const s = await finished(
      (await startPull({ source: SOURCE, ticket: TICKET, mode: 'full' })).run_id
    )
    expect(s).toMatchObject({ state: 'done', copied: 1, failed: 1 })
    expect(sourceSeen).not.toContain('redirect-target')
    expect(() => statSync(join(root, 'f2.bin'))).toThrow()
  })

  it('an answer over the per-object cap fails that row', async () => {
    pullDeps.limits = { ...pullDeps.defaultLimits, maxObjectBytes: 8 }
    objects.set('g1', Buffer.from('0123456789abcdef'))
    objects.set('g2', Buffer.from('small'))
    rows.push(row('g1', 16), row('g2', 5))
    const s = await finished(
      (await startPull({ source: SOURCE, ticket: TICKET, mode: 'full' })).run_id
    )
    expect(s).toMatchObject({ copied: 1, failed: 1 })
  })

  it('refuses a source that is not https or a private http address (BAD_SOURCE)', async () => {
    for (const source of [
      'http://example.com/api/hub-transfer/files',
      'ftp://10.0.0.1/api/hub-transfer/files',
      'https://user:pw@example.com/api/hub-transfer/files',
      'https://example.com/other/path',
      'https://example.com/api/hub-transfer/files?x=1'
    ]) {
      const err = await startPull({ source, ticket: TICKET, mode: 'full' }).catch((e) => e)
      expect(err, source).toBeInstanceOf(PullError)
      expect(err.code, source).toBe('BAD_SOURCE')
      expect(String(err.message)).not.toContain(TICKET)
    }
    for (const source of [
      'https://acme.example.com/api/hub-transfer/files',
      'http://10.1.2.3:3055/api/hub-transfer/files',
      'http://192.168.4.5/api/hub-transfer/files/',
      'http://172.20.0.9/api/hub-transfer/files'
    ]) {
      rows = []
      const out = await startPull({ source, ticket: TICKET, mode: 'full' })
      expect(out.run_id, source).toMatch(/^[A-Za-z0-9_-]{1,100}$/)
      await finished(out.run_id)
    }
  })

  it('refuses a bad ticket or mode', async () => {
    expect(
      await startPull({ source: SOURCE, ticket: 'Bearer x', mode: 'full' }).catch((e) => e.code)
    ).toBe('BAD_TICKET')
    expect(
      await startPull({ source: SOURCE, ticket: TICKET, mode: 'all' as never }).catch((e) => e.code)
    ).toBe('BAD_MODE')
  })

  it('one pull at a time per app (PULL_RUNNING)', async () => {
    objects.set('h1', Buffer.from('h'))
    rows.push(row('h1', 1))
    const first = await startPull({ source: SOURCE, ticket: TICKET, mode: 'full' })
    const err = await startPull({ source: SOURCE, ticket: TICKET, mode: 'full' }).catch((e) => e)
    expect(err.code).toBe('PULL_RUNNING')
    await finished(first.run_id)
    await finished((await startPull({ source: SOURCE, ticket: TICKET, mode: 'delta' })).run_id)
  })

  it('a refused ticket fails the run, and the ticket never appears in status, logs or errors', async () => {
    const WRONG = `nvt_${'W'.repeat(43)}`
    objects.set('i1', Buffer.from('i'))
    rows.push(row('i1', 1), row('i2', 1))
    const bad = await startPull({ source: SOURCE, ticket: WRONG, mode: 'full' })
    const s = await finished(bad.run_id)
    expect(s.state).toBe('failed')
    expect(s.error).toMatch(/refused/i)
    const good = await startPull({ source: SOURCE, ticket: TICKET, mode: 'full' })
    const ok = await finished(good.run_id)
    const everything = JSON.stringify({
      bad,
      good,
      s,
      ok,
      logs,
      redis: [...redis.kv.entries()],
      mirrored: [await readPullStatus(bad.run_id), await readPullStatus(good.run_id)]
    })
    expect(everything).not.toContain(WRONG)
    expect(everything).not.toContain(TICKET)
    expect(logs.length).toBeGreaterThan(0)
  })

  it('status is mirrored in Redis for another replica, without the ticket', async () => {
    objects.set('j1', Buffer.from('j'))
    rows.push(row('j1', 1))
    const { run_id } = await startPull({ source: SOURCE, ticket: TICKET, mode: 'full' })
    await finished(run_id)
    resetPullsForTests() // another replica: nothing in memory
    expect(pullStatus(run_id)).toBeNull()
    const mirrored = await readPullStatus(run_id)
    expect(mirrored).toMatchObject({ state: 'done', copied: 1 })
    expect(JSON.stringify([...redis.kv.entries()])).not.toContain(TICKET)
    expect(await readPullStatus('no-such-run')).toBeNull()
  })

  it('no progress for the stall window fails the run', async () => {
    pullDeps.limits = { ...pullDeps.defaultLimits, stallMs: 150, stallCheckMs: 20 }
    rows.push(row('k1', 1))
    // a source that never answers this one object
    const hang = createServer(() => {
      /* never answers */
    })
    await new Promise<void>((r) => hang.listen(0, '127.0.0.1', r))
    const a = hang.address()
    const src = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}/api/hub-transfer/files`
    try {
      const s = await finished(
        (await startPull({ source: src, ticket: TICKET, mode: 'full' })).run_id
      )
      expect(s.state).toBe('failed')
      expect(s.error).toMatch(/no progress/i)
    } finally {
      hang.closeAllConnections()
      await new Promise<void>((r) => hang.close(() => r()))
    }
  })

  it('a run is seen only inside the app that started it (shared deployment)', async () => {
    process.env.HUB_SHARED_DEPLOYMENT = 'shared-a'
    process.env.HUB_URL = 'https://hub.example'
    process.env.HUB_DEPLOYMENT_TOKEN = 'd'.repeat(40)
    delete process.env.HUB_TOKEN
    const t = (id: string) => ({
      id,
      slug: id,
      dbClient: 'pg',
      dbConnection: `postgres://u:p@127.0.0.1:1/${id.replace(/-/g, '_')}`,
      poolMax: 1
    })
    rows.push(row('l1', 1))
    objects.set('l1', Buffer.from('l'))
    const { run_id } = await withTenant(t('app-a-e1'), () =>
      startPull({ source: SOURCE, ticket: TICKET, mode: 'full' })
    )
    await withTenant(t('app-a-e1'), async () => {
      await finished(run_id)
    })
    expect(await withTenant(t('app-b-e2'), async () => pullStatus(run_id))).toBeNull()
    expect(await withTenant(t('app-b-e2'), () => readPullStatus(run_id))).toBeNull()
    expect(await withTenant(t('app-a-e1'), () => readPullStatus(run_id))).toMatchObject({
      state: 'done'
    })
  })
})
