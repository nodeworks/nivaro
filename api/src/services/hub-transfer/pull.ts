import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { isIP } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { db } from '../../db/index.js'
import { runInBackgroundPool } from '../../db/pool-context.js'
import { getTenantId } from '../../db/tenant-context.js'
import { type SafeFetchInit, safeFetch } from '../../lib/ssrf.js'
import { tenantSource } from '../deployment-mode.js'
import { hubLinkKeyTag } from '../hub-link/retire.js'
import { getApp } from '../io-holder.js'
import { getStorage, type StorageProvider } from '../storage/index.js'
import { appKeyPart } from '../tenancy/credential-binding.js'
import { TRANSFER_TICKET_RE } from './tickets.js'

/**
 * The pull (Hub phase 6, Decision 11): the TARGET of a move copies every stored object of the
 * app from the SOURCE's `GET /api/hub-transfer/files/:id` (routes/hub-transfer.ts) into its own
 * env storage, under the same keys.
 *
 *  - Rows: the app's `nivaro_files` whose provider is the env-driven `local` provider (`storage =
 *    'local'`). The database is the app's own (the same one on both homes), so both sides agree
 *    on ids and keys. Settings-driven S3/Azure objects live in the app's bucket and do not move.
 *  - Per row: skipped when the object is already here at the row's size (resumable); otherwise
 *    fetched (`redirect: 'error'`, 10 min per object, 4 at a time) into a temp file, then
 *    `putFile(filename_disk)`. Streams go through `pipeline()`, never `.pipe()`.
 *  - A 404 is `missing` (≤ 50 ids listed; neither copied nor failed: total − copied − skipped −
 *    failed = how many were missing). An answer over 5 GB, a redirect, another status, an answer
 *    without `X-Nivaro-Filename-Disk` (or naming another key) or without `Content-Length`, or a
 *    streamed size that differs from Content-Length or from the row's known size fails that row. A 401/403 (the ticket refused) or no
 *    progress for 10 minutes fails the run.
 *  - `delta`: only rows not in the run manifest (a Redis set of the ids copied or found present
 *    here), or whose `modified_on` moved since the previous finished run started — those are
 *    copied again without the size skip. A `full` run starts a new manifest.
 *  - Source: `https:`, or `http:` only to loopback / RFC 1918 (`BAD_SOURCE`). An https host NAME
 *    is fetched through `safeFetch` (lib/ssrf.ts: the address is pinned, a name that resolves to a
 *    private or reserved address is refused unless SSRF_ALLOW_HOSTS lets it through). The one
 *    exception to "safeFetch for a URL someone supplied": a loopback / RFC 1918 LITERAL (http or
 *    https) uses plain fetch with `redirect: 'error'` — the Hub names a source on its own network
 *    on purpose, and a literal cannot be rebound.
 *
 * One pull per app at a time (`PULL_RUNNING`; a Redis lock across replicas). Status lives in this
 * process and is mirrored to Redis, so another replica can answer the Hub; a run whose mirror
 * stops moving reads `failed`. On a Hub shared deployment everything here runs inside the
 * target app (its rows, its storage scope apps/<tenantId>/, its Redis keys).
 *
 * The ticket is held only in the run's closure: never in status, a Redis value, a log line or an
 * error.
 */

export interface PullRequest {
  /** The source's file route: origin + '/api/hub-transfer/files'. */
  source: string
  ticket: string
  mode: 'full' | 'delta'
}

export interface PullStatus {
  state: 'running' | 'done' | 'failed'
  total: number
  copied: number
  skipped: number
  failed: number
  /** At most 50 file ids. */
  missing: string[]
  bytes: number
  error: string | null
}

export interface FileRow {
  id: string
  filename_disk: string | null
  filesize: number | string | null
  type: string | null
  uploaded_on: Date | string | null
  modified_on: Date | string | null
}

export type PullErrorCode =
  | 'BAD_SOURCE'
  | 'BAD_TICKET'
  | 'BAD_MODE'
  | 'NO_APP'
  | 'PULL_RUNNING'
  | 'REDIS_UNAVAILABLE'

