import { createReadStream } from 'node:fs'
import { join } from 'node:path'

export interface StorageAdapter {
  /** Store a file. `stream` is a readable stream of the file contents. */
  put(key: string, stream: NodeJS.ReadableStream, meta: StorageFileMeta): Promise<void>
  /** Return a readable stream for the file. */
  get(key: string): Promise<NodeJS.ReadableStream>
  /** Delete a file. Should not throw if the key does not exist. */
  delete(key: string): Promise<void>
  /** Return a public or pre-signed URL, or null if serving via proxy. */
  url(key: string): Promise<string | null>
}

export interface StorageFileMeta {
  filename: string
  mimetype: string
  size: number
}

// ─── Built-in local adapter ───────────────────────────────────────────────────

const UPLOADS_DIR = new URL('../../../uploads', import.meta.url).pathname

class LocalStorageAdapter implements StorageAdapter {
  async put(key: string, stream: NodeJS.ReadableStream): Promise<void> {
    const { createWriteStream } = await import('node:fs')
    const { mkdir } = await import('node:fs/promises')
    const dest = join(UPLOADS_DIR, key)
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
    return createReadStream(join(UPLOADS_DIR, key))
  }

  async delete(key: string): Promise<void> {
    const { unlink } = await import('node:fs/promises')
    try {
      await unlink(join(UPLOADS_DIR, key))
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
