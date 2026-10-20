/**
 * #2441 — a shared second level for the driver-seam configuration cache
 * (db/metadata-query-cache.ts), in Redis.
 *
 * The in-process cache starts empty in every new process: a fresh replica or a
 * restart rebuilt collections, fields, relations, layouts and column lists one
 * round trip at a time (the GraphQL schema alone was ~240 reads, ~12 s against
 * the remote dev database). This level keeps what any process read, so the next
 * process to start asks Redis (~1 ms) instead of the database (~50 ms).
 *
 * Keyed by the CONFIGURATION EPOCH (db/config-epoch.ts): every configuration
 * write moves that number, so entries stored before the write become
 * unreachable without anyone deleting them. Also keyed by the API version (the
 * row shape is the driver's and may change between releases), the tenant
 * (cloud), the database the read went to, and that database's INCARNATION.
 *
 * Incarnation: a restore (EFP staging is restored from a production clone every
 * night) puts a different epoch row in place — possibly a lower number, possibly
 * one already used — so the epoch alone cannot retire what was stored before
 * it. The incarnation tag is the newest msdb restore_date for the database plus
 * its sys.databases create_date (which RESTORE ... WITH REPLACE does NOT change:
 * EFP_Staging, restored nightly, still shows its 2023 create_date). It is read
 * before the level is first used and re-read whenever the epoch could not be
 * read, was moved by another process or went backwards, and at least once a
 * minute. An epoch going BACKWARDS also drops every generation this process
 * used and clears the in-process caches; a changed tag clears them too.
 *
 * Never used:
 *   - when the epoch is off (CACHE_EPOCH=off, cloud mode) — nothing would retire stale entries;
 *   - while THIS process has a configuration write settling (its own epoch move has not
 *     landed yet) — the entries it would read or store belong to the epoch it is leaving;
 *   - while the database incarnation is unknown;
 *   - for a database other than the primary pool's (a read replica may lag the epoch);
 *   - for an entry larger than METADATA_L2_MAX_BYTES compressed.
 * Redis slow, down or erroring → straight to the database, counted, never thrown.
 *
 * Leaf module: no import from db/index.ts.
 */
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { deflateRaw, inflateRaw } from 'node:zlib'
import { NIVARO_VERSION } from '../version.js'
import { configEpochForRead, configEpochNow, onEpochReset } from './config-epoch.js'
import { getTenantId } from './tenant-context.js'

export type L2Cell = { n: string; v: unknown }

/** The ioredis commands this level uses (a fake in tests). */
export interface L2Redis {
  status?: string
  getBuffer(key: string): Promise<Buffer | null>
  set(key: string, value: Buffer, mode: 'EX', seconds: number): Promise<unknown>
  sadd(key: string, member: string): Promise<unknown>
  expire(key: string, seconds: number): Promise<unknown>
  smembers(key: string): Promise<string[]>
  del(...keys: string[]): Promise<unknown>
}

interface EpochSource {
  forRead: () => Promise<number | null>
  now: () => number | null
}

/** One generation of entries: an epoch of one incarnation of the database. */
export interface L2Gen {
  epoch: number
  tag: string
}

/** Reads the database incarnation tag (null = unknown: the level is skipped). */
type IdentitySource = () => Promise<string | null>
type RawRunner = { raw: (sql: string) => unknown }

const FORMAT = 'v1'
const PREFIX = 'nvr:mdl2'

const ENABLED = process.env.METADATA_L2 !== 'off'
const TTL_S = Math.max(10, Number(process.env.METADATA_L2_TTL_S) || 600)
const MAX_BYTES = Math.max(1024, Number(process.env.METADATA_L2_MAX_BYTES) || 256 * 1024)
const TIMEOUT_MS = Math.max(5, Number(process.env.METADATA_L2_TIMEOUT_MS) || 150)
/** After a Redis error or timeout, skip this level for a moment instead of paying the timeout on
 *  every read. */
const BACKOFF_MS = 5_000
/** The incarnation tag is re-checked (in the background) at least this often. */
const IDENTITY_RECHECK_MS = 60_000

