/**
 * Stored config snapshots (#523) — see migration 337.
 *
 * `takeConfigSnapshot` builds the same ConfigSnapshot the export route
 * serves (secrets already stripped by config-inventory), gzips it and stores
 * it once a day. Consecutive identical snapshots are stored anyway — a row
 * per night is what makes "since Friday" answerable — but dedupe by
 * content_hash keeps the compare honest: a stretch of identical hashes IS
 * the answer "nothing drifted".
 *
 * #2803 — the same rows are restore points. Besides the nightly ('cron') and
 * 'manual' ones, a snapshot is stored before boot migrations ('pre-migration'),
 * before a deploy (the deploy script POSTs 'pre-deploy') and before a config
 * restore ('pre-restore', only the tables the restore touches — undo for the
 * restore itself). Retention is per trigger kind (KEEP_BY_TRIGGER), so thirty
 * nightly rows never push the last deploy's restore point out.
 */
import { createHash } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import type { Knex } from 'knex'
import { config } from '../config.js'
import { db } from '../db/index.js'
import { NIVARO_VERSION } from '../version.js'
import {
  buildConfigSnapshot,
  type ConfigSnapshot,
  diffSnapshots,
  redactSnapshot,
  type SnapshotDiff
} from './config-inventory.js'
import { chunkArray } from './db-batch.js'

export type SnapshotTrigger = 'cron' | 'manual' | 'pre-migration' | 'pre-deploy' | 'pre-restore'

/** Newest N kept per trigger kind (#2803). Unknown kinds keep the default. */
export const KEEP_BY_TRIGGER: Record<string, number> = {
  cron: 30,
  manual: 10,
  'pre-migration': 10,
  'pre-deploy': 10,
  'pre-restore': 10
}
const KEEP_DEFAULT = 10
/** Every kind at its cap, plus slack: the history list's default length. */
const LIST_LIMIT = 80

export interface StoredSnapshotMeta {
  id: number
  taken_at: string
  version: string | null
  environment: string | null
  tables: number
  rows: number
  content_hash: string
  bytes: number
  trigger: string
  /** True when identical to the snapshot before it. */
  same_as_previous: boolean
  /** Why a restore point was taken ("Before deploying 0.3.5", the migrations about to run…). */
  note?: string | null
}

export interface TakeSnapshotOptions {
  userId?: string | null
  note?: string | null
  targetVersion?: string | null
  migrations?: string[]
  restoreOf?: number | null
  /** Only these config tables (a pre-restore point carries just what the restore touches). */
  tables?: string[]
  signal?: AbortSignal
  concurrency?: number
}

/** Exported for tests: the ids retention removes, newest N kept per trigger kind. */
export function idsToPrune(rows: Array<{ id: number; trigger: string | null }>): number[] {
  const seen = new Map<string, number>()
  const out: number[] = []
  for (const r of [...rows].sort((a, b) => b.id - a.id)) {
    const kind = r.trigger ?? 'cron'
    const n = (seen.get(kind) ?? 0) + 1
    seen.set(kind, n)
    if (n > (KEEP_BY_TRIGGER[kind] ?? KEEP_DEFAULT)) out.push(r.id)
  }
  return out
}

function contentHash(snap: ConfigSnapshot): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(snap.tables).map(([t, rows]) => [
            t,
            Object.keys(rows)
              .sort()
              .map((k) => `${k}:${rows[k].hash}`)
          ])
        )
      )
    )
    .digest('hex')
}

