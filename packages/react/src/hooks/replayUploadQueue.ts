/**
 * Resilient uploads for the session recorder (#1369).
 *
 * The full-mode recorder used to POST each chunk once and forget it: a flaky
 * network, a deploy's few seconds of 502s or a laptop lid closing lost that
 * stretch of the replay for good, and a reload started a brand-new recording.
 * This module is the part of the recorder that makes uploads survive that,
 * kept free of React and rrweb so it can be unit tested on its own.
 *
 * - Every chunk gets its seq ONCE, when it is queued. A retry re-sends the
 *   same seq, so replay order (the server concatenates by seq) never changes
 *   and the server can recognise a chunk it already holds.
 * - Chunks wait in a queue that is mirrored to IndexedDB, keyed by recording
 *   id + seq. The in-memory copy drives uploads; the IndexedDB copy is what a
 *   reload in the same tab picks up. Without IndexedDB (private mode, tests)
 *   the in-memory queue still retries, it just does not outlive the page.
 * - Uploads drain in seq order, one at a time. A network error or 5xx keeps
 *   the chunk and backs off (2s doubling to a 60s cap, with jitter); offline
 *   tabs queue without trying. 413 drops that chunk (one lost snapshot beats a
 *   dead session), 409 means the recording is closed or capped, and any other
 *   4xx (403, 404) means this recording will never accept the chunk.
 * - The queue is bounded by bytes so a long offline stretch can't fill the
 *   disk: past the cap the OLDEST chunks go first.
 * - The tab remembers {recordingId, nextSeq} in sessionStorage. A reload
 *   within RESUME_WINDOW_MS continues the same recording instead of starting
 *   a new one; rrweb opens every recording with a full snapshot, so the
 *   resumed stream stays replayable.
 * - On pagehide whatever fits in the browser's keepalive allowance (64KB of
 *   request bodies in flight) goes out with fetch keepalive; the IndexedDB
 *   copy covers the rest and anything a dying page could not confirm.
 * - Each chunk carries the route pattern it was recorded on and the frontend
 *   build (#1368, the server's cost attribution), and the first upload after
 *   transient failures reports how many attempts failed (`retries`) — the
 *   server cannot see a request that never reached it.
 *
 * A copy of the admin app's admin/src/lib/replay-upload-queue.ts — the two
 * packages share no code, like splitBySize before it. Keep them in step.
 */

/**
 * Raw JSON bytes per upload. The server takes 8MB per chunk; a full snapshot
 * of a heavy page can be several MB on its own, so the buffer is cut by SIZE,
 * not count, and an oversized single event travels alone.
 */
export const CHUNK_BYTES = 2_000_000
/**
 * Chunk size while the page may be going away. Small enough that a chunk can
 * ride fetch keepalive (64KB of bodies in flight per page, shared with
 * anything else the page sends on the way out — chat presence, page views).
 */
export const KEEPALIVE_CHUNK_BYTES = 60_000
/** Total keepalive body bytes the recorder allows itself on pagehide. */
export const KEEPALIVE_BUDGET = 60_000
/** Queue ceiling. Past it the oldest chunks are dropped. */
export const QUEUE_MAX_BYTES = 20_000_000
/** A reload this soon after the last activity continues the same recording. */
export const RESUME_WINDOW_MS = 10 * 60_000
export const BACKOFF_BASE_MS = 2_000
export const BACKOFF_MAX_MS = 60_000
/**
 * IndexedDB is shared by every tab of the origin, and a tab that is closed
 * (not reloaded) never comes back for its leftovers. Anything older than this
 * is swept when a recorder starts.
 */
export const ORPHAN_TTL_MS = 24 * 60 * 60_000

export function splitBySize(events: unknown[], max = CHUNK_BYTES): unknown[][] {
  const out: unknown[][] = []
  let cur: unknown[] = []
  let size = 2
  for (const ev of events) {
    let len = 0
    try {
      len = JSON.stringify(ev).length + 1
    } catch {
      continue
    }
    if (cur.length > 0 && size + len > max) {
      out.push(cur)
      cur = []
      size = 2
    }
    cur.push(ev)
    size += len
  }
  if (cur.length > 0) out.push(cur)
  return out
}