const deflateAsync = promisify(deflateRaw)
const inflateAsync = promisify(inflateRaw)

let redis: L2Redis | null = null
let epochs: EpochSource = { forRead: configEpochForRead, now: configEpochNow }
let primaryScope: string | null = null
let downUntil = 0
/** Generations this process read or stored under lately — what a clear drops. */
const recentGens: L2Gen[] = []

let identityDb: RawRunner | null = null
let identitySource: IdentitySource = readIdentity
/** The tag reads and stores use now; null = must be (re-)read before the level is used. */
let identityTag: string | null = null
/** The last tag read successfully (kept across a reset, to notice a change). */
let knownTag: string | null = null
let identityAt = 0
let identityLoading: Promise<void> | null = null
const identityListeners = new Set<() => void>()
let inIdentityChange = false

const counters = {
  hits: 0,
  misses: 0,
  stores: 0,
  bytes_read: 0,
  bytes_written: 0,
  max_entry_bytes: 0,
  /** Entries over METADATA_L2_MAX_BYTES (compressed), never stored. */
  oversize: 0,
  /** Rows holding a value this level cannot carry faithfully, never stored. */
  uncacheable: 0,
  /** Redis errors and timeouts; the read went to the database. */
  errors: 0,
  /** Reads that skipped this level: Redis not ready / backing off after an error. */
  skipped_unavailable: 0,
  /** Reads that skipped this level: no usable epoch (off, unknown, or a local write settling). */
  skipped_no_epoch: 0,
  /** Reads that skipped this level: the database incarnation could not be read. */
  skipped_no_identity: 0,
  /** A database read whose generation moved before it could be stored. */
  skipped_store: 0,
  /** Generation drops: a local clear (clearMetadataCache) or a backwards epoch. */
  drops: 0,
  /** Incarnation reads, and how often the tag came back different (a restore). */
  identity_reads: 0,
  identity_changes: 0,
  /** Times the configuration epoch went backwards (a restore). */
  rewinds: 0
}

/** Wire the process's Redis connection (server boot). null turns the level off. */
export function setMetadataL2Redis(client: L2Redis | null): void {
  redis = client
}

/** The database the primary pool reads — the only one whose reads this level keeps. First call
 *  wins (attachMetadataQueryCache is called with the primary pool). */
export function setMetadataL2PrimaryScope(scope: string): void {
  if (primaryScope == null) primaryScope = scope
}

/** The primary pool, for the incarnation read. First call wins. */
export function setMetadataL2Database(runner: RawRunner): void {
  if (identityDb == null) identityDb = runner
}

/** Hear that the database turned out to be a different incarnation (restored underneath us). */
export function onMetadataL2IdentityChange(fn: () => void): () => void {
  identityListeners.add(fn)
  return () => {
    identityListeners.delete(fn)
  }
}

/** Tests only. */
export function resetMetadataL2ForTests(
  opts: { epochs?: EpochSource; identity?: IdentitySource } = {}
): void {
  redis = null
  primaryScope = null
  downUntil = 0
  recentGens.length = 0
  epochs = opts.epochs ?? { forRead: configEpochForRead, now: configEpochNow }
  identitySource = opts.identity ?? readIdentity
  identityTag = null
  knownTag = null
  identityAt = 0
  identityLoading = null
  for (const k of Object.keys(counters)) (counters as Record<string, number>)[k] = 0
}

export function metadataL2Stats(): Record<string, number | boolean | string | null> {
  const lookups = counters.hits + counters.misses
  return {
    enabled: ENABLED,
    connected: !!redis && isReady(redis),
    ttl_s: TTL_S,
    max_bytes: MAX_BYTES,
    timeout_ms: TIMEOUT_MS,
    epoch: epochs.now(),
    identity: identityTag,
    hit_rate: lookups ? Math.round((counters.hits / lookups) * 1000) / 1000 : null,
    ...counters
  }
}

