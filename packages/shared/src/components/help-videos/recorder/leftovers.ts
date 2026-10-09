import type { PartStore } from './partQueue'

/** An upload `/help-videos/uploads/mine` lists: one left unfinished (`open`)
 *  or a finished recording never saved as a video (`finalized`). */
export type OpenUpload = {
  id: string
  bytes_received: number
  next_part: number
  status?: string
  duration_ms?: number | null
  created_at: string
  updated_at: string
}

/** A recording this person started and never finished.
 *  - `interrupted`: the server still holds it open; it can be kept or discarded.
 *    `gap` means the parts after the server's last one were lost (they were
 *    kept in memory only), so only what the server has can be kept.
 *  - `finished`: fully uploaded but never saved as a video (the tab closed, or
 *    the save failed); it can be saved straight away or discarded.
 *  - `unsaveable`: parts are in this browser but the server no longer holds
 *    the upload (abandoned or expired); it can only be discarded. */
export type Leftover = {
  id: string
  kind: 'interrupted' | 'finished' | 'unsaveable'
  created_at: string | null
  bytes: number
  gap: boolean
  /** Length of a finished recording, when the server could measure it. */
  duration_ms?: number | null
}

/** An upload touched this recently may still be recording in another tab. */
export const LIVE_ELSEWHERE_MS = 2 * 60_000

/** Which stored parts to re-send after the server's `next_part`. When the
 *  first one kept is not the one the server expects, the end in between is
 *  gone: nothing is re-sent (the server would refuse it). */
export function planResume(
  parts: Array<{ n: number; blob: Blob }>,
  nextServer: number
): { resend: Array<{ n: number; blob: Blob }>; gap: boolean } {
  const kept = parts.filter((p) => p.n >= nextServer).sort((a, b) => a.n - b.n)
  if (kept.length && kept[0].n !== nextServer) return { resend: [], gap: true }
  return { resend: kept, gap: false }
}

export async function findLeftovers(
  open: OpenUpload[],
  store: PartStore,
  now = Date.now()
): Promise<Leftover[]> {
  const rows: Leftover[] = []
  const openIds = new Set(open.map((u) => u.id))
  for (const u of open) {
    const touched = Date.parse(u.updated_at)
    if (Number.isFinite(touched) && now - touched < LIVE_ELSEWHERE_MS) continue
    if (u.status === 'finalized') {
      rows.push({
        id: u.id,
        kind: 'finished',
        created_at: u.created_at,
        bytes: u.bytes_received,
        gap: false,
        duration_ms: u.duration_ms ?? null
      })
      continue
    }
    const { resend, gap } = planResume(await store.list(u.id).catch(() => []), u.next_part)
    rows.push({
      id: u.id,
      kind: 'interrupted',
      created_at: u.created_at,
      bytes: u.bytes_received + resend.reduce((sum, p) => sum + p.blob.size, 0),
      gap
    })
  }
  for (const id of await store.uploads().catch(() => [] as string[])) {
    if (openIds.has(id)) continue
    const parts = await store.list(id).catch(() => [])
    rows.push({
      id,
      kind: 'unsaveable',
      created_at: null,
      bytes: parts.reduce((sum, p) => sum + p.blob.size, 0),
      gap: false
    })
  }
  return rows
}
