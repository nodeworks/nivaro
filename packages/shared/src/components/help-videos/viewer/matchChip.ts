import type { HelpVideoDto } from '../types'
import { formatDuration, isGettingReady } from './format'

/**
 * #18 — the screen's best help video, offered as a small "Watch: …" chip in
 * the page header area. The server names it (`best_id`: a strong match —
 * this step, this screen, screens like it, this record type — the person has
 * not finished); a person can wave one away and it stays away (per video, in
 * this browser).
 */

export const CHIP_DISMISSED_KEY = 'nvr_hv_chip_dismissed'
const MAX_REMEMBERED = 200

type Store = Pick<Storage, 'getItem' | 'setItem'>

function storage(): Store | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}

export function readDismissed(store: Store | null = storage()): Set<string> {
  try {
    const raw = store?.getItem(CHIP_DISMISSED_KEY)
    const list = raw ? (JSON.parse(raw) as unknown) : []
    return new Set(
      Array.isArray(list)
        ? list.filter((x): x is string => typeof x === 'string').map((x) => x.toLowerCase())
        : []
    )
  } catch {
    return new Set()
  }
}

export function rememberDismissed(id: string, store: Store | null = storage()): Set<string> {
  const set = readDismissed(store)
  set.delete(id.toLowerCase())
  const list = [...set, id.toLowerCase()].slice(-MAX_REMEMBERED)
  try {
    store?.setItem(CHIP_DISMISSED_KEY, JSON.stringify(list))
  } catch {
    /* storage full or off — dismissed for this page only */
  }
  return new Set(list)
}

/** The video the chip offers, or null: the server's best match, unless it was
 *  dismissed, finished, or is still getting ready. */
export function chipVideo(
  videos: HelpVideoDto[] | undefined,
  bestId: string | null | undefined,
  dismissed: Set<string>
): HelpVideoDto | null {
  if (!bestId || !videos?.length) return null
  const v = videos.find((x) => x.id.toLowerCase() === bestId.toLowerCase())
  if (!v) return null
  if (dismissed.has(v.id.toLowerCase())) return null
  if (v.my_progress?.completed || isGettingReady(v)) return null
  return v
}

/** "Watch: How to submit an IR (2:10)". */
export function chipLabel(v: Pick<HelpVideoDto, 'title' | 'duration_ms'>): string {
  const d = v.duration_ms != null ? ` (${formatDuration(v.duration_ms)})` : ''
  return `Watch: ${v.title}${d}`
}

/** Screens that never get a chip: the video library itself. */
export function chipAllowedOn(path: string): boolean {
  return !/^\/(help-videos|help\/videos)(\/|$)/.test(path)
}
