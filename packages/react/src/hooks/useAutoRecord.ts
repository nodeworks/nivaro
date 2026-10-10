import type { NivaroClient } from '@nivaro/sdk'
import { appendSessionRecordingEvents, endSessionRecording } from '@nivaro/sdk'
import {
  parseAutoRecord,
  runAutoRecording,
  stopAutoRecording,
  useOptionalRealtime
} from '@nivaro/shared'
import { useEffect } from 'react'
import { useOptionalNivaroClient } from '../context'
import { post } from '../lib/commands'

/**
 * Auto-record on a signal (#1371) for headless hosts: listens for the
 * server's `replay:record` on the host's RealtimeAdapter (the socket the
 * portal already holds) and starts a three-minute recording labelled
 * auto:<signal> through the shared runner. useSessionRecorder calls it, so a
 * host that records needs nothing more; without a realtime adapter or rrweb
 * it does nothing.
 */
export function useAutoRecord(opts: { client?: NivaroClient | null; disabled?: boolean } = {}) {
  const rt = useOptionalRealtime()
  const contextClient = useOptionalNivaroClient()
  const client = opts.client ?? contextClient
  const disabled = opts.disabled ?? false
  useEffect(() => {
    if (!rt || !client || disabled || typeof window === 'undefined') return
    const off = rt.on('replay:record', (payload: unknown) => {
      const req = parseAutoRecord(payload)
      if (!req) return
      void runAutoRecording(req, {
        loadRecord: async () => {
          try {
            return (await import('rrweb')).record as never
          } catch {
            return null
          }
        },
        start: async (token) =>
          (
            await client.request(
              post<{ data: { id: string } }>('/session-recordings/start', {
                auto_token: token,
                origin: window.location.origin
              })
            )
          ).data.id,
        append: async (id, seq, events) => {
          try {
            await client.request(appendSessionRecordingEvents(id, seq, events))
            return 'ok'
          } catch (err) {
            const status =
              (err as { status?: number }).status ??
              (err as { response?: { status?: number } }).response?.status
            return status === 409 ? 'closed' : 'ok'
          }
        },
        end: async (id) => {
          await client.request(endSessionRecording(id)).catch(() => {})
        }
      })
    })
    return () => {
      off()
      void stopAutoRecording()
    }
  }, [rt, client, disabled])
}
