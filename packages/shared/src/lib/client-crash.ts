import type { Command } from '@nivaro/sdk'
import { post } from './commands'
import { captureReplayClip, type ReplayLink } from './replay-capture'

/**
 * Report a render crash into the issue log with its replay (#1370) — the one
 * call a host's error boundary makes from componentDidCatch:
 *
 *   componentDidCatch(error, info) { void reportClientCrash(client, error, info) }
 *
 * It asks the registered session recorder for the last minute (or the live
 * recording's offset), then posts POST /issues/client with the replay link,
 * exactly as the admin's PageErrorBoundary does. Never throws and never
 * blocks rendering: the capture self-times-out and a failed post is dropped.
 */

export interface ClientCrashBody {
  message: string
  stack?: string
  url: string
  recording_id?: string
  recording_offset_ms?: number | null
}

const STACK_CAP = 6000

export function buildClientCrashBody(
  error: unknown,
  info: { componentStack?: string | null } | null | undefined,
  url: string,
  replay: ReplayLink | null
): ClientCrashBody {
  const err =
    error instanceof Error ? error : new Error(typeof error === 'string' ? error : String(error))
  const stack = [err.stack, info?.componentStack]
    .filter(Boolean)
    .join('\n---\n')
    .slice(0, STACK_CAP)
  return {
    message: err.message || 'Unknown error',
    ...(stack ? { stack } : {}),
    url: url.slice(0, 300),
    ...(replay ? { recording_id: replay.recording_id, recording_offset_ms: replay.offset_ms } : {})
  }
}

export async function reportClientCrash(
  client: { request<T>(cmd: Command<T>): Promise<T> },
  error: unknown,
  info?: { componentStack?: string | null } | null,
  opts?: { url?: string }
): Promise<void> {
  try {
    const replay = await captureReplayClip('error')
    const url = opts?.url ?? (typeof window !== 'undefined' ? window.location.pathname : 'unknown')
    await client.request(
      post<void>('/issues/client', buildClientCrashBody(error, info, url, replay))
    )
  } catch {
    /* error reporting must never throw from an error boundary */
  }
}
