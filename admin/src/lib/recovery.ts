import {
  isKeyedWrite,
  isReadPost,
  isRecoverable,
  isServerBack,
  newIdempotencyKey,
  onRecoveryEvent,
  type RecoveryEvent,
  type RecoveryOptions,
  recoverySleep,
  setRecoveryDefaults,
  withRecovery
} from '@nivaro/sdk'
import { registerUnsavedWork } from '@nivaro/shared'
import type { QueryClient } from '@tanstack/react-query'
import axios, {
  type AxiosAdapter,
  type AxiosInstance,
  type InternalAxiosRequestConfig
} from 'axios'
import { toast } from 'sonner'

/**
 * Riding out a server that is briefly away (deploy, restart) in the admin — the
 * SDK's one policy (packages/sdk/src/recovery.ts) for the admin's axios calls
 * and for every SDK client its pages create:
 *
 *  - reads wait for the server for up to two minutes;
 *  - creates / updates / deletes of records (`/items/…`) carry one
 *    Idempotency-Key per save and wait too — never written twice;
 *  - every other write (schema, layouts, pipeline moves, uploads, pushes)
 *    fails at once, as before;
 *  - a maintenance window is not waited out.
 */

/** Two minutes: longer than a rolling deploy, short enough that a real outage says so. */
export const RECOVERY: RecoveryOptions = { enabled: true, budgetMs: 120_000 }

/** The body's `code` — inside the adapter axios has not parsed the JSON yet, so `data` may
 *  still be the raw string. */
function bodyCode(data: unknown): string | null {
  let d = data
  if (typeof d === 'string') {
    try {
      d = JSON.parse(d)
    } catch {
      return null
    }
  }
  const c = (d as { code?: unknown } | null)?.code
  return typeof c === 'string' ? c : null
}

/** One axios try's outcome → retry or not (the same rules as the SDK's fetch verdict). */
export function axiosVerdict(
  method: string,
  keyed: boolean,
  err: unknown
): { retry: boolean; retryAfterMs?: number | null; back?: boolean } {
  if (err === undefined) return { retry: false, back: true }
  if (axios.isCancel(err)) return { retry: false, back: false }
  const e = err as {
    code?: string
    response?: { status?: number; data?: unknown; headers?: Record<string, unknown> }
  }
  // Our own read timeout (#2857) is the answer: never a second 90 s wait.
  if (e.code === 'ECONNABORTED' || e.code === 'ETIMEDOUT') return { retry: false, back: false }
  const status = e.response?.status
  const code = bodyCode(e.response?.data)
  const after = e.response?.headers?.['retry-after']
  const retryAfterMs =
    typeof after === 'string' && /^\d+$/.test(after.trim()) ? Number(after) * 1000 : null
  return {
    retry: isRecoverable(method, { status, code, keyed }),
    retryAfterMs,
    back: isServerBack(status, code)
  }
}

/** Wraps an axios adapter so each request rides the recovery policy. */
export function recoveringAdapter(base: AxiosAdapter): AxiosAdapter {
  return (config: InternalAxiosRequestConfig) => {
    const method = (config.method ?? 'get').toUpperCase()
    const path = (config.url ?? '').replace(/^\/api(?=\/)/, '')
    // A read-only batch POST waits like a read and carries no key.
    const as = isReadPost(method, path) ? 'GET' : method
    const keyed = as !== 'GET' && isKeyedWrite(method, path)
    // Downloads (blob / stream) run once: a retried half-stream is worse than an error.
    const streamed = ['blob', 'arraybuffer', 'stream'].includes(config.responseType ?? '')
    if ((as !== 'GET' && !keyed) || streamed) return base(config)
    if (keyed && !config.headers.has('Idempotency-Key'))
      config.headers.set('Idempotency-Key', newIdempotencyKey())
    return withRecovery(
      { method: as, path, write: keyed },
      RECOVERY,
      () => base(config),
      (_res, err) => axiosVerdict(as, keyed, err),
      recoverySleep(config.signal as AbortSignal | undefined)
    )
  }
}

const TOAST_ID = 'nvr-server-away'
let installed = false

/**
 * Turn recovery on for the axios instance and every SDK client in the page;
 * tell the person while requests wait, and re-run the reads that failed once
 * the server is back.
 */
export function installRecovery(api: AxiosInstance, queryClient: QueryClient): void {
  if (installed) return
  installed = true
  setRecoveryDefaults(RECOVERY)
  api.defaults.adapter = recoveringAdapter(axios.getAdapter(api.defaults.adapter))

  let waitingWrites = 0
  let waiting = 0
  let refetchTimer: ReturnType<typeof setTimeout> | null = null
  const refetchFailedReads = () => {
    if (refetchTimer) return
    refetchTimer = setTimeout(() => {
      refetchTimer = null
      void queryClient.refetchQueries({
        type: 'active',
        predicate: (q) => q.state.status === 'error'
      })
    }, 1_000)
  }
  const show = () => {
    if (waiting <= 0) return
    toast.loading('The server is restarting — waiting for it to come back…', {
      id: TOAST_ID,
      duration: Number.POSITIVE_INFINITY,
      description:
        waitingWrites > 0
          ? `${waitingWrites === 1 ? 'Your change' : `${waitingWrites} changes`} will be saved as soon as it is back. Keep this tab open.`
          : undefined
    })
  }
  // A save waiting for the server is unsaved work: a force refresh / minimum-build reload
  // must not drop it (lib unsaved-work).
  registerUnsavedWork('A change waiting for the server', () => waitingWrites > 0)
  onRecoveryEvent((e: RecoveryEvent) => {
    const step = e.type === 'waiting' ? 1 : -1
    waiting = Math.max(0, waiting + step)
    if (e.write) waitingWrites = Math.max(0, waitingWrites + step)
    if (e.type === 'waiting') return show()
    if (e.type === 'recovered') {
      refetchFailedReads()
      if (waiting === 0) toast.success('The server is back.', { id: TOAST_ID, duration: 3_000 })
      else show()
      return
    }
    if (waiting > 0) return show()
    // The person left the screen or cancelled: nothing to report for it.
    if (e.aborted) return void toast.dismiss(TOAST_ID)
    toast.error('The server is still not answering.', {
      id: TOAST_ID,
      duration: 10_000,
      description: e.write
        ? 'A change could not be saved. Try again once the server is back.'
        : 'Reload the page once it is back.'
    })
  })
}
