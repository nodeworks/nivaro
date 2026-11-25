import { allowedHubTabs, HUB_PATHS, hubForPath, hubTabPath } from '@/lib/hubs'

/**
 * The standalone Hub's top-bar sections, as config. A section shows only when
 *  - its route exists in this build (another Hub area not shipped yet — Fleet, Deploys, Moves,
 *    People — is hidden, never a dead link), and
 *  - this person may open it, exactly as the old sidebar decided: a Hub tab needs the Apps entry
 *    in the person's permitted nav AND the tab allowed by their role's ui_permissions
 *    (allowedHubTabs); any other page needs its own permitted nav entry.
 * Everything else a standalone Hub keeps (HUB_ONLY_NAV: Users, Roles, Health, Jobs…) goes under
 * "System" in the bar.
 */
export interface HubSection {
  label: string
  to: string
}

export const HUB_SECTIONS: HubSection[] = [
  { label: 'Fleet', to: '/hub/fleet' },
  { label: 'Apps', to: '/hub' },
  { label: 'Deploys', to: '/hub/deploys' },
  { label: 'Shared', to: '/hub/shared' },
  { label: 'Moves', to: '/hub/moves' },
  { label: 'People', to: '/hub/people' },
  { label: 'Settings', to: '/settings' }
]

/** Routes outside the hub registry this build is known to answer. */
const PLAIN_ROUTES = new Set(['/settings'])

export function routeExists(to: string, hubPaths: ReadonlySet<string> = HUB_PATHS): boolean {
  return hubPaths.has(to) || PLAIN_ROUTES.has(to)
}

export interface SectionAccess {
  /** The nav entries this person may open (permittedCategories keys / paths). */
  permitted: ReadonlySet<string>
  /** Their role's ui_permissions (useUiPermissions). */
  disabled: ReadonlySet<string>
}

/** May this person open `to` (same rule as the sidebar)? */
export function sectionAllowed(to: string, access: SectionAccess): boolean {
  const match = hubForPath(to)
  if (match) {
    if (!access.permitted.has(match.hub.base)) return false
    return allowedHubTabs(match.hub, access.disabled as Set<string>).some(
      (t) => hubTabPath(match.hub, t) === to
    )
  }
  return access.permitted.has(to)
}

/** The sections this build shows this person, in order. */
export function visibleSections(
  access: SectionAccess | null,
  hubPaths: ReadonlySet<string> = HUB_PATHS,
  sections: HubSection[] = HUB_SECTIONS
): HubSection[] {
  return sections.filter(
    (s) => routeExists(s.to, hubPaths) && (!access || sectionAllowed(s.to, access))
  )
}

/**
 * The section `path` is in: an exact section, else the section whose path it extends; any other
 * page of the Apps hub (Drivers, Templates, Capacity…) lights Apps.
 */
export function activeSection(sections: HubSection[], path: string): HubSection | null {
  const p = path.length > 1 ? path.replace(/\/+$/, '') : path
  let best: HubSection | null = null
  for (const s of sections) {
    if (s.to === '/hub') continue
    if (p === s.to || p.startsWith(`${s.to}/`)) {
      if (!best || s.to.length > best.to.length) best = s
    }
  }
  if (best) return best
  const apps = sections.find((s) => s.to === '/hub')
  return apps && (p === '/hub' || p.startsWith('/hub/')) ? apps : null
}
