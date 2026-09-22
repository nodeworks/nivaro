/**
 * Stored config snapshots (#523) — see migration 337.
 *
 * `takeConfigSnapshot` builds the same ConfigSnapshot the export route
 * serves (secrets already stripped by config-inventory), gzips it and stores
 * it once a day. Consecutive identical snapshots are stored anyway — a row
 * per night is what makes "since Friday" answerable — but dedupe by
 * content_hash keeps the compare honest: a stretch of identical hashes IS
 * the answer "nothing drifted".
 */
import { createHash } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import { config } from '../config.js'
import { db } from '../db/index.js'
import { NIVARO_VERSION } from '../version.js'
import {
  buildConfigSnapshot,
  type ConfigSnapshot,
  diffSnapshots,
  type SnapshotDiff
} from './config-inventory.js'

const KEEP = 30

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
}

export async function takeConfigSnapshot(
  trigger: 'cron' | 'manual',
  userId?: string | null
): Promise<StoredSnapshotMeta> {
  const snap = await buildConfigSnapshot({ version: NIVARO_VERSION, environment: config.NODE_ENV })
  const json = JSON.stringify(snap)
  const hash = createHash('sha256')
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
  const gz = gzipSync(Buffer.from(json, 'utf8')).toString('base64')
  const rows = Object.values(snap.tables).reduce((a, t) => a + Object.keys(t).length, 0)
  const taken = new Date()
  await db('nivaro_config_snapshots').insert({
    taken_at: taken,
    version: NIVARO_VERSION,
    environment: config.NODE_ENV,
    tables: Object.keys(snap.tables).length,
    rows,
    content_hash: hash,
    bytes: gz.length,
    snapshot_gz: gz,
    trigger,
    created_by: userId ?? null
  })
  const row = (await db('nivaro_config_snapshots')
    .where({ content_hash: hash })
    .orderBy('id', 'desc')
    .first()) as { id: number }
  // prune
  const keepIds = (await db('nivaro_config_snapshots')
    .orderBy('id', 'desc')
    .limit(KEEP)
    .pluck('id')) as number[]
  if (keepIds.length === KEEP) await db('nivaro_config_snapshots').whereNotIn('id', keepIds).del()
  const list = await listConfigSnapshots(2)
  return (
    list.find((m) => m.id === row.id) ?? {
      id: row.id,
      taken_at: taken.toISOString(),
      version: NIVARO_VERSION,
      environment: config.NODE_ENV,
      tables: Object.keys(snap.tables).length,
      rows,
      content_hash: hash,
      bytes: gz.length,
      trigger,
      same_as_previous: false
    }
  )
}

export async function listConfigSnapshots(limit = KEEP): Promise<StoredSnapshotMeta[]> {
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
  return rows.slice(0, limit).map((r, i) => ({
    ...r,
    taken_at: new Date(r.taken_at).toISOString(),
    same_as_previous: rows[i + 1] ? rows[i + 1].content_hash === r.content_hash : false
  }))
}

export async function loadConfigSnapshot(id: number): Promise<ConfigSnapshot | null> {
  const row = (await db('nivaro_config_snapshots').where({ id }).first('snapshot_gz')) as
    | { snapshot_gz: string }
    | undefined
  if (!row) return null
  return JSON.parse(
    gunzipSync(Buffer.from(row.snapshot_gz, 'base64')).toString('utf8')
  ) as ConfigSnapshot
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
  const meta = (await listConfigSnapshots(KEEP)).find((m) => m.id === id)
  const now = await buildConfigSnapshot({ version: NIVARO_VERSION, environment: config.NODE_ENV })
  const diff = diffSnapshots(now, then)
  return { ...diff, since: meta as StoredSnapshotMeta }
}
