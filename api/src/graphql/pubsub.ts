import { EventEmitter } from 'node:events'
import { currentTenantKey, tenantScopedRoom } from '../services/tenant-rooms.js'

type Handler<T> = (v: T) => void

class PubSub {
  private em = new EventEmitter()

  constructor() {
    this.em.setMaxListeners(500)
  }

  publish<T>(topic: string, payload: T): void {
    this.em.emit(topic, payload)
  }

  asyncIterator<T>(topic: string): AsyncIterableIterator<T> {
    const em = this.em
    const queue: T[] = []
    const waiters: Array<(r: IteratorResult<T>) => void> = []
    let closed = false

    function cleanup(): void {
      em.removeListener(topic, push)
      closed = true
      for (const w of waiters.splice(0)) w({ value: undefined as unknown as T, done: true })
    }

    function push(v: T): void {
      if (waiters.length > 0) waiters.shift()!({ value: v, done: false })
      else queue.push(v)
    }

    em.on(topic, push)

    return {
      next(): Promise<IteratorResult<T>> {
        if (closed) return Promise.resolve({ value: undefined as unknown as T, done: true })
        if (queue.length) return Promise.resolve({ value: queue.shift()!, done: false })
        return new Promise((res) => waiters.push(res))
      },
      return(): Promise<IteratorResult<T>> {
        cleanup()
        return Promise.resolve({ value: undefined as unknown as T, done: true })
      },
      throw(e: unknown): Promise<IteratorResult<T>> {
        cleanup()
        return Promise.reject(e)
      },
      [Symbol.asyncIterator]() {
        return this
      }
    }
  }
}

export const pubsub = new PubSub()

// ── Topic helpers ──────────────────────────────────────────────────────────────
// Cloud mode: one process serves several tenants, so every topic carries the tenant
// (tenant-rooms.ts convention, `t:<tenant>:`). Publishers default to the tenant of the
// request they run in; subscribers pass the tenant their connection resolved to.
// Self-hosted (no tenant): topic names are unchanged.
export const topics = {
  workflowStateChanged: (collection: string, item: string, tenant = currentTenantKey()) =>
    tenantScopedRoom(`workflow:state:${collection}:${item}`, tenant),
  pipelineStateChanged: (collection: string, item: string, tenant = currentTenantKey()) =>
    tenantScopedRoom(`pipeline:state:${collection}:${item}`, tenant),
  itemMutated: (collection: string, item: string, tenant = currentTenantKey()) =>
    tenantScopedRoom(`item:mutated:${collection}:${item}`, tenant)
}