function isReady(r: L2Redis): boolean {
  return r.status == null || r.status === 'ready'
}

// ── database incarnation ────────────────────────────────────────────────────

function firstRow(res: unknown): Record<string, unknown> | undefined {
  const rows = Array.isArray(res) ? res : (res as { recordset?: unknown[] } | null)?.recordset
  return Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined
}

/**
 * sys.databases create_date plus the newest msdb.dbo.restorehistory restore_date
 * for this database, when the login may read msdb (create_date alone otherwise;
 * a restore then shows only through the epoch moving or going backwards).
 */
async function readIdentity(): Promise<string | null> {
  const k = identityDb
  if (!k) return null
  let created: unknown
  try {
    created = firstRow(
      await k.raw(
        'SELECT CONVERT(varchar(33), create_date, 126) AS created FROM sys.databases WHERE name = DB_NAME()'
      )
    )?.created
  } catch {
    return null
  }
  if (created == null) return null
  let restored: unknown = null
  try {
    restored = firstRow(
      await k.raw(
        'SELECT CONVERT(varchar(33), MAX(restore_date), 126) AS restored FROM msdb.dbo.restorehistory WHERE destination_database_name = DB_NAME()'
      )
    )?.restored
  } catch {
    /* msdb not readable */
  }
  return createHash('sha1')
    .update(`${String(created)}|${restored == null ? '' : String(restored)}`)
    .digest('hex')
    .slice(0, 10)
}

function loadIdentity(): Promise<void> {
  if (identityLoading) return identityLoading
  identityLoading = (async () => {
    let tag: string | null = null
    try {
      tag = await identitySource()
    } catch {
      tag = null
    }
    counters.identity_reads++
    identityAt = Date.now()
    if (tag == null) {
      identityTag = null
      return
    }
    const changed = knownTag != null && knownTag !== tag
    knownTag = tag
    identityTag = tag
    if (changed) {
      counters.identity_changes++
      // Restored underneath us: the generations of the old database can never match again,
      // and what this process holds in memory came from it. The clears the listeners make
      // must not drop the NEW incarnation's generation other processes are filling.
      recentGens.length = 0
      inIdentityChange = true
      try {
        for (const fn of identityListeners) {
          try {
            fn()
          } catch {
            /* a listener never breaks the read */
          }
        }
      } finally {
        inIdentityChange = false
      }
    }
  })().finally(() => {
    identityLoading = null
  })
  return identityLoading
}

/** The incarnation tag to key on now (reading it first when unknown), or null. */
async function currentIdentity(): Promise<string | null> {
  if (identityTag == null) {
    await loadIdentity()
    return identityTag
  }
  if (Date.now() - identityAt > IDENTITY_RECHECK_MS) void loadIdentity()
  return identityTag
}

/**
 * The epoch watch saw something a restore causes (config-epoch onEpochReset): the number moved
 * elsewhere, could not be read, or went BACKWARDS. The incarnation is re-read before the level
 * is used again; backwards also drops every generation this process used. Exported for tests.
 */
export function noteEpochReset(e: { backwards: boolean }): void {
  if (e.backwards) {
    counters.rewinds++
    void dropGenerations([...recentGens])
    recentGens.length = 0
  }
  identityTag = null
}

onEpochReset(noteEpochReset)

// ── keys ────────────────────────────────────────────────────────────────────

function scopeTag(scope: string): string {
  return createHash('sha1').update(scope).digest('hex').slice(0, 12)
}

function genPrefix(scope: string, gen: L2Gen): string {
  const tenant = (getTenantId() ?? '-').replace(/[^\w.-]/g, '_')
  const database = `${scopeTag(scope)}.${gen.tag.replace(/[^\w]/g, '_')}`
  return `${PREFIX}:${FORMAT}:${NIVARO_VERSION}:${tenant}:${database}:${gen.epoch}`
}

/** Exported for tests: the Redis key of one statement in one generation. */
export function l2KeyOf(scope: string, gen: L2Gen, statementKey: string): string {
  return `${genPrefix(scope, gen)}:${createHash('sha1').update(statementKey).digest('hex')}`
}

