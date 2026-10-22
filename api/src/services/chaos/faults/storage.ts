import { type ArmedFault, registerFault } from '../catalog.js'
import { chaosPoint } from '../registry.js'

/**
 * Storage faults (#1773): a slow driver, a full disk (ENOSPC) or a read-only volume (EROFS).
 * They act at the storage seam every provider and driver passes — the timing wrapper
 * (services/storage/instrument.ts: put / get / delete / exists / list), the local streaming
 * paths that bypass it (services/stored-object-stream.ts) and the help-video work directory
 * (upload parts, render scratch). `files.write` covers put and delete; `files.read` covers
 * get, exists and list. Errors carry the code, errno and syscall Node's fs gives them, so the
 * "disk full" handling and the Traffic Map's storage node see the real shape.
 */

export type StorageOp = 'write' | 'read' | 'delete' | 'check' | 'list'

export function makeStorageError(kind: 'disk_full' | 'read_only', what = 'write'): Error {
  if (kind === 'disk_full') {
    return Object.assign(new Error(`ENOSPC: no space left on device, ${what}`), {
      code: 'ENOSPC',
      errno: -28,
      syscall: 'write',
      chaos: true
    })
  }
  return Object.assign(new Error(`EROFS: read-only file system, ${what}`), {
    code: 'EROFS',
    errno: -30,
    syscall: 'open',
    chaos: true
  })
}

function acts(f: ArmedFault, op: StorageOp): { delay: number; error: Error | null } | null {
  const mode = String(f.params.mode ?? 'slow')
  const isWrite = op === 'write' || op === 'delete'
  const delay = Math.max(0, Number(f.params.delay_ms) || 0)
  if (mode === 'slow') {
    const ops = String(f.params.ops ?? 'both')
    if (ops === 'writes' && !isWrite) return null
    if (ops === 'reads' && isWrite) return null
    return delay > 0 ? { delay, error: null } : null
  }
  if (!isWrite) return null
  // A full disk still lets you delete; a read-only volume refuses that too.
  if (mode === 'disk_full' && op === 'delete') return null
  return { delay, error: makeStorageError(mode === 'disk_full' ? 'disk_full' : 'read_only', op) }
}

/**
 * The storage fault acting on this operation: null (the usual answer, O(1)) or a promise that
 * waits and/or rejects with the fault's error. Callers `const hit = storageChaos(op); if (hit) await hit`.
 */
export function storageChaos(op: StorageOp): Promise<void> | null {
  const f = chaosPoint(op === 'write' || op === 'delete' ? 'files.write' : 'files.read')
  if (!f) return null
  const a = acts(f, op)
  if (!a) return null
  return new Promise<void>((resolve, reject) => {
    const done = () => (a.error ? reject(a.error) : resolve())
    if (a.delay > 0) setTimeout(done, a.delay)
    else done()
  })
}

registerFault({
  key: 'storage_faults',
  label: 'Storage failing',
  area: 'storage',
  proves:
    'Storage trouble is contained: a slow driver shows as slow uploads and downloads (not timeouts elsewhere), a full disk or read-only volume fails the upload with a clear message, records still save, and reads of existing files keep working.',
  claim_keys: ['storage.failures_contained'],
  targets: ['all', 'share'],
  params: {
    mode: {
      type: 'enum',
      label: 'Fault',
      options: ['slow', 'disk_full', 'read_only'],
      default: 'slow'
    },
    delay_ms: {
      type: 'number',
      label: 'Added per call',
      min: 0,
      max: 30000,
      default: 1500,
      unit: 'ms'
    },
    ops: {
      type: 'enum',
      label: 'Slow (which calls)',
      options: ['both', 'writes', 'reads'],
      default: 'both'
    }
  },
  max_seconds: 600,
  default_seconds: 60,
  points: ['files.write', 'files.read'],
  danger: 'medium',
  hypothesis_defaults: [{ sampler: 'http.5xx_pct', op: '<', limit: 1, tolerance: 0.5 }]
})
