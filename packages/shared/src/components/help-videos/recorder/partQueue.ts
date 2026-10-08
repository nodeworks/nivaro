// Recording parts are kept in the browser until the server confirms them, so
// a network drop or a closed tab never loses footage. Sending is strictly in
// order and one at a time — the server only accepts the next part number.

export interface PartStore {
  put(uploadId: string, n: number, blob: Blob): Promise<void>
  remove(uploadId: string, n: number): Promise<void>
  list(uploadId: string): Promise<Array<{ n: number; blob: Blob }>>
  clear(uploadId: string): Promise<void>
}

export class MemoryPartStore implements PartStore {
  private m = new Map<string, Blob>()
  async put(u: string, n: number, b: Blob) {
    this.m.set(`${u}:${n}`, b)
  }
  async remove(u: string, n: number) {
    this.m.delete(`${u}:${n}`)
  }
  async list(u: string) {
    return [...this.m.entries()]
      .filter(([k]) => k.startsWith(`${u}:`))
      .map(([k, blob]) => ({ n: Number(k.split(':')[1]), blob }))
      .sort((a, b) => a.n - b.n)
  }
  async clear(u: string) {
    for (const k of [...this.m.keys()]) if (k.startsWith(`${u}:`)) this.m.delete(k)
  }
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}

class IdbPartStore implements PartStore {
  private memory = new MemoryPartStore()
  private dbp: Promise<IDBDatabase> | null = null

  private async store(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    if (!this.dbp) {
      this.dbp = new Promise((resolve, reject) => {
        const r = indexedDB.open('nivaro-help-video-parts', 1)
        r.onupgradeneeded = () => r.result.createObjectStore('parts')
        r.onsuccess = () => resolve(r.result)
        r.onerror = () => reject(r.error)
      })
    }
    return (await this.dbp).transaction('parts', mode).objectStore('parts')
  }

  async put(u: string, n: number, b: Blob): Promise<void> {
    try {
      await req((await this.store('readwrite')).put(b, `${u}:${n}`))
    } catch {
      await this.memory.put(u, n, b)
    }
  }

  async remove(u: string, n: number): Promise<void> {
    try {
      await req((await this.store('readwrite')).delete(`${u}:${n}`))
    } catch {
      /* not stored there */
    }
    await this.memory.remove(u, n)
  }

  async list(u: string): Promise<Array<{ n: number; blob: Blob }>> {
    const out = await this.memory.list(u)
    try {
      const s = await this.store('readonly')
      const keys = (await req(s.getAllKeys(IDBKeyRange.bound(`${u}:`, `${u}:\uffff`)))) as string[]
      for (const k of keys)
        out.push({
          n: Number(k.split(':')[1]),
          blob: (await req((await this.store('readonly')).get(k))) as Blob
        })
    } catch {
      /* memory only */
    }
    return out.sort((a, b) => a.n - b.n)
  }

  async clear(u: string): Promise<void> {
    for (const p of await this.list(u)) await this.remove(u, p.n)
  }
}

let shared: PartStore | null = null

/** The browser's part store (one per page, so its memory fallback is shared). */
export function idbPartStore(): PartStore {
  if (!shared)
    shared = typeof indexedDB === 'undefined' ? new MemoryPartStore() : new IdbPartStore()
  return shared
}

export function nextBackoff(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** attempt)
}

/** A refusal the server will repeat however often the part is re-sent.
 *  Network errors (no status), 5xx and 409 UPLOAD_ELSEWHERE (the upload's host
 *  is restarting) are outages and retry; 422 (UPLOAD_NOT_VIDEO,
 *  UPLOAD_TOO_LONG) never changes on a retry. */
export function isFatalStatus(status: number | undefined, code?: string): boolean {
  if (status === undefined || status >= 500) return false
  if (status === 409 && code === 'UPLOAD_ELSEWHERE') return false
  return [400, 404, 409, 413, 415, 422].includes(status)
}

export class PartUploader {
  private next: number
  private queue: number[] = []
  private blobs = new Map<number, Blob>()
  private running: Promise<void> | null = null
  private failure: Error | null = null
  private opts: {
    uploadId: string
    send: (n: number, blob: Blob) => Promise<void>
    store: PartStore
    sleep: (ms: number) => Promise<void>
    maxAttempts: number
    onChange?: (s: { pending: number; retrying: boolean }) => void
  }

  constructor(opts: {
    uploadId: string
    send: (n: number, blob: Blob) => Promise<void>
    store: PartStore
    startAt?: number
    sleep?: (ms: number) => Promise<void>
    maxAttempts?: number
    onChange?: (s: { pending: number; retrying: boolean }) => void
  }) {
    this.next = opts.startAt ?? 0
    this.opts = {
      ...opts,
      sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      maxAttempts: opts.maxAttempts ?? 12
    }
  }

  get pending(): number {
    return this.queue.length
  }

  enqueue(blob: Blob): void {
    if (!blob.size) return
    const n = this.next++
    this.blobs.set(n, blob)
    this.queue.push(n)
    void this.opts.store.put(this.opts.uploadId, n, blob)
    this.pump()
  }

  /** Re-send parts kept from an interrupted session (keep what was recorded). */
  resume(parts: Array<{ n: number; blob: Blob }>): void {
    for (const p of parts) {
      this.blobs.set(p.n, p.blob)
      this.queue.push(p.n)
      this.next = Math.max(this.next, p.n + 1)
    }
    this.queue.sort((a, b) => a - b)
    this.pump()
  }

  private pump(): void {
    if (this.running || this.failure) return
    this.running = (async () => {
      while (this.queue.length) {
        const n = this.queue[0]
        const blob = this.blobs.get(n) as Blob
        let attempt = 0
        for (;;) {
          try {
            this.opts.onChange?.({ pending: this.queue.length, retrying: attempt > 0 })
            await this.opts.send(n, blob)
            break
          } catch (err) {
            const e = err as Error & { status?: number; code?: string }
            if (isFatalStatus(e.status, e.code) || ++attempt >= this.opts.maxAttempts) {
              this.failure = e
              throw e
            }
            await this.opts.sleep(nextBackoff(attempt - 1))
          }
        }
        this.queue.shift()
        this.blobs.delete(n)
        await this.opts.store.remove(this.opts.uploadId, n)
      }
      this.opts.onChange?.({ pending: 0, retrying: false })
    })().finally(() => {
      this.running = null
    })
    this.running.catch(() => null)
  }

  async drain(): Promise<void> {
    while (this.running) await this.running.catch(() => null)
    if (this.failure) throw this.failure
    if (this.queue.length) {
      this.pump()
      return this.drain()
    }
  }
}
