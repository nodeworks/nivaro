import type { ArmedFault } from './catalog.js'

/**
 * Who may see an armed fault (#2854 blind mode). The registry knows every armed fault; most are
 * public (the drill banner shows them to everyone signed in). A blind drill hides its faults
 * from responders: only its insiders (the lead) and chaos operators see them. One resolver is
 * installed by services/chaos/blind.ts; without it every fault is public.
 *
 * Read synchronously on the hot paths that build the banner: `GET /api/chaos/armed` and the
 * `chaos:armed` broadcast (drill.ts emitArmedChanged).
 */

export interface ArmedViewer {
  id: string | null
  /** A chaos operator (administrators today, #2862 later) sees everything. */
  operator: boolean
}

export interface ArmedVisibilityResolver {
  /** Null = public; otherwise the user ids allowed to see it besides operators. */
  insidersOf(fault: ArmedFault): string[] | null
}

let resolver: ArmedVisibilityResolver | null = null

export function setArmedVisibility(r: ArmedVisibilityResolver | null): void {
  resolver = r
}

function insiders(f: ArmedFault): string[] | null {
  if (!resolver) return null
  try {
    return resolver.insidersOf(f)
  } catch {
    // Fail closed: a resolver error hides the fault from responders (operators still see it).
    return []
  }
}

const same = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase()

/** The faults this viewer may see. */
export function visibleArmedFor(viewer: ArmedViewer, list: ArmedFault[]): ArmedFault[] {
  if (viewer.operator) return list
  return list.filter((f) => {
    const who = insiders(f)
    return who == null || who.some((id) => same(id, viewer.id))
  })
}

/** The faults everybody may see (the tenant-wide broadcast). */
export function publicArmed(list: ArmedFault[]): ArmedFault[] {
  return list.filter((f) => insiders(f) == null)
}

/**
 * The people who must get a fuller list than the public one, with that list: every insider of
 * a hidden fault gets the public faults plus the hidden ones they are inside.
 */
export function insiderViews(list: ArmedFault[]): Map<string, ArmedFault[]> {
  const out = new Map<string, ArmedFault[]>()
  const hidden = list.filter((f) => insiders(f) != null)
  if (!hidden.length) return out
  const ids = new Set<string>()
  for (const f of hidden) for (const id of insiders(f) ?? []) ids.add(id.toLowerCase())
  for (const id of ids) out.set(id, visibleArmedFor({ id, operator: false }, list))
  return out
}

/** True when any armed fault is hidden from responders right now. */
export function anyHidden(list: ArmedFault[]): boolean {
  return list.some((f) => insiders(f) != null)
}