export async function takeConfigSnapshot(
  trigger: SnapshotTrigger,
  userIdOrOpts?: string | null | TakeSnapshotOptions
): Promise<StoredSnapshotMeta> {
  const opts: TakeSnapshotOptions =
    userIdOrOpts && typeof userIdOrOpts === 'object' ? userIdOrOpts : { userId: userIdOrOpts }
  const snap = await buildConfigSnapshot({
    version: NIVARO_VERSION,
    environment: config.NODE_ENV,
    tables: opts.tables,
    signal: opts.signal,
    concurrency: opts.concurrency ?? 4
  })
  // A time-boxed snapshot that ran out of time must not land late (after the migrations it
  // was meant to precede have run) — it would be a restore point of the wrong state.
  if (opts.signal?.aborted) throw new Error('config snapshot aborted')
  const stored = await storeConfigSnapshot(snap, trigger, opts)
  await afterSnapshotStored(stored, opts)
  return stored
}

/**
 * Store an already built snapshot. `database` may be the caller's transaction (a config restore
 * stores its pre-restore point from the rows it locked, and that row rolls back with it).
 * Call afterSnapshotStored once the row is committed.
 */
export async function storeConfigSnapshot(
  snap: ConfigSnapshot,
  trigger: SnapshotTrigger,
  opts: TakeSnapshotOptions = {},
  database: Knex = db as unknown as Knex
): Promise<StoredSnapshotMeta> {
  if (trigger !== 'cron' && trigger !== 'manual') {
    snap.restore_point = {
      trigger,
      note: opts.note ?? null,
      ...(opts.targetVersion ? { target_version: opts.targetVersion } : {}),
      ...(opts.migrations?.length ? { migrations: opts.migrations } : {}),
      ...(opts.restoreOf ? { restore_of: opts.restoreOf } : {})
    }
  }
  const json = JSON.stringify(snap)
  const hash = contentHash(snap)
  const gz = gzipSync(Buffer.from(json, 'utf8')).toString('base64')
  const rows = Object.values(snap.tables).reduce((a, t) => a + Object.keys(t).length, 0)
  const taken = new Date()
  const inserted = (await database('nivaro_config_snapshots')
    .insert({
      taken_at: taken,
      version: NIVARO_VERSION,
      environment: config.NODE_ENV,
      tables: Object.keys(snap.tables).length,
      rows,
      content_hash: hash,
      bytes: gz.length,
      snapshot_gz: gz,
      trigger,
      created_by: opts.userId ?? null
    })
    .returning('id')) as unknown[]
  const first = inserted[0] as { id?: number } | number | undefined
  let id = typeof first === 'object' && first ? Number(first.id) : Number(first)
  if (!Number.isFinite(id) || id <= 0) {
    const row = (await database('nivaro_config_snapshots')
      .where({ content_hash: hash })
      .orderBy('id', 'desc')
      .first('id')) as { id: number }
    id = row.id
  }
  return {
    id,
    taken_at: taken.toISOString(),
    version: NIVARO_VERSION,
    environment: config.NODE_ENV,
    tables: Object.keys(snap.tables).length,
    rows,
    content_hash: hash,
    bytes: gz.length,
    trigger,
    same_as_previous: false,
    note: opts.note ?? null
  }
}