export class PullError extends Error {
  readonly code: PullErrorCode
  readonly statusCode: number
  constructor(code: PullErrorCode, message: string) {
    super(message)
    this.name = 'PullError'
    this.code = code
    this.statusCode = code === 'PULL_RUNNING' ? 409 : code === 'REDIS_UNAVAILABLE' ? 503 : 400
  }
}

export const TRANSFER_FILES_PATH = '/api/hub-transfer/files'
const MAX_MISSING = 50
const RUN_TTL_MS = 24 * 60 * 60 * 1000
const MANIFEST_TTL_MS = 7 * 24 * 60 * 60 * 1000
const LOCK_TTL_MS = 60_000
/** Timestamps may be written in server-local time on some engines (GETDATE): a changed row is
 *  judged against the previous start minus the widest UTC offset. */
const DELTA_CLOCK_MARGIN_MS = 15 * 60 * 60 * 1000
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,100}$/

const ERR_TICKET = 'The source refused the transfer ticket.'
const ERR_STALL = 'The copy stopped: no progress for 10 minutes.'
const ERR_LIST = 'The list of stored files could not be read.'
const ERR_GONE = 'The copy stopped: the process running it went away.'

export interface PullRedis {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ...args: Array<string | number>): Promise<unknown>
  del(...keys: string[]): Promise<unknown>
  pexpire(key: string, ms: number): Promise<unknown>
  sadd(key: string, ...members: string[]): Promise<unknown>
  smembers(key: string): Promise<string[]>
  /** ioredis EVAL; when a client has none, renewal compares then extends in two calls. */
  eval?(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>
}

/** Extend the lock only while it still holds this run's id (atomic on a real Redis). */
const RENEW_IF_MINE =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end"

async function renewLock(redis: PullRedis, key: string, runId: string): Promise<void> {
  try {
    if (typeof redis.eval === 'function') {
      await redis.eval(RENEW_IF_MINE, 1, key, runId, String(LOCK_TTL_MS))
      return
    }
    if ((await redis.get(key)) === runId) await redis.pexpire(key, LOCK_TTL_MS)
  } catch {
    /* a lock that lapses lets a second pull start; the next tick tries again */
  }
}

type PullStorage = Pick<StorageProvider, 'putFile'> & Partial<Pick<StorageProvider, 'size'>>

const defaultLimits = {
  concurrency: 4,
  objectTimeoutMs: 10 * 60 * 1000,
  stallMs: 10 * 60 * 1000,
  stallCheckMs: 30_000,
  maxObjectBytes: 5 * 1024 * 1024 * 1024,
  pageSize: 500,
  mirrorEveryMs: 2_000
}

/** Test seams. */
export const pullDeps = {
  redis(): PullRedis | null {
    try {
      return (getApp()?.redis as PullRedis | undefined) ?? null
    } catch {
      return null
    }
  },
  storage(): PullStorage {
    return getStorage()
  },
  /** The next page of the app's env-local file rows after `after` (by id). */
  async listRows(after: string | null, limit: number): Promise<FileRow[]> {
    let q = db('nivaro_files')
      .select('id', 'filename_disk', 'filesize', 'type', 'uploaded_on', 'modified_on')
      .where('storage', 'local')
      .whereNotNull('filename_disk')
      .orderBy('id', 'asc')
      .limit(limit)
    if (after !== null) q = q.where('id', '>', after)
    return (await q) as FileRow[]
  },
  /** Plain fetch: only for an http(s) source that is a loopback / private literal. */
  fetch: (url: string, init: RequestInit): Promise<Response> => fetch(url, init),
  /** The SSRF-guarded fetch (address pinned, private answers refused) for every https host name. */
  safeFetch: (url: string, init: SafeFetchInit): Promise<Response> => safeFetch(url, init),
  log(msg: string, meta?: Record<string, unknown>): void {
    try {
      getApp()?.log?.info?.(meta ?? {}, msg)
    } catch {
      /* best-effort */
    }
  },
  tmpDir: (): string => join(tmpdir(), 'nivaro-hub-transfer'),
  defaultLimits,
  limits: { ...defaultLimits }
}

