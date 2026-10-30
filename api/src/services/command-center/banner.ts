/**
 * Command Center board banner (CC-20): what the board should say above everything when the
 * instance is not in its normal state. Reuses the existing sources — nothing new is stored:
 *   - maintenance: services/security.ts maintenanceState() (settings row or the nvr:maintenance
 *     Redis override). Everyone sees it (the app's own strip shows it to everyone anyway).
 *   - incident: the open ops incident thread (services/ops-incidents.ts currentIncident) —
 *     administrators only (an incident title is operations detail).
 * A running chaos drill is NOT here: the board reads the shared `useArmedFaults()` hook
 * (GET /api/chaos/armed + the chaos:armed socket event), which already decides who may see a
 * blind drill.
 */

export interface BoardBannerState {
  maintenance: { on: true; message: string | null; until: string | null } | null
  incident: { title: string; started_at: string; href: string } | null
}

export async function readBanner(isAdmin: boolean): Promise<BoardBannerState> {
  const out: BoardBannerState = { maintenance: null, incident: null }
  try {
    const { maintenanceState } = await import('../security.js')
    const m = await maintenanceState()
    if (m.on) out.maintenance = { on: true, message: m.message, until: m.until }
  } catch {
    /* no maintenance answer = no banner */
  }
  if (isAdmin) {
    try {
      const { currentIncident } = await import('../ops-incidents.js')
      const inc = await currentIncident()
      if (inc)
        out.incident = {
          title: String(inc.title).slice(0, 200),
          started_at: new Date(inc.started_at).toISOString(),
          href: '/ops-console'
        }
    } catch {
      /* incidents table missing */
    }
  }
  return out
}
