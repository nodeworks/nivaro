/**
 * Local-disk storage provider — preserves the original files-service behavior.
 * Root directory comes from config.STORAGE_LOCAL_ROOT.
 *
 * Keys may contain forward slashes (e.g. transforms/<id>/<hash>.webp); they are
 * resolved under the root with path-traversal protection.
 */
import { mkdirSync } from 'node:fs'
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { config } from '../../config.js'
import type { StorageProvider } from './index.js'

export class LocalStorage implements StorageProvider {
  private root: string

  constructor() {
    this.root = resolve(config.STORAGE_LOCAL_ROOT)
    mkdirSync(this.root, { recursive: true })
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
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, buffer)
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.resolveKey(key))
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
