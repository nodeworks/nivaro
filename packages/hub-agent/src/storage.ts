/**
 * Storage health (Hub enhancement 20): how full the agent's volume storage is, for the Hub's
 * Docker driver page and its 80 % / 90 % warnings. Read-only: this file never creates, changes
 * or removes a volume, a file or a folder, and never calls the Engine.
 *
 * ONE mount setting per kind (checked at start, a bad value refuses to start):
 *  - NFS volumes (`HUB_AGENT_VOLUME_OPTS_FILE` type nfs/nfs4): `HUB_AGENT_VOLUME_EXPORT_MOUNT`,
 *    where the agent sees the NFS export root (the same mount the volume-export work uses).
 *    `HUB_AGENT_STORAGE_PATH` is refused here: two settings for one mount would drift apart.
 *  - Local volumes: `HUB_AGENT_STORAGE_PATH`, where the agent sees the node's
 *    `/var/lib/docker/volumes` (mounted read-only).
 *  Absolute, no `..` segment, else STORAGE_PATH_BAD. Unset = the health answer says
 *  `not_configured` and nothing is read.
 *
 * The health call NEVER waits on the storage: `report()` answers the last reading at once and
 * starts a refresh in the background when it is stale.
 *  - capacity: statfs on the path (total, free, used, used %), refreshed at most every
 *    STATFS_TTL_MS. A refresh still out after STATFS_TIMEOUT_MS (a hung NFS mount) is reported
 *    as `timeout` (with the last good figures and their time); no second one starts while it is.
 *  - tree: bytes and file count under the path, walked in the background at most every
 *    WALK_EVERY_MS, one directory at a time, stopped at WALK_MAX_ENTRIES entries or WALK_BUDGET_MS
 *    (then `complete: false`, the figures are a floor). Off by default on NFS (a hung mount would
 *    pin the agent's I/O threads), on for local; HUB_AGENT_STORAGE_WALK=on|off decides.
 *    Symbolic links are counted, never followed; nothing outside the path is read.
 *
 * The answer carries figures and a fixed state word only — never a path, a file name or an
 * error's text.
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { isNfsOpts } from './volume-kind.js'

export const STATFS_TTL_MS = 30_000
export const STATFS_TIMEOUT_MS = 5_000
export const WALK_EVERY_MS = 15 * 60_000
export const WALK_BUDGET_MS = 120_000
export const WALK_MAX_ENTRIES = 2_000_000

export type StorageState = 'ok' | 'not_configured' | 'unreadable' | 'timeout' | 'pending'

export interface StorageTree {
  bytes: number
  files: number
  /** False when the walk stopped at its entry or time limit: the figures are a floor. */
  complete: boolean
  walked_at: string
}

export interface StorageReport {
  configured: boolean
  /** nfs when the volume options name an NFS export, else local. */
  kind: 'nfs' | 'local'
  state: StorageState
  total_bytes: number | null
  free_bytes: number | null
  used_bytes: number | null
  /** 0–100, one decimal; null when not read. */
  used_pct: number | null
  tree: StorageTree | null
  /** When the figures were read (the last good reading for `timeout`). */
  checked_at: string | null
}

export interface StatfsLike {
  bsize: number
  blocks: number
  bfree: number
  bavail: number
}

export interface StorageDeps {
  statfs?: (p: string) => Promise<StatfsLike>
  walk?: (root: string, limits: WalkLimits) => Promise<Omit<StorageTree, 'walked_at'>>
  now?: () => number
  statfsTimeoutMs?: number
}

export interface WalkLimits {
  maxEntries: number
  budgetMs: number
  now: () => number
}

export interface StorageOptions {
  path: string | null
  walk: boolean
  kind: 'nfs' | 'local'
}

export type StorageOptionsResult =
  | { ok: true; value: StorageOptions }
  | { ok: false; code: 'STORAGE_PATH_BAD' | 'STORAGE_WALK_BAD' }

export interface StorageProbe {
  report(): Promise<StorageReport>
}

const goodPath = (raw: string) => path.isAbsolute(raw) && !raw.split(/[\\/]/).includes('..')

/**
 * The storage settings, checked (main.ts refuses to start on a bad one). NFS reads
 * HUB_AGENT_VOLUME_EXPORT_MOUNT, local HUB_AGENT_STORAGE_PATH; see the header.
 */
export function storageOptionsFrom(
  env: NodeJS.ProcessEnv,
  volumeOpts: Record<string, string> = {}
): StorageOptionsResult {
  const kind = isNfsOpts(volumeOpts) ? 'nfs' : 'local'
  const storagePath = env.HUB_AGENT_STORAGE_PATH?.trim() ?? ''
  const exportMount = env.HUB_AGENT_VOLUME_EXPORT_MOUNT?.trim() ?? ''
  let p = ''
  if (kind === 'nfs') {
    if (storagePath) return { ok: false, code: 'STORAGE_PATH_BAD' }
    p = exportMount
  } else {
    p = storagePath
  }
  if (p && !goodPath(p)) return { ok: false, code: 'STORAGE_PATH_BAD' }
  const walkRaw = (env.HUB_AGENT_STORAGE_WALK ?? '').trim().toLowerCase()
  if (walkRaw && walkRaw !== 'on' && walkRaw !== 'off')
    return { ok: false, code: 'STORAGE_WALK_BAD' }
  const walk = walkRaw ? walkRaw === 'on' : kind === 'local'
  return { ok: true, value: { path: p ? path.normalize(p) : null, walk, kind } }
}

