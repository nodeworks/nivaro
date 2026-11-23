/**
 * Read-only fallback for uploaded files after an environment refresh.
 *
 * A refresh copies the source's database but not its files, so the target's records name files it
 * has no copy of. `FILES_FALLBACK_DIR` points at the SOURCE's uploads folder (mounted read-only
 * on the target's host, e.g. production's uploads volume on the staging box): when this
 * environment has no copy of a stored object, it is read from there instead of answering 404.
 *
 * Read-only by construction: this module only stats and reads. Writes, replacements and deletes
 * never look here (storage-drivers / stored-object-stream write to this environment's own
 * storage), so the source's folder is never changed. Off in cloud mode — tenants have no shared
 * host folders, and a tenant must never read another environment's files.
 */
import { opendir, readFile, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { isMultiTenant } from '../deployment-mode.js'

/** The fallback folder, or null (unset, relative, or cloud mode). */
export function filesFallbackDir(env: NodeJS.ProcessEnv = process.env): string | null {
  if (isMultiTenant(env)) return null
  const dir = env.FILES_FALLBACK_DIR?.trim()
  if (!dir || !isAbsolute(dir)) return null
  return resolve(dir)
}

/** The path of `key` inside the fallback folder; null when there is none or the key escapes it. */
export function fallbackPath(key: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const root = filesFallbackDir(env)
  if (!root || !key || key.includes('\0')) return null
  const full = resolve(root, key)
  const rel = relative(root, full)
  if (!rel || rel.startsWith('..') || rel.includes(`..${sep}`) || isAbsolute(rel)) return null
  return full
}

/** A stat error that means "not there" (as opposed to "could not look"). */
function isNotThere(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * The fallback folder is set but is not there as a folder (an NFS mount that is gone, a volume
 * that was not mounted), or it is EMPTY — an unmounted share or volume usually leaves its mount
 * point behind as an empty folder (ruling C-1). Strict mode only: never "missing" (`code` is not
 * ENOENT), so a move's copy fails the row instead of skipping it for good. Carries no path.
 * Cost of the rule: a source whose uploads really are empty while file rows exist fails its move;
 * the remedy is to unset FILES_FALLBACK_DIR on it (the move's text says so).
 */
export class FallbackFolderUnavailable extends Error {
  readonly code = 'FALLBACK_FOLDER_UNAVAILABLE'
  constructor() {
    super('The files fallback folder is not available.')
    this.name = 'FallbackFolderUnavailable'
  }
}

/**
 * The fallback file's path when it exists and is a regular file. By default any stat error reads
 * as no copy (the app's reads then answer 404 as before). `strict` (a move's file chain, R7-M-1):
 * only ENOENT / ENOTDIR mean no copy; any other error (EACCES, EIO, ESTALE on an NFS mount) is
 * thrown, so a file the fallback still holds is never counted as missing. A key that is not there
 * counts as missing only while the folder itself is there: a fallback folder that is gone or not
 * a folder (an unmounted volume answers ENOENT for every key), or one with no entries at all (an
 * empty mount point), throws FallbackFolderUnavailable.
 */
export async function existingFallback(
  key: string,
  opts: { strict?: boolean } = {}
): Promise<{ path: string; size: number } | null> {
  const p = fallbackPath(key)
  if (!p) return null
  try {
    const s = await stat(p)
    return s.isFile() ? { path: p, size: s.size } : null
  } catch (err) {
    if (opts.strict && !isNotThere(err)) throw err
    if (opts.strict) await assertFallbackFolder()
    return null
  }
}

/** Strict mode: the fallback folder itself must be there, readable and not empty for a miss to
 *  count. Reads at most one entry (opendir), never the whole folder. */
async function assertFallbackFolder(): Promise<void> {
  const root = filesFallbackDir()
  if (!root) return
  let dir: Awaited<ReturnType<typeof stat>>
  try {
    dir = await stat(root)
  } catch (err) {
    if (isNotThere(err)) throw new FallbackFolderUnavailable()
    throw err
  }
  if (!dir.isDirectory()) throw new FallbackFolderUnavailable()
  const handle = await opendir(root)
  try {
    if ((await handle.read()) === null) throw new FallbackFolderUnavailable()
  } finally {
    await handle.close().catch(() => {})
  }
}

/** The fallback copy's bytes, or null. */
export async function readFallback(key: string): Promise<Buffer | null> {
  const f = await existingFallback(key)
  if (!f) return null
  try {
    return await readFile(f.path)
  } catch {
    return null
  }
}
