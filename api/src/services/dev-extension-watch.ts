import { existsSync, stat, utimes, watch } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extensionRegistry } from '../extensions/loader.js'

/**
 * Development only: restart the API when a loaded extension's source changes.
 *
 * Extensions are loaded by dynamic import, outside tsx's module graph, so
 * `tsx watch` never restarts on an edit under api/extensions — and asking it
 * to (`--include extensions/**`) made every start crawl that tree for minutes.
 * `fs.watch` with `recursive` is native on macOS and Windows and costs no
 * crawl. On a change this process TOUCHES api/src/index.ts (mtime only): tsx
 * watch tracks that file, kills this process and starts a fresh one — the
 * only way an extension's hooks, crons and routes get re-registered. It must
 * not simply exit: tsx watch never respawns a child that exited on its own,
 * it waits for the next file change, and the API stayed dead until someone
 * saved something under api/src.
 *
 * Only the folders of extensions that actually loaded are watched; scripts,
 * tests and data under them are ignored. Never runs in production (no source
 * tree in the image).
 */

const SKIP =
  /\/(scripts|tests|data|node_modules|\.git)(\/|$)|\.(test|spec)\.ts$|\.(json|md|sql|log)$/
const SETTLE_MS = 400
/** Events in the first seconds after boot are the boot itself, not an edit. */
const BOOT_QUIET_MS = 5_000

let started = false

/** Pure: a change counts only after the quiet window, and only when the file
 *  really changed after this process started (deleted = changed). */
export function isRealChange(
  mtimeMs: number | null,
  processStartMs: number,
  nowMs: number
): boolean {
  if (nowMs - processStartMs < BOOT_QUIET_MS) return false
  return mtimeMs == null || mtimeMs > processStartMs
}

/** Pure: should this changed path restart the process? */
export function isRestartWorthy(rel: string | null | undefined): boolean {
  if (!rel) return false
  const p = `/${rel.replace(/\\/g, '/')}`
  if (SKIP.test(p)) return false
  return /\.(ts|js|mjs|liquid)$/.test(p)
}

export function startDevExtensionWatch(nodeEnv: string, log: (msg: string) => void): void {
  if (started || nodeEnv !== 'development') return
  if (process.platform !== 'darwin' && process.platform !== 'win32') return // recursive watch is native there
  started = true
  const startedAt = Date.now()
  let timer: NodeJS.Timeout | null = null
  const entry = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'index.ts')
  const restart = (id: string, rel: string) => {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      log(`extension ${id} changed (${rel}) — touching ${entry} so tsx watch restarts the API`)
      const now = new Date()
      utimes(entry, now, now, (err) => {
        if (err) log(`could not touch ${entry} (${err.message}) — restart the API by hand`)
      })
    }, SETTLE_MS)
    timer.unref()
  }
  for (const [id, entry] of extensionRegistry) {
    if (entry.status !== 'loaded' || entry.cloud || !existsSync(entry.path)) continue
    try {
      const w = watch(entry.path, { recursive: true }, (_event, filename) => {
        const rel = filename == null ? null : String(filename)
        if (!isRestartWorthy(rel)) return
        stat(join(entry.path, rel ?? ''), (err, st) => {
          if (isRealChange(err ? null : st.mtimeMs, startedAt, Date.now())) restart(id, rel ?? '')
        })
      })
      w.unref()
      w.on('error', () => w.close())
    } catch {
      /* a watch that cannot start just means a manual restart, as before */
    }
  }
  if (extensionRegistry.size > 0) log(`watching ${join('api', 'extensions')} for changes (dev)`)
}
