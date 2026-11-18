/**
 * Local-disk storage provider — preserves the original files-service behavior.
 * Root directory comes from config.STORAGE_LOCAL_ROOT.
 *
 * Keys may contain forward slashes (e.g. transforms/<id>/<hash>.webp); they are
 * resolved under the root with path-traversal protection.
 */
import { createReadStream, createWriteStream, mkdirSync, statSync } from 'node:fs'
import { access, mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { config } from '../../config.js'
import type { StorageProvider } from './index.js'

/**
 * Create a folder only when it is missing. Never mkdir a folder that exists: on an NFS share whose
 * parent the app cannot write (prod /app/uploads is owned by nobody, 755), the server answers
 * mkdir of an EXISTING folder with EACCES instead of EEXIST — after a host patch reboot on
 * 2026-11-18 that failed every file request, reads included, for two hours.
 */
function ensureDirSync(dir: string): void {
  try {
    if (statSync(dir).isDirectory()) return
  } catch {
    // missing (or unreadable) — create it below
  }
  mkdirSync(dir, { recursive: true })
}

async function ensureDir(dir: string): Promise<void> {
  try {
    if ((await stat(dir)).isDirectory()) return
  } catch {
    // missing (or unreadable) — create it below
  }
  await mkdir(dir, { recursive: true })
}

export class LocalStorage implements StorageProvider {
  private root: string

  constructor() {
    this.root = resolve(config.STORAGE_LOCAL_ROOT)
    ensureDirSync(this.root)
  }

  /** Resolve a key under the root; throws on path traversal. */
  resolveKey(key: string): string {
    const full = resolve(this.root, key)
    const rel = relative(this.root, full)
    if (rel.startsWith('..') || rel.includes(`..${sep}`)) {
      throw new Error('Invalid storage key')
    }
    return full
  }

  async put(key: string, buffer: Buffer, _mime: string): Promise<void> {
    const full = this.resolveKey(key)
    await ensureDir(dirname(full))
    await writeFile(full, buffer)
  }

  /** Stream a file on disk into place (never read whole into memory). */
  async putFile(
    key: string,
    path: string,
    _mime: string,
    opts: { signal?: AbortSignal } = {}
  ): Promise<number> {
    const full = this.resolveKey(key)
    await ensureDir(dirname(full))
    await pipeline(createReadStream(path), createWriteStream(full), { signal: opts.signal })
    return (await stat(full)).size
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.resolveKey(key))
  }

  async exists(key: string): Promise<boolean> {
    try {
      await access(this.resolveKey(key))
      return true
    } catch {
      return false
    }
  }

  async delete(key: string): Promise<void> {
    await unlink(this.resolveKey(key)).catch(() => null)
  }

  getUrl(key: string): string {
    return `/api/files/raw/${key.split('/').map(encodeURIComponent).join('/')}`
  }

  async list(prefix: string): Promise<string[]> {
    // Prefix may be a directory ("transforms/") or a key prefix.
    const dir = prefix.endsWith('/') ? prefix.slice(0, -1) : dirname(prefix)
    const base = dir === '.' ? this.root : this.resolveKey(dir)
    const keys: string[] = []
    const walk = async (abs: string): Promise<void> => {
      const entries = await readdir(abs, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        const child = join(abs, entry.name)
        if (entry.isDirectory()) await walk(child)
        else keys.push(relative(this.root, child).split(sep).join('/'))
      }
    }
    await walk(base)
    return keys.filter((k) => k.startsWith(prefix))
  }
}