function indexKeyOf(scope: string, gen: L2Gen): string {
  return `${genPrefix(scope, gen)}:idx`
}

function noteGen(gen: L2Gen): void {
  if (recentGens.some((g) => g.epoch === gen.epoch && g.tag === gen.tag)) return
  recentGens.push(gen)
  if (recentGens.length > 4) recentGens.shift()
}

/** Is this generation still the one to read and store under? */
function isCurrent(gen: L2Gen): boolean {
  return epochs.now() === gen.epoch && identityTag === gen.tag
}

function usable(scope: string): L2Redis | null {
  if (!ENABLED || !redis) return null
  if (primaryScope == null || scope !== primaryScope) return null
  if (!isReady(redis) || Date.now() < downUntil) {
    counters.skipped_unavailable++
    return null
  }
  return redis
}

function failed(): void {
  counters.errors++
  downUntil = Date.now() + BACKOFF_MS
}

function withTimeout<T>(p: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('metadata L2 timeout')), TIMEOUT_MS)
    t.unref?.()
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      }
    )
  })
}

// ── encoding ────────────────────────────────────────────────────────────────
// Columnar JSON (one name list, value rows), Dates and Buffers tagged, deflated.
// A value of any other kind (an object, a bigint, a non-finite number) makes the
// result uncacheable here: it is never stored rather than stored changed.

type Packed = { c: string[]; r: unknown[][] }

function packValue(v: unknown): unknown {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('non-finite')
    return v
  }
  if (v instanceof Date) {
    const t = v.getTime()
    if (Number.isNaN(t)) throw new Error('invalid date')
    return { $d: t }
  }
  if (Buffer.isBuffer(v)) return { $b: v.toString('base64') }
  throw new Error('uncacheable value')
}

function unpackValue(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v
  const o = v as { $d?: number; $b?: string }
  if (typeof o.$d === 'number') return new Date(o.$d)
  if (typeof o.$b === 'string') return Buffer.from(o.$b, 'base64')
  throw new Error('corrupt metadata L2 value')
}

/** Exported for tests: rows → compressed bytes, or null when they cannot be carried. */
export async function encodeRows(rows: L2Cell[][]): Promise<Buffer | null> {
  const c = rows[0]?.map((cell) => cell.n) ?? []
  const r: unknown[][] = []
  try {
    for (const row of rows) {
      if (row.length !== c.length) return null
      const vals: unknown[] = []
      for (let i = 0; i < row.length; i++) {
        if (row[i].n !== c[i]) return null
        vals.push(packValue(row[i].v))
      }
      r.push(vals)
    }
  } catch {
    return null
  }
  const packed: Packed = { c, r }
  return deflateAsync(Buffer.from(JSON.stringify(packed)))
}

/** Exported for tests: compressed bytes → rows. Throws on anything malformed. */
export async function decodeRows(buf: Buffer): Promise<L2Cell[][]> {
  const packed = JSON.parse((await inflateAsync(buf)).toString('utf8')) as Packed
  if (!packed || !Array.isArray(packed.c) || !Array.isArray(packed.r)) {
    throw new Error('corrupt metadata L2 entry')
  }
  return packed.r.map((vals) => {
    if (!Array.isArray(vals) || vals.length !== packed.c.length) {
      throw new Error('corrupt metadata L2 row')
    }
    return vals.map((v, i) => ({ n: packed.c[i], v: unpackValue(v) }))
  })
}

// ── read / store / drop ─────────────────────────────────────────────────────

export interface L2Lookup {
  /** The rows Redis held, or null (miss, skipped, error). */
  rows: L2Cell[][] | null
  /** The generation the read is keyed on — store the database's answer under it. null = do not
   *  store. */
  gen: L2Gen | null
}

