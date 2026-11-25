/**
 * Storage health (Hub enhancement 20): how full the agent's volume storage is, for the Hub's
 * Docker driver page and its 80 % / 90 % warnings. Read-only: this file never creates, changes
 * or removes a volume, a file or a folder, and never calls the Engine.
 *
 * HUB_AGENT_STORAGE_PATH (optional, absolute): where the agent container sees the storage the
 * stacks' volumes live on, mounted READ-ONLY — the NFS export root (`HUB_AGENT_VOLUME_OPTS_FILE`
 * type nfs/nfs4) or the node's `/var/lib/docker/volumes` for local volumes. Unset = the health
 * answer says `not_configured` and nothing is read.
 *
 * Two readings, both reported through GET /v1/health `storage`:
 *  - capacity: statfs on the path (total, free, used, used %). Cheap; read at most every
 *    STATFS_TTL_MS. A statfs that does not return in STATFS_TIMEOUT_MS (a hung NFS mount) is
 *    reported as `timeout` and is never stacked: while it is still out, no other one starts.
 *  - tree: bytes and file count under the path, walked in the background at most every
 *    WALK_EVERY_MS, one directory at a time, stopped at WALK_MAX_ENTRIES entries or WALK_BUDGET_MS
 *    (then `complete: false`, the figures are a floor). HUB_AGENT_STORAGE_WALK=off skips it.
 *    Symbolic links are counted, never followed; nothing outside the path is read.
 *
 * The answer carries figures and a fixed state word only — never a path, a file name or an
 * error's text.
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'

export const STATFS_TTL_MS = 30_000
export const STATFS_TIMEOUT_MS = 5_000
export const WALK_EVERY_MS = 15 * 60_000
export const WALK_BUDGET_MS = 120_000
export const WALK_MAX_ENTRIES = 2_000_000

export type StorageState = 'ok' | 'not_configured' | 'unreadable' | 'timeout'

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

export interface StorageProbe {
  report(): Promise<StorageReport>
}

/** HUB_AGENT_STORAGE_PATH / HUB_AGENT_STORAGE_WALK; the kind from the volume options' type. */
export function storageOptionsFrom(
  env: NodeJS.ProcessEnv,
  volumeOpts: Record<string, string> = {}
): StorageOptions {
  const raw = env.HUB_AGENT_STORAGE_PATH?.trim() ?? ''
  // Absolute, no `..` segment: anything else counts as not configured (never a guess).
  const ok = raw !== '' && path.isAbsolute(raw) && !raw.split(/[\\/]/).includes('..')
  const type = String(volumeOpts.type ?? '')
    .trim()
    .toLowerCase()
  return {
    path: ok ? path.normalize(raw) : null,
    walk: (env.HUB_AGENT_STORAGE_WALK ?? '').trim().toLowerCase() !== 'off',
    kind: type === 'nfs' || type === 'nfs4' ? 'nfs' : 'local'
  }
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
  while (stack.length) {
    if (entries >= limits.maxEntries || limits.now() - started > limits.budgetMs)
      return { bytes, files, complete: false }
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
        if (entries >= limits.maxEntries || limits.now() - started > limits.budgetMs) break
      }
    } catch {
      // An unreadable directory part-way: what was read counts.
    }
  }
  return {
    bytes,
    files,
    complete: entries < limits.maxEntries && limits.now() - started <= limits.budgetMs
  }
}

function pct(used: number, total: number): number | null {
  if (!(total > 0)) return null
  return Math.round((used / total) * 1000) / 10
}

/** One probe per agent process: statfs cached and never stacked, the tree walked in the background. */
export function createStorageProbe(opts: StorageOptions, deps: StorageDeps = {}): StorageProbe {
  const statfs = deps.statfs ?? ((p: string) => fsp.statfs(p) as Promise<StatfsLike>)
  const walk = deps.walk ?? walkTree
  const now = deps.now ?? Date.now
  const timeoutMs = deps.statfsTimeoutMs ?? STATFS_TIMEOUT_MS

  let last: { at: number; value: Omit<StorageReport, 'tree' | 'configured' | 'kind'> } | null = null
  /** A statfs still out (a hung mount): no other one starts while it is. */
  let inFlight: Promise<StatfsLike> | null = null
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
        // Unreadable: the previous figures stay; the next health read after WALK_EVERY_MS retries.
      })
      .finally(() => {
        walking = false
      })
  }

  const readCapacity = async (root: string) => {
    if (last && now() - last.at < STATFS_TTL_MS) return last.value
    const at = new Date(now()).toISOString()
    if (inFlight) {
      return {
        state: 'timeout' as const,
        total_bytes: null,
        free_bytes: null,
        used_bytes: null,
        used_pct: null,
        checked_at: at
      }
    }
    const flight = statfs(root)
    inFlight = flight
    void flight
      .catch(() => undefined)
      .finally(() => {
        if (inFlight === flight) inFlight = null
      })
    let timer: NodeJS.Timeout | undefined
    let value: Omit<StorageReport, 'tree' | 'configured' | 'kind'>
    try {
      const s = await Promise.race([
        flight,
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), timeoutMs)
        })
      ])
      if (s === 'timeout') {
        value = {
          state: 'timeout',
          total_bytes: null,
          free_bytes: null,
          used_bytes: null,
          used_pct: null,
          checked_at: at
        }
        // A timeout is not cached: the next read reports it again while the call is out.
        return value
      }
      const total = s.blocks * s.bsize
      const free = s.bavail * s.bsize
      const used = Math.max(0, (s.blocks - s.bfree) * s.bsize)
      value = {
        state: 'ok',
        total_bytes: total,
        free_bytes: free,
        used_bytes: used,
        // Used against what is usable (used + available), as `df` shows it.
        used_pct: pct(used, used + free),
        checked_at: at
      }
    } catch {
      value = {
        state: 'unreadable',
        total_bytes: null,
        free_bytes: null,
        used_bytes: null,
        used_pct: null,
        checked_at: at
      }
    } finally {
      clearTimeout(timer)
    }
    last = { at: now(), value }
    return value
  }

  return {
    async report(): Promise<StorageReport> {
      if (!opts.path) {
        return {
          configured: false,
          kind: opts.kind,
          state: 'not_configured',
          total_bytes: null,
          free_bytes: null,
          used_bytes: null,
          used_pct: null,
          tree: null,
          checked_at: null
        }
      }
      const cap = await readCapacity(opts.path)
      if (cap.state === 'ok') startWalk(opts.path)
      return { configured: true, kind: opts.kind, ...cap, tree }
    }
  }
}