// ─── keys (per app on a shared deployment, per hub link on a dedicated one) ─────────────────

/** A dedicated app's own part: two apps on one Redis database never share a run or manifest. */
function linkPart(): string {
  return tenantSource() === 'hub' ? '' : `link:${hubLinkKeyTag()}:`
}
function lockKey(): string {
  return `nvr:hub-transfer:pull-lock:${appKeyPart()}${linkPart()}`
}
function runKey(runId: string): string {
  return `nvr:hub-transfer:run:${appKeyPart()}${linkPart()}${runId}`
}
function manifestKey(): string {
  return `nvr:hub-transfer:manifest:${appKeyPart()}${linkPart()}`
}
function manifestStartKey(): string {
  return `nvr:hub-transfer:manifest-start:${appKeyPart()}${linkPart()}`
}
/** The in-process map's scope: the app on a shared deployment ('' on a dedicated one). */
function scope(): string {
  return tenantSource() === 'hub' ? (getTenantId() ?? '') : ''
}

// ─── source check ────────────────────────────────────────────────────────────────────────────

const LOOPBACK_HOSTS = new Set(['localhost', '[::1]'])

/** Loopback, or an RFC 1918 IPv4 address (10/8, 172.16/12, 192.168/16). */
function plainHttpHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  if (LOOPBACK_HOSTS.has(h)) return true
  if (isIP(h) !== 4) return false
  const [a, b] = h.split('.').map(Number)
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/** The source's file route (origin + TRANSFER_FILES_PATH), or null when it is not allowed. */
export function transferSource(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 500) return null
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return null
  }
  if (u.username || u.password || u.search || u.hash) return null
  if (u.pathname.replace(/\/+$/, '') !== TRANSFER_FILES_PATH) return null
  if (u.protocol === 'https:') return `${u.origin}${TRANSFER_FILES_PATH}`
  if (u.protocol === 'http:' && plainHttpHost(u.hostname))
    return `${u.origin}${TRANSFER_FILES_PATH}`
  return null
}

// ─── runs ────────────────────────────────────────────────────────────────────────────────────

interface Run {
  id: string
  scope: string
  status: PullStatus
  startedAt: number
  lastProgress: number
  finished: boolean
}

const runs = new Map<string, Run>()
const mapKey = (s: string, id: string) => `${s}|${id}`

/** Tests only: forget every run this process knows. */
export function resetPullsForTests(): void {
  runs.clear()
}

function prune(now: number): void {
  for (const [k, r] of runs) if (r.finished && now - r.startedAt > RUN_TTL_MS) runs.delete(k)
}

function copyStatus(s: PullStatus): PullStatus {
  return { ...s, missing: [...s.missing] }
}

/** This app's run `runId` as this process knows it, or null. */
export function pullStatus(runId: string): PullStatus | null {
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) return null
  const r = runs.get(mapKey(scope(), runId))
  return r ? copyStatus(r.status) : null
}

/**
 * This app's run `runId` from this process, else from its Redis mirror (another replica started
 * it). A running mirror that stopped moving reads failed. Null when unknown.
 */
export async function readPullStatus(runId: string): Promise<PullStatus | null> {
  const here = pullStatus(runId)
  if (here) return here
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) return null
  const redis = pullDeps.redis()
  if (!redis) return null
  let raw: string | null
  try {
    raw = await redis.get(runKey(runId))
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as { status?: PullStatus; at?: number }
    if (!v.status || typeof v.status.state !== 'string') return null
    const s = copyStatus(v.status)
    if (s.state === 'running' && Date.now() - Number(v.at ?? 0) > pullDeps.limits.stallMs)
      return { ...s, state: 'failed', error: ERR_GONE }
    return s
  } catch {
    return null
  }
}

function toNumber(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null
}

function toTime(v: unknown): number | null {
  if (v == null) return null
  const t = v instanceof Date ? v.getTime() : new Date(String(v)).getTime()
  return Number.isFinite(t) ? t : null
}

