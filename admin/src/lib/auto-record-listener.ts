import { parseAutoRecord, runAutoRecording, stopAutoRecording } from '@nivaro/shared'
import { useEffect } from 'react'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { readMasquerade } from '@/lib/masquerade'
import { getSocket } from '@/lib/socket'

/**
 * Auto-record on a signal (#1371), the admin's socket half: `replay:record`
 * from the server (rage click, dead-click burst, monitor flip, breaker
 * opening — only with replay_auto_signals on) starts a three-minute
 * recording labelled auto:<signal> through the shared runner
 * (packages/shared/src/lib/auto-record.ts). Kept out of the recorder module
 * on purpose; the recorder calls this hook once.
 */
export function useAutoRecordListener(): void {
  const { user } = useAuth()
  useEffect(() => {
    // Never record a "View as" tab — it would be filed under the other person.
    if (!user || readMasquerade()) return
    const socket = getSocket()
    const onRecord = (payload: unknown) => {
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
            await api.post<{ data: { id: string } }>('/session-recordings/start', {
              auto_token: token,
              origin: window.location.origin
            })
          ).data.data.id,
        append: async (id, seq, events) => {
          try {
            await api.post(`/session-recordings/${id}/events`, { seq, events })
            return 'ok'
          } catch (err) {
            return (err as { response?: { status?: number } }).response?.status === 409
              ? 'closed'
              : 'ok'
          }
        },
        end: async (id) => {
          await api.post(`/session-recordings/${id}/end`).catch(() => {})
        }
      })
    }
    socket.on('replay:record', onRecord)
    return () => {
      socket.off('replay:record', onRecord)
      void stopAutoRecording()
    }
  }, [user])
}
