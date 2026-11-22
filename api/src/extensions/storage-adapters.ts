import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import type { StorageAdapter } from '@nivaro/extension-kit'
import { getTenantId } from '../db/tenant-context.js'
import { tenantSource } from '../services/deployment-mode.js'
import { appScopedKey } from '../services/storage/app-scope.js'

export type { StorageAdapter, StorageFileMeta } from '@nivaro/extension-kit'

// ─── Built-in local adapter ───────────────────────────────────────────────────

const UPLOADS_DIR = new URL('../../../uploads', import.meta.url).pathname

/** The object's path. On a Hub shared deployment it lies inside the current app's storage
 *  scope (apps/<tenantId>/, services/storage/app-scope.ts): a bad key or a call outside any
 *  app is refused. Self-hosted and cloud: unchanged. */
function pathOf(key: string): string {
  if (tenantSource() === 'hub') return join(UPLOADS_DIR, appScopedKey(key, getTenantId() ?? null))
  return join(UPLOADS_DIR, key)
}

class LocalStorageAdapter implements StorageAdapter {
  async put(key: string, stream: NodeJS.ReadableStream): Promise<void> {
    const { createWriteStream } = await import('node:fs')
    const { mkdir } = await import('node:fs/promises')
    const dest = pathOf(key)
    const dir = dest.substring(0, dest.lastIndexOf('/'))
    await mkdir(dir, { recursive: true })
    await new Promise<void>((resolve, reject) => {
      const ws = createWriteStream(dest)
      stream.pipe(ws)
      ws.on('finish', resolve)
      ws.on('error', reject)
    })
  }

  async get(key: string): Promise<NodeJS.ReadableStream> {
    return createReadStream(pathOf(key))
  }

  async delete(key: string): Promise<void> {
    const { unlink } = await import('node:fs/promises')
    const path = pathOf(key)
    try {
      await unlink(path)
    } catch {
      // File already gone — not an error
    }
  }

  async url(_key: string): Promise<string | null> {
    return null // served via /api/files/:id proxy
  }
}

// ─── Registry ─────────────────────────────────────────────────────────────────

class StorageAdapterRegistry {
  private adapters = new Map<string, StorageAdapter>()
  private _active = 'local'

  constructor() {
    this.adapters.set('local', new LocalStorageAdapter())
  }

  register(name: string, adapter: StorageAdapter): void {
    this.adapters.set(name, adapter)
  }

  /** Switch the active adapter. All new uploads use this adapter. */
  setActive(name: string): void {
    if (!this.adapters.has(name)) {
      throw new Error(`Storage adapter "${name}" is not registered`)
    }
    this._active = name
  }

  get active(): StorageAdapter {
    return this.adapters.get(this._active) ?? (this.adapters.get('local') as StorageAdapter)
  }

  get activeName(): string {
    return this._active
  }

  list(): string[] {
    return [...this.adapters.keys()]
  }
}

export const storageAdapterRegistry = new StorageAdapterRegistry()