function decodeHeader(v: string): string | null {
  try {
    return decodeURIComponent(v)
  } catch {
    return null
  }
}

const TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * Remove temp files older than 24 h from the pull's temp folder: a run unlinks its own, so these
 * are what a crashed process left. A live run's temp file is at most 10 minutes old (the
 * per-object timeout). Best-effort, never fails a pull.
 */
async function sweepTemp(dir: string, now = Date.now()): Promise<void> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  for (const name of names) {
    const path = join(dir, name)
    try {
      const st = await stat(path)
      if (st.isFile() && now - st.mtimeMs > TEMP_MAX_AGE_MS) await unlink(path)
    } catch {
      /* gone already, or not ours to remove */
    }
  }
}

/** Start a pull; resolves as soon as the run is registered (the copy goes on in the background). */
export async function startPull(req: PullRequest): Promise<{ run_id: string }> {
  const b = (req ?? {}) as Partial<PullRequest>
  const source = transferSource(b.source)
  if (!source)
    throw new PullError(
      'BAD_SOURCE',
      'The source must be an https address, or plain http to a loopback or private address, ending in /api/hub-transfer/files.'
    )
  if (typeof b.ticket !== 'string' || !TRANSFER_TICKET_RE.test(b.ticket))
    throw new PullError('BAD_TICKET', 'The transfer ticket is not one the source minted.')
  if (b.mode !== 'full' && b.mode !== 'delta')
    throw new PullError('BAD_MODE', 'The mode must be full or delta.')
  if (tenantSource() === 'hub' && !getTenantId())
    throw new PullError('NO_APP', 'A pull on a shared deployment runs inside an app.')
  const ticket = b.ticket
  const mode = b.mode
  const sc = scope()
  const now = Date.now()
  prune(now)
  for (const r of runs.values())
    if (r.scope === sc && !r.finished)
      throw new PullError('PULL_RUNNING', 'A file copy is already running for this app.')

  await sweepTemp(pullDeps.tmpDir(), now)

  const runId = randomUUID()
  const redis = pullDeps.redis()
  if (redis) {
    let got: unknown
    try {
      got = await redis.set(lockKey(), runId, 'PX', LOCK_TTL_MS, 'NX')
    } catch {
      throw new PullError('REDIS_UNAVAILABLE', 'The file copy could not be started (Redis).')
    }
    if (got == null)
      throw new PullError('PULL_RUNNING', 'A file copy is already running for this app.')
  }

  const run: Run = {
    id: runId,
    scope: sc,
    startedAt: now,
    lastProgress: now,
    finished: false,
    status: {
      state: 'running',
      total: 0,
      copied: 0,
      skipped: 0,
      failed: 0,
      missing: [],
      bytes: 0,
      error: null
    }
  }
  runs.set(mapKey(sc, runId), run)
  pullDeps.log('hub transfer: pull started', {
    run_id: runId,
    mode,
    source: new URL(source).origin
  })
  // Runs in the caller's async context (on a shared deployment, inside the target app) and on
  // the background pool: fire-and-forget work never takes request connections.
  void runInBackgroundPool(() => execute(run, { source, ticket, mode }, redis))
  return { run_id: runId }
}