/** Look a statement up. Never throws: every failure reads as a miss. */
export async function metadataL2Get(scope: string, statementKey: string): Promise<L2Lookup> {
  const r = usable(scope)
  if (!r) return { rows: null, gen: null }
  let epoch: number | null = null
  try {
    epoch = await epochs.forRead()
  } catch {
    epoch = null
  }
  if (epoch == null) {
    counters.skipped_no_epoch++
    return { rows: null, gen: null }
  }
  const tag = await currentIdentity()
  if (tag == null) {
    counters.skipped_no_identity++
    return { rows: null, gen: null }
  }
  const gen: L2Gen = { epoch, tag }
  if (!isCurrent(gen)) {
    counters.skipped_no_epoch++
    return { rows: null, gen: null }
  }
  noteGen(gen)
  let buf: Buffer | null
  try {
    buf = await withTimeout(r.getBuffer(l2KeyOf(scope, gen, statementKey)))
  } catch {
    failed()
    return { rows: null, gen: null }
  }
  if (!buf) {
    counters.misses++
    return { rows: null, gen }
  }
  try {
    const rows = await decodeRows(buf)
    // The epoch or the incarnation may have moved while Redis answered.
    if (!isCurrent(gen)) {
      counters.skipped_no_epoch++
      return { rows: null, gen: null }
    }
    counters.hits++
    counters.bytes_read += buf.length
    return { rows, gen }
  } catch {
    counters.errors++
    return { rows: null, gen }
  }
}

/** Keep a database answer under the generation its read began in — if that is still current. */
export function metadataL2Put(
  scope: string,
  statementKey: string,
  gen: L2Gen,
  rows: L2Cell[][]
): Promise<void> {
  const r = usable(scope)
  if (!r) return Promise.resolve()
  if (!isCurrent(gen)) {
    counters.skipped_store++
    return Promise.resolve()
  }
  return (async () => {
    let buf: Buffer | null
    try {
      buf = await encodeRows(rows)
    } catch {
      buf = null
    }
    if (!buf) {
      counters.uncacheable++
      return
    }
    if (buf.length > MAX_BYTES) {
      counters.oversize++
      return
    }
    // Compression yielded; check once more that nothing moved meanwhile.
    if (!isCurrent(gen)) {
      counters.skipped_store++
      return
    }
    const key = l2KeyOf(scope, gen, statementKey)
    const idx = indexKeyOf(scope, gen)
    try {
      await withTimeout(
        Promise.all([r.set(key, buf, 'EX', TTL_S), r.sadd(idx, key), r.expire(idx, TTL_S + 60)])
      )
      noteGen(gen)
      counters.stores++
      counters.bytes_written += buf.length
      if (buf.length > counters.max_entry_bytes) counters.max_entry_bytes = buf.length
    } catch {
      failed()
    }
  })()
}

/**
 * A local clear (clearMetadataCache in the process that changed configuration): drop every
 * generation this process keyed on lately, for the primary database and the current tenant.
 * The epoch move retires them for everyone anyway; dropping covers a write that committed after
 * its epoch move (a long transaction), which the epoch alone would not.
 */
export function dropMetadataL2(): Promise<void> {
  if (inIdentityChange) return Promise.resolve()
  const gens = [...recentGens]
  const now = epochs.now()
  if (now != null && identityTag != null) {
    const gen = { epoch: now, tag: identityTag }
    if (!gens.some((g) => g.epoch === gen.epoch && g.tag === gen.tag)) gens.push(gen)
  }
  return dropGenerations(gens)
}

function dropGenerations(gens: L2Gen[]): Promise<void> {
  const r = redis
  const scope = primaryScope
  if (!ENABLED || !r || scope == null || !isReady(r)) return Promise.resolve()
  if (gens.length === 0) return Promise.resolve()
  counters.drops++
  return (async () => {
    for (const gen of gens) {
      const idx = indexKeyOf(scope, gen)
      try {
        const members = await withTimeout(r.smembers(idx))
        for (let i = 0; i < members.length; i += 500) {
          await withTimeout(r.del(...members.slice(i, i + 500)))
        }
        await withTimeout(r.del(idx))
      } catch {
        failed()
        return
      }
    }
  })()
}
