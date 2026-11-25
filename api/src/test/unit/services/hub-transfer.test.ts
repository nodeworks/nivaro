import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
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

import { requestedPool } from '../../../db/pool-context.js'
import { getTenantId, withTenant } from '../../../db/tenant-context.js'
import {
  errorShape,
  type FileRow,
  PullError,
  parseSourceScope,
  pullDeps,
  pullStatus,
  readPullStatus,
  resetPullsForTests,
  startPull
} from '../../../services/hub-transfer/pull.js'
import {
  mintTransferTicket,
  revokeTransferTicket,
  TRANSFER_TICKET_RE,
  ticketDeps,
  ticketKey,
  ticketTenant
} from '../../../services/hub-transfer/tickets.js'
import { scopedStorage } from '../../../services/storage/app-scope.js'

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
  pexpired: string[] = []
  async pexpire(k: string, _ms: number) {
    this.pexpired.push(k)
    return 1
  }
  /** The one script the pull runs: compare-and-pexpire of its lock. */
  async eval(script: string, _n: number, key: string, value: string, ms: string) {
    expect(script).toContain("redis.call('pexpire'")
    if ((await this.get(key)) !== value) return 0
    return this.pexpire(key, Number(ms))
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
/** Ids answered without X-Nivaro-Filename-Disk / without Content-Length (chunked). */
const noName = new Set<string>()
const noLength = new Set<string>()
/** R6-I-1: ids the source cannot read right now (its storage throttles): 503. */
const readFails = new Set<string>()
/** Review M-5: ids answered by "a proxy's" 404 (no transfer-route marker). */
const proxy404 = new Set<string>()
/** C-1: ids whose 503 says the source's FILES_FALLBACK_DIR is gone or empty. */
const fallbackGone = new Set<string>()
/** Review N-3: ids whose body the source cuts off mid-way (the connection drops). */
const cutMidBody = new Set<string>()
/** 0.3.215: extra answer headers per id (the store, its bucket hash and the full key). */
const extraHeaders = new Map<string, Record<string, string>>()
const sourceSeen: string[] = []
let server: Server
let SOURCE = ''

beforeAll(async () => {
  server = createServer((req, res) => {
    const last = decodeURIComponent((req.url ?? '').split('/').pop() ?? '')
    // 0.3.215: /api/hub-transfer/replays/:id serves a replay's cold object (key `replay:<id>`).
    const replay = (req.url ?? '').startsWith('/api/hub-transfer/replays/')
    const id = replay ? `replay:${last}` : last
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
    if (fallbackGone.has(id)) {
      res.writeHead(503, { 'content-type': 'application/json' })
      return res.end('{"code":"SOURCE_READ_FAILED","reason":"FALLBACK_FOLDER_UNAVAILABLE"}')
    }
    if (readFails.has(id)) {
      res.writeHead(503, { 'content-type': 'application/json' })
      return res.end('{"code":"SOURCE_READ_FAILED"}')
    }
    if (id === 'redirect-target') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': '4' })
      return res.end('evil')
    }
    const body = objects.get(id)
    if (!body) {
      // The transfer route's own "not found" marker (only that counts as missing).
      res.writeHead(404, {
        'content-type': 'application/json',
        ...(proxy404.has(id) ? {} : { 'x-nivaro-transfer-missing': '1' })
      })
      return res.end('{"code":"NOT_FOUND"}')
    }
    const headers: Record<string, string> = {
      'content-type': 'application/octet-stream',
      ...(extraHeaders.get(id) ?? {})
    }
    if (!noLength.has(id)) headers['content-length'] = String(body.length)
    if (!noName.has(id))
      headers['x-nivaro-filename-disk'] = replay ? `session-replays/${last}.gz` : `${id}.bin`
    res.writeHead(200, headers)
    if (cutMidBody.has(id)) {
      // Half the bytes, then the connection drops.
      res.write(body.subarray(0, Math.floor(body.length / 2)))
      setTimeout(() => res.socket?.destroy(), 20)
      return
    }
    if (noLength.has(id)) {
      res.write(body)
      return res.end()
    }
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
let tmp = ''
let rows: FileRow[] = []
let replayRows: FileRow[] = []
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
  tmp = mkdtempSync(join(tmpdir(), 'nvr-hub-transfer-tmp-'))
  pullDeps.tmpDir = () => tmp
  redis = new FakeRedis()
  rows = []
  objects.clear()
  redirects.clear()
  noName.clear()
  noLength.clear()
  readFails.clear()
  proxy404.clear()
  fallbackGone.clear()
  cutMidBody.clear()
  extraHeaders.clear()
  sourceSeen.length = 0
  logs.length = 0
  resetPullsForTests()
  ticketDeps.redis = () => redis
  ticketDeps.now = () => Date.now()
  pullDeps.redis = () => redis as never
  pullDeps.storage = () => fakeStorage() as never
  pullDeps.listRows = async (after, limit, withObjects = false, withEnv = false) =>
    rows
      .filter((r) => after === null || r.id > after)
      .filter(
        (r) =>
          (r.storage ?? 'local') === 'local' ||
          (withObjects && ['s3', 'azure-blob'].includes(String(r.storage))) ||
          (withEnv && ['s3', 'azure'].includes(String(r.storage)))
      )
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .slice(0, limit)
  replayRows = []
  pullDeps.listReplays = async (after, limit) =>
    replayRows
      .filter((r) => after === null || r.id > after)
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .slice(0, limit)
  pullDeps.log = (msg, meta) => void logs.push(`${msg} ${JSON.stringify(meta ?? {})}`)
  pullDeps.fetch = (url, init) => fetch(url, init)
  pullDeps.safeFetch = () => Promise.reject(new Error('safeFetch is not expected in this test'))
  pullDeps.limits = { ...pullDeps.defaultLimits }
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true })
  rmSync(tmp, { recursive: true, force: true })
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

  it('revoke ends a ticket at once, only for the app it was minted for', async () => {
    process.env.HUB_SHARED_DEPLOYMENT = 'shared-a'
    process.env.HUB_URL = 'https://hub.example'
    process.env.HUB_DEPLOYMENT_TOKEN = 'd'.repeat(40)
    delete process.env.HUB_TOKEN
    const { ticket } = await mintTransferTicket('app-a-e1')
    expect(await revokeTransferTicket(ticket, 'app-b-e2')).toBe(false)
    expect((await ticketTenant(ticket)).ok).toBe(true)
    expect(await revokeTransferTicket(ticket, 'app-a-e1')).toBe(true)
    expect((await ticketTenant(ticket)).ok).toBe(false)
    expect(redis.kv.size).toBe(0)
    // already gone, or not a ticket: nothing to revoke
    expect(await revokeTransferTicket(ticket, 'app-a-e1')).toBe(false)
    expect(await revokeTransferTicket('nope', 'app-a-e1')).toBe(false)
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

  it('delta re-copies a changed row even at the same size (no size skip for a change)', async () => {
    objects.set('e2', Buffer.from('aaaa'))
    rows.push(row('e2', 4))
    await finished((await startPull({ source: SOURCE, ticket: TICKET, mode: 'full' })).run_id)
    objects.set('e2', Buffer.from('bbbb'))
    rows[0] = row('e2', 4, { modified_on: new Date(Date.now() + 60_000) })
    const delta = await finished(
      (await startPull({ source: SOURCE, ticket: TICKET, mode: 'delta' })).run_id
    )
    expect(delta).toMatchObject({ total: 1, copied: 1, skipped: 0 })
    expect(readFileSync(join(root, 'e2.bin'), 'utf8')).toBe('bbbb')
  })

  it('a redirect answer fails that row (redirect: error)', async () => {
    objects.set('f1', Buffer.from('fine'))
    rows.push(row('f1', 4), row('f2', 4))
    redirects.add('f2')
    const s = await finished(
      (await startPull({ source: SOURCE, ticket: TICKET, mode: 'full' })).run_id
    )
    expect(s).toMatchObject({ state: 'done', copied: 1, failed: 1 })
    expect(s.failed_reasons).toEqual({ unreachable: 1 })
    expect(sourceSeen).not.toContain('redirect-target')
    expect(() => statSync(join(root, 'f2.bin'))).toThrow()
  })

  // Task 16 changed this on purpose (T10 review N-1): a row whose stored filesize disagrees with
  // what the source serves is copied anyway against the source's Content-Length and counted in
  // size_mismatch; before, a stale filesize failed the row on every run.
  it('an answer without the disk name or Content-Length fails its row; a stale row size copies and counts', async () => {
    for (const id of ['n1', 'n2', 'n3', 'n4']) objects.set(id, Buffer.from(`body-${id}`))
    noName.add('n1')
    noLength.add('n2')
    rows.push(row('n1', 7), row('n2', 7), row('n3', 99), row('n4', 7))
    const s = await finished(
      (await startPull({ source: SOURCE, ticket: TICKET, mode: 'full' })).run_id
    )
    expect(s).toMatchObject({ state: 'done', copied: 2, failed: 2, size_mismatch: 1 })
    expect([...(s?.failed_ids ?? [])].sort()).toEqual(['n1', 'n2'])
    expect(s.failed_reasons).toEqual({ bad_answer: 2 })
    for (const id of ['n1', 'n2']) expect(() => statSync(join(root, `${id}.bin`))).toThrow()
    expect(readFileSync(join(root, 'n3.bin'), 'utf8')).toBe('body-n3')
    expect(readFileSync(join(root, 'n4.bin'), 'utf8')).toBe('body-n4')
  })

  // Review M-5: only the transfer route's own "not found" (its marker) is missing.
  it('a 404 without the transfer route marker (a proxy) fails its row, never "missing"', async () => {
    rows.push(row('p1', 4), row('p2', 4))
    proxy404.add('p1')
    const s = await finished(
      (await startPull({ source: SOURCE, ticket: TICKET, mode: 'full' })).run_id
    )
    expect(s).toMatchObject({ state: 'done', failed: 1, missing: ['p2'] })
    expect(s.failed_ids).toEqual(['p1'])
    expect(s.failed_reasons).toEqual({ bad_answer: 1 })
  })

  // C-1: a source whose FILES_FALLBACK_DIR is gone or empty says so; the reason is its own.
  it('a 503 naming FALLBACK_FOLDER_UNAVAILABLE counts as source_fallback_unavailable', async () => {
    rows.push(row('g1', 4))
    fallbackGone.add('g1')
    const s = await finished(
      (await startPull({ source: SOURCE, ticket: TICKET, mode: 'full' })).run_id
    )
    expect(s.failed_reasons).toEqual({ source_fallback_unavailable: 1 })
  })

  // Review N-3: a source that drops the connection mid-body is incomplete, never the target's
  // temp folder (pipeline destroys the temp file's stream with the source's error too).
  it('a body the source cuts off mid-way is incomplete, not a temp-folder failure', async () => {
    objects.set('c1', Buffer.alloc(64 * 1024, 7))
    rows.push(row('c1', 64 * 1024))
    cutMidBody.add('c1')
    const s = await finished(
      (await startPull({ source: SOURCE, ticket: TICKET, mode: 'full' })).run_id
    )
    expect(s).toMatchObject({ failed: 1, copied: 0 })
    expect(s.failed_reasons).toEqual({ incomplete: 1 })
    expect(() => statSync(join(root, 'c1.bin'))).toThrow()
  })

  // Review M-5: a full or unwritable temporary folder on the target is its own reason.
  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
    'a temporary folder that cannot be written fails the row as temp_write_failed',
    async () => {
      objects.set('t1', Buffer.from('four'))
      rows.push(row('t1', 4))
      const ro = join(tmp, 'read-only')
      mkdirSync(ro)
      chmodSync(ro, 0o500)
      pullDeps.tmpDir = () => ro
      try {
        const s = await finished(
          (await startPull({ source: SOURCE, ticket: TICKET, mode: 'full' })).run_id
        )
        expect(s).toMatchObject({ failed: 1, copied: 0 })
        expect(s.failed_reasons).toEqual({ temp_write_failed: 1 })
      } finally {
        chmodSync(ro, 0o755)
      }
    }
  )

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

  it('an https source on a host name goes through safeFetch; a private literal keeps plain fetch', async () => {
    const guarded: string[] = []
    const plain: string[] = []
    const answer = () =>
      new Response('ok', {
        status: 200,
        headers: { 'content-length': '2', 'x-nivaro-filename-disk': 'm1.bin' }
      })
    pullDeps.safeFetch = async (url, init) => {
      guarded.push(String(url))
      expect(init.redirect).toBe('error')
      return answer()
    }
    pullDeps.fetch = async (url, init) => {
      plain.push(String(url))
      expect(init.redirect).toBe('error')
      return answer()
    }
    rows.push(row('m1', 2))
    for (const source of [
      'https://acme.example.com/api/hub-transfer/files',
      'https://10.1.2.3/api/hub-transfer/files',
      'http://192.168.1.4:3055/api/hub-transfer/files'
    ]) {
      rmSync(join(root, 'm1.bin'), { force: true })
      const s = await finished((await startPull({ source, ticket: TICKET, mode: 'full' })).run_id)
      expect(s.copied, source).toBe(1)
    }
    expect(guarded).toEqual(['https://acme.example.com/api/hub-transfer/files/m1'])
    expect(plain).toEqual([
      'https://10.1.2.3/api/hub-transfer/files/m1',
      'http://192.168.1.4:3055/api/hub-transfer/files/m1'
    ])
  })

  it('a pull sweeps temp files older than 24 h left by a crashed run, and keeps fresh ones', async () => {
    mkdirSync(tmp, { recursive: true })
    const old = join(tmp, 'crashed-run-part')
    const fresh = join(tmp, 'running-elsewhere-part')
    writeFileSync(old, 'x')
    writeFileSync(fresh, 'y')
    const dayAndAHalf = (Date.now() - 36 * 60 * 60 * 1000) / 1000
    utimesSync(old, dayAndAHalf, dayAndAHalf)
    await finished((await startPull({ source: SOURCE, ticket: TICKET, mode: 'full' })).run_id)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })

  it('errorShape keeps an error’s name and code, never its message', () => {
    const e = Object.assign(new RangeError(`bad ${TICKET}`), { code: 'E_X' })
    expect(errorShape(e)).toEqual({ err_name: 'RangeError', err_code: 'E_X' })
    expect(JSON.stringify(errorShape(e))).not.toContain(TICKET)
    expect(errorShape(null)).toEqual({ err_name: null, err_code: null })
    expect(errorShape({ code: 7 })).toEqual({ err_name: null, err_code: '7' })
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

  it('a wait no signal can reach (size never resolves) still fails the run in the stall window', async () => {
    pullDeps.limits = { ...pullDeps.defaultLimits, stallMs: 150, stallCheckMs: 20 }
    objects.set('s1', Buffer.from('s'))
    rows.push(row('s1', 1))
    let release: (v: number | null) => void = () => {}
    const hung = new Promise<number | null>((r) => {
      release = r
    })
    pullDeps.storage = () => ({ ...fakeStorage(), size: () => hung }) as never
    const t0 = Date.now()
    const { run_id } = await startPull({ source: SOURCE, ticket: TICKET, mode: 'full' })
    const s = await finished(run_id)
    expect(s.state).toBe('failed')
    expect(s.error).toMatch(/no progress/i)
    expect(Date.now() - t0).toBeLessThan(2_000)
    expect(logs.some((l) => l.includes('"reason":"STALLED"'))).toBe(true)
    // the lock is gone and the mirror says failed
    expect([...redis.kv.keys()].some((k) => k.includes('pull-lock'))).toBe(false)
    resetPullsForTests()
    expect((await readPullStatus(run_id))?.state).toBe('failed')
    // the stuck wait comes back late: nothing flips back
    release(1)
    await new Promise((r) => setTimeout(r, 30))
    expect((await readPullStatus(run_id))?.state).toBe('failed')
    // and a new pull can start
    pullDeps.storage = () => fakeStorage() as never
    const next = await startPull({ source: SOURCE, ticket: TICKET, mode: 'full' })
    expect((await finished(next.run_id)).state).toBe('done')
  })

  it('a late return after a stall never flips the status this process answers', async () => {
    pullDeps.limits = { ...pullDeps.defaultLimits, stallMs: 150, stallCheckMs: 20 }
    objects.set('s2', Buffer.from('s'))
    rows.push(row('s2', 1))
    let release: (v: number | null) => void = () => {}
    const hung = new Promise<number | null>((r) => {
      release = r
    })
    pullDeps.storage = () => ({ ...fakeStorage(), size: () => hung }) as never
    const { run_id } = await startPull({ source: SOURCE, ticket: TICKET, mode: 'full' })
    expect((await finished(run_id)).state).toBe('failed')
    release(1)
    await new Promise((r) => setTimeout(r, 50))
    expect(pullStatus(run_id)).toMatchObject({ state: 'failed', copied: 0, skipped: 0 })
  })

  it('the lock is renewed only while it is still this run’s (compare-and-pexpire)', async () => {
    pullDeps.limits = {
      ...pullDeps.defaultLimits,
      stallMs: 10_000,
      stallCheckMs: 20,
      objectTimeoutMs: 300
    }
    rows.push(row('o1', 1))
    const hang = createServer(() => {
      /* never answers */
    })
    await new Promise<void>((r) => hang.listen(0, '127.0.0.1', r))
    const a = hang.address()
    const src = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}/api/hub-transfer/files`
    try {
      const { run_id } = await startPull({ source: src, ticket: TICKET, mode: 'full' })
      const lock = [...redis.kv.keys()].find((k) => k.includes('pull-lock')) as string
      await new Promise((r) => setTimeout(r, 80))
      expect(redis.pexpired.filter((k) => k === lock).length).toBeGreaterThan(0)
      // another run took the lock over (this one's lapsed): never extend theirs
      await redis.set(lock, 'someone-else')
      redis.pexpired.length = 0
      await new Promise((r) => setTimeout(r, 80))
      expect(redis.pexpired.filter((k) => k === lock)).toEqual([])
      await finished(run_id)
      // and the end of this run leaves their lock alone
      expect(await redis.get(lock)).toBe('someone-else')
    } finally {
      hang.closeAllConnections()
      await new Promise<void>((r) => hang.close(() => r()))
    }
  })

  it('the copy runs on the background pool, not the request pool', async () => {
    const pools: string[] = []
    const list = pullDeps.listRows
    pullDeps.listRows = async (after, limit) => {
      pools.push(requestedPool())
      return list(after, limit)
    }
    expect(requestedPool()).toBe('main')
    await finished((await startPull({ source: SOURCE, ticket: TICKET, mode: 'full' })).run_id)
    expect(pools.length).toBeGreaterThan(0)
    expect(new Set(pools)).toEqual(new Set(['background']))
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

// Ruling P6-31: saved-settings S3/Azure objects live under apps/<tenant>/ on a shared deployment.
// A move to or from one changes the key prefix, so the pull copies them (same bucket or not)
// through the target's own saved-settings driver.
describe('pull: saved-settings objects (P6-31)', () => {
  /** One S3 bucket both homes name (the app's settings row is the same on both). */
  const bucket = new Map<string, Buffer>()
  const fakeS3 = () => ({
    name: 's3',
    async put(k: string, b: Buffer) {
      bucket.set(k, b)
    },
    async putFile(k: string, from: string) {
      const b = readFileSync(from)
      bucket.set(k, b)
      return b.length
    },
    async get(k: string) {
      const b = bucket.get(k)
      if (!b) throw new Error('missing')
      return b
    },
    async delete(k: string) {
      bucket.delete(k)
    },
    async exists(k: string) {
      return bucket.has(k)
    }
  })
  beforeEach(() => bucket.clear())

  it('to a shared deployment: a bucket-root object is copied under apps/<tenant>/ in the same bucket', async () => {
    const { scopedStorage } = await import('../../../services/storage/app-scope.js')
    bucket.set('o1.bin', Buffer.from('object one'))
    objects.set('o1', bucket.get('o1.bin') as Buffer) // the source serves its own (root) key
    rows.push(row('o1', 10, { storage: 's3' }), row('l1', 5))
    objects.set('l1', Buffer.from('local'))
    pullDeps.objectStorage = async () => scopedStorage(fakeS3(), () => 'shop-e11') as never
    const { run_id } = await startPull({
      source: SOURCE,
      ticket: TICKET,
      mode: 'full',
      objects: true
    })
    const s = await finished(run_id)
    expect(s).toMatchObject({ state: 'done', total: 2, copied: 2, failed: 0 })
    expect(bucket.get('apps/shop-e11/o1.bin')?.toString()).toBe('object one')
    expect(bucket.has('o1.bin')).toBe(true) // copied, not moved: the old copy is still there
    expect(readFileSync(join(root, 'l1.bin'), 'utf8')).toBe('local')
  })

  it('from a shared deployment: an apps/<tenant>/ object is copied to the bucket root', async () => {
    bucket.set('apps/shop-e11/o2.bin', Buffer.from('object two'))
    objects.set('o2', bucket.get('apps/shop-e11/o2.bin') as Buffer) // served from its scope
    rows.push(row('o2', 10, { storage: 's3' }))
    pullDeps.objectStorage = async () => fakeS3() as never // a dedicated target: unscoped
    const { run_id } = await startPull({
      source: SOURCE,
      ticket: TICKET,
      mode: 'full',
      objects: true
    })
    const s = await finished(run_id)
    expect(s).toMatchObject({ state: 'done', total: 1, copied: 1, failed: 0 })
    expect(bucket.get('o2.bin')?.toString()).toBe('object two')
  })

  // R6-I-1: an S3 read error at the source (a 5xx, not a 404) fails the row, never "missing":
  // in a blocking copy (inside maintenance) that stops the move before release.
  it('R6-I-1: a source that cannot read an S3 object right now fails that row (not missing)', async () => {
    rows.push(row('o4', 10, { storage: 's3' }))
    readFails.add('o4')
    pullDeps.objectStorage = async () => fakeS3() as never
    const { run_id } = await startPull({
      source: SOURCE,
      ticket: TICKET,
      mode: 'full',
      objects: true
    })
    const s = await finished(run_id)
    expect(s).toMatchObject({ state: 'done', total: 1, copied: 0, failed: 1 })
    expect(s.missing).toEqual([])
    expect(s.failed_ids).toEqual(['o4'])
    // The plain reason the move repeats (hub-transfer/fail-reasons.ts).
    expect(s.failed_reasons).toEqual({ source_read_failed: 1 })
  })

  it('without objects (the prefix stays) a saved-settings row is never copied', async () => {
    bucket.set('o3.bin', Buffer.from('object three'))
    objects.set('o3', bucket.get('o3.bin') as Buffer)
    rows.push(row('o3', 12, { storage: 's3' }))
    let asked = false
    pullDeps.objectStorage = async () => {
      asked = true
      return fakeS3() as never
    }
    const { run_id } = await startPull({ source: SOURCE, ticket: TICKET, mode: 'full' })
    const s = await finished(run_id)
    expect(s).toMatchObject({ state: 'done', total: 0, copied: 0 })
    expect(asked).toBe(false)
    expect(sourceSeen).toEqual([])
  })
})

// 0.3.215: env S3/Azure objects (storage 's3' / 'azure'), the store the source says held each
// object, a server-side copy inside one bucket, and the cold objects of session replays.
describe('pull: env object storage and session replays (0.3.215)', () => {
  /** This side's env provider on one bucket (hash BUCKET): what it holds, and its copies. */
  const BUCKET = 'b'.repeat(64)
  const envBucket = new Map<string, Buffer>()
  const copies: Array<{ key: string; raw: string; mime: string; scope: unknown }> = []
  let copyFails = false
  function envS3(tenant: string | null = null) {
    const full = (k: string) => (tenant ? `apps/${tenant}/${k}` : k)
    return {
      async size(k: string) {
        return envBucket.get(full(k))?.length ?? null
      },
      async putFile(k: string, from: string) {
        const b = readFileSync(from)
        envBucket.set(full(k), b)
        return b.length
      },
      storeId: () => BUCKET,
      async copyFrom(k: string, raw: string, mime: string, opts: { sourceScope: unknown }) {
        if (copyFails) throw Object.assign(new Error('AccessDenied'), { name: 'AccessDenied' })
        copies.push({ key: full(k), raw, mime, scope: opts.sourceScope })
        const b = envBucket.get(raw)
        if (!b) throw new Error('NoSuchKey')
        envBucket.set(full(k), b)
        return b.length
      }
    }
  }
  const settingsBucket = new Map<string, Buffer>()
  const settingsS3 = () => ({
    async putFile(k: string, from: string) {
      const b = readFileSync(from)
      settingsBucket.set(k, b)
      return b.length
    }
  })
  beforeEach(() => {
    envBucket.clear()
    settingsBucket.clear()
    copies.length = 0
    copyFails = false
    pullDeps.storage = () => envS3() as never
    pullDeps.objectStorage = async () => settingsS3() as never
  })
  const envSaid = (id: string, raw: string | null, store = 'env', bucket = BUCKET) =>
    extraHeaders.set(id, {
      'x-nivaro-transfer-store': store,
      ...(raw ? { 'x-nivaro-transfer-store-id': bucket, 'x-nivaro-transfer-stored-key': raw } : {})
    })
  const start = (o: Partial<Parameters<typeof startPull>[0]> = {}) =>
    startPull({ source: SOURCE, ticket: TICKET, mode: 'full', env_objects: true, ...o })
  const replayRow = (id: string, size: number): FileRow => ({
    id,
    kind: 'replay',
    filename_disk: `session-replays/${id}.gz`,
    storage: 'replay',
    filesize: size,
    type: 'application/gzip',
    uploaded_on: null,
    modified_on: null
  })

  it('without env_objects an env S3 / Azure row is never taken (an older Hub)', async () => {
    rows.push(row('e1', 3, { storage: 's3' }), row('e2', 3, { storage: 'azure' }))
    const s = await finished((await start({ env_objects: false })).run_id)
    expect(s).toMatchObject({ state: 'done', total: 0 })
    expect(sourceSeen).toEqual([])
  })

  it('another bucket: streamed through into this side’s env provider', async () => {
    for (const id of ['e1', 'e2']) objects.set(id, Buffer.from(`env ${id}`))
    rows.push(row('e1', 6, { storage: 's3' }), row('e2', 6, { storage: 'azure' }))
    envSaid('e1', 'e1.bin', 'env', 'c'.repeat(64)) // a bucket this side does not use
    envSaid('e2', null) // local disk at the source (no bucket): plain stream
    const s = await finished((await start()).run_id)
    expect(s).toMatchObject({ state: 'done', total: 2, copied: 2, failed: 0, server_copied: 0 })
    expect(envBucket.get('e1.bin')?.toString()).toBe('env e1')
    expect(envBucket.get('e2.bin')?.toString()).toBe('env e2')
    expect(copies).toEqual([])
    expect(settingsBucket.size).toBe(0)
  })

  it('an s3 row the source kept in its saved-settings driver goes to the settings driver here', async () => {
    objects.set('s1', Buffer.from('settings'))
    rows.push(row('s1', 8, { storage: 's3' }))
    envSaid('s1', null, 'settings')
    const s = await finished((await start()).run_id)
    expect(s).toMatchObject({ state: 'done', copied: 1 })
    expect(settingsBucket.get('s1.bin')?.toString()).toBe('settings')
    expect(envBucket.size).toBe(0)
  })

  it('the same bucket, shared source to dedicated target: the bucket copies it', async () => {
    envBucket.set('apps/shop-e1/e3.bin', Buffer.from('shared obj'))
    objects.set('e3', Buffer.from('shared obj'))
    rows.push(row('e3', 10, { storage: 's3' }))
    envSaid('e3', 'apps/shop-e1/e3.bin')
    const s = await finished((await start({ source_scope: 'shop-e1' })).run_id)
    expect(s).toMatchObject({ state: 'done', copied: 1, server_copied: 1, bytes: 10, failed: 0 })
    expect(copies).toEqual([
      {
        key: 'e3.bin',
        raw: 'apps/shop-e1/e3.bin',
        mime: 'application/octet-stream',
        scope: { tenant: 'shop-e1' }
      }
    ])
    expect(envBucket.get('e3.bin')?.toString()).toBe('shared obj')
  })

  it('without a source scope from the Hub nothing is copied server-side (streamed)', async () => {
    envBucket.set('apps/shop-e1/e9.bin', Buffer.from('shared obj'))
    objects.set('e9', Buffer.from('shared obj'))
    rows.push(row('e9', 10, { storage: 's3' }))
    envSaid('e9', 'apps/shop-e1/e9.bin')
    const s = await finished((await start()).run_id)
    expect(s).toMatchObject({ state: 'done', copied: 1, server_copied: 0 })
    expect(copies).toEqual([])
  })

  it('dedicated target: another app’s key the source names in the same bucket is never copied', async () => {
    envBucket.set('apps/other-e2/e8.bin', Buffer.from('not ours!!'))
    objects.set('e8', Buffer.from('our bytes!'))
    rows.push(row('e8', 10, { storage: 's3' }))
    envSaid('e8', 'apps/other-e2/e8.bin') // the source lies about where the object is
    const s = await finished((await start({ source_scope: 'shop-e1' })).run_id)
    expect(s).toMatchObject({ state: 'done', copied: 1, server_copied: 0 })
    expect(copies).toEqual([])
    expect(envBucket.get('e8.bin')?.toString()).toBe('our bytes!') // the authenticated read
  })

  it('the root form is refused when the Hub says the source is shared', async () => {
    envBucket.set('e10.bin', Buffer.from('root'))
    objects.set('e10', Buffer.from('streamed!'))
    rows.push(row('e10', 9, { storage: 's3' }))
    envSaid('e10', 'e10.bin')
    const s = await finished((await start({ source_scope: 'shop-e1' })).run_id)
    expect(s).toMatchObject({ state: 'done', copied: 1, server_copied: 0 })
    expect(copies).toEqual([])
    expect(envBucket.get('e10.bin')?.toString()).toBe('streamed!')
  })

  it('a dedicated source (root) naming an apps/ key is refused', async () => {
    envBucket.set('apps/other-e2/e11.bin', Buffer.from('not ours'))
    objects.set('e11', Buffer.from('streamed'))
    rows.push(row('e11', 8, { storage: 's3' }))
    envSaid('e11', 'apps/other-e2/e11.bin')
    const s = await finished((await start({ source_scope: 'root' })).run_id)
    expect(s).toMatchObject({ state: 'done', copied: 1, server_copied: 0 })
    expect(copies).toEqual([])
  })

  it('a source scope that is not a tenant id is ignored (streamed)', async () => {
    expect(parseSourceScope('root')).toBe('root')
    expect(parseSourceScope('shop-e1')).toEqual({ tenant: 'shop-e1' })
    for (const bad of ['../x', 'a/b', '', 'apps/x', 7, null, undefined])
      expect(parseSourceScope(bad), String(bad)).toBeNull()
  })

  it('the same bucket and the very same full key: nothing to copy (skipped)', async () => {
    envBucket.set('e4.bin', Buffer.from('xx'))
    objects.set('e4', Buffer.from('xxx')) // the row's size is stale, so the size skip misses
    rows.push(row('e4', 3, { storage: 's3' }))
    envSaid('e4', 'e4.bin')
    const s = await finished((await start({ source_scope: 'root' })).run_id)
    expect(s).toMatchObject({ state: 'done', skipped: 1, copied: 0 })
    expect(copies).toEqual([])
  })

  it('a server-side copy the bucket refuses (credentials) is streamed instead', async () => {
    envBucket.set('apps/shop-e1/e5.bin', Buffer.from('fallback'))
    objects.set('e5', Buffer.from('fallback'))
    rows.push(row('e5', 8, { storage: 's3' }))
    envSaid('e5', 'apps/shop-e1/e5.bin')
    copyFails = true
    const s = await finished((await start({ source_scope: 'shop-e1' })).run_id)
    expect(s).toMatchObject({ state: 'done', copied: 1, server_copied: 0, failed: 0 })
    expect(envBucket.get('e5.bin')?.toString()).toBe('fallback')
    expect(sourceSeen).toEqual(['e5', 'e5']) // asked again for the bytes
  })

  it('shared target: never copies from the bucket root or another app’s folder', async () => {
    process.env.HUB_SHARED_DEPLOYMENT = 'pool-a'
    process.env.HUB_URL = 'https://hub.example'
    process.env.HUB_DEPLOYMENT_TOKEN = 'd'.repeat(40)
    delete process.env.HUB_TOKEN
    // The real per-app scope over this side's bucket.
    pullDeps.storage = () => scopedStorage(envS3(), () => getTenantId() ?? null) as never
    envBucket.set('e6.bin', Buffer.from('root obj'))
    envBucket.set('apps/other-e2/e7.bin', Buffer.from('not ours'))
    objects.set('e6', Buffer.from('root obj'))
    objects.set('e7', Buffer.from('streamed'))
    rows.push(row('e6', 8, { storage: 's3' }), row('e7', 8, { storage: 's3' }))
    envSaid('e6', 'e6.bin')
    envSaid('e7', 'apps/other-e2/e7.bin')
    const tenant = {
      id: 'shop-e1',
      slug: 'shop',
      name: 'Shop',
      status: 'active',
      dbClient: 'pg',
      dbConnection: 'postgres://x@127.0.0.1:1/x',
      poolMax: 1,
      hostnames: []
    }
    for (const sourceScope of ['root', 'other-e2']) {
      copies.length = 0
      envBucket.delete('apps/shop-e1/e6.bin')
      envBucket.delete('apps/shop-e1/e7.bin')
      const { run_id } = await withTenant(tenant as never, () =>
        start({ source_scope: sourceScope })
      )
      const s = await withTenant(tenant as never, () => finished(run_id))
      expect(s, sourceScope).toMatchObject({ state: 'done', copied: 2, server_copied: 0 })
      expect(copies, sourceScope).toEqual([])
      expect(envBucket.get('apps/shop-e1/e6.bin')?.toString()).toBe('root obj')
      expect(envBucket.get('apps/shop-e1/e7.bin')?.toString()).toBe('streamed')
    }
  })

  it('replays: the cold objects come from /replays/:id into the store the source names', async () => {
    replayRows.push(replayRow('r1', 5), replayRow('r2', 4), replayRow('r3', 4))
    objects.set('replay:r1', Buffer.from('gzip1'))
    objects.set('replay:r2', Buffer.from('gzp2'))
    extraHeaders.set('replay:r1', { 'x-nivaro-transfer-store': 'env' })
    extraHeaders.set('replay:r2', { 'x-nivaro-transfer-store': 'settings' })
    objects.set('f1', Buffer.from('file'))
    rows.push(row('f1', 4))
    const s = await finished((await start({ replays: true })).run_id)
    expect(s).toMatchObject({ state: 'done', total: 4, copied: 3, failed: 0 })
    expect(s.missing).toEqual(['replay:r3'])
    expect(envBucket.get('session-replays/r1.gz')?.toString()).toBe('gzip1')
    expect(settingsBucket.get('session-replays/r2.gz')?.toString()).toBe('gzp2')
    expect(envBucket.get('f1.bin')?.toString()).toBe('file')
    // The manifest holds the tagged replay ids, so a delta takes nothing it already has.
    const manifests = [...redis.sets.values()].map((m) => [...m].sort())
    expect(manifests).toEqual([['f1', 'replay:r1', 'replay:r2']])
    sourceSeen.length = 0
    const again = await finished((await start({ replays: true, mode: 'delta' })).run_id)
    expect(again).toMatchObject({ state: 'done', total: 1, copied: 0 })
    expect(sourceSeen).toEqual(['replay:r3'])
  })

  it('without replays the cold objects are never asked for (an older source)', async () => {
    let asked = false
    pullDeps.listReplays = async () => {
      asked = true
      return []
    }
    await finished((await start()).run_id)
    expect(asked).toBe(false)
  })

  it('a replay the source cannot read fails as replay:<id>', async () => {
    replayRows.push(replayRow('r9', 4))
    readFails.add('replay:r9')
    const s = await finished((await start({ replays: true })).run_id)
    expect(s).toMatchObject({ state: 'done', failed: 1 })
    expect(s.failed_ids).toEqual(['replay:r9'])
    expect(s.failed_reasons).toEqual({ source_read_failed: 1 })
  })
})