async function execute(
  run: Run,
  req: { source: string; ticket: string; mode: 'full' | 'delta' },
  redis: PullRedis | null
): Promise<void> {
  const limits = pullDeps.limits
  const st = run.status
  const ac = new AbortController()
  let fatal: string | null = null
  const stop = (why: string) => {
    if (fatal) return
    fatal = why
    ac.abort()
  }
  const progress = () => {
    run.lastProgress = Date.now()
  }
  let lastMirror = 0
  const mirror = async () => {
    // A finished run's mirror is written once, by finalize().
    if (!redis || run.finished) return
    const now = Date.now()
    if (now - lastMirror < limits.mirrorEveryMs) return
    lastMirror = now
    try {
      await redis.set(runKey(run.id), JSON.stringify({ status: st, at: now }), 'PX', RUN_TTL_MS)
    } catch {
      /* best-effort: this process still answers */
    }
  }
  const lockK = lockKey()
  const mKey = manifestKey()
  const startK = manifestStartKey()
  const remember = async (id: string) => {
    if (!redis) return
    try {
      await redis.sadd(mKey, id)
    } catch {
      /* a missing entry only makes the next delta look at that row again */
    }
  }

  // Ends the run once: the status this process answers is frozen (a worker that comes back late
  // from a wait no signal could interrupt — a hung NFS stat, a Redis call — changes an orphaned
  // copy only), the mirror is written, and the lock is released if it is still this run's.
  let finalized: Promise<void> | null = null
  const finalize = (state: 'done' | 'failed', error: string | null, reason?: string) => {
    if (finalized) return finalized
    clearInterval(watchdog)
    run.finished = true
    run.status = { ...copyStatus(st), state, error }
    const final = run.status
    finalized = (async () => {
      if (redis) {
        try {
          await redis.set(
            runKey(run.id),
            JSON.stringify({ status: final, at: Date.now() }),
            'PX',
            RUN_TTL_MS
          )
        } catch {
          /* best-effort: this process still answers */
        }
        try {
          if ((await redis.get(lockK)) === run.id) await redis.del(lockK)
        } catch {
          /* the lock expires on its own */
        }
      }
      pullDeps.log('hub transfer: pull finished', {
        run_id: run.id,
        state,
        ...(reason ? { reason } : {}),
        total: final.total,
        copied: final.copied,
        skipped: final.skipped,
        failed: final.failed,
        missing: final.total - final.copied - final.skipped - final.failed,
        bytes: final.bytes
      })
    })()
    return finalized
  }

  const watchdog = setInterval(() => {
    if (run.finished) return
    if (Date.now() - run.lastProgress > limits.stallMs) {
      // Fail the run here, not when the workers return: one may be stuck on a wait the abort
      // signal cannot reach, and the lock and the mirror must not stay `running` behind it.
      stop(ERR_STALL)
      void finalize('failed', ERR_STALL, 'STALLED')
      return
    }
    if (redis) void renewLock(redis, lockK, run.id)
    void mirror()
  }, limits.stallCheckMs)
  watchdog.unref?.()

  const tmpDir = pullDeps.tmpDir()
  try {
    await mkdir(tmpDir, { recursive: true })
    let manifest: Set<string> | null = null
    let changedAfter: number | null = null
    if (redis) {
      if (req.mode === 'delta') {
        try {
          manifest = new Set(await redis.smembers(mKey))
          const prev = toNumber(await redis.get(startK))
          changedAfter = prev === null ? null : prev - DELTA_CLOCK_MARGIN_MS
        } catch {
          manifest = null
        }
      } else {
        await redis.del(mKey, startK).catch(() => {})
      }
    }
    // Why a row is taken: 'any' = copy unless already here at the row's size; 'changed' = a row
    // the previous run already had whose modified_on moved since — always copied again, a
    // changed object may keep its size. Delta with no manifest, or no previous finished run,
    // takes every row as 'any'.
    const pick = (row: FileRow): 'any' | 'changed' | null => {
      if (req.mode === 'full' || !manifest || changedAfter === null) return 'any'
      if (!manifest.has(String(row.id))) return 'any'
      const t = toTime(row.modified_on)
      return t !== null && t >= changedAfter ? 'changed' : null
    }

    async function* candidates(): AsyncGenerator<{ row: FileRow; changed: boolean }> {
      let after: string | null = null
      for (;;) {
        if (fatal) return
        let page: FileRow[]
        try {
          page = await pullDeps.listRows(after, limits.pageSize)
        } catch {
          stop(ERR_LIST)
          return
        }
        if (page.length === 0) return
        for (const row of page) {
          if (!row.filename_disk) continue
          const why = pick(row)
          if (!why) continue
          st.total++
          yield { row, changed: why === 'changed' }
        }
        after = String(page[page.length - 1].id)
        if (page.length < limits.pageSize) return
        progress()
      }
    }

    const storage = pullDeps.storage()
    const iter = candidates()
    // A private literal is the only plain fetch (see the header); every host name is guarded.
    const guarded = !plainHttpHost(new URL(req.source).hostname)

    const failRow = () => {
      if (!fatal) st.failed++
      progress()
    }

    const copyOne = async (row: FileRow, changed: boolean): Promise<void> => {
      const id = String(row.id)
      const key = String(row.filename_disk)
      const expected = toNumber(row.filesize)
      if (!changed && expected !== null && storage.size) {
        const have = await storage.size(key).catch(() => null)
        if (have === expected) {
          st.skipped++
          progress()
          await remember(id)
          return
        }
      }
      const signal = AbortSignal.any([ac.signal, AbortSignal.timeout(limits.objectTimeoutMs)])
      let res: Response
      try {
        const url = `${req.source}/${encodeURIComponent(id)}`
        const init = {
          method: 'GET',
          headers: { Authorization: `Transfer ${req.ticket}` },
          redirect: 'error' as const,
          signal
        }
        res = guarded ? await pullDeps.safeFetch(url, init) : await pullDeps.fetch(url, init)
      } catch {
        // unreachable, timed out, or a redirect (redirect: 'error')
        return failRow()
      }
      const drop = () => {
        void res.body?.cancel().catch(() => {})
      }
      if (res.status === 401 || res.status === 403) {
        drop()
        return stop(ERR_TICKET)
      }
      if (res.status === 404) {
        drop()
        if (st.missing.length < MAX_MISSING) st.missing.push(id)
        progress()
        return
      }
      if (res.status !== 200 || !res.body) {
        drop()
        return failRow()
      }
      // A Nivaro source always names the object and its length: an answer without both is not
      // one (another endpoint at that path) and is never written over the row's key.
      const declared = toNumber(res.headers.get('content-length'))
      if (declared === null || declared > limits.maxObjectBytes) {
        drop()
        return failRow()
      }
      const named = res.headers.get('x-nivaro-filename-disk')
      if (named === null || decodeHeader(named) !== key) {
        drop()
        return failRow()
      }
      // The row knows the size: an object of another size is not the one it describes.
      if (expected !== null && declared !== expected) {
        drop()
        return failRow()
      }
      const tmp = join(tmpDir, `${run.id}-${randomUUID()}`)
      let got = 0
      const max = limits.maxObjectBytes
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          got += chunk.length
          run.lastProgress = Date.now()
          if (got > max) cb(new Error('object too large'))
          else cb(null, chunk)
        }
      })
      try {
        await pipeline(
          Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>),
          counter,
          createWriteStream(tmp),
          { signal }
        )
        if (got !== declared || (expected !== null && got !== expected)) return failRow()
        await storage.putFile(key, tmp, row.type || 'application/octet-stream', {
          signal: ac.signal
        })
        st.copied++
        st.bytes += got
        progress()
        await remember(id)
      } catch {
        return failRow()
      } finally {
        await unlink(tmp).catch(() => {})
      }
    }

    const worker = async () => {
      for (;;) {
        if (fatal) return
        const n = await iter.next()
        if (n.done) return
        await copyOne(n.value.row, n.value.changed)
        await mirror()
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, limits.concurrency) }, worker))
    // A stall already ended the run: a late return changes nothing.
    if (run.finished) return
    if (fatal) {
      await finalize('failed', fatal)
    } else {
      if (redis) {
        // The next delta takes rows changed since this run started.
        await redis.set(startK, String(run.startedAt), 'PX', MANIFEST_TTL_MS).catch(() => {})
        await redis.pexpire(mKey, MANIFEST_TTL_MS).catch(() => {})
      }
      await finalize('done', null)
    }
  } catch {
    await finalize('failed', fatal ?? 'The file copy failed.')
  } finally {
    // Every path above finalizes; this only guards a path that did not.
    if (!run.finished) await finalize('failed', fatal ?? 'The file copy failed.')
  }
}