/**
 * Delay before retry number `attempt` (1-based): 2s, 4s, 8s … capped at 60s,
 * each drawn from the upper half of its step so a fleet of tabs that lost the
 * network together does not come back in lockstep.
 */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const n = Math.max(1, Math.floor(attempt))
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (n - 1))
  return Math.round(ceiling / 2 + random() * (ceiling / 2))
}

/**
 * What a failed upload means for the queue.
 * - retry: no answer (network), 5xx, 408, 429 — keep the chunk, back off.
 * - drop-chunk: 413 / 400 — this chunk can never go; the recording is fine.
 * - closed: 409 — the recording is closed or capped; stop for good.
 * - abandon: any other 4xx (403 not yours, 404 gone, 401 signed out) — no
 *   chunk of this recording will ever be accepted.
 * A 401 (signed out, or a View-as session that ended — MASQUERADE_EXPIRED) is
 * never a stale resumed id either: a fresh recording would be refused the same
 * way, so the uploader stops outright (`ReplayUploader.drain`).
 */
export type UploadFailure = 'retry' | 'drop-chunk' | 'closed' | 'abandon'

export function classifyUploadError(status: number | undefined): UploadFailure {
  if (status === 409) return 'closed'
  if (status === 413 || status === 400) return 'drop-chunk'
  if (status === 408 || status === 429) return 'retry'
  if (typeof status === 'number' && status >= 400 && status < 500) return 'abandon'
  return 'retry'
}

/**
 * One-shot clip uploads (error-clip mode): after a failed chunk, go on to the
 * next one or stop? A chunk refused as too big or malformed (413 / 400) is
 * dropped and the rest still go; a refusal of the recording or the person
 * (401 signed out / View-as ended, 403, 404, 409 closed) stops — every later
 * chunk would be refused the same way. A transient failure moves on too: a
 * clip is sent once, with no retry queue.
 */
export function clipChunkFailure(status: number | undefined): 'next' | 'stop' {
  const failure = classifyUploadError(status)
  return failure === 'closed' || failure === 'abandon' ? 'stop' : 'next'
}

/** HTTP status off an axios error ({response: {status}}) or a fetch error ({status}). */
export function errorStatus(err: unknown): number | undefined {
  const e = err as { status?: unknown; response?: { status?: unknown } } | null
  const s = typeof e?.status === 'number' ? e.status : e?.response?.status
  return typeof s === 'number' ? s : undefined
}

function utf8Bytes(s: string): number {
  try {
    return new TextEncoder().encode(s).length
  } catch {
    return s.length * 3
  }
}

// ── Chunk store ──────────────────────────────────────────────────────────────

export interface QueuedChunk {
  recordingId: string
  seq: number
  events: unknown[]
  /** Raw JSON size, for the queue bound. */
  bytes: number
  /** When it was queued — the orphan sweep reads this. */
  at: number
  /** Route pattern it was recorded on (#1368). */
  route?: string
  /** Frontend build that recorded it (#1368). */
  build?: string
}

/** What a chunk's request carries besides seq + events (#1368). */
export interface ChunkExtra {
  route?: string
  build?: string
  /** Upload attempts that failed since the last success. */
  retries?: number
}

/** The request body for one chunk: `{seq, events}` plus its route, build and retries. */
export function chunkBody(chunk: QueuedChunk, retries = 0): string {
  const extra = chunkExtra(chunk, retries)
  return JSON.stringify({ seq: chunk.seq, events: chunk.events, ...extra })
}

export function chunkExtra(chunk: QueuedChunk, retries = 0): ChunkExtra {
  const extra: ChunkExtra = {}
  if (chunk.route) extra.route = chunk.route
  if (chunk.build) extra.build = chunk.build
  if (retries > 0) extra.retries = retries
  return extra
}

