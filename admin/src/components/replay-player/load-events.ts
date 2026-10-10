import { api } from '@/lib/api'

/**
 * Fetch a recording's events for the player. A recording moved to cold
 * storage (#1411) answers 202 while the server loads it back; this polls
 * until the events are there, telling the caller so it can say "Loading from
 * storage…". Gives up after about two minutes.
 */
export async function fetchRecordingEvents(
  recordingId: string,
  opts: {
    onFromStorage?: () => void
    cancelled?: () => boolean
    intervalMs?: number
    maxPolls?: number
  } = {}
): Promise<{ events: unknown[]; last_seq?: number }> {
  const interval = opts.intervalMs ?? 1500
  const max = opts.maxPolls ?? 80
  for (let i = 0; i <= max; i++) {
    const r = await api.get<{
      data: { events?: unknown[]; last_seq?: number; status?: string }
    }>(`/session-recordings/${recordingId}/events`)
    if (r.status !== 202) {
      return { events: r.data.data.events ?? [], last_seq: r.data.data.last_seq }
    }
    opts.onFromStorage?.()
    await new Promise((resolve) => setTimeout(resolve, interval))
    if (opts.cancelled?.()) break
  }
  throw new Error('Timed out loading the recording from storage')
}