/** Bytes and files under `root`, one directory at a time, bounded; links counted, not followed. */
export async function walkTree(
  root: string,
  limits: WalkLimits
): Promise<Omit<StorageTree, 'walked_at'>> {
  const started = limits.now()
  let bytes = 0
  let files = 0
  let entries = 0
  const stack: string[] = [root]
  const over = () => entries >= limits.maxEntries || limits.now() - started > limits.budgetMs
  while (stack.length) {
    if (over()) return { bytes, files, complete: false }
    const dir = stack.pop() as string
    let handle: Awaited<ReturnType<typeof fsp.opendir>>
    try {
      handle = await fsp.opendir(dir)
    } catch {
      continue
    }
    try {
      for await (const d of handle) {
        entries++
        const full = path.join(dir, d.name)
        if (d.isDirectory()) stack.push(full)
        else if (d.isFile()) {
          files++
          try {
            bytes += (await fsp.lstat(full)).size
          } catch {
            // Gone between the listing and the stat: counted as a file, no bytes.
          }
        }
        if (over()) break
      }
    } catch {
      // An unreadable directory part-way: what was read counts.
    }
  }
  return { bytes, files, complete: !over() }
}

function pct(used: number, total: number): number | null {
  if (!(total > 0)) return null
  return Math.round((used / total) * 1000) / 10
}

type Capacity = Pick<
  StorageReport,
  'state' | 'total_bytes' | 'free_bytes' | 'used_bytes' | 'used_pct' | 'checked_at'
>

const EMPTY: Omit<Capacity, 'state'> = {
  total_bytes: null,
  free_bytes: null,
  used_bytes: null,
  used_pct: null,
  checked_at: null
}

/** One probe per agent process: never blocks the caller; statfs and the walk run behind it. */
export function createStorageProbe(opts: StorageOptions, deps: StorageDeps = {}): StorageProbe {
  const statfs = deps.statfs ?? ((p: string) => fsp.statfs(p) as Promise<StatfsLike>)
  const walk = deps.walk ?? walkTree
  const now = deps.now ?? Date.now
  const timeoutMs = deps.statfsTimeoutMs ?? STATFS_TIMEOUT_MS

  /** The last reading (ok or unreadable) and when it was taken. */
  let last: { at: number; value: Capacity } | null = null
  /** The last GOOD figures, kept through a timeout. */
  let lastGood: Capacity | null = null
  /** A statfs still out (a hung mount): no other one starts while it is. */
  let inFlight: { started: number } | null = null
  let tree: StorageTree | null = null
  let walking = false
  let walkedAt = 0

  const startWalk = (root: string) => {
    if (!opts.walk || walking || (tree && now() - walkedAt < WALK_EVERY_MS)) return
    walking = true
    walkedAt = now()
    void walk(root, { maxEntries: WALK_MAX_ENTRIES, budgetMs: WALK_BUDGET_MS, now })
      .then((r) => {
        tree = { ...r, walked_at: new Date(now()).toISOString() }
      })
      .catch(() => {
        // Unreadable: the previous figures stay; the next read after WALK_EVERY_MS retries.
      })
      .finally(() => {
        walking = false
      })
  }

  const startRefresh = (root: string) => {
    if (inFlight) return
    const flight = { started: now() }
    inFlight = flight
    void statfs(root)
      .then((s) => {
        const total = s.blocks * s.bsize
        const free = s.bavail * s.bsize
        const used = Math.max(0, (s.blocks - s.bfree) * s.bsize)
        const value: Capacity = {
          state: 'ok',
          total_bytes: total,
          free_bytes: free,
          used_bytes: used,
          // Used against what is usable (used + available), as `df` shows it.
          used_pct: pct(used, used + free),
          checked_at: new Date(now()).toISOString()
        }
        last = { at: now(), value }
        lastGood = value
        startWalk(root)
      })
      .catch(() => {
        last = {
          at: now(),
          value: { state: 'unreadable', ...EMPTY, checked_at: new Date(now()).toISOString() }
        }
      })
      .finally(() => {
        if (inFlight === flight) inFlight = null
      })
  }

  return {
    async report(): Promise<StorageReport> {
      const base = { configured: !!opts.path, kind: opts.kind, tree }
      if (!opts.path) return { ...base, configured: false, state: 'not_configured', ...EMPTY }
      if (!last || now() - last.at >= STATFS_TTL_MS) startRefresh(opts.path)
      const hung = inFlight && now() - inFlight.started >= timeoutMs
      if (hung) return { ...base, tree, ...(lastGood ?? EMPTY), state: 'timeout' }
      if (!last) return { ...base, tree, state: 'pending', ...EMPTY }
      return { ...base, tree, ...last.value }
    }
  }
}