/** The note's activity row and retention, once the snapshot row is committed. */
export async function afterSnapshotStored(
  stored: StoredSnapshotMeta,
  opts: TakeSnapshotOptions = {}
): Promise<void> {
  // The note rides an activity row keyed by the snapshot id: the list reads it without
  // unzipping every snapshot (the snapshot JSON carries it too, as restore_point).
  if (opts.note) {
    const { logActivity } = await import('./activity.js')
    await logActivity({
      action: 'config-snapshot-store',
      user: opts.userId ?? null,
      collection: 'nivaro_config_snapshots',
      item: String(stored.id),
      comment: opts.note.slice(0, 900),
      origin: opts.userId ? 'person' : 'machine'
    })
  }
  try {
    await pruneConfigSnapshots()
  } catch (err) {
    console.warn(
      `[config-snapshot] retention failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

async function pruneConfigSnapshots(): Promise<void> {
  const rows = (await db('nivaro_config_snapshots').select('id', 'trigger')) as Array<{
    id: number
    trigger: string | null
  }>
  const drop = idsToPrune(rows)
  // Chunked: a backlog (retention changed, a long-dead cron) must not hit the parameter cap.
  for (const ids of chunkArray(drop, 500))
    await db('nivaro_config_snapshots').whereIn('id', ids).del()
}

export async function listConfigSnapshots(limit = LIST_LIMIT): Promise<StoredSnapshotMeta[]> {
  const rows = (await db('nivaro_config_snapshots')
    .select(
      'id',
      'taken_at',
      'version',
      'environment',
      'tables',
      'rows',
      'content_hash',
      'bytes',
      'trigger'
    )
    .orderBy('id', 'desc')
    .limit(limit + 1)) as Array<
    Omit<StoredSnapshotMeta, 'same_as_previous' | 'taken_at'> & { taken_at: Date }
  >
  const notes = new Map<string, string>()
  const noted = rows.filter((r) => r.trigger !== 'cron').map((r) => String(r.id))
  if (noted.length) {
    try {
      const acts = (await db('nivaro_activity')
        .where({ action: 'config-snapshot-store', collection: 'nivaro_config_snapshots' })
        .whereIn('item', noted)
        .whereNotNull('comment')
        .select('item', 'comment')) as Array<{ item: string; comment: string }>
      for (const a of acts) notes.set(String(a.item), a.comment)
    } catch {
      // A note is decoration; the list itself is the payload.
    }
  }
  return rows.slice(0, limit).map((r, i) => ({
    ...r,
    taken_at: new Date(r.taken_at).toISOString(),
    same_as_previous: rows[i + 1] ? rows[i + 1].content_hash === r.content_hash : false,
    note: notes.get(String(r.id)) ?? null
  }))
}

export async function getConfigSnapshotMeta(id: number): Promise<StoredSnapshotMeta | null> {
  const list = await listConfigSnapshots()
  return list.find((m) => m.id === id) ?? null
}

export async function loadConfigSnapshot(id: number): Promise<ConfigSnapshot | null> {
  const row = (await db('nivaro_config_snapshots').where({ id }).first('snapshot_gz')) as
    | { snapshot_gz: string }
    | undefined
  if (!row) return null
  // Today's redaction over a snapshot stored before a column joined the list (#2803 review):
  // its value is never shown, compared or written back.
  return redactSnapshot(
    JSON.parse(
      gunzipSync(Buffer.from(row.snapshot_gz, 'base64')).toString('utf8')
    ) as ConfigSnapshot
  )
}

/** The stored snapshot taken at or before `at` (newest such), or the oldest when none is that old. */
export async function snapshotAtOrBefore(at: Date): Promise<number | null> {
  const row = (await db('nivaro_config_snapshots')
    .where('taken_at', '<=', at)
    .orderBy('taken_at', 'desc')
    .first('id')) as { id: number } | undefined
  if (row) return row.id
  const oldest = (await db('nivaro_config_snapshots').orderBy('taken_at', 'asc').first('id')) as
    | { id: number }
    | undefined
  return oldest?.id ?? null
}

/** Live config vs a stored snapshot: `mine` = now, `theirs` = then. */
export async function diffSinceSnapshot(
  id: number
): Promise<(SnapshotDiff & { since: StoredSnapshotMeta }) | null> {
  const then = await loadConfigSnapshot(id)
  if (!then) return null
  const meta = await getConfigSnapshotMeta(id)
  // A pre-restore point carries only the tables its restore touched; comparing every other
  // table against it would report all of them as "only here".
  const partial = then.restore_point?.trigger === 'pre-restore'
  const now = await buildConfigSnapshot({
    version: NIVARO_VERSION,
    environment: config.NODE_ENV,
    tables: partial ? Object.keys(then.tables) : undefined,
    concurrency: 4
  })
  const diff = diffSnapshots(now, then)
  return { ...diff, since: meta as StoredSnapshotMeta }
}
