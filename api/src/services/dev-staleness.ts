import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Development-only: is this process running code older than what is on disk?
 *
 * tsx watch is supposed to restart the API on every save, but it has missed
 * restarts (a child that died on a DB blip and was never respawned; a process
 * that simply kept running old code), and it never reloads api/extensions at
 * all. Separately, the admin's vite server has served a stale build of
 * packages/shared after a rebuild. Both looked like "my fix doesn't work".
 *
 * The scan runs on its own 30s timer so /api/version stays free of disk I/O.
 * It only starts when the source tree exists — a release image has none, so
 * production never scans.
 */

export interface DevStaleness {
  /** When this API process started. */
  started_at: string
  /** Newest source file changed after the process started, else null. */
  api_stale: { file: string; changed_at: string } | null
  /** Build time stamped into packages/shared/dist by its build, else null. */
  shared_built_at: string | null
}

const STARTED_AT = new Date()
/** A restart takes a few seconds; a file saved just before it is not stale. */
const GRACE_MS = 10_000
const SCAN_EVERY_MS = 30_000

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'scratch',
  'test',
  'tests',
  'scripts',
  'data',
  '__tests__'
])

let state: DevStaleness = {
  started_at: STARTED_AT.toISOString(),
  api_stale: null,
  shared_built_at: null
}
let timer: NodeJS.Timeout | null = null

function repoRoot(): string {
  // api/src/services → repo root is three levels up.
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
}

/** The newest source file under `dir`, skipping tests, probes and build output. */
async function newestFile(dir: string): Promise<{ path: string; mtime: number } | null> {
  let best: { path: string; mtime: number } | null = null
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
      const sub = await newestFile(p)
      if (sub && (!best || sub.mtime > best.mtime)) best = sub
    } else if (/\.(ts|js|mjs|liquid)$/.test(e.name) && !/\.(test|spec|d)\.ts$/.test(e.name)) {
      try {
        const s = await stat(p)
        if (!best || s.mtimeMs > best.mtime) best = { path: p, mtime: s.mtimeMs }
      } catch {
        /* removed mid-scan */
      }
    }
  }
  return best
}

/** Pure: is `newest` changed late enough after `startedAt` to count as stale? */
export function staleFrom(
  newest: { path: string; mtime: number } | null,
  startedAt: number,
  root: string
): DevStaleness['api_stale'] {
  if (!newest || newest.mtime <= startedAt + GRACE_MS) return null
  return { file: relative(root, newest.path), changed_at: new Date(newest.mtime).toISOString() }
}

/** Pure: the ISO stamp out of dist/build-info.js, else null. */
export function parseSharedStamp(js: string): string | null {
  const m = js.match(/SHARED_BUILT_AT\s*=\s*['"]([^'"]+)['"]/)
  return m ? m[1] : null
}

async function scan(root: string): Promise<void> {
  const [src, ext] = await Promise.all([
    newestFile(join(root, 'api', 'src')),
    newestFile(join(root, 'api', 'extensions'))
  ])
  const newest = !src ? ext : !ext ? src : src.mtime >= ext.mtime ? src : ext
  let shared: string | null = null
  try {
    shared = parseSharedStamp(
      await readFile(join(root, 'packages', 'shared', 'dist', 'build-info.js'), 'utf8')
    )
  } catch {
    shared = null
  }
  state = {
    started_at: STARTED_AT.toISOString(),
    api_stale: staleFrom(newest, STARTED_AT.getTime(), root),
    shared_built_at: shared
  }
}

/** Start the dev scan when running from a source checkout in development. */
export function startDevStalenessScan(nodeEnv: string): void {
  if (timer || nodeEnv !== 'development') return
  const root = repoRoot()
  if (!existsSync(join(root, 'api', 'src'))) return
  void scan(root).catch(() => {})
  timer = setInterval(() => void scan(root).catch(() => {}), SCAN_EVERY_MS)
  timer.unref()
}

/** Last scan result, or null when the scan is not running (production). */
export function devStaleness(): DevStaleness | null {
  return timer ? state : null
}