/** Persistence behind the queue. Every method is best-effort and never throws. */
export interface ChunkStore {
  put(chunk: QueuedChunk): Promise<void>
  list(recordingId: string): Promise<QueuedChunk[]>
  remove(recordingId: string, seq: number): Promise<void>
  clear(recordingId: string): Promise<void>
  /** Drop every chunk (any recording) queued before `before`. */
  prune(before: number): Promise<void>
}

export function memoryChunkStore(): ChunkStore {
  const rows = new Map<string, QueuedChunk>()
  const key = (id: string, seq: number) => `${id}\u0000${seq}`
  return {
    async put(c) {
      rows.set(key(c.recordingId, c.seq), c)
    },
    async list(id) {
      return [...rows.values()].filter((c) => c.recordingId === id).sort((a, b) => a.seq - b.seq)
    },
    async remove(id, seq) {
      rows.delete(key(id, seq))
    },
    async clear(id) {
      for (const [k, c] of rows) if (c.recordingId === id) rows.delete(k)
    },
    async prune(before) {
      for (const [k, c] of rows) if (c.at < before) rows.delete(k)
    }
  }
}

const IDB_NAME = 'nivaro-replay-queue'
const IDB_STORE = 'chunks'

/**
 * IndexedDB-backed store, falling back to memory when IndexedDB is missing
 * or refuses to open (private mode, blocked storage, tests).
 */
