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
import { readFile, stat } from 'node:fs/promises'
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

/** The fallback file's path when it exists and is a regular file. */
export async function existingFallback(
  key: string
): Promise<{ path: string; size: number } | null> {
  const p = fallbackPath(key)
  if (!p) return null
  try {
    const s = await stat(p)
    return s.isFile() ? { path: p, size: s.size } : null
  } catch {
    return null
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
