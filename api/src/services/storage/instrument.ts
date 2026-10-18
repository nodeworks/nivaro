/**
 * Storage call timing for the Traffic Map's storage node (#2164). Wraps a provider / driver so
 * every put, get, delete, exists and list reports its backend time, bytes and outcome to the
 * `storage` tap — and changes nothing else: arguments, results and errors pass through as they
 * were, and `this` stays the real provider.
 */
import {
  isMissingObject,
  noteStorageCall,
  type StorageOp,
  scrubReason
} from '../traffic-taps/storage.js'

const OPS: Record<string, StorageOp> = {
  put: 'write',
  get: 'read',
  delete: 'delete',
  exists: 'check',
  list: 'list'
}

function bytesOf(op: StorageOp, args: unknown[], result: unknown): number {
  if (op === 'write') return Buffer.isBuffer(args[1]) ? (args[1] as Buffer).length : 0
  if (op === 'read') return Buffer.isBuffer(result) ? (result as Buffer).length : 0
  return 0
}

export function instrumentStorage<T extends object>(target: T, driver: string): T {
  return new Proxy(target, {
    get(t, prop) {
      const value = Reflect.get(t, prop, t)
      if (typeof value !== 'function') return value
      const op = typeof prop === 'string' ? OPS[prop] : undefined
      if (!op) return value.bind(t)
      return async (...args: unknown[]) => {
        const t0 = performance.now()
        try {
          const result = await value.apply(t, args)
          noteStorageCall({
            driver,
            op,
            bytes: bytesOf(op, args, result),
            ms: performance.now() - t0,
            ok: true
          })
          return result
        } catch (err) {
          const missing = isMissingObject(err)
          noteStorageCall({
            driver,
            op,
            ms: performance.now() - t0,
            ok: false,
            missing,
            reason: missing ? undefined : scrubReason(err, String(args[0] ?? ''))
          })
          throw err
        }
      }
    }
  })
}