export function idbChunkStore(factory?: IDBFactory | null): ChunkStore {
  const idb = factory !== undefined ? factory : typeof indexedDB !== 'undefined' ? indexedDB : null
  const memory = memoryChunkStore()
  if (!idb) return memory
  const opened = new Promise<IDBDatabase | null>((resolve) => {
    try {
      const req = idb.open(IDB_NAME, 1)
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(IDB_STORE, { keyPath: ['recordingId', 'seq'] })
        store.createIndex('at', 'at')
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  const range = (id: string) => IDBKeyRange.bound([id, -Infinity], [id, Infinity])
  /** Run one transaction; resolves with `read()` once it commits, or `fallback`. */
  async function run<T>(
    mode: IDBTransactionMode,
    work: (store: IDBObjectStore) => (() => T) | undefined,
    viaMemory: () => Promise<T>,
    fallback: T
  ): Promise<T> {
    const db = await opened
    if (!db) return viaMemory()
    return new Promise<T>((resolve) => {
      try {
        const tx = db.transaction(IDB_STORE, mode)
        const read = work(tx.objectStore(IDB_STORE))
        tx.oncomplete = () => resolve(read ? read() : fallback)
        tx.onerror = () => resolve(fallback)
        tx.onabort = () => resolve(fallback)
      } catch {
        resolve(fallback)
      }
    })
  }
  return {
    put: (c) =>
      run(
        'readwrite',
        (s) => {
          s.put(c)
          return undefined
        },
        () => memory.put(c),
        undefined
      ),
    list: (id) =>
      run(
        'readonly',
        (s) => {
          const req = s.getAll(range(id))
          return () => ((req.result ?? []) as QueuedChunk[]).sort((a, b) => a.seq - b.seq)
        },
        () => memory.list(id),
        [] as QueuedChunk[]
      ),
    remove: (id, seq) =>
      run(
        'readwrite',
        (s) => {
          s.delete([id, seq])
          return undefined
        },
        () => memory.remove(id, seq),
        undefined
      ),
    clear: (id) =>
      run(
        'readwrite',
        (s) => {
          s.delete(range(id))
          return undefined
        },
        () => memory.clear(id),
        undefined
      ),
    prune: (before) =>
      run(
        'readwrite',
        (s) => {
          const req = s.index('at').openCursor(IDBKeyRange.upperBound(before, true))
          req.onsuccess = () => {
            const cur = req.result
            if (!cur) return
            cur.delete()
            cur.continue()
          }
          return undefined
        },
        () => memory.prune(before),
        undefined
      )
  }
}

let sharedStore: ChunkStore | null = null
/** One IndexedDB connection per page, opened on first use. */
export function sharedChunkStore(): ChunkStore {
  if (!sharedStore) sharedStore = idbChunkStore()
  return sharedStore
}

// ── Resume state (sessionStorage) ────────────────────────────────────────────

export interface ResumeRecord {
  recordingId: string
  /** The seq the next queued chunk gets. */
  nextSeq: number
  /** When the recording started — error offsets count from here. */
  startedAt: number
  lastActivityAt: number
  /** Whose recording — a different sign-in in the same tab starts fresh. */
  userId?: string | null
}

type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** sessionStorage, or null where it is missing or throws (sandboxed frames). */
export function sessionStore(): KeyValueStorage | null {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null
  } catch {
    return null
  }
}

export function readResume(storage: KeyValueStorage | null, key: string): ResumeRecord | null {
  try {
    const raw = storage?.getItem(key)
    if (!raw) return null
    const r = JSON.parse(raw) as Partial<ResumeRecord>
    if (
      typeof r.recordingId !== 'string' ||
      !r.recordingId ||
      typeof r.nextSeq !== 'number' ||
      typeof r.startedAt !== 'number' ||
      typeof r.lastActivityAt !== 'number'
    ) {
      return null
    }
    return r as ResumeRecord
  } catch {
    return null
  }
}

export function writeResume(storage: KeyValueStorage | null, key: string, rec: ResumeRecord): void {
  try {
    storage?.setItem(key, JSON.stringify(rec))
  } catch {
    /* quota / disabled storage — the tab just won't resume */
  }
}

export function clearResume(storage: KeyValueStorage | null, key: string): void {
  try {
    storage?.removeItem(key)
  } catch {
    /* best-effort */
  }
}

/**
 * May this tab continue `rec`? Only inside the resume window (a clock that
 * went backwards counts as expired) and only for the same user.
 */
export function isResumable(
  rec: ResumeRecord | null,
  now: number,
  userId?: string | null
): boolean {
  if (!rec) return false
  const idle = now - rec.lastActivityAt
  if (idle < 0 || idle > RESUME_WINDOW_MS) return false
  if (userId !== undefined && (rec.userId ?? null) !== (userId ?? null)) return false
  return true
}

// ── Keepalive packing ────────────────────────────────────────────────────────

export interface KeepaliveRequest {
  chunk: QueuedChunk
  /** The exact request body, `{seq, events}` (+ route, build). */
  body: string
}

/**
 * The longest run of chunks, in seq order, whose bodies fit in `budget`
 * bytes. Stops at the first chunk that does not fit rather than skipping it:
 * the rest stays queued and goes, in order, on the next load.
 */
export function packKeepalive(chunks: QueuedChunk[], budget: number): KeepaliveRequest[] {
  const out: KeepaliveRequest[] = []
  let left = budget
  for (const chunk of chunks) {
    const body = chunkBody(chunk)
    const size = utf8Bytes(body)
    if (size > left) break
    out.push({ chunk, body })
    left -= size
  }
  return out
}

// ── The uploader ─────────────────────────────────────────────────────────────

/**
 * - ok: the queue is empty.
 * - offline: the browser says it is offline; nothing was tried.
 * - retry: a transient failure; call again after `backoffDelay(attempt)`.
 * - closed / abandoned: the recording is dead; the queue was cleared.
 * - stale: a RESUMED recording id was refused before the server ever took a
 *   chunk from this page — start a fresh recording and `rebase()` onto it.
 *   The previous page's leftovers were dropped; this page's chunks are kept.
 */
export type DrainOutcome = 'ok' | 'offline' | 'retry' | 'closed' | 'abandoned' | 'stale'

export interface UploaderOptions {
  store: ChunkStore
  /**
   * POST one chunk. Rejects with an error carrying the HTTP status, if any.
   * `extra` (route, build, retries) rides in the same body (#1368).
   */
  send: (
    recordingId: string,
    seq: number,
    events: unknown[],
    keepalive: boolean,
    extra: ChunkExtra
  ) => Promise<void>
  online?: () => boolean
  now?: () => number
  maxBytes?: number
}

export class ReplayUploader {
  recordingId: string | null = null
  nextSeq = 0
  /** Consecutive transient failures — feeds backoffDelay. */
  attempt = 0
  /**
   * Whether a refusal means the recording is dead. False for an id picked
   * up from sessionStorage until the server has taken a chunk for it.
   */
  trusted = true
  /**
   * The recording was refused for good (closed / abandoned): nothing more is
   * queued or sent for it until `begin()` / `rebase()` points the uploader at
   * another one. A pagehide keepalive after the refusal sends nothing.
   */
  stopped = false
  private pending: QueuedChunk[] = []
  private bytesQueued = 0
  private restored = new WeakSet<QueuedChunk>()
  private sending: QueuedChunk | null = null
  private sendingKeepaliveBytes = 0
  private readonly store: ChunkStore
  private readonly send: UploaderOptions['send']
  private readonly online: () => boolean
  private readonly now: () => number
  private readonly maxBytes: number

  constructor(opts: UploaderOptions) {
    this.store = opts.store
    this.send = opts.send
    this.online = opts.online ?? (() => true)
    this.now = opts.now ?? Date.now
    this.maxBytes = opts.maxBytes ?? QUEUE_MAX_BYTES
  }

  /**
   * Point the queue at a recording. `restored` are chunks a previous page of
   * this tab left in the store for it; they go first.
   */
  begin(
    recordingId: string,
    nextSeq = 0,
    opts: { trusted?: boolean; restored?: QueuedChunk[] } = {}
  ) {
    this.recordingId = recordingId
    this.nextSeq = nextSeq
    this.trusted = opts.trusted ?? true
    this.stopped = false
    this.attempt = 0
    this.pending = []
    this.bytesQueued = 0
    for (const c of opts.restored ?? []) {
      if (c.recordingId !== recordingId) continue
      this.restored.add(c)
      this.pending.push(c)
      this.bytesQueued += c.bytes
      if (c.seq >= this.nextSeq) this.nextSeq = c.seq + 1
    }
    this.pending.sort((a, b) => a.seq - b.seq)
    this.enforceBound()
  }

  hasPending(): boolean {
    return this.pending.length > 0
  }

  get size(): number {
    return this.pending.length
  }

  get bytes(): number {
    return this.bytesQueued
  }

  /** Seqs currently queued, in order — for tests and debugging. */
  seqs(): number[] {
    return this.pending.map((c) => c.seq)
  }

  /**
   * Queue one chunk: its seq is fixed here, for every retry to come. `meta`
   * names the route it was recorded on and the build (#1368).
   */
  enqueue(events: unknown[], meta: { route?: string; build?: string } = {}): QueuedChunk | null {
    if (!this.recordingId || this.stopped || events.length === 0) return null
    let bytes = 2
    try {
      bytes = JSON.stringify(events).length
    } catch {
      /* splitBySize already dropped what can't serialise */
    }
    const chunk: QueuedChunk = {
      recordingId: this.recordingId,
      seq: this.nextSeq++,
      events,
      bytes,
      at: this.now(),
      ...(meta.route ? { route: meta.route } : {}),
      ...(meta.build ? { build: meta.build } : {})
    }
    this.pending.push(chunk)
    this.bytesQueued += bytes
    void this.store.put(chunk)
    this.enforceBound()
    return chunk
  }

  /** Oldest first, but never the last chunk standing. */
  private enforceBound() {
    while (this.bytesQueued > this.maxBytes && this.pending.length > 1) {
      const oldest = this.pending[0]
      console.warn(`[session-recorder] upload queue full — chunk ${oldest.seq} dropped`)
      this.forget(oldest)
    }
  }

  private forget(chunk: QueuedChunk) {
    const i = this.pending.indexOf(chunk)
    if (i === -1) return
    this.pending.splice(i, 1)
    this.bytesQueued -= chunk.bytes
    void this.store.remove(chunk.recordingId, chunk.seq)
  }

  /** Drop the whole queue for the current recording, memory and store. */
  discard() {
    const ids = new Set(this.pending.map((c) => c.recordingId))
    if (this.recordingId) ids.add(this.recordingId)
    for (const id of ids) void this.store.clear(id)
    this.pending = []
    this.bytesQueued = 0
  }

  /**
   * Upload queued chunks in seq order until the queue is empty or something
   * stops it. `keepalive` sends chunks that fit the keepalive allowance with
   * fetch keepalive — set while the page is hidden and may be unloading.
   * Callers keep this single-flight.
   */
  async drain(keepalive = false): Promise<DrainOutcome> {
    while (this.recordingId && !this.stopped && this.pending.length > 0) {
      if (!this.online()) return 'offline'
      const chunk = this.pending[0]
      const viaKeepalive = keepalive && chunk.bytes <= KEEPALIVE_CHUNK_BYTES
      this.sending = chunk
      this.sendingKeepaliveBytes = viaKeepalive ? chunk.bytes : 0
      try {
        await this.send(
          chunk.recordingId,
          chunk.seq,
          chunk.events,
          viaKeepalive,
          chunkExtra(chunk, this.attempt)
        )
        this.trusted = true
        this.attempt = 0
        this.forget(chunk)
      } catch (err) {
        const status = errorStatus(err)
        const failure = classifyUploadError(status)
        if (failure === 'retry') {
          this.attempt++
          return 'retry'
        }
        if (failure === 'drop-chunk') {
          console.warn(
            `[session-recorder] chunk ${chunk.seq} refused (too large or malformed) — dropped`
          )
          this.trusted = true
          this.forget(chunk)
          continue
        }
        if (!this.trusted && status !== 401) {
          // A resumed id the server won't take (ended, purged, someone
          // else's): the previous page's leftovers can't go anywhere, but
          // this page's chunks — opening full snapshot included — move to
          // a fresh recording.
          for (const c of [...this.pending]) if (this.restored.has(c)) this.forget(c)
          return 'stale'
        }
        this.discard()
        this.stopped = true
        return failure === 'closed' ? 'closed' : 'abandoned'
      } finally {
        this.sending = null
        this.sendingKeepaliveBytes = 0
      }
    }
    return 'ok'
  }

  /**
   * Move the queue onto a freshly started recording (after 'stale'): seqs
   * restart at 0 in the same order.
   */
  rebase(recordingId: string) {
    const previous = this.recordingId
    const keep = this.pending.filter((c) => !this.restored.has(c))
    if (previous && previous !== recordingId) void this.store.clear(previous)
    this.recordingId = recordingId
    this.nextSeq = 0
    this.trusted = true
    this.stopped = false
    this.attempt = 0
    this.pending = []
    this.bytesQueued = 0
    for (const c of keep) {
      const moved: QueuedChunk = { ...c, recordingId, seq: this.nextSeq++ }
      this.pending.push(moved)
      this.bytesQueued += moved.bytes
      void this.store.put(moved)
    }
  }

  /**
   * What to send with fetch keepalive as the page goes away: queued chunks
   * in order, skipping the one a drain is already sending (it is on the
   * wire, possibly with keepalive itself — its bytes come off the budget).
   * Nothing is removed from the queue: the store copy is the safety net, and
   * the server ignores a seq it already holds.
   */
  keepaliveBatch(budget = KEEPALIVE_BUDGET): KeepaliveRequest[] {
    if (this.stopped) return []
    const queue = this.pending.filter((c) => c !== this.sending)
    return packKeepalive(queue, budget - this.sendingKeepaliveBytes)
  }
}
